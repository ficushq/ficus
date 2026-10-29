import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { and, eq, inArray, like } from 'drizzle-orm'
import { workflowPresetSchema } from '@ficus/shared'
import {
  db,
  agents,
  agentTypes,
  squads,
  workStreams,
  executions,
  inbox,
  workflowBindings,
  workStreamFlowRuns,
  workStreamContinuations,
  slotPools,
  slotWaiters,
} from '../../db'
import { Agent } from '../../entities/Agent'
import { prepareInboxDelivery } from '../inbox/inboxDelivery'
import { InboxMessage } from '../../entities/InboxMessage'
import { WorkStream } from '../../entities/WorkStream'
import { attachFlow, dispatchFlow, ensureFlowDispatch, advanceFlow, getFlow, isCurrentFlowMessage } from './execution'
import { openWait, closeOpenWaits } from '../work-streams/waits'
import { pauseWorkStream } from '../work-streams/pause'
import { parkWorkStream, promoteEligibleQueuedStreams, runSquadAdmissionMaintenance } from '../work-streams/admission'

const prefix = `readmission-${randomUUID()}`
const agentTypeId = `${prefix}-worker`
const squadIds: string[] = []

beforeAll(async () => {
  await db.insert(agentTypes).values({
    id: agentTypeId,
    name: 'Readmission fixture',
    model: 'anthropic:claude-sonnet-4-5',
    systemPrompt: 'Test worker',
    extraScopes: ['workstreams:respond'],
  })
})
afterAll(async () => {
  for (const squadId of squadIds) {
    const owned = await db.select({ id: agents.id }).from(agents).where(eq(agents.squadId, squadId))
    if (owned.length)
      await db.delete(inbox).where(
        inArray(
          inbox.recipientId,
          owned.map((a) => a.id)
        )
      )
    const pools = await db.select({ id: slotPools.id }).from(slotPools).where(eq(slotPools.squadId, squadId))
    if (pools.length)
      await db.delete(slotWaiters).where(
        inArray(
          slotWaiters.poolId,
          pools.map((p) => p.id)
        )
      )
    await db.delete(slotPools).where(eq(slotPools.squadId, squadId))
    await db.delete(workStreams).where(eq(workStreams.squadId, squadId))
    await db.delete(agents).where(eq(agents.squadId, squadId))
    await db.delete(squads).where(eq(squads.id, squadId))
  }
  await db.delete(agentTypes).where(eq(agentTypes.id, agentTypeId))
})

async function fixture(inline = false, park = true) {
  const definition = workflowPresetSchema.parse(
    Bun.YAML.parse(
      await Bun.file(new URL('../../../../../config/workflows/builder-reviewer.yaml', import.meta.url)).text()
    )
  ).definition
  for (const participant of Object.values(definition.participants)) participant.agentTypeId = agentTypeId
  if (inline && definition.steps[1]?.kind === 'agent') definition.steps[1].participant = 'builder'
  const [squad] = await db
    .insert(squads)
    .values({ name: prefix, purpose: 'Readmission tests', maxConcurrentWorkStreams: 1 })
    .returning()
  squadIds.push(squad!.id)
  const id = await db.transaction(async (tx) => {
    const [stream] = await tx
      .insert(workStreams)
      .values({ squadId: squad!.id, title: prefix, status: 'active', priority: 'low' })
      .returning()
    const run = await attachFlow(tx, stream!, { kind: 'inline', definition })
    await dispatchFlow(tx, stream!, run, [])
    return stream!.id
  })
  // Actual inbox -> Agent.sendMessage -> durable queued execution (no model/box).
  await ensureFlowDispatch(id)
  const initial = (await getFlow(id))!
  const agentId = initial.attemptAgents['1']!
  if (inline) {
    const result = await advanceFlow(
      id,
      {
        action: 'complete',
        expectedVersion: 0,
        attemptId: 1,
        outcome: 'completed',
        evidence: 'First step done',
      },
      randomUUID(),
      { type: 'agent', agentId, squadId: squad!.id }
    )
    expect(result.assignments?.[0]?.attemptId).toBe(2)
  }
  // The worker consumed its assignment and ended its turn at the parking checkpoint.
  await db.update(inbox).set({ readAt: new Date() }).where(eq(inbox.recipientId, agentId))
  await db.update(executions).set({ status: 'completed', endedAt: new Date() }).where(eq(executions.agentId, agentId))
  await db
    .update(workStreamContinuations)
    .set({ normalAttemptCount: 1, transportAttemptCount: 2 })
    .where(eq(workStreamContinuations.workStreamId, id))
  const [competitor] = await db
    .insert(workStreams)
    .values({ squadId: squad!.id, title: prefix, status: 'queued', priority: 'high' })
    .returning()
  if (park) {
    await parkWorkStream(id, { removeSandbox: async () => {} })
    expect((await WorkStream.mustFind(id)).status).toBe('queued')
    expect((await WorkStream.mustFind(competitor!.id)).status).toBe('active')
  }
  return { id, agentId, squadId: squad!.id, competitorId: competitor!.id }
}
async function executionRows(agentId: string) {
  return db.select().from(executions).where(eq(executions.agentId, agentId))
}

for (const inline of [false, true])
  test(`ordinary readmission resumes existing ${inline ? 'inline' : 'inbox'} attempt once`, async () => {
    const { id, agentId, squadId, competitorId } = await fixture(inline)
    const before = (await getFlow(id))!
    const bindings = await db.select().from(workflowBindings).where(eq(workflowBindings.workStreamId, id))
    const [budget] = await db.select().from(workStreamContinuations).where(eq(workStreamContinuations.workStreamId, id))
    expect(await executionRows(agentId)).toHaveLength(1)
    await promoteEligibleQueuedStreams(squadId)
    await ensureFlowDispatch(id)
    expect(await executionRows(agentId)).toHaveLength(1) // finite cap still occupied
    await db.update(workStreams).set({ status: 'done' }).where(eq(workStreams.id, competitorId))
    await promoteEligibleQueuedStreams(squadId)
    expect((await WorkStream.mustFind(id)).status).toBe('active')
    const resumed = await executionRows(agentId)
    expect(resumed).toHaveLength(2)
    expect(resumed.filter((row) => row.status === 'queued')).toHaveLength(1)
    expect(resumed.find((row) => row.status === 'queued')!.flowContext).toEqual({
      workStreamId: id,
      stepId: inline ? 'review' : 'build',
      attemptId: inline ? 2 : 1,
    })
    await Promise.all([promoteEligibleQueuedStreams(squadId), ensureFlowDispatch(id), ensureFlowDispatch(id)])
    expect(await executionRows(agentId)).toHaveLength(2)
    expect((await getFlow(id))!.state).toEqual(before.state)
    expect((await getFlow(id))!.attemptAgents).toEqual(before.attemptAgents)
    expect(await db.select().from(workflowBindings).where(eq(workflowBindings.workStreamId, id))).toEqual(bindings)
    expect(
      await db
        .select()
        .from(inbox)
        .where(like(inbox.idempotencyKey, `flow:${id}:%`))
    ).toHaveLength(1)
    const [afterBudget] = await db
      .select()
      .from(workStreamContinuations)
      .where(eq(workStreamContinuations.workStreamId, id))
    expect(afterBudget).toEqual(budget)
    // Finishing the resumed turn does not make repeated dispatch an automatic idle-nudge loop.
    await db
      .update(executions)
      .set({ status: 'completed', endedAt: new Date() })
      .where(and(eq(executions.agentId, agentId), eq(executions.status, 'queued')))
    await ensureFlowDispatch(id)
    await promoteEligibleQueuedStreams(squadId)
    expect(await executionRows(agentId)).toHaveLength(2)
  })

async function pendingReadmission() {
  const fixtureState = await fixture()
  const { id, squadId, competitorId } = fixtureState
  // Simulate process loss between committed promotion and successful delivery.
  const send = spyOn(Agent.prototype, 'sendMessage').mockRejectedValue(new Error('Injected delivery interruption'))
  try {
    await db.update(workStreams).set({ status: 'done' }).where(eq(workStreams.id, competitorId))
    await promoteEligibleQueuedStreams(squadId)
  } finally {
    send.mockRestore()
  }
  const [intent] = await db
    .select()
    .from(inbox)
    .where(like(inbox.idempotencyKey, `flow-readmission:${id}:%`))
  expect(intent!.deliveredAt).toBeNull()
  return { ...fixtureState, intent: new InboxMessage(intent!) }
}

test('readmission stays pending behind a queued slot and rechecks the slot at acceptance', async () => {
  const { id, agentId, squadId, intent } = await pendingReadmission()
  const [pool] = await db.insert(slotPools).values({ squadId, key: 'held', createdBy: 'test' }).returning()
  const [waiter] = await db.insert(slotWaiters).values({ poolId: pool!.id, ownerAgentId: agentId }).returning()
  await ensureFlowDispatch(id)
  expect(await executionRows(agentId)).toHaveLength(1)
  // Bypass selection to exercise the final send boundary, as if a slot queued
  // after delivery selected the intent but before acceptance acquired its lock.
  const delivery = prepareInboxDelivery([intent], 'steer', 'steer')
  await expect(
    (await Agent.mustFind(agentId)).sendMessage(delivery.prompt, { metadata: delivery.metadata })
  ).rejects.toThrow('slot')
  expect(await executionRows(agentId)).toHaveLength(1)
  await db.update(slotWaiters).set({ status: 'canceled', endedAt: new Date() }).where(eq(slotWaiters.id, waiter!.id))
  await ensureFlowDispatch(id)
  expect(await executionRows(agentId)).toHaveLength(2)
})

// Gate fixtures use the same durable waits consumed by dispatch and final inbox acceptance.
for (const gate of ['human', 'owner', 'provider', 'question', 'dependency', 'review'] as const) {
  test(`readmission preserves the ${gate} gate both before promotion and after commit`, async () => {
    const { id, agentId, squadId, competitorId } = await fixture()
    const waitInput = {
      workStreamId: id,
      type: gate === 'question' || gate === 'dependency' || gate === 'review' ? gate : ('manual' as const),
      actor: gate === 'owner' || gate === 'provider' ? ('owner' as const) : ('human' as const),
      message: `Remaining ${gate} gate`,
    }
    await openWait(db, waitInput)
    await db.update(workStreams).set({ status: 'done' }).where(eq(workStreams.id, competitorId))
    await promoteEligibleQueuedStreams(squadId)
    expect((await WorkStream.mustFind(id)).status).toBe('queued')
    expect(await executionRows(agentId)).toHaveLength(1)
    await closeOpenWaits(db, { workStreamId: id }, 'cleared')
    const send = spyOn(Agent.prototype, 'sendMessage').mockRejectedValue(new Error('Interrupted'))
    try {
      await promoteEligibleQueuedStreams(squadId)
    } finally {
      send.mockRestore()
    }
    const [intent] = await db
      .select()
      .from(inbox)
      .where(like(inbox.idempotencyKey, `flow-readmission:${id}:%`))
    await openWait(db, waitInput)
    await ensureFlowDispatch(id)
    expect(await isCurrentFlowMessage(intent!)).toBe(false)
    const delivery = prepareInboxDelivery([new InboxMessage(intent!)], 'steer', 'steer')
    await expect(
      (await Agent.mustFind(agentId)).sendMessage(delivery.prompt, { metadata: delivery.metadata })
    ).rejects.toThrow('waiting for input')
    expect(await executionRows(agentId)).toHaveLength(1)
    await closeOpenWaits(db, { workStreamId: id }, 'cleared')
    await Promise.all([ensureFlowDispatch(id), ensureFlowDispatch(id)])
    expect(await executionRows(agentId)).toHaveLength(2)
  })
}

test('pending durable readmission retries once after interrupted delivery without another promotion', async () => {
  const { id, agentId, squadId, intent } = await pendingReadmission()
  await Promise.all([ensureFlowDispatch(id), ensureFlowDispatch(id), promoteEligibleQueuedStreams(squadId)])
  expect(await executionRows(agentId)).toHaveLength(2)
  const intents = await db
    .select()
    .from(inbox)
    .where(like(inbox.idempotencyKey, `flow-readmission:${id}:%`))
  expect(intents).toHaveLength(1)
  expect(intents[0]!.id).toBe(intent.id)
  expect(intents[0]!.deliveredAt).not.toBeNull()
})

for (const state of ['queued', 'paused', 'canceled', 'done', 'superseded', 'wrong-agent'] as const) {
  test(`pending readmission fences ${state} identity at selection and final acceptance`, async () => {
    const { id, agentId, intent } = await pendingReadmission()
    if (state === 'paused') await pauseWorkStream(id)
    else if (state === 'superseded') {
      await advanceFlow(
        id,
        { action: 'complete', expectedVersion: 0, attemptId: 1, outcome: 'completed', evidence: 'Superseded' },
        randomUUID(),
        { type: 'legacy' }
      )
    } else if (state === 'wrong-agent') {
      const [other] = await db
        .insert(agents)
        .values({ agentTypeId, squadId: (await WorkStream.mustFind(id)).squadId })
        .returning()
      await db
        .update(workStreamFlowRuns)
        .set({ attemptAgents: { '1': other!.id } })
        .where(eq(workStreamFlowRuns.workStreamId, id))
    } else await db.update(workStreams).set({ status: state }).where(eq(workStreams.id, id))
    expect(await isCurrentFlowMessage(intent)).toBe(false)
    const delivery = prepareInboxDelivery([intent], 'steer', 'steer')
    await expect(
      (await Agent.mustFind(agentId)).sendMessage(delivery.prompt, { metadata: delivery.metadata })
    ).rejects.toThrow()
    await ensureFlowDispatch(id)
    expect(await executionRows(agentId)).toHaveLength(1)
  })
}

test('paused queued work and unmet dependencies never get a promotion wake', async () => {
  const { id, agentId, squadId, competitorId } = await fixture()
  await pauseWorkStream(id)
  await db.update(workStreams).set({ status: 'done' }).where(eq(workStreams.id, competitorId))
  await promoteEligibleQueuedStreams(squadId)
  expect((await WorkStream.mustFind(id)).status).toBe('queued')
  expect(await executionRows(agentId)).toHaveLength(1)
  // Synthetic state: resume cleared the pause but a dependency remains unmet.
  await db
    .update(workStreams)
    .set({ pause: null, dependsOn: [competitorId] })
    .where(eq(workStreams.id, id))
  await db.update(workStreams).set({ status: 'queued' }).where(eq(workStreams.id, competitorId))
  await promoteEligibleQueuedStreams(squadId)
  expect((await WorkStream.mustFind(id)).status).toBe('queued')
  expect(await executionRows(agentId)).toHaveLength(1)
})

test('completion-ready PR-event waiting does not reopen or resume a completed attempt', async () => {
  const { id, agentId, squadId, competitorId } = await fixture(true, false)
  await advanceFlow(
    id,
    { action: 'complete', expectedVersion: 1, attemptId: 2, outcome: 'approved', evidence: 'Reviewed' },
    randomUUID(),
    { type: 'legacy' }
  )
  const before = (await getFlow(id))!
  // PR completion policy waits externally without reopening its delivery participant.
  before.state.definition.completion.mode = 'pr-auto-merge'
  await db.update(workStreamFlowRuns).set({ state: before.state }).where(eq(workStreamFlowRuns.workStreamId, id))
  expect(before.state.status).toBe('completion-ready')
  await parkWorkStream(id, { removeSandbox: async () => {} })
  await db.update(workStreams).set({ status: 'done' }).where(eq(workStreams.id, competitorId))
  await promoteEligibleQueuedStreams(squadId)
  await ensureFlowDispatch(id)
  expect((await getFlow(id))!.state).toEqual(before.state)
  expect(await executionRows(agentId)).toHaveLength(1)
  expect(
    await db
      .select()
      .from(inbox)
      .where(like(inbox.idempotencyKey, `flow-readmission:${id}:%`))
  ).toHaveLength(0)
})

test.each(['queued', 'running', 'stopping'] as const)(
  'readmission does not duplicate a %s execution',
  async (status) => {
    const { id, agentId, intent } = await pendingReadmission()
    await (await Agent.mustFind(agentId)).sendMessage('Already resumed elsewhere')
    const execution = (await executionRows(agentId)).find((row) => row.status === 'queued')!
    await db.update(executions).set({ status }).where(eq(executions.id, execution.id))
    await ensureFlowDispatch(id)
    expect(await executionRows(agentId)).toHaveLength(2)
    const [message] = await db.select().from(inbox).where(eq(inbox.id, intent.id))
    if (status === 'stopping') {
      expect(message!.deliveredAt).toBeNull()
      await db.update(executions).set({ status: 'stopped', endedAt: new Date() }).where(eq(executions.id, execution.id))
      await ensureFlowDispatch(id)
      expect(await executionRows(agentId)).toHaveLength(3)
    } else expect(message!.deliveredAt).not.toBeNull()
  }
)

test('maintenance promotion uses the same durable resume and repeated parking reuses a pending intent', async () => {
  const { id, agentId, squadId, competitorId } = await fixture()
  await db.update(workStreams).set({ status: 'done' }).where(eq(workStreams.id, competitorId))
  const send = spyOn(Agent.prototype, 'sendMessage').mockRejectedValue(new Error('Interrupted'))
  try {
    await runSquadAdmissionMaintenance(squadId, { removeSandbox: async () => {} })
    await parkWorkStream(id, { removeSandbox: async () => {} }) // immediately re-admitted
  } finally {
    send.mockRestore()
  }
  expect(
    await db
      .select()
      .from(inbox)
      .where(like(inbox.idempotencyKey, `flow-readmission:${id}:%`))
  ).toHaveLength(1)
  await ensureFlowDispatch(id)
  expect(await executionRows(agentId)).toHaveLength(2)
})

test('a still-pending original assignment is delivered instead of a duplicate resume', async () => {
  const { id, agentId, squadId, competitorId } = await fixture()
  // Characterize the original assignment's undelivered state, e.g. an initial
  // dispatch interrupted before inbox acceptance, rather than a consumed turn.
  await db
    .update(inbox)
    .set({ deliveredAt: null, readAt: null })
    .where(like(inbox.idempotencyKey, `flow:${id}:%`))
  await db.update(workStreams).set({ status: 'done' }).where(eq(workStreams.id, competitorId))
  await promoteEligibleQueuedStreams(squadId)
  expect(await executionRows(agentId)).toHaveLength(2)
  expect(
    await db
      .select()
      .from(inbox)
      .where(like(inbox.idempotencyKey, `flow-readmission:${id}:%`))
  ).toHaveLength(0)
})
