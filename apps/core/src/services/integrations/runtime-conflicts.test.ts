import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq, inArray } from 'drizzle-orm'
import { db, squads, sandboxExposureCleanup, integrationConnectionAssignments } from '../../db'
import { eventEmitter } from '../../lib/infra/event-emitter'
import { startSubsystems, stopSubsystems, subsystem } from '../../lib/infra/subsystem'
import { regenerateEnvFileForSquad } from '../squad/env'
import { getSquadWorkspacePath } from '../squad/workspace'
import { runExposureCleanupSweep } from '../sandbox/exposure-cleanup'
import { initializeIntegrationDefaults, integrationRoutesService, integrationConnectionService } from './runtime'
import { IntegrationProjectionReconciler } from './projection/reconciler'
import { createTestGitHubConnection } from '../../test-utils/github-connection'
import { useEnabledIntegrationFixtures } from '../../test-utils/enabled-integrations'

useEnabledIntegrationFixtures('github')
const logger = { info() {}, warn() {}, error() {} }

async function fixture() {
  const previous = process.env.HOME_DIR,
    home = mkdtempSync(join(tmpdir(), 'runtime-env-conflicts-'))
  process.env.HOME_DIR = home
  const bad = crypto.randomUUID(),
    good = crypto.randomUUID(),
    ids: string[] = [bad, good]
  await db.insert(squads).values([
    { id: bad, name: 'A conflicting fixture', purpose: 'test' },
    { id: good, name: 'Z healthy fixture', purpose: 'test' },
  ])
  const badDot = join(getSquadWorkspacePath(bad), '.ficus'),
    goodDot = join(getSquadWorkspacePath(good), '.ficus')
  mkdirSync(getSquadWorkspacePath(bad), { recursive: true })
  writeFileSync(badDot, 'custom settings conflict; preserve until operator repairs')
  mkdirSync(goodDot, { recursive: true })
  writeFileSync(join(goodDot, 'env.user'), 'CUSTOM=healthy')
  const invalidated: string[] = []
  const onInvalidate = (event: { squadId: string }) => {
    if (ids.includes(event.squadId)) invalidated.push(event.squadId)
  }
  const unsubscribe = eventEmitter.on('integration.projection-invalidated', onInvalidate)
  return {
    bad,
    good,
    ids,
    badDot,
    goodDot,
    invalidated,
    async dispose() {
      unsubscribe()
      await db.delete(sandboxExposureCleanup).where(inArray(sandboxExposureCleanup.sourceId, ids))
      await db.delete(squads).where(inArray(squads.id, ids))
      if (previous === undefined) delete process.env.HOME_DIR
      else process.env.HOME_DIR = previous
      rmSync(home, { recursive: true, force: true })
    },
  }
}

test('startup reconciliation contains a known settings conflict, keeps cleanup alive and retries failed targets after repair', async () => {
  const f = await fixture()
  let cleanupAlive = false
  try {
    // Regression-first: this used to throw before startup could finish. It also
    // guards the provider-init seam below from running before it is implemented.
    await regenerateEnvFileForSquad(f.bad)
    const targets = f.ids.map((id) => ({
      targetId: `squad:${id}`,
      sourceId: id,
      squadId: id,
      kind: 'squad' as const,
    }))
    const list = [
      subsystem(
        'cleanup',
        async () => {
          cleanupAlive = true
          await runExposureCleanupSweep({ discover: async () => targets })
        },
        () => {
          cleanupAlive = false
        }
      ),
      subsystem(
        'integration-projection',
        () =>
          initializeIntegrationDefaults({ initializeProviders: async () => {}, reconcileSquads: async () => f.ids }),
        () => {}
      ),
    ]
    await startSubsystems(list, logger)
    expect(cleanupAlive).toBe(true)
    expect(f.invalidated).toEqual(f.ids)
    expect(readFileSync(join(f.goodDot, '.env'), 'utf8')).toContain('CUSTOM=healthy')
    await runExposureCleanupSweep({ discover: async () => targets })
    const rows = await db.select().from(sandboxExposureCleanup).where(inArray(sandboxExposureCleanup.sourceId, f.ids))
    expect(rows.find((row) => row.sourceId === f.bad)?.status).toBe('failed')
    const failed = rows.find((row) => row.sourceId === f.bad)!
    expect(failed.nextAttemptAt.getTime()).toBeGreaterThan(failed.updatedAt.getTime())
    const reconciler = new IntegrationProjectionReconciler({
      connections: { get: async () => null, getAssigned: async () => null },
    })
    await expect(
      reconciler.reconcile({
        squadId: f.bad,
        providerKey: 'github',
        generation: 1n,
        status: 'installing',
        desiredFingerprint: null,
        appliedFingerprint: null,
        desiredCredentialRevision: null,
        appliedCredentialRevision: null,
        attempts: 1,
        nextAttemptAt: new Date(),
        leaseToken: 'synthetic',
        leaseExpiresAt: new Date(),
        lastErrorCode: null,
      })
    ).rejects.toMatchObject({ code: 'protected_env_write_failed' })
    expect(rows.find((row) => row.sourceId === f.bad)?.reason).toContain('settings dir')
    expect(rows.find((row) => row.sourceId === f.good)?.status).toBe('done')
    expect(readFileSync(f.badDot, 'utf8')).toContain('custom settings conflict')
    rmSync(f.badDot)
    mkdirSync(f.badDot)
    writeFileSync(join(f.badDot, 'env.user'), 'CUSTOM=repaired')
    await db
      .update(sandboxExposureCleanup)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(sandboxExposureCleanup.sourceId, f.bad))
    await runExposureCleanupSweep({ discover: async () => targets })
    const [repaired] = await db.select().from(sandboxExposureCleanup).where(eq(sandboxExposureCleanup.sourceId, f.bad))
    expect(repaired.status).toBe('done')
    expect(repaired.reason).toBeNull()
    expect(readFileSync(join(f.badDot, '.env'), 'utf8')).toContain('CUSTOM=repaired')
    await stopSubsystems(list, logger)
    expect(cleanupAlive).toBe(false)
  } finally {
    await f.dispose()
  }
})

test('real bulk provider reproject and connection deproject continue past a conflicted squad', async () => {
  const f = await fixture(),
    connection = await createTestGitHubConnection({ squadId: f.bad })
  try {
    await db
      .insert(integrationConnectionAssignments)
      .values({ squadId: f.good, providerKey: 'github', connectionId: connection.id, isDefault: true })
    await integrationRoutesService.setEnabled('github', false, 'test')
    expect(f.invalidated).toEqual(expect.arrayContaining(f.ids))
    expect(existsSync(join(f.goodDot, '.env'))).toBe(true)
    f.invalidated.length = 0
    rmSync(join(f.goodDot, '.env'))
    await integrationConnectionService.disable(connection.id, 'test', true)
    expect(f.invalidated).toEqual(expect.arrayContaining(f.ids))
    expect(readFileSync(join(f.goodDot, '.env'), 'utf8')).toContain('CUSTOM=healthy')
    expect(readFileSync(f.badDot, 'utf8')).toContain('custom settings conflict')
  } finally {
    await connection.dispose()
    await f.dispose()
  }
})

test('unrelated provider startup failures and env I/O errors still abort startup', async () => {
  const f = await fixture()
  try {
    await expect(
      initializeIntegrationDefaults({
        initializeProviders: async () => {
          throw new Error('synthetic provider bootstrap failure')
        },
        reconcileSquads: async () => f.ids,
      })
    ).rejects.toThrow('synthetic provider bootstrap failure')
    rmSync(join(f.goodDot, 'env.user'))
    mkdirSync(join(f.goodDot, 'env.user'))
    let cleanupAlive = false
    const list = [
      subsystem(
        'cleanup',
        () => {
          cleanupAlive = true
        },
        () => {
          cleanupAlive = false
        }
      ),
      subsystem(
        'integration-projection',
        () =>
          initializeIntegrationDefaults({ initializeProviders: async () => {}, reconcileSquads: async () => f.ids }),
        () => {}
      ),
    ]
    await expect(startSubsystems(list, logger)).rejects.toMatchObject({ code: 'EISDIR' })
    expect(cleanupAlive).toBe(false)
  } finally {
    await f.dispose()
  }
})
