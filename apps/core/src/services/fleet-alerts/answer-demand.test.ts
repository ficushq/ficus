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
import { FLOW_WAIT_STREAM_ENDED_MESSAGES, FLOW_WAIT_SUPERSEDED_MESSAGE } from '../work-streams/wait-scope'
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

  async function replaceAttempt() {
    // A rework: the delivery participant's completed attempt is replaced by a new running one,
    // while the stream itself stays active.
    const [run] = await db.select().from(workStreamFlowRuns).where(eq(workStreamFlowRuns.workStreamId, streamId))
    const state = structuredClone(run!.state)
    state.status = 'running'
    state.attempts.push({ ...state.attempts[0]!, id: 2, status: 'running', outcome: undefined })
    await db.update(workStreamFlowRuns).set({ state }).where(eq(workStreamFlowRuns.workStreamId, streamId))
  }

  test.each([
    {
      ending: 'finishes',
      end: finishStream,
      streamEnds: true,
      lastError: FLOW_WAIT_STREAM_ENDED_MESSAGES.done,
      refusal: 'stream-done',
      alertSays: 'the work stream had already finished when the answer arrived, so it was not delivered to the agent',
    },
    {
      ending: 'is canceled',
      end: () => db.update(workStreams).set({ status: 'canceled' }).where(eq(workStreams.id, streamId)),
      streamEnds: true,
      lastError: FLOW_WAIT_STREAM_ENDED_MESSAGES.canceled,
      refusal: 'stream-canceled',
      alertSays:
        'the work stream had already been canceled when the answer arrived, so it was not delivered to the agent',
    },
  ] as const)(
    'an answer saved before the stream $ending is refused with that cause, not delivered or lost',
    async ({ end, streamEnds, lastError, refusal, alertSays }) => {
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
            await end()
            // The answer no longer belongs to any current attempt. A replacement attempt is new
            // demand of its own, so the count clears only when the stream ends.
            if (streamEnds) expect((await observe()).snapshot.count).toBe(0)
          },
        },
      })
      expect(result.failed).toBe(1)
      const [question] = await db.select().from(agentQuestions).where(eq(agentQuestions.id, questionId))
      expect(question!.answerDeliveryStatus).toBe('failed')
      // The cause is recorded where delivery is refused, under the stream lock.
      expect(question!.answerDeliveryLastError).toBe(lastError)
      // No execution was queued for the agent.
      expect(
        await db
          .select()
          .from(executions)
          .where(and(eq(executions.agentId, agentId), eq(executions.status, 'queued')))
      ).toEqual([])
      // Not silently lost: the answer stays in the Action Center with its cause and no retry, which
      // could only fail the same way, and an operator alert says why it went undelivered.
      const actionable = (await listActionableAgentQuestions()).find((row) => row.id === questionId)
      expect(actionable?.answerDelivery).toMatchObject({ status: 'failed', refusal, canRetry: false })
      expect(await ensureQuestionDeliveryFailureAlert(questionId)).toBe(true)
      const [alert] = await db
        .select()
        .from(inbox)
        .where(like(inbox.idempotencyKey, `agent-question-delivery-failure:v1:${questionId}:%`))
      expect(alert).toMatchObject({ recipientId: SYSTEM_RECIPIENT_ID })
      expect(alert!.content).toContain(alertSays)
      if (!streamEnds) return
      // The incident raised while delivery was owed resolved once the stream ended; this is how an
      // existing alert for such an answer clears after deployment.
      const observed = await observe()
      expect(observed.snapshot.count).toBe(0)
      expect(observed.incidents).toHaveLength(1)
      expect(observed.incidents[0]!.resolvedAt).toEqual(NOW)
    }
  )

  // Regression: an attempt that stops running between routing and acceptance used to refuse the
  // answer as superseded, so it reached nobody. Now delivery routes again and passes it on.
  test('an answer whose attempt is replaced mid-delivery is passed on, not refused', async () => {
    const result = await reconcileQuestionAnswerDeliveriesOnce({
      now: NOW,
      questionId,
      testHooks: { afterInboxPersisted: replaceAttempt },
    })
    expect(result).toMatchObject({ delivered: 1, failed: 0 })
    const [question] = await db.select().from(agentQuestions).where(eq(agentQuestions.id, questionId))
    expect(question!.answerDeliveryStatus).toBe('delivered')
    expect(question!.answerDeliveryLastError).toBeNull()
    // The replacement attempt has no agent and the stream no owner, so the asker itself is told,
    // as an ordinary message rather than a reply bound to its old attempt.
    expect(question!.answerDeliveryForward).toMatchObject({
      reason: 'attempt-finished',
      workStreamId: streamId,
      originAttemptId: 1,
      recipients: [{ role: 'asker', agentId }],
    })
    const [forwarded] = await db
      .select()
      .from(inbox)
      .where(eq(inbox.idempotencyKey, `agent-question-answer:v1:${questionId}:forward:${agentId}`))
    expect(forwarded).toMatchObject({ recipientId: agentId, senderType: 'user', deliveryMode: 'follow-up' })
    expect(forwarded!.content).toContain('Yes, merge it.')
    // The copy bound to the old attempt can never be delivered, so it is closed rather than left unread.
    const [stale] = await db
      .select()
      .from(inbox)
      .where(eq(inbox.idempotencyKey, `agent-question-answer:v1:${questionId}`))
    expect(stale!.readAt).not.toBeNull()
    expect((await listActionableAgentQuestions()).map((row) => row.id)).not.toContain(questionId)
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
