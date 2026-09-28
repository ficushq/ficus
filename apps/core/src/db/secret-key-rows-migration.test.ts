import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { decrypt, encrypt } from '@ficus/shared/crypto'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import type postgres from 'postgres'
import { MONOREPO_ROOT } from '../lib/paths'
import { createPostgresConnection, getConnectionString } from './connection'
import { COPIED_LEGACY_SECRET_ROW_KEYS } from './legacy-secret-rows'
import { applyMigrations } from './migrator'

const marker = 'INSERT INTO "secrets"'
const migrations = readMigrationFiles({ migrationsFolder: join(MONOREPO_ROOT, 'apps/core/drizzle') })
const target = migrations.find((migration) => migration.sql.join('\n').includes(marker))
const predecessors = target ? migrations.filter((migration) => migration.folderMillis < target.folderMillis) : []

// A real AES-256-GCM key: the copied rows must decrypt under their new names.
const encryptionKey = randomBytes(32)
const seededAt = new Date('2026-01-02T03:04:05.000Z')

interface SecretRow {
  key: string
  encrypted_value: string
  iv: string
  updated_at: Date
  updated_by: string | null
}

function urlFor(name: string): string {
  const url = new URL(getConnectionString())
  url.pathname = `/${name}`
  return url.toString()
}

async function withMigratedPredecessors(run: (connection: postgres.ReservedSql) => Promise<void>): Promise<void> {
  const dbName = `secret_rows_mig_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`
  const admin = createPostgresConnection(urlFor('postgres'), { max: 1, onnotice: () => {} })
  let client: ReturnType<typeof createPostgresConnection> | undefined
  let connection: postgres.ReservedSql | undefined
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`)
    client = createPostgresConnection(urlFor(dbName), { max: 1, onnotice: () => {} })
    connection = await client.reserve()
    expect(target).toBeDefined()
    await applyMigrations(connection, predecessors)
    await run(connection)
  } finally {
    connection?.release()
    await client?.end()
    await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => {})
    await admin.end()
  }
}

async function insertSecret(
  connection: postgres.ReservedSql,
  key: string,
  plaintext: string,
  updatedBy: string | null
): Promise<void> {
  const { encrypted, iv } = encrypt(plaintext, encryptionKey)
  await connection.unsafe(
    'INSERT INTO secrets (key, encrypted_value, iv, updated_at, updated_by) VALUES ($1, $2, $3, $4, $5)',
    [key, encrypted, iv, seededAt, updatedBy]
  )
}

async function selectRows(connection: postgres.ReservedSql): Promise<Map<string, SecretRow>> {
  const rows = await connection.unsafe<SecretRow[]>(
    'SELECT key, encrypted_value, iv, updated_at, updated_by FROM secrets ORDER BY key'
  )
  return new Map(rows.map((row) => [row.key, { ...row }]))
}

let restoreWarn: (() => void) | undefined
afterEach(() => {
  restoreWarn?.()
  restoreWarn = undefined
})

describe('FICUS_ secret-row copy migration (real runner, isolated database)', () => {
  test('copies exactly the four TAU_ rows as ciphertext, keeps them, and is idempotent', async () => {
    await withMigratedPredecessors(async (connection) => {
      await insertSecret(connection, 'TAU_PASSWORD', 'old-core-password', 'env')
      await insertSecret(connection, 'TAU_PUSH_RELAY_TOKEN', 'relay-token-value', 'admin')
      await insertSecret(connection, 'TAU_PLATFORM_INSTANCE_TOKEN', 'instance-token-value', null)
      // TAU_PLATFORM_USAGE_TOKEN is absent: nothing is invented for it.
      await insertSecret(connection, 'TAU_CUSTOM_TOKEN', 'custom-value', 'admin') // custom rows are not copied
      await insertSecret(connection, 'OPENAI_API_KEY', 'unrelated-value', 'admin')
      const before = await selectRows(connection)

      await applyMigrations(connection, [...predecessors, target!])
      await applyMigrations(connection, [...predecessors, target!])
      // Statement-level idempotence, even if the ledger were bypassed.
      for (const statement of target!.sql) await connection.unsafe(statement)

      const after = await selectRows(connection)
      // Every pre-existing row, TAU_ rows included, is byte-for-byte unchanged.
      for (const [key, row] of before) expect(after.get(key), key).toEqual(row)

      const copied = [...after.keys()].filter((key) => !before.has(key))
      expect(copied.sort()).toEqual(['FICUS_PASSWORD', 'FICUS_PLATFORM_INSTANCE_TOKEN', 'FICUS_PUSH_RELAY_TOKEN'])
      for (const key of copied) {
        const source = before.get(`TAU_${key.slice('FICUS_'.length)}`)!
        // Ciphertext and IV are copied, never re-encrypted or written as plaintext;
        // provenance (updated_by) is kept so env-seeded rows keep syncing from env.
        expect(after.get(key)).toEqual({ ...source, key })
      }
      // The store's AES-256-GCM binds no key name (no AAD), so the copy decrypts under its new name.
      const password = after.get('FICUS_PASSWORD')!
      expect(decrypt(password.encrypted_value, password.iv, encryptionKey)).toBe('old-core-password')
      expect(after.has('FICUS_CUSTOM_TOKEN')).toBe(false)
      expect(after.has('FICUS_PLATFORM_USAGE_TOKEN')).toBe(false)
    })
  })

  test('never overwrites an existing FICUS_ row and names a differing pair without its value', async () => {
    await withMigratedPredecessors(async (connection) => {
      await insertSecret(connection, 'TAU_PASSWORD', 'rolled-back-core-password', 'env')
      await insertSecret(connection, 'FICUS_PASSWORD', 'current-core-password', 'admin')
      // A byte-identical pair is already in the desired state: silent.
      const { encrypted, iv } = encrypt('same-relay-token', encryptionKey)
      for (const key of ['TAU_PUSH_RELAY_TOKEN', 'FICUS_PUSH_RELAY_TOKEN']) {
        await connection.unsafe(
          'INSERT INTO secrets (key, encrypted_value, iv, updated_at, updated_by) VALUES ($1, $2, $3, $4, $5)',
          [key, encrypted, iv, seededAt, 'admin']
        )
      }
      const before = await selectRows(connection)

      const warn = spyOn(console, 'warn').mockImplementation(() => {})
      restoreWarn = () => warn.mockRestore()
      await applyMigrations(connection, [...predecessors, target!])
      const warned = warn.mock.calls.map((args) => args.map(String).join(' ')).join('\n')
      restoreWarn()
      restoreWarn = undefined

      expect(await selectRows(connection)).toEqual(before)
      expect(warned).toContain('FICUS_PASSWORD')
      expect(warned).toContain('TAU_PASSWORD')
      expect(warned).not.toContain('PUSH_RELAY_TOKEN')
      for (const row of before.values()) {
        expect(warned).not.toContain(row.encrypted_value)
        expect(warned).not.toContain(row.iv)
      }
      for (const plaintext of ['rolled-back-core-password', 'current-core-password', 'same-relay-token']) {
        expect(warned).not.toContain(plaintext)
      }
    })
  })

  test('the migration copies exactly the keys the conflict report checks', () => {
    expect(target).toBeDefined()
    const sql = target!.sql.join('\n')
    const listed = [...sql.matchAll(/'(TAU_[A-Z_]+)'/g)].map((match) => match[1]).sort()
    expect(listed).toEqual([...COPIED_LEGACY_SECRET_ROW_KEYS].sort())
  })
})
