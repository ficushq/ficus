import { randomBytes, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { inArray } from 'drizzle-orm'
import { db, secrets } from '../../db'
import { ContentSafety } from '../security/content-safety'
import { ContentSafetyRegistry } from '../security/content-safety-registry'
import { createGeneratedSecretEnvironmentFixture, SecretStore } from './store'

describe('SecretStore test environment isolation', () => {
  const generatedKey = `CANARY_KEY_${randomUUID().replaceAll('-', '_')}`
  const generatedValue = `CANARY_SECRET_${randomUUID()}`
  const originalEncryptionKey = process.env.FICUS_ENCRYPTION_KEY
  const createdDbKeys = new Set<string>()

  beforeEach(() => {
    process.env.FICUS_ENCRYPTION_KEY = randomBytes(32).toString('hex')
    process.env[generatedKey] = generatedValue
    createdDbKeys.clear()
  })

  afterEach(async () => {
    delete process.env[generatedKey]
    if (createdDbKeys.size > 0) await db.delete(secrets).where(inArray(secrets.key, [...createdDbKeys]))
    if (originalEncryptionKey === undefined) delete process.env.FICUS_ENCRYPTION_KEY
    else process.env.FICUS_ENCRYPTION_KEY = originalEncryptionKey
  })

  test('shared preload rejects a generated sentinel inherited by a controlled child', () => {
    const databaseUrl = process.env.DATABASE_URL
    const executablePath = Bun.which('bun')
    if (!databaseUrl || !executablePath) throw new Error('missing_sterile_child_test_dependency')
    const childKey = `CANARY_KEY_${randomUUID().replaceAll('-', '_')}`
    const childValue = `CANARY_SECRET_${randomUUID()}`
    const repoRoot = resolve(import.meta.dir, '../../../../..')
    const child = Bun.spawnSync(
      [executablePath, './apps/core/src/services/secrets/store-parent-environment.fixture.ts'],
      {
        cwd: repoRoot,
        env: {
          PATH: process.env.PATH ?? '',
          HOME: '/tmp',
          NODE_ENV: 'test',
          FICUS_TEST_MODE: '1',
          DATABASE_URL: databaseUrl,
          SECRET_BOUNDARY_REQUIRE_ISOLATED_DB: process.env.SECRET_BOUNDARY_REQUIRE_ISOLATED_DB ?? '0',
          FICUS_TEST_PARENT_SENTINEL_KEY: childKey,
          [childKey]: childValue,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      }
    )
    const output = `${child.stdout.toString()}${child.stderr.toString()}`

    if (child.exitCode !== 0) {
      const safeOutput = ContentSafety.fromSecretEntries([{ key: 'CHILD_CANARY', value: childValue }]).redact(output)
      throw new Error(`sterile_child_failed: ${safeOutput}`)
    }
    expect(output).not.toContain(childValue)
  }, 20_000)

  test('rejects an inherited known service value even when the shared database already contains that key', async () => {
    const databaseUrl = process.env.DATABASE_URL
    const executablePath = Bun.which('bun')
    if (!databaseUrl || !executablePath) throw new Error('missing_sterile_child_test_dependency')
    const childValue = `CANARY_SECRET_${randomUUID()}`
    if (process.env.SECRET_BOUNDARY_REQUIRE_ISOLATED_DB !== '1') {
      // Deterministic reproduction of the shared-suite collision: key presence
      // is not evidence that this child's environment value leaked. The
      // dedicated sterile lane intentionally keeps its stronger absent-key DB.
      const store = new SecretStore()
      await store.initialize()
      createdDbKeys.add('GITHUB_TOKEN')
      await store.set('GITHUB_TOKEN', `CANARY_SECRET_DB_${randomUUID()}`)
      expect(store.get('GITHUB_TOKEN')).not.toBe(childValue)
      store.stopPeriodicRefresh()
    }
    const repoRoot = resolve(import.meta.dir, '../../../../..')
    const child = Bun.spawnSync(
      [executablePath, './apps/core/src/services/secrets/store-parent-environment.fixture.ts'],
      {
        cwd: repoRoot,
        env: {
          PATH: process.env.PATH ?? '',
          HOME: '/tmp',
          NODE_ENV: 'test',
          FICUS_TEST_MODE: '1',
          DATABASE_URL: databaseUrl,
          SECRET_BOUNDARY_REQUIRE_ISOLATED_DB: process.env.SECRET_BOUNDARY_REQUIRE_ISOLATED_DB ?? '0',
          FICUS_TEST_PARENT_SENTINEL_KEY: 'GITHUB_TOKEN',
          GITHUB_TOKEN: childValue,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      }
    )
    const output = `${child.stdout.toString()}${child.stderr.toString()}`
    expect(
      child.exitCode,
      ContentSafety.fromSecretEntries([{ key: 'CHILD_CANARY', value: childValue }]).redact(output)
    ).toBe(0)
    expect(output).not.toContain(childValue)
  }, 20_000)

  test('rejects a non-generated environment read opt-in', () => {
    const ambientKey = 'RUNTIME_CREDENTIAL_KEY'
    process.env[ambientKey] = `CANARY_SECRET_${randomUUID()}`
    try {
      expect(() => new SecretStore({ testEnvironmentReadFixtures: [{ key: ambientKey }] as never })).toThrow(
        'active generated fixture capability'
      )
    } finally {
      delete process.env[ambientKey]
    }
  })

  test('does not observe a parent environment sentinel by default', async () => {
    const store = new SecretStore()
    await store.initialize()

    const registry = new ContentSafetyRegistry(store)
    expect(store.get(generatedKey)).toBeUndefined()
    expect(await store.list()).not.toContainEqual(expect.objectContaining({ key: generatedKey }))
    expect(registry.redact(generatedValue)).toBe(generatedValue)
    registry.dispose()
  })

  test('migrates only an opaque generated environment fixture capability', async () => {
    const fixture = createGeneratedSecretEnvironmentFixture()
    try {
      createdDbKeys.add(fixture.key)
      const store = new SecretStore({ testEnvironmentMigrationFixtures: [fixture] })
      await store.initialize()

      const registry = new ContentSafetyRegistry(store)
      expect(store.get(fixture.key)).toBe(fixture.value)
      expect(registry.redact(fixture.value)).toBe(`[REDACTED_SECRET_ENV:${fixture.key}]`)
      expect(await store.list()).toContainEqual(
        expect.objectContaining({ key: fixture.key, isSet: true, updatedBy: 'env' })
      )
      registry.dispose()
    } finally {
      fixture.revoke()
    }
  })

  test('binds an explicit generated database fixture', async () => {
    const databaseKey = `CANARY_KEY_${randomUUID().replaceAll('-', '_')}`
    const databaseValue = `CANARY_SECRET_${randomUUID()}`
    const store = new SecretStore()
    await store.initialize()
    createdDbKeys.add(databaseKey)
    await store.set(databaseKey, databaseValue)

    const registry = new ContentSafetyRegistry(store)

    expect(registry.redact(databaseValue)).toBe(`[REDACTED_SECRET_ENV:${databaseKey}]`)
    registry.dispose()
  })
})
