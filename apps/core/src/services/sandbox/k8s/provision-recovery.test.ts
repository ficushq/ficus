import { afterAll as maintenanceAfterAll, beforeAll as maintenanceBeforeAll } from 'bun:test'
import { acquireMaintenanceTestIsolation } from '../../../test-utils/maintenance-test-isolation'

let releaseMaintenanceIsolation: (() => Promise<void>) | undefined
maintenanceBeforeAll(async () => (releaseMaintenanceIsolation = await acquireMaintenanceTestIsolation()))
maintenanceAfterAll(() => releaseMaintenanceIsolation?.())

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { and, eq, inArray } from 'drizzle-orm'
import { db } from '../../../db'
import {
  agents,
  agentTypes,
  executionAdmissionReservations,
  executions,
  k8sProvisionAttempts,
  k8sProvisionControls,
  sandboxProvisionRecoveries,
} from '../../../db/schema'
import {
  SandboxProvisionRecoveryService,
  startSandboxProvisionRecovery,
  stopSandboxProvisionRecovery,
} from './provision-recovery'
import { listPeriodicRunnerNames, listPeriodicRunners } from '../../../lib/infra/PeriodicRunner'
import { eventEmitter } from '../../../lib/infra/event-emitter'
import { Execution } from '../../../entities/Execution'
import { validateModelSpecList } from '../../../lib/utils/model-spec'

const TEST_MODEL = 'anthropic:claude-sonnet-4-5'
let agentId: string
let typeId: string
let scopeId: string
const now = new Date('2026-08-09T02:00:00Z')

beforeEach(async () => {
  scopeId = crypto.randomUUID()
  typeId = `reconciler-${crypto.randomUUID()}`
  await db.insert(agentTypes).values({ id: typeId, name: 'Recovery', model: TEST_MODEL, systemPrompt: 'test' })
  ;[{ id: agentId }] = await db.insert(agents).values({ agentTypeId: typeId }).returning({ id: agents.id })

  const [fixtureType] = await db.select({ model: agentTypes.model }).from(agentTypes).where(eq(agentTypes.id, typeId))
  expect(() => validateModelSpecList(fixtureType.model)).not.toThrow()
})

afterEach(async () => {
  await stopSandboxProvisionRecovery()
  await db.delete(k8sProvisionAttempts).where(eq(k8sProvisionAttempts.scope, scopeId))
  await db.delete(sandboxProvisionRecoveries).where(eq(sandboxProvisionRecoveries.agentId, agentId))
  await db.delete(executions).where(eq(executions.agentId, agentId))
  await db.delete(agents).where(eq(agents.id, agentId))
  await db.delete(k8sProvisionControls).where(eq(k8sProvisionControls.scope, scopeId))
  await db.delete(agentTypes).where(eq(agentTypes.id, typeId))

  expect(await db.select({ id: agents.id }).from(agents).where(eq(agents.id, agentId))).toEqual([])
  expect(await db.select({ id: agentTypes.id }).from(agentTypes).where(eq(agentTypes.id, typeId))).toEqual([])
  expect(await db.select({ id: executions.id }).from(executions).where(eq(executions.agentId, agentId))).toEqual([])
  expect(
    await db
      .select({ id: sandboxProvisionRecoveries.executionId })
      .from(sandboxProvisionRecoveries)
      .where(eq(sandboxProvisionRecoveries.agentId, agentId))
  ).toEqual([])
  expect(await db.select().from(k8sProvisionAttempts).where(eq(k8sProvisionAttempts.scope, scopeId))).toEqual([])
  expect(await db.select().from(k8sProvisionControls).where(eq(k8sProvisionControls.scope, scopeId))).toEqual([])
})

async function seedWait(options: { deadlineAt?: Date; attemptCount?: number; sandboxKey?: string } = {}) {
  const [{ id: executionId }] = await db
    .insert(executions)
    .values({ agentId, status: 'waiting-sandbox', startedAt: new Date(now.getTime() - 10_000) })
    .returning({ id: executions.id })
  await db.insert(k8sProvisionControls).values({ scope: scopeId, state: 'closed' }).onConflictDoNothing()
  await db.insert(sandboxProvisionRecoveries).values({
    executionId,
    agentId,
    scope: scopeId,
    sandboxKey: options.sandboxKey ?? 'box',
    refusalId: crypto.randomUUID(),
    status: 'waiting',
    errorCode: 'SANDBOX_PROVISION_BUSY',
    attemptCount: options.attemptCount ?? 0,
    nextAttemptAt: new Date(now.getTime() - 1_000),
    deadlineAt: options.deadlineAt ?? new Date(now.getTime() + 60_000),
  })
  return executionId
}

describe('SandboxProvisionRecoveryService', () => {
  test('deduplicates overlapping periodic and transition-hint reconciliation', async () => {
    let release!: () => void
    const blocked = new Promise<void>((resolve) => (release = resolve))
    let claims = 0
    const service = new SandboxProvisionRecoveryService({
      ownerId: 'worker',
      store: {
        claimDue: async () => {
          claims++
          await blocked
          return []
        },
      } as any,
    })

    const first = service.reconcileOnce(now)
    const duplicate = service.reconcileOnce(now)
    release()
    await Promise.all([first, duplicate])
    expect(claims).toBe(1)
  })

  test('registers one idempotent immediate recovery runner and removes its hint listener', async () => {
    const reconcileSpy = spyOn(SandboxProvisionRecoveryService.prototype, 'reconcileOnce').mockResolvedValue(undefined)
    startSandboxProvisionRecovery()
    startSandboxProvisionRecovery()
    expect(listPeriodicRunnerNames().filter((name) => name === 'sandbox-provision-recovery')).toHaveLength(1)

    await stopSandboxProvisionRecovery()
    expect(listPeriodicRunnerNames()).not.toContain('sandbox-provision-recovery')
    const callsAfterStop = reconcileSpy.mock.calls.length
    eventEmitter.emit('sandbox.provision-transition', {
      scopeHash: 'scope',
      from: 'open',
      to: 'closed',
      version: 2,
    })
    expect(reconcileSpy).toHaveBeenCalledTimes(callsAfterStop)
    reconcileSpy.mockRestore()
  })

  test('runs the timer backstop every 30s and does no DB work off the k8s runtime', async () => {
    const reconcileSpy = spyOn(SandboxProvisionRecoveryService.prototype, 'reconcileOnce').mockResolvedValue(undefined)
    const previousRuntime = process.env.FICUS_SANDBOX_RUNTIME
    try {
      // Non-k8s runtime (the tests' default): the tick must not touch the DB.
      delete process.env.FICUS_SANDBOX_RUNTIME
      startSandboxProvisionRecovery()
      const runner = listPeriodicRunners().find((r) => r.runnerName === 'sandbox-provision-recovery')
      expect(runner?.runnerIntervalMs).toBe(30_000)
      expect(reconcileSpy).not.toHaveBeenCalled()
      await stopSandboxProvisionRecovery()

      // k8s runtime: the immediate tick still reconciles.
      process.env.FICUS_SANDBOX_RUNTIME = 'k8s'
      startSandboxProvisionRecovery()
      expect(reconcileSpy).toHaveBeenCalledTimes(1)
    } finally {
      await stopSandboxProvisionRecovery()
      if (previousRuntime === undefined) delete process.env.FICUS_SANDBOX_RUNTIME
      else process.env.FICUS_SANDBOX_RUNTIME = previousRuntime
      reconcileSpy.mockRestore()
    }
  })

  test('replays a durable wait after restart by queueing the same execution', async () => {
    const executionId = await seedWait()
    const service = new SandboxProvisionRecoveryService({ ownerId: 'worker' })

    await service.reconcileOnce(now)

    const [execution] = await db.select().from(executions).where(eq(executions.id, executionId))
    const [recovery] = await db
      .select()
      .from(sandboxProvisionRecoveries)
      .where(eq(sandboxProvisionRecoveries.executionId, executionId))
    expect(execution.status).toBe('queued')
    expect(recovery).toMatchObject({ status: 'resumed', attemptCount: 1 })
    const ownedRecoveries = await db
      .select({ status: sandboxProvisionRecoveries.status })
      .from(sandboxProvisionRecoveries)
      .where(eq(sandboxProvisionRecoveries.agentId, agentId))
    expect(ownedRecoveries.filter((row) => row.status === 'waiting')).toHaveLength(0)
    expect(ownedRecoveries.filter((row) => row.status === 'leased')).toHaveLength(0)

    const diagnostics = await service.getDiagnostics()
    expect(diagnostics.recoveryCounters).toMatchObject({ claimed: 1, resumed: 1 })
  })

  test('keeps one durable open-scope probe reservation until the circuit closes', async () => {
    const first = await seedWait({ sandboxKey: 'first' })
    const second = await seedWait({ sandboxKey: 'second' })
    await db
      .update(k8sProvisionControls)
      .set({ state: 'open', retryAt: now })
      .where(eq(k8sProvisionControls.scope, scopeId))
    const service = new SandboxProvisionRecoveryService({ ownerId: 'worker' })

    await service.reconcileOnce(now)
    await service.reconcileOnce(new Date(now.getTime() + 1_000))
    let rows = await db.select().from(executions).where(eq(executions.agentId, agentId))
    expect(rows.filter((row) => row.status === 'queued')).toHaveLength(1)
    const [probe] = await db
      .select()
      .from(sandboxProvisionRecoveries)
      .where(
        and(
          eq(sandboxProvisionRecoveries.status, 'leased'),
          inArray(sandboxProvisionRecoveries.executionId, [first, second])
        )
      )
    expect(probe).toMatchObject({ claimKind: 'half_open_probe' })

    await db
      .update(k8sProvisionControls)
      .set({ state: 'half_open', retryAt: null })
      .where(eq(k8sProvisionControls.scope, scopeId))
    await service.reconcileOnce(new Date(now.getTime() + 2_000))
    rows = await db.select().from(executions).where(eq(executions.agentId, agentId))
    expect(rows.filter((row) => row.status === 'queued')).toHaveLength(1)

    await db
      .update(k8sProvisionControls)
      .set({ state: 'closed', retryAt: null })
      .where(eq(k8sProvisionControls.scope, scopeId))
    await service.reconcileOnce(new Date(now.getTime() + 3_000))
    rows = await db.select().from(executions).where(eq(executions.agentId, agentId))
    const [queued] = rows.filter((row) => row.status === 'queued')
    const [waiting] = rows.filter((row) => row.status === 'waiting-sandbox')
    expect([queued?.id, waiting?.id].sort()).toEqual([first, second].sort())
    expect(
      await db
        .select()
        .from(executionAdmissionReservations)
        .where(
          and(
            eq(executionAdmissionReservations.agentId, agentId),
            eq(executionAdmissionReservations.executionId, queued!.id)
          )
        )
    ).toMatchObject([{ agentId, executionId: queued!.id, state: 'queued', ownerId: null, token: null }])
    expect((await service.getDiagnostics()).recoveryCounters).toMatchObject({ errors: 0, postponed: 1, resumed: 1 })

    await new Execution(queued!).stop()
    const [retry] = await db
      .select({ nextAttemptAt: sandboxProvisionRecoveries.nextAttemptAt })
      .from(sandboxProvisionRecoveries)
      .where(eq(sandboxProvisionRecoveries.executionId, waiting!.id))
    await service.reconcileOnce(retry!.nextAttemptAt)

    const [resumed] = await db.select().from(executions).where(eq(executions.id, waiting!.id))
    expect(resumed!.status).toBe('queued')
    expect(
      await db
        .select()
        .from(executionAdmissionReservations)
        .where(
          and(
            eq(executionAdmissionReservations.agentId, agentId),
            eq(executionAdmissionReservations.executionId, waiting!.id)
          )
        )
    ).toMatchObject([{ agentId, executionId: waiting!.id, state: 'queued', ownerId: null, token: null }])
  })

  test('cancels a wait instead of waking a terminated agent', async () => {
    const executionId = await seedWait()
    await db.update(agents).set({ status: 'terminated', terminatedAt: now }).where(eq(agents.id, agentId))

    await new SandboxProvisionRecoveryService({ ownerId: 'worker' }).reconcileOnce(now)

    const [execution] = await db.select().from(executions).where(eq(executions.id, executionId))
    const [recovery] = await db
      .select()
      .from(sandboxProvisionRecoveries)
      .where(eq(sandboxProvisionRecoveries.executionId, executionId))
    expect(execution.status).toBe('stopped')
    expect(recovery.status).toBe('cancelled')
  })

  test.each([
    ['closed-to-open', 'closed', 'open'],
    ['open-to-half-open', 'open', 'half_open'],
  ] as const)('postpones rather than cancels a valid wait on %s control race', async (_, initial, raced) => {
    const executionId = await seedWait()
    await db
      .update(k8sProvisionControls)
      .set({ state: initial, retryAt: initial === 'open' ? now : null })
      .where(eq(k8sProvisionControls.scope, scopeId))
    const service = new SandboxProvisionRecoveryService({
      ownerId: 'worker',
      testHooks: {
        beforeProcessLease: async () => {
          await db
            .update(k8sProvisionControls)
            .set({ state: raced, retryAt: raced === 'open' ? new Date(now.getTime() + 30_000) : null })
            .where(eq(k8sProvisionControls.scope, scopeId))
        },
      },
    })

    await service.reconcileOnce(now)

    const [execution] = await db.select().from(executions).where(eq(executions.id, executionId))
    const [recovery] = await db
      .select()
      .from(sandboxProvisionRecoveries)
      .where(eq(sandboxProvisionRecoveries.executionId, executionId))
    expect(execution.status).toBe('waiting-sandbox')
    expect(recovery.status).toBe('waiting')
    expect(recovery.nextAttemptAt.getTime()).toBeGreaterThan(now.getTime())
  })

  test('reopens an expired authoritative half-open probe after restart, then nominates one recovery', async () => {
    const executionId = await seedWait()
    const attemptId = crypto.randomUUID()
    await db.insert(k8sProvisionAttempts).values({
      scope: scopeId,
      sandboxKey: 'probe-box',
      operationKind: 'ensure',
      desiredSpecHash: 'spec',
      attemptId,
      ownerId: 'dead-worker',
      status: 'in_progress',
      leaseExpiresAt: new Date(now.getTime() - 1),
    })
    await db
      .update(k8sProvisionControls)
      .set({ state: 'half_open', probeAttemptId: attemptId, retryAt: null })
      .where(eq(k8sProvisionControls.scope, scopeId))
    const service = new SandboxProvisionRecoveryService({ ownerId: 'worker' })

    await service.reconcileOnce(now)
    const [control] = await db.select().from(k8sProvisionControls).where(eq(k8sProvisionControls.scope, scopeId))
    expect(control.state).toBe('open')
    expect((await db.select().from(executions).where(eq(executions.id, executionId)))[0]?.status).toBe(
      'waiting-sandbox'
    )

    await service.reconcileOnce(control.retryAt!)
    expect((await db.select().from(executions).where(eq(executions.id, executionId)))[0]?.status).toBe('queued')
    const [recovery] = await db
      .select()
      .from(sandboxProvisionRecoveries)
      .where(eq(sandboxProvisionRecoveries.executionId, executionId))
    expect(recovery.claimKind).toBe('half_open_probe')
  })

  test('terminalizes an authoritative permanent authorization failure', async () => {
    const executionId = await seedWait()
    await db
      .update(k8sProvisionControls)
      .set({ state: 'open', retryAt: now, reasonCode: 'cluster_authorization' })
      .where(eq(k8sProvisionControls.scope, scopeId))

    await new SandboxProvisionRecoveryService({ ownerId: 'worker' }).reconcileOnce(now)

    const [execution] = await db.select().from(executions).where(eq(executions.id, executionId))
    const [recovery] = await db
      .select()
      .from(sandboxProvisionRecoveries)
      .where(eq(sandboxProvisionRecoveries.executionId, executionId))
    expect(execution.status).toBe('failed')
    expect(recovery.status).toBe('exhausted')
  })

  test('exhausts a wait at the durable attempt cap', async () => {
    const executionId = await seedWait({ attemptCount: 8 })

    await new SandboxProvisionRecoveryService({ ownerId: 'worker' }).reconcileOnce(now)

    const [execution] = await db.select().from(executions).where(eq(executions.id, executionId))
    const [recovery] = await db
      .select()
      .from(sandboxProvisionRecoveries)
      .where(eq(sandboxProvisionRecoveries.executionId, executionId))
    expect(execution.status).toBe('failed')
    expect(recovery.status).toBe('exhausted')
  })

  test('exhausts a wait after its durable deadline without creating another execution', async () => {
    const executionId = await seedWait({ deadlineAt: new Date(now.getTime() - 1) })

    await new SandboxProvisionRecoveryService({ ownerId: 'worker' }).reconcileOnce(now)

    const rows = await db.select().from(executions).where(eq(executions.agentId, agentId))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toBe(executionId)
    expect(rows[0]?.status).toBe('failed')
    const [recovery] = await db
      .select()
      .from(sandboxProvisionRecoveries)
      .where(eq(sandboxProvisionRecoveries.executionId, executionId))
    expect(recovery.status).toBe('exhausted')
  })
})
