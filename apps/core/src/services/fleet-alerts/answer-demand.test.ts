import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createBlankWorkflow, createWorkflowRun, resolveWorkflow, SYSTEM_RECIPIENT_ID } from '@ficus/shared'
import { and, eq, inArray, like } from 'drizzle-orm'
import { db } from '../../db'
import {
  agents,
  agentTypes,
  agentQuestions,
  executions,
  inbox,
  squads,
  workStreams,
  workStreamFlowRuns,
  workflowBindings,
  fleetIncidents,
  fleetIncidentNotifications,
  users,
} from '../../db/schema'
import { listActionableAgentQuestions } from '../agents/questions'
import { reconcileQuestionAnswerDeliveriesOnce } from '../agents/question-answer-delivery'
import { ensureQuestionDeliveryFailureAlert } from '../agents/question-delivery-failure-alert'
import { FLOW_WAIT_SUPERSEDED_MESSAGE } from '../work-streams/wait-scope'
import { isCurrentFlowMessage } from '../workflows/execution'
import { getSquadDemandSnapshots } from './demand'
import { reconcileDeadFleet } from './dead-fleet'

const START = new Date('2026-08-18T12:00:00Z')
const at = (minutes: number) => new Date(START.getTime() + minutes * 60_000)
const NOW = at(90)

/**
 * A saved answer is delivered only by the answer-delivery protocol, never by the ordinary inbox
 * batch. These fixtures reproduce the shape behind a false stall alert: the delivery participant
 * asked whether to merge, the stream then finished (its flow run stays completion-ready), and the
 * answer's inbox row stayed unread for an idle agent.
 */
describe('question answers as squad demand', () => {
  let squadId: string
  let agentId: string
  let agentTypeId: string
  let streamId: string
  let questionId: string
  let userId: string

  beforeEach(async () => {
    agentTypeId = `answer-demand-${crypto.randomUUID()}`
    const [agentType] = await db
      .insert(agentTypes)
      .values({
        id: agentTypeId,
        name: 'Answer demand worker',
        model: 'anthropic:claude-sonnet-4-5',
        systemPrompt: 'x',
      })
      .returning()
    const [squad] = await db
      .insert(squads)
      .values({ name: 'Answer demand fixture', purpose: 'Answer lifecycle', status: 'active' })
      .returning()
    squadId = squad!.id
    const [owner] = await db.insert(agents).values({ squadId, agentTypeId, status: 'idle' }).returning()
    agentId = owner!.id
    const [human] = await db
      .insert(users)
      .values({ email: `answer-demand-${crypto.randomUUID()}@example.invalid`, displayName: 'Fixture respondent' })
      .returning()
    userId = human!.id
    const [stream] = await db
      .insert(workStreams)
      .values({
        squadId,
        title: 'Merge after approval',
        status: 'active',
        assigneeAgentId: agentId,
        agentIds: [agentId],
        createdAt: START,
      })
      .returning()
    streamId = stream!.id
    // The agent's attempt is completed and the flow is completion-ready, so the agent is the
    // delivery participant. Review-approval completion keeps the stream itself out of the
    // demand count, isolating the answer.
    const definition = createBlankWorkflow()
    definition.completion = { mode: 'review-approval' }
    const state = createWorkflowRun(definition)
    state.status = 'completion-ready'
    state.attempts[0]!.status = 'completed'
    state.attempts[0]!.outcome = 'completed'
    await db.insert(workStreamFlowRuns).values({
      workStreamId: streamId,
      activated: true,
      state,
      source: resolveWorkflow({ kind: 'inline', definition }),
      attemptAgents: { '1': agentId },
      createRequestId: crypto.randomUUID(),
      createRequestHash: 'test',
      createdBy: 'test',
      createdAt: START,
      updatedAt: START,
    })
    await db.insert(workflowBindings).values({
      agentId,
      workStreamId: streamId,
      participantId: Object.keys(definition.participants)[0]!,
      bindingKey: crypto.randomUUID(),
      agentSnapshot: agentType!,
    })
    const [origin] = await db
      .insert(executions)
      .values({
        agentId,
        status: 'completed',
        startedAt: START,
        runStartedAt: START,
        endedAt: at(1),
        flowContext: { workStreamId: streamId, attemptId: 1, stepId: definition.steps[0]!.id },
      })
      .returning()
    const [question] = await db
      .insert(agentQuestions)
      .values({
        agentId,
        squadId,
        executionId: origin!.id,
        questionData: { questions: [{ id: 'merge', type: 'text', question: 'Should I merge once CI passes?' }] },
        status: 'answered',
        answer: 'Yes, merge it.',
        answeredByUserId: userId,
        answeredAt: at(2),
        answerDeliveryStatus: 'pending',
        answerDeliveryNextAttemptAt: at(2),
      })
      .returning()
    questionId = question!.id
  })

  afterEach(async () => {
    await db.delete(inbox).where(like(inbox.idempotencyKey, `agent-question-delivery-failure:v1:${questionId}:%`))
    const incidents = await db.select().from(fleetIncidents).where(eq(fleetIncidents.squadId, squadId))
    for (const incident of incidents)
      await db.delete(inbox).where(like(inbox.idempotencyKey, `fleet-incident:${incident.id}:%`))
    if (incidents.length) {
      const ids = incidents.map((row) => row.id)
      await db.delete(fleetIncidentNotifications).where(inArray(fleetIncidentNotifications.incidentId, ids))
      await db.delete(fleetIncidents).where(inArray(fleetIncidents.id, ids))
    }
    await db.delete(inbox).where(eq(inbox.recipientId, agentId))
    await db.delete(squads).where(eq(squads.id, squadId))
    await db.delete(agentTypes).where(eq(agentTypes.id, agentTypeId))
    await db.delete(users).where(eq(users.id, userId))
  })

  async function observe(now = NOW) {
    const snapshot = (await getSquadDemandSnapshots({ now })).get(squadId)!
    await reconcileDeadFleet({ now, demand: new Map([[squadId, snapshot]]) })
    const incidents = await db.select().from(fleetIncidents).where(eq(fleetIncidents.squadId, squadId))
    const alerts = incidents.length
      ? await db
          .select()
          .from(fleetIncidentNotifications)
          .where(
            and(
              inArray(
                fleetIncidentNotifications.incidentId,
                incidents.map((row) => row.id)
              ),
              eq(fleetIncidentNotifications.kind, 'alert')
            )
          )
      : []
    return { snapshot, incidents, alerts }
  }

  /** The durable answer row exactly as the delivery protocol persists it before sending. */
  async function persistedAnswer() {
    const [row] = await db
      .insert(inbox)
      .values({
        recipientType: 'agent',
        recipientId: agentId,
        senderType: 'user',
        senderId: userId,
        subject: 'Answer to your question',
        content: '**Question:** Should I merge once CI passes?\n\n**Answer:** Yes, merge it.',
        deliveryMode: 'steer',
        metadata: { source: 'agent-question-answer', questionId },
        idempotencyKey: `agent-question-answer:v1:${questionId}`,
        createdAt: START,
      })
      .returning()
    return row!
  }

  async function setDelivery(status: 'pending' | 'failed', lastError: string | null = null) {
    await db
      .update(agentQuestions)
      .set({
        answerDeliveryStatus: status,
        // A future retry keeps a pending delivery out of this fixture's sweep; it is still owed.
        answerDeliveryNextAttemptAt: status === 'pending' ? at(24 * 60) : null,
        answerDeliveryAttemptCount: 1,
        answerDeliveryLastError: lastError,
      })
      .where(eq(agentQuestions.id, questionId))
  }

  async function finishStream() {
    // Finishing records done on the stream and leaves the flow run completion-ready.
    await db.update(workStreams).set({ status: 'done' }).where(eq(workStreams.id, streamId))
  }

  test('a genuinely undelivered answer for the idle delivery participant still alerts', async () => {
    const answer = await persistedAnswer()
    await setDelivery('pending', 'Agent.sendMessage returned success=false (busy)')
    expect(await isCurrentFlowMessage(answer)).toBe(true)
    expect((await observe(at(29))).alerts).toEqual([])
    const stuck = await observe()
    expect(stuck.snapshot).toMatchObject({ count: 1, agentIds: [agentId], unservedSince: START })
    expect(stuck.alerts.length).toBeGreaterThan(0)
  })

  test('the exact reported shape: a superseded answer for a finished stream and an idle agent is not demand', async () => {
    const answer = await persistedAnswer()
    await setDelivery('failed', FLOW_WAIT_SUPERSEDED_MESSAGE)
    await finishStream()
    expect(await isCurrentFlowMessage(answer)).toBe(false)
    const result = await observe()
    expect(result.snapshot.count).toBe(0)
    expect(result.incidents).toEqual([])
    // History is retained untouched: the row stays unread and undelivered.
    const [kept] = await db.select().from(inbox).where(eq(inbox.id, answer.id))
    expect(kept!.readAt).toBeNull()
    expect(kept!.deliveredAt).toBeNull()
  })

  test('an answer saved before the stream finishes is settled as superseded, not delivered or lost', async () => {
    const result = await reconcileQuestionAnswerDeliveriesOnce({
      now: NOW,
      questionId,
      testHooks: {
        afterInboxPersisted: async () => {
          await db
            .update(inbox)
            .set({ createdAt: START })
            .where(eq(inbox.idempotencyKey, `agent-question-answer:v1:${questionId}`))
          // While delivery is still owed to the current delivery participant, it is demand.
          expect((await observe()).snapshot.count).toBe(1)
          await finishStream()
          // The stream is done: the answer no longer belongs to any current attempt.
          expect((await observe()).snapshot.count).toBe(0)
        },
      },
    })
    expect(result.failed).toBe(1)
    const [question] = await db.select().from(agentQuestions).where(eq(agentQuestions.id, questionId))
    expect(question!.answerDeliveryStatus).toBe('failed')
    expect(question!.answerDeliveryLastError).toBe(FLOW_WAIT_SUPERSEDED_MESSAGE)
    // No execution was queued for the finished work.
    expect(
      await db
        .select()
        .from(executions)
        .where(and(eq(executions.agentId, agentId), eq(executions.status, 'queued')))
    ).toEqual([])
    // Not silently lost: the answer stays actionable in the Action Center and an operator alert
    // explains that the attempt was replaced and how to pass the answer on.
    expect((await listActionableAgentQuestions()).map((row) => row.id)).toContain(questionId)
    expect(await ensureQuestionDeliveryFailureAlert(questionId)).toBe(true)
    const [alert] = await db
      .select()
      .from(inbox)
      .where(like(inbox.idempotencyKey, `agent-question-delivery-failure:v1:${questionId}:%`))
    expect(alert).toMatchObject({ recipientId: SYSTEM_RECIPIENT_ID })
    expect(alert!.content).toContain('was replaced before the answer arrived')
    // The incident raised while delivery was owed resolved once the stream finished; this is how
    // an existing alert for such an answer clears after deployment.
    const observed = await observe()
    expect(observed.snapshot.count).toBe(0)
    expect(observed.incidents).toHaveLength(1)
    expect(observed.incidents[0]!.resolvedAt).toEqual(NOW)
  })

  test('a terminal delivery failure for a still-current attempt is surfaced by its own alert, not as a stall', async () => {
    const answer = await persistedAnswer()
    await setDelivery('failed', 'Agent.sendMessage returned success=false (busy)')
    // The attempt is still current; only the delivery protocol has given up.
    expect(await isCurrentFlowMessage(answer)).toBe(true)
    const result = await observe()
    expect(result.snapshot.count).toBe(0)
    expect(result.incidents).toEqual([])
    expect((await listActionableAgentQuestions()).map((row) => row.id)).toContain(questionId)
  })

  test.each([
    ['dormant', 'pending', 1],
    ['dormant', 'failed', 0],
  ] as const)('a %s agent with a %s answer counts as %d demand', async (status, delivery, count) => {
    await db.update(agents).set({ status }).where(eq(agents.id, agentId))
    await persistedAnswer()
    await setDelivery(delivery, delivery === 'failed' ? FLOW_WAIT_SUPERSEDED_MESSAGE : null)
    const result = await observe()
    expect(result.snapshot.count).toBe(count)
    expect(result.alerts.length > 0).toBe(count > 0)
  })

  test('an agent already scheduled for dormancy does not count its pending answer', async () => {
    await db
      .update(agents)
      .set({ pendingDormancyAt: at(1) })
      .where(eq(agents.id, agentId))
    await persistedAnswer()
    await setDelivery('pending')
    expect((await observe()).snapshot.count).toBe(0)
  })
})
