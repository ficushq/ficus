import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { createBlankWorkflow, createWorkflowRun, resolveWorkflow } from '@ficus/shared'
import { and, eq, inArray, sql } from 'drizzle-orm'
import {
  db,
  agents,
  agentTypes,
  agentExtraScopes,
  inbox,
  messages,
  recoveryEpisodes,
  slotClaims,
  slotPools,
  squads,
  workStreamFlowRuns,
  workStreams,
} from '../../db'
import { Agent } from '../../entities/Agent'
import { AgentType } from '../../entities/AgentType'
import { Execution } from '../../entities/Execution'
import { Squad } from '../../entities/Squad'
import type { WorkStream } from '../../entities/WorkStream'
import { storedLegacyWorkStream } from '../../test-utils/stored-legacy-work-stream'
import { createTestAdmin, cleanupTestRbac } from '../../test-utils'
import { attachAdmissionEffectPhase } from '../maintenance/admission-reservation'
import { PROCESS_RESTART_NOTICE } from './startup-recovery'
import { findResumedRunObligations } from './resumed-run-failure'

const prefix = `resumed-run-${crypto.randomUUID()}`
let squad: Squad
let worker: Agent
let stream: WorkStream
let ownerId: string

/** The exact errors and classifications recorded for the 0.5.23 and 0.5.24 executions. */
const LOST_BASH_OUTCOME = 'Bash invocation outcome is unknown: the stream ended before an exit code'
const SANDBOX_ENSURE = { failureClass: 'platform_pre_tool_refusal', failureReason: 'phase_sandbox-ensure' } as const
const BOX_PROVISION_EXIT_3 =
  'box-provision failed for agent_fixture (exit 3): this machine or box predates the finalized Ficus layout'

beforeEach(async () => {
  const owner = await createTestAdmin({ prefix })
  ownerId = owner.id
  await AgentType.upsert({ id: prefix, name: 'Resumed run fixture', model: 'test:model', systemPrompt: 'test' })
  squad = await Squad.create({ name: `${prefix}-${crypto.randomUUID()}`, purpose: 'test' })
  await db
    .insert(agentExtraScopes)
    .values(['workstreams:respond', 'agents:run'].map((permission) => ({ agentId: squad.managerAgentId!, permission })))
  worker = await Agent.create({ agentTypeId: prefix, squadId: squad.id })
  stream = await storedLegacyWorkStream({
    squadId: squad.id,
    title: 'Resumed run fixture',
    assigneeAgentId: worker.id,
    agentIds: [worker.id],
    requestingUserId: ownerId,
  })
})

afterEach(async () => {
  if (squad) {
    const pools = await db.select({ id: slotPools.id }).from(slotPools).where(eq(slotPools.squadId, squad.id))
    if (pools.length)
      await db.delete(slotClaims).where(
        inArray(
          slotClaims.poolId,
          pools.map((pool) => pool.id)
        )
      )
    const squadAgents = await db.select({ id: agents.id }).from(agents).where(eq(agents.squadId, squad.id))
    const agentIds = squadAgents.map((agent) => agent.id)
    if (agentIds.length) {
      await db.delete(inbox).where(inArray(inbox.recipientId, agentIds))
      await db.delete(recoveryEpisodes).where(inArray(recoveryEpisodes.agentId, agentIds))
    }
    await db.delete(inbox).where(eq(inbox.recipientId, ownerId))
    await db.delete(workStreams).where(eq(workStreams.squadId, squad.id))
    await db.delete(agents).where(eq(agents.squadId, squad.id))
    await db.delete(squads).where(eq(squads.id, squad.id))
  }
  await db.delete(agentTypes).where(eq(agentTypes.id, prefix))
  await cleanupTestRbac(prefix)
})

async function holdSlot(): Promise<string> {
  const [pool] = await db
    .insert(slotPools)
    .values({ squadId: squad.id, key: 'production-change', capacity: 1, createdBy: 'system' })
    .returning()
  const [claim] = await db
    .insert(slotClaims)
    .values({ poolId: pool!.id, ownerAgentId: worker.id, expiresAt: new Date(Date.now() + 60 * 60_000) })
    .returning()
  return claim!.id
}

/**
 * The durable marker every platform resume commits with its requeue
 * (startup-recovery.ts `recoverExecutions`): a graceful worker stop carries a
 * restart context (0.5.24), a crash or lease sweep does not (0.5.23).
 */
async function markResumed(executionId: string, kind: 'worker-restart' | 'unknown-interruption') {
  await db.insert(messages).values({
    agentId: worker.id,
    role: 'assistant',
    content:
      kind === 'worker-restart'
        ? '[System] Paused for a restart; it will resume automatically.'
        : PROCESS_RESTART_NOTICE,
    metadata: {
      isSystem: true,
      admissionRecoveryExecutionId: executionId,
      executionId,
      ...(kind === 'worker-restart'
        ? { restart: { restartId: crypto.randomUUID(), restartedAt: new Date().toISOString() }, restartPhase: 'pause' }
        : {}),
    },
  })
}

async function resumedExecution(kind: 'worker-restart' | 'unknown-interruption'): Promise<Execution> {
  const active = await worker.getActiveExecution()
  const queued = active ? await Execution.mustFind(active.id) : await worker.queueExecution({ message: 'Ship it' })
  await markResumed(queued.id, kind)
  expect(await queued.start()).toBe(true)
  return queued
}

async function workerInbox() {
  return db.select().from(inbox).where(eq(inbox.recipientId, worker.id)).orderBy(inbox.createdAt)
}

async function strandedNotices() {
  return db
    .select()
    .from(inbox)
    .where(sql`${inbox.metadata}->>'source' = 'resumed-run-stranded'`)
}

test('0.5.24 shape: a resumed run that fails box provisioning re-wakes the slot holder with an unknown-outcome brief', async () => {
  const claimId = await holdSlot()
  const execution = await resumedExecution('worker-restart')
  const runners = await import('../../entities/agent-runners')
  const runner = spyOn(runners, 'createRunner').mockRejectedValue(
    attachAdmissionEffectPhase(new Error(BOX_PROVISION_EXIT_3), 'sandbox-drift-recreate')
  )
  try {
    await execution.run()
  } finally {
    runner.mockRestore()
  }
  const failed = await Execution.mustFind(execution.id)
  expect(failed.status).toBe('failed')
  expect(failed.failureReason).toBe('phase_sandbox-drift-recreate')

  const [wake] = await workerInbox()
  expect(wake?.subject).toBe('Your resumed run failed: inspect state before continuing')
  expect(wake?.metadata).toMatchObject({ wakeEligible: true })
  expect(wake?.content).toContain(`resumed execution ${execution.id} then failed`)
  expect(wake?.content).toContain('outcome of what was running when it stopped is unknown')
  expect(wake?.content).toContain(`Slot claim ${claimId} on pool production-change`)
  // Not the replay-safe startup retry: the interrupted segment may have had effects.
  expect(wake?.content).not.toContain('Retained request')
  const [record] = await db.select().from(recoveryEpisodes).where(eq(recoveryEpisodes.agentId, worker.id))
  expect(record!.state).toMatchObject({ state: 'recovering', failures: 1, startupOnly: false })

  // The wake was delivered: the agent has a new run, and nobody else was paged.
  const next = await worker.getActiveExecution()
  expect(next).not.toBeNull()
  expect(next!.id).not.toBe(execution.id)
  expect(await strandedNotices()).toHaveLength(0)
}, 15000)

test('0.5.23 shape: a resumed run that loses a bash outcome in sandbox ensure re-wakes, and the woken run cannot re-wake itself', async () => {
  const claimId = await holdSlot()
  const execution = await resumedExecution('unknown-interruption')
  await execution.fail(LOST_BASH_OUTCOME, undefined, SANDBOX_ENSURE)

  let mail = await workerInbox()
  expect(mail).toHaveLength(1)
  expect(mail[0]!.content).toContain(LOST_BASH_OUTCOME)
  expect(mail[0]!.content).toContain(claimId)

  // The woken run is an ordinary run, not a platform resume. Its failure is
  // counted against the same budget but never wakes the agent again.
  const woken = await Execution.mustFind((await worker.getActiveExecution())!.id)
  expect(await woken.start()).toBe(true)
  await woken.fail(LOST_BASH_OUTCOME, undefined, SANDBOX_ENSURE)
  mail = await workerInbox()
  expect(mail.filter((row) => row.subject?.startsWith('Your resumed run failed'))).toHaveLength(1)
  expect(await worker.getActiveExecution()).toBeNull()
  const [record] = await db.select().from(recoveryEpisodes).where(eq(recoveryEpisodes.agentId, worker.id))
  expect(record!.state.failures).toBe(2)
}, 15000)

test('a run that was not resumed keeps the existing behavior: no wake and no notice', async () => {
  await holdSlot()
  const execution = await worker.queueExecution({ message: 'Ship it' })
  expect(await execution.start()).toBe(true)
  await execution.fail(LOST_BASH_OUTCOME, undefined, SANDBOX_ENSURE)
  expect(await workerInbox()).toHaveLength(0)
  expect(await strandedNotices()).toHaveLength(0)
  expect(await worker.getActiveExecution()).toBeNull()
})

test('a resumed run without a slot or attempt that fails mid-turn is not woken', async () => {
  const execution = await resumedExecution('unknown-interruption')
  await execution.fail(LOST_BASH_OUTCOME, undefined, SANDBOX_ENSURE)
  expect(await workerInbox()).toHaveLength(0)
  expect(await strandedNotices()).toHaveLength(0)
})

test('a resumed run without obligations that fails at startup retries with the unknown-outcome brief, not a replay', async () => {
  const execution = await resumedExecution('worker-restart')
  await execution.fail(BOX_PROVISION_EXIT_3, undefined, SANDBOX_ENSURE, { safeStartupRetry: true })
  const [wake] = await workerInbox()
  expect(wake?.content).toContain('outcome of what was running when it stopped is unknown')
  expect(wake?.content).not.toContain('Retained request')
  expect(wake?.content).not.toContain('You still hold')
})

test('a resumed run that owns a running flow attempt is woken with the attempt identifiers', async () => {
  const definition = createBlankWorkflow()
  await db.insert(workStreamFlowRuns).values({
    workStreamId: stream.id,
    activated: true,
    state: createWorkflowRun(definition),
    source: resolveWorkflow({ kind: 'inline', definition }),
    attemptAgents: { '1': worker.id },
    createRequestId: crypto.randomUUID(),
    createRequestHash: 'test',
    createdBy: 'test',
  })
  const obligations = await findResumedRunObligations(worker.id)
  expect(obligations.slotClaims).toEqual([])
  expect(obligations.attempts).toEqual([
    { workStreamId: stream.id, workStreamNumber: stream.number, attemptId: 1, stepId: definition.steps[0]!.id },
  ])
  const execution = await resumedExecution('unknown-interruption')
  await execution.fail(LOST_BASH_OUTCOME, undefined, SANDBOX_ENSURE)
  const [wake] = await workerInbox()
  expect(wake?.content).toContain(`Work stream ${stream.number} (${stream.id}), flow attempt 1`)
})

test('an explained failure is not retried automatically; the manager is told the claim identifier', async () => {
  const claimId = await holdSlot()
  const execution = await resumedExecution('worker-restart')
  await execution.fail('Provider transport failed', undefined, {
    failureClass: 'provider_transport',
    failureReason: 'transport',
  })
  expect((await workerInbox()).filter((row) => row.senderType === 'system')).toHaveLength(0)
  const [notice] = await strandedNotices()
  expect(notice?.recipientId).toBe(squad.managerAgentId!)
  expect(notice?.metadata).toMatchObject({ wakeEligible: true })
  expect(notice?.metadata).toMatchObject({ reason: 'not-counted', slotClaimIds: [claimId], agentId: worker.id })
  expect(notice?.content).toContain(`Slot claim ${claimId}`)
  expect(notice?.content).toContain(`resumed execution ${execution.id} failed`)
})

test('a paused stream is not bypassed: the wake waits and the manager is told instead', async () => {
  const claimId = await holdSlot()
  const queued = await worker.queueExecution({ message: 'Ship it' })
  await db
    .update(workStreams)
    .set({
      pause: {
        id: crypto.randomUUID(),
        pausedAt: new Date().toISOString(),
        reason: 'test',
        parkAt: null,
        agentIds: [worker.id],
      },
    })
    .where(eq(workStreams.id, stream.id))
  const execution = await resumedExecution('worker-restart')
  expect(execution.id).toBe(queued.id)
  await execution.fail(LOST_BASH_OUTCOME, undefined, SANDBOX_ENSURE)
  expect(await worker.getActiveExecution()).toBeNull()
  // The bounded wake is still recorded and is delivered after an explicit resume.
  expect((await workerInbox()).filter((row) => row.subject?.startsWith('Your resumed run failed'))).toHaveLength(1)
  const [notice] = await strandedNotices()
  expect(notice?.metadata).toMatchObject({ reason: 'not-deliverable', slotClaimIds: [claimId] })
})

test('repeated resumed failures stop at the recovery budget and hand the claim to the manager', async () => {
  const claimId = await holdSlot()
  for (let attempt = 1; attempt <= 3; attempt++) {
    const execution = await resumedExecution('worker-restart')
    await execution.fail(LOST_BASH_OUTCOME, undefined, SANDBOX_ENSURE)
    const wakes = (await workerInbox()).filter((row) => row.subject?.startsWith('Your resumed run failed'))
    expect(wakes).toHaveLength(Math.min(attempt, 2))
  }
  const [record] = await db.select().from(recoveryEpisodes).where(eq(recoveryEpisodes.agentId, worker.id))
  expect(record!.state.state).toBe('waiting-manager')
  expect(await worker.getActiveExecution()).toBeNull()
  const notices = await strandedNotices()
  expect(notices).toHaveLength(1)
  expect(notices[0]!.recipientId).toBe(squad.managerAgentId!)
  expect(notices[0]!.metadata).toMatchObject({
    reason: 'recovery-held',
    recoveryId: record!.id,
    slotClaimIds: [claimId],
  })
  // The generated Continue / Stop decision still reaches the manager as before.
  const decision = await db
    .select()
    .from(inbox)
    .where(
      and(
        eq(inbox.recipientId, squad.managerAgentId!),
        sql`${inbox.metadata}->>'source' = 'recovery-decision-required'`
      )
    )
  expect(decision).toHaveLength(1)
}, 20000)

test('an owner-escalated recovery routes the stranded notice to the owner, not the manager', async () => {
  const claimId = await holdSlot()
  const { decideRecovery } = await import('../recovery/store')
  const fail = async () => {
    const execution = await resumedExecution('worker-restart')
    await execution.fail(LOST_BASH_OUTCOME, undefined, SANDBOX_ENSURE)
    return execution
  }
  for (let attempt = 1; attempt <= 3; attempt++) await fail()
  let [record] = await db.select().from(recoveryEpisodes).where(eq(recoveryEpisodes.agentId, worker.id))
  expect(record!.state.state).toBe('waiting-manager')
  // The manager spends its one extra cycle; the next exhaustion escalates to the owner.
  await decideRecovery(
    record!.id,
    { action: 'continue', expectedVersion: record!.version },
    { agentId: squad.managerAgentId! }
  )
  let last!: Execution
  for (let attempt = 1; attempt <= 3; attempt++) last = await fail()
  ;[record] = await db.select().from(recoveryEpisodes).where(eq(recoveryEpisodes.agentId, worker.id))
  expect(record!.state).toMatchObject({ state: 'waiting-owner', ownerEscalated: true })
  const notices = await db
    .select()
    .from(inbox)
    .where(
      and(
        sql`${inbox.metadata}->>'source' = 'resumed-run-stranded'`,
        sql`${inbox.metadata}->>'executionId' = ${last.id}`
      )
    )
  expect(notices).toHaveLength(1)
  expect(notices[0]).toMatchObject({ recipientType: 'user', recipientId: ownerId })
  expect(notices[0]!.metadata).toMatchObject({
    reason: 'recovery-held',
    recoveryId: record!.id,
    slotClaimIds: [claimId],
  })
}, 30000)

test('with no eligible manager or owner the stranded notice becomes a durable system diagnostic', async () => {
  const claimId = await holdSlot()
  await db.update(squads).set({ managerAgentId: null }).where(eq(squads.id, squad.id))
  const permissions = await import('../rbac/permissions')
  const permission = spyOn(permissions, 'hasUserPermissionWithExecutor').mockResolvedValue(false)
  let executionId: string | undefined
  try {
    const execution = await resumedExecution('worker-restart')
    executionId = execution.id
    await execution.fail('Provider transport failed', undefined, {
      failureClass: 'provider_transport',
      failureReason: 'transport',
    })
    expect(await strandedNotices()).toHaveLength(0)
    const diagnostics = await db
      .select()
      .from(inbox)
      .where(eq(inbox.idempotencyKey, `resumed-run-stranded-unroutable:${execution.id}`))
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]).toMatchObject({ recipientType: 'system', senderType: 'system' })
    expect(diagnostics[0]!.metadata).toMatchObject({
      source: 'resumed-run-stranded-unroutable',
      reason: 'not-counted',
      slotClaimIds: [claimId],
    })
    expect(diagnostics[0]!.content).toContain(`Slot claim ${claimId}`)
  } finally {
    permission.mockRestore()
    if (executionId)
      await db.delete(inbox).where(eq(inbox.idempotencyKey, `resumed-run-stranded-unroutable:${executionId}`))
  }
})
