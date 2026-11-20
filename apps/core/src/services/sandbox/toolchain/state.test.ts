import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import { db } from '../../../db'
import { sandboxToolchainActivations, sandboxToolchainProvisions, squads } from '../../../db/schema'
import { eventEmitter } from '../../../lib/infra/event-emitter'
import {
  clearCurrentToolchainState,
  getProvisionState,
  markActivationRequired,
  markDesired,
  markFailed,
  markReady,
  markStage,
  readToolchainReconcileSnapshot,
  withPinnedProvisionLease,
  withProvisionLease,
} from './state'

const squadId = '11111111-1111-4111-8111-111111111119'
const sandboxId = `squad_${squadId}`
const fingerprint = 'a'.repeat(64)

/**
 * Resolve once the lease under test is genuinely contended — i.e. a second
 * backend is waiting on an ungranted advisory lock. Returns false as soon as
 * the second lease runs anyway, so an unlocked implementation fails the
 * assertion instead of stalling until the deadline.
 */
async function waitForBlockedAdvisoryLock(calls: string[]): Promise<boolean> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (calls.length > 1) return false
    const [row] = (await db.execute(
      sql`select count(*)::int as waiting from pg_locks where locktype = 'advisory' and not granted`
    )) as unknown as Array<{ waiting: number }>
    if ((row?.waiting ?? 0) > 0) return true
    await Bun.sleep(5)
  }
  return false
}

describe('sandbox toolchain provision state', () => {
  beforeAll(async () => {
    await db.insert(squads).values({ id: squadId, name: 'Toolchain state', purpose: 'test' }).onConflictDoNothing()
  })

  afterAll(async () => {
    await db.delete(squads).where(eq(squads.id, squadId))
  })

  it.each(['success', 'failure'] as const)(
    'pins lock/reconcile/unlock to one reserved session and cleans up on %s',
    async (outcome) => {
      const calls: string[] = []
      const session = {
        query: async (strings: TemplateStringsArray) =>
          void calls.push(strings[0].includes('unlock') ? 'unlock' : 'lock'),
        release: () => void calls.push('release'),
      }
      const pool = {
        reserve: async () => {
          calls.push('reserve')
          return session
        },
        end: async () => void calls.push('end'),
      }
      const operation = withPinnedProvisionLease(
        'pinned-test',
        async () => {
          calls.push('reconcile')
          if (outcome === 'failure') throw new Error('expected')
          return 'ready'
        },
        pool
      )
      if (outcome === 'failure') await expect(operation).rejects.toThrow('expected')
      else expect(await operation).toBe('ready')
      expect(calls).toEqual(['reserve', 'lock', 'reconcile', 'unlock', 'release', 'end'])
    }
  )

  it('serializes dedicated-session leases without a long database transaction', async () => {
    const calls: string[] = []
    let releaseFirst!: () => void
    const blocked = new Promise<void>((resolve) => (releaseFirst = resolve))
    const first = withProvisionLease('lease-test', async () => {
      calls.push('first')
      await blocked
    })
    while (calls.length === 0) await Bun.sleep(1)
    const second = withProvisionLease('lease-test', async () => void calls.push('second'))

    // Force the contended interleaving before asserting. A fixed short delay
    // cannot do this: opening the second lease's dedicated connection alone
    // outlasts it, so `calls` would still read ['first'] even with no lock at
    // all. Wait until Postgres actually reports the second session parked on an
    // ungranted advisory lock — that state is unreachable unless the lock is
    // both taken and held across the whole reconcile window.
    expect(await waitForBlockedAdvisoryLock(calls)).toBe(true)
    expect(calls).toEqual(['first'])

    releaseFirst()
    await Promise.all([first, second])
    expect(calls).toEqual(['first', 'second'])
  })

  it('declares generated squad cascade ownership for result and activation evidence', () => {
    const migration = Bun.file(new URL('../../../../drizzle/0097_cooing_cobalt_man.sql', import.meta.url)).text()
    return migration.then((sqlText) => {
      expect(sqlText).toContain('sandbox_toolchain_activations_squad_id_squads_id_fk')
      expect(sqlText).toContain('ON DELETE cascade')
    })
  })

  it('reads one authoritative reconcile snapshot without neighboring state', async () => {
    const snapshotId = `squad_snapshot_${squadId}`
    const neighborId = `squad_neighbor_${squadId}`
    await db
      .update(squads)
      .set({ metadata: { sandbox: { toolchain: { packages: ['jq'] } } } })
      .where(eq(squads.id, squadId))
    await db.insert(sandboxToolchainProvisions).values({
      sandboxId: snapshotId,
      squadId,
      desiredFingerprint: fingerprint,
      status: 'pending',
    })
    await db.insert(sandboxToolchainActivations).values({ sandboxId: neighborId, squadId })

    expect(await readToolchainReconcileSnapshot(squadId, snapshotId)).toMatchObject({
      config: { packages: ['jq'] },
      provision: { sandboxId: snapshotId },
      activation: undefined,
    })
    expect(await readToolchainReconcileSnapshot(squadId, neighborId)).toMatchObject({
      config: { packages: ['jq'] },
      provision: undefined,
      activation: { sandboxId: neighborId },
    })
    expect(await readToolchainReconcileSnapshot('11111111-1111-4111-8111-111111111121', snapshotId)).toEqual({
      config: undefined,
      provision: undefined,
      activation: undefined,
    })
    await clearCurrentToolchainState(snapshotId, squadId)
    await clearCurrentToolchainState(neighborId, squadId)
    await db.update(squads).set({ metadata: {} }).where(eq(squads.id, squadId))
  })

  it('tracks activation conservatively and clears both evidence rows', async () => {
    const activationId = `agent_activation_${squadId}`
    await markDesired({ sandboxId: activationId, squadId, desiredFingerprint: fingerprint })
    await markActivationRequired({ sandboxId: activationId, squadId, desiredFingerprint: fingerprint })
    await markReady({ sandboxId: activationId, squadId, desiredFingerprint: fingerprint })

    expect(await readToolchainReconcileSnapshot(squadId, activationId)).toMatchObject({
      provision: { status: 'ready', appliedFingerprint: fingerprint },
      activation: { appliedFingerprint: fingerprint },
    })
    await clearCurrentToolchainState(activationId, squadId)
    expect(await readToolchainReconcileSnapshot(squadId, activationId)).toMatchObject({
      provision: undefined,
      activation: undefined,
    })
  })

  it('persists transitions, clears failures, and emits invalidations', async () => {
    const events: string[] = []
    const unsubscribe = eventEmitter.on('sandbox.status', ({ sandboxId: changed }) => events.push(changed))
    await markDesired({ sandboxId, squadId, desiredFingerprint: fingerprint })
    await markStage({ sandboxId, squadId, desiredFingerprint: fingerprint, status: 'installing' })
    await markFailed({ sandboxId, squadId, desiredFingerprint: fingerprint, errorCode: 'install_failed', exitCode: 2 })
    expect((await getProvisionState(sandboxId, fingerprint))?.reason).toBe('Package installation failed')
    await markStage({ sandboxId, squadId, desiredFingerprint: fingerprint, status: 'installing' })
    await markReady({ sandboxId, squadId, desiredFingerprint: fingerprint })
    unsubscribe()

    const ready = await getProvisionState(sandboxId, fingerprint)
    expect(ready).toMatchObject({ status: 'ready', desiredFingerprint: fingerprint, appliedFingerprint: fingerprint })
    expect(ready?.errorCode).toBeUndefined()
    expect(events).toEqual([sandboxId, sandboxId, sandboxId, sandboxId, sandboxId])
  })

  it('keeps a ready toolchain ready when an ensure desires the same fingerprint again', async () => {
    const steadyId = `squad_steady_${squadId}`
    const key = { sandboxId: steadyId, squadId, desiredFingerprint: fingerprint }
    await markDesired(key)
    await markReady(key)

    // Every sandbox ensure re-reconciles the toolchain. An unchanged one must
    // not report `pending` (shown as degraded) while it is re-verified.
    const events: string[] = []
    const unsubscribe = eventEmitter.on('sandbox.status', ({ sandboxId: changed }) => events.push(changed))
    await markDesired(key)
    unsubscribe()

    expect(await getProvisionState(steadyId, fingerprint)).toMatchObject({
      status: 'ready',
      appliedFingerprint: fingerprint,
    })
    expect(events).toEqual([])
  })

  it('still returns a failed toolchain to pending and clears its failure when desired again', async () => {
    const retryId = `squad_retry_${squadId}`
    const key = { sandboxId: retryId, squadId, desiredFingerprint: fingerprint }
    await markDesired(key)
    await markReady(key)
    await markFailed({ ...key, errorCode: 'readiness_failed', exitCode: 1 })

    const events: string[] = []
    const unsubscribe = eventEmitter.on('sandbox.status', ({ sandboxId: changed }) => events.push(changed))
    await markDesired(key)
    unsubscribe()

    const retried = await getProvisionState(retryId, fingerprint)
    expect(retried).toMatchObject({ status: 'pending', appliedFingerprint: fingerprint })
    expect(retried?.errorCode).toBeUndefined()
    expect(events).toEqual([retryId])
  })

  it('persists a safe failure code when failure is the first write', async () => {
    const firstFailureId = `agent_${squadId}`
    await markFailed({
      sandboxId: firstFailureId,
      squadId,
      desiredFingerprint: fingerprint,
      errorCode: 'activation_failed',
    })
    expect(await getProvisionState(firstFailureId, fingerprint)).toMatchObject({
      status: 'failed',
      errorCode: 'activation_failed',
      reason: 'Toolchain activation failed',
    })
  })

  it('rejects stale completion after a newer desired fingerprint wins', async () => {
    const staleId = `squad_stale_${squadId}`
    await markDesired({ sandboxId: staleId, squadId, desiredFingerprint: fingerprint })
    await markActivationRequired({ sandboxId: staleId, squadId, desiredFingerprint: fingerprint })
    const newer = 'b'.repeat(64)
    await markDesired({ sandboxId: staleId, squadId, desiredFingerprint: newer })
    await markReady({ sandboxId: staleId, squadId, desiredFingerprint: fingerprint })
    expect(await getProvisionState(staleId, newer)).toMatchObject({ status: 'pending', desiredFingerprint: newer })
    expect((await readToolchainReconcileSnapshot(squadId, staleId)).activation?.appliedFingerprint).toBeUndefined()
  })

  it('returns pending when the desired fingerprint changed', async () => {
    expect(await getProvisionState(sandboxId, 'b'.repeat(64))).toMatchObject({
      status: 'pending',
      desiredFingerprint: 'b'.repeat(64),
    })
  })
})
