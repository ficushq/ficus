import { afterEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'crypto'
import { eq } from 'drizzle-orm'
import { db } from '../../../db'
import { eventEmitter } from '../../../lib/infra/event-emitter'
import { machineBoxes, machines, vmBoxSetupStates } from '../../../db/schema'
import {
  clearVmSetupPendingInvocation,
  computeVmSetupBackoffMs,
  ensureVmSetupFingerprint,
  isVmSetupDue,
  markVmSetupPending,
  projectVmSetupIncidents,
  projectVmSetupState,
  restoreVmSetupAfterRequiredAssets,
  withVmSetupLease,
} from './setup-state'

describe('VM setup state policy', () => {
  test('uses deterministic exponential backoff capped at fifteen minutes', () => {
    const values = Array.from({ length: 8 }, (_, index) => computeVmSetupBackoffMs('squad_s1', index + 1))
    expect(values[0]).toBeGreaterThanOrEqual(30_000)
    expect(values[0]).toBeLessThanOrEqual(36_000)
    expect(values[1]).toBeGreaterThanOrEqual(60_000)
    expect(values[1]).toBeLessThanOrEqual(72_000)
    expect(values.at(-1)).toBeGreaterThanOrEqual(900_000)
    expect(values.at(-1)).toBeLessThanOrEqual(1_080_000)
    expect(computeVmSetupBackoffMs('squad_s1', 3)).toBe(computeVmSetupBackoffMs('squad_s1', 3))
  })

  test('reclaims a reconciliation abandoned beyond the streamed-command budget', () => {
    const base = {
      sandboxId: 'squad_s1',
      desiredFingerprint: 'f',
      readiness: 'reconciling' as const,
      reasons: [],
      attemptCount: 1,
      nextAttemptAt: null,
      pendingInvocationId: null,
      pendingInvocationKind: null,
      lastFailureClass: null,
      updatedAt: new Date(0),
    }
    expect(isVmSetupDue({ ...base, lastAttemptAt: new Date(1) }, new Date(12 * 60_000))).toBe(false)
    expect(isVmSetupDue({ ...base, lastAttemptAt: new Date(0) }, new Date(12 * 60_000))).toBe(true)
  })

  test('schedules degraded setup exactly at its retry boundary', () => {
    const degraded = {
      sandboxId: 'squad_s1',
      desiredFingerprint: 'f',
      readiness: 'ready_degraded' as const,
      reasons: ['devbox_unavailable' as const],
      attemptCount: 1,
      nextAttemptAt: new Date(1000),
      pendingInvocationId: null,
      pendingInvocationKind: null,
      lastFailureClass: null,
      lastAttemptAt: new Date(0),
      updatedAt: new Date(0),
    }
    expect(isVmSetupDue(degraded, new Date(999))).toBe(false)
    expect(isVmSetupDue(degraded, new Date(1000))).toBe(true)
    expect(isVmSetupDue({ ...degraded, readiness: 'ready' }, new Date(2000))).toBe(false)
    expect(isVmSetupDue({ ...degraded, readiness: 'pending', nextAttemptAt: null }, new Date(0))).toBe(true)
  })

  test('replays missed alert and recovery projections from durable state', () => {
    const degraded = {
      sandboxId: 'agent_degraded',
      desiredFingerprint: 'f',
      readiness: 'ready_degraded' as const,
      reasons: ['devbox_unavailable' as const],
      attemptCount: 3,
      nextAttemptAt: new Date(1000),
      pendingInvocationId: null,
      pendingInvocationKind: null,
      lastFailureClass: null,
      lastAttemptAt: new Date(0),
      updatedAt: new Date(0),
    }
    const ready = {
      ...degraded,
      sandboxId: 'agent_ready',
      readiness: 'ready' as const,
      reasons: [],
      attemptCount: 0,
      nextAttemptAt: null,
    }
    const unalertedReady = { ...ready, sandboxId: 'agent_unalerted' }
    expect(
      projectVmSetupIncidents([degraded, ready, unalertedReady], ['agent_ready', 'agent_deleted'], new Date(2000))
    ).toEqual([
      expect.objectContaining({ status: 'degraded', sandboxId: 'agent_degraded', attemptCount: 3 }),
      { status: 'ready', sandboxId: 'agent_ready', now: new Date(2000) },
      { status: 'ready', sandboxId: 'agent_deleted', now: new Date(2000) },
    ])
  })

  test('public projection bounds and deduplicates safe reasons and omits invocation identity', () => {
    expect(
      projectVmSetupState({
        sandboxId: 'squad_s1',
        desiredFingerprint: 'f',
        readiness: 'ready_degraded',
        reasons: [
          'devbox_unavailable',
          'devbox_unavailable',
          'bashrc_unavailable',
          'git_credentials_unavailable',
          'transport_recovery_failed',
          'callback_transport_degraded',
          'command_outcome_ambiguous',
        ],
        attemptCount: 2,
        nextAttemptAt: new Date('2026-01-01T00:00:00Z'),
        pendingInvocationId: 'secret-internal-id',
        pendingInvocationKind: 'devbox',
        lastFailureClass: 'raw failure',
        lastAttemptAt: null,
        updatedAt: new Date(),
      })
    ).toEqual({
      readiness: 'ready_degraded',
      reasons: [
        'devbox_unavailable',
        'bashrc_unavailable',
        'git_credentials_unavailable',
        'transport_recovery_failed',
        'callback_transport_degraded',
      ],
      attemptCount: 2,
      nextAttemptAt: '2026-01-01T00:00:00.000Z',
    })
  })
})

describe('VM setup invocation generation fencing', () => {
  const machineId = randomUUID()
  const sandboxId = `agent_${randomUUID()}`
  afterEach(async () => {
    await db.delete(machines).where(eq(machines.id, machineId))
  })

  test('rejects a stale-generation invocation clear', async () => {
    await db.insert(machines).values({
      id: machineId,
      name: `test-${machineId}`,
      provider: 'ssh',
      sshHost: '127.0.0.1',
      sshUser: 'ficus',
      sshKeyId: 'test',
      sshPublicKey: 'test',
    })
    await db.insert(machineBoxes).values({ sandboxId, machineId, unixUser: 'ficus', port: 45000 })
    await db.insert(vmBoxSetupStates).values({
      sandboxId,
      desiredFingerprint: 'generation-two',
      readiness: 'pending',
      pendingInvocationId: 'stable-id',
      pendingInvocationKind: 'git',
    })

    expect(await clearVmSetupPendingInvocation(sandboxId, 'generation-one', 'stable-id')).toBe(false)
    expect(
      (await db.select().from(vmBoxSetupStates).where(eq(vmBoxSetupStates.sandboxId, sandboxId)))[0].pendingInvocationId
    ).toBe('stable-id')
  })

  test('restores the exact pre-asset degraded backoff after a successful refresh', async () => {
    await db.delete(vmBoxSetupStates).where(eq(vmBoxSetupStates.sandboxId, sandboxId))
    await db.delete(machineBoxes).where(eq(machineBoxes.sandboxId, sandboxId))
    await db.delete(machines).where(eq(machines.id, machineId))
    await db.insert(machines).values({
      id: machineId,
      name: `test-${machineId}`,
      provider: 'ssh',
      sshHost: '127.0.0.1',
      sshUser: 'ficus',
      sshKeyId: 'test',
      sshPublicKey: 'test',
    })
    await db.insert(machineBoxes).values({ sandboxId, machineId, unixUser: 'ficus', port: 45000 })
    const prior = {
      sandboxId,
      desiredFingerprint: 'same',
      readiness: 'ready_degraded' as const,
      reasons: ['devbox_unavailable' as const],
      attemptCount: 2,
      nextAttemptAt: new Date(60_000),
      pendingInvocationId: null,
      pendingInvocationKind: null,
      lastFailureClass: 'socket_closed',
      lastAttemptAt: new Date(0),
      updatedAt: new Date(0),
    }
    await db.insert(vmBoxSetupStates).values(prior)
    expect(await markVmSetupPending(sandboxId, 'same')).toBe(true)
    expect(await restoreVmSetupAfterRequiredAssets(sandboxId, 'same', prior)).toBe(true)
    const restored = (await db.select().from(vmBoxSetupStates).where(eq(vmBoxSetupStates.sandboxId, sandboxId)))[0]
    expect(restored).toMatchObject({
      readiness: 'ready_degraded',
      reasons: ['devbox_unavailable'],
      attemptCount: 2,
      nextAttemptAt: new Date(60_000),
    })
  })

  test('does not emit status for an unchanged setup fingerprint', async () => {
    await db.delete(vmBoxSetupStates).where(eq(vmBoxSetupStates.sandboxId, sandboxId))
    await db.delete(machineBoxes).where(eq(machineBoxes.sandboxId, sandboxId))
    await db.delete(machines).where(eq(machines.id, machineId))
    await db.insert(machines).values({
      id: machineId,
      name: `test-${machineId}`,
      provider: 'ssh',
      sshHost: '127.0.0.1',
      sshUser: 'ficus',
      sshKeyId: 'test',
      sshPublicKey: 'test',
    })
    await db.insert(machineBoxes).values({ sandboxId, machineId, unixUser: 'ficus', port: 45000 })
    await ensureVmSetupFingerprint(sandboxId, 'unchanged')
    const events: string[] = []
    const unsubscribe = eventEmitter.on('sandbox.status', ({ sandboxId: changed }) => events.push(changed))
    try {
      await ensureVmSetupFingerprint(sandboxId, 'unchanged')
    } finally {
      unsubscribe()
    }
    expect(events).toEqual([])
  })

  test('serializes same-sandbox reconciliation leases', async () => {
    const events: string[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const first = withVmSetupLease('lease-test', async () => {
      events.push('first-enter')
      await gate
      events.push('first-exit')
    })
    while (!events.length) await Bun.sleep(1)
    const second = withVmSetupLease('lease-test', async () => {
      events.push('second-enter')
    })
    await Bun.sleep(10)
    expect(events).toEqual(['first-enter'])
    release()
    await Promise.all([first, second])
    expect(events).toEqual(['first-enter', 'first-exit', 'second-enter'])
  })
})
