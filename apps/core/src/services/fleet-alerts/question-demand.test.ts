import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { createBlankWorkflow, createWorkflowRun, resolveWorkflow } from '@ficus/shared'
import { and, eq, inArray, like } from 'drizzle-orm'
import { db } from '../../db'
import {
  agents,
  agentTypes,
  agentQuestions,
  executions,
  messages,
  inbox,
  squads,
  schedules,
  workStreams,
  workStreamFlowRuns,
  workStreamWaits,
  workflowBindings,
  fleetIncidents,
  fleetIncidentNotifications,
  slotPools,
  users,
} from '../../db/schema'
import { Agent } from '../../entities/Agent'
import { Execution } from '../../entities/Execution'
import { Schedule } from '../../entities/Schedule'
import { createAgentQuestion } from '../agents/questions'
import { reconcileQuestionAnswerDeliveriesOnce } from '../agents/question-answer-delivery'
import { deliverInboxMessagesToAgent } from '../inbox/inboxDelivery'
import { isCurrentFlowMessage } from '../workflows/execution'
import { attemptPickup } from '../execution/pickup'
import { concurrencyLimiter } from '../execution/concurrency-limiter-instance'
import { executionLifecycleRegistry } from '../execution/lifecycle-registry'
import { getSquadDemandSnapshots } from './demand'
import { reconcileDeadFleet } from './dead-fleet'

const START = new Date('2026-08-18T12:00:00Z')
const at = (minutes: number) => new Date(START.getTime() + minutes * 60_000)
const NOW = at(90)

describe('human question attribution through demand and incident reconciliation', () => {
  let squadId: string
  let agentId: string
  let agentTypeId: string
  let streamId: string
  let questionId: string
  let waitId: string
  let definition: ReturnType<typeof createBlankWorkflow>
  let ownedExecutionIds: string[]
  let originExecutionId: string
  let ownedUserIds: string[]

  beforeEach(async () => {
    ownedExecutionIds = []
    ownedUserIds = []
    agentTypeId = `question-demand-${crypto.randomUUID()}`
    const [agentType] = await db
      .insert(agentTypes)
      .values({
        id: agentTypeId,
        name: 'Question demand worker',
        model: 'anthropic:claude-sonnet-4-5',
        systemPrompt: 'Test worker',
      })
      .returning()
    const [squad] = await db
      .insert(squads)
      .values({ name: 'Question demand fixture', purpose: 'Wait attribution', status: 'active' })
      .returning()
    squadId = squad!.id
    const [owner] = await db.insert(agents).values({ squadId, agentTypeId, status: 'idle' }).returning()
    agentId = owner!.id
    const [stream] = await db
      .insert(workStreams)
      .values({
        squadId,
        title: 'Waiting for a human choice',
        status: 'active',
        assigneeAgentId: agentId,
        agentIds: [agentId],
        createdAt: START,
      })
      .returning()
    streamId = stream!.id
    definition = createBlankWorkflow()
    await db.insert(workStreamFlowRuns).values({
      workStreamId: streamId,
      activated: true,
      state: createWorkflowRun(definition),
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
        status: 'running',
        startedAt: START,
        runStartedAt: START,
        flowContext: { workStreamId: streamId, attemptId: 1, stepId: definition.steps[0]!.id },
      })
      .returning()
    ownedExecutionIds.push(origin!.id)
    originExecutionId = origin!.id
    await db.insert(messages).values({
      agentId,
      role: 'human',
      content: 'Choose the test color before continuing.',
      metadata: { executionId: origin!.id, consumedAt: at(1).toISOString() },
      pending: false,
      createdAt: START,
    })
    const question = await createAgentQuestion(
      { agentId, executionId: origin!.id },
      {
        questions: [
          {
            id: 'color',
            type: 'select',
            question: 'Which test color should I use?',
            options: [{ value: 'blue' }, { value: 'green' }],
          },
        ],
      },
      { blocking: true }
    )
    questionId = question.id
    expect(question.openedWaitWorkStreamIds).toEqual([streamId])
    const [wait] = await db
      .select()
      .from(workStreamWaits)
      .where(and(eq(workStreamWaits.workStreamId, streamId), eq(workStreamWaits.referenceId, questionId)))
    waitId = wait!.id
    await db
      .update(workStreamWaits)
      .set({ openedAt: at(3) })
      .where(eq(workStreamWaits.id, waitId))
    await db
      .update(executions)
      .set({ status: 'completed', endedAt: at(4) })
      .where(eq(executions.id, origin!.id))
  })

  afterEach(async () => {
    for (const id of ownedExecutionIds) {
      concurrencyLimiter.release(id)
      const lifecycle = executionLifecycleRegistry.get(id)
      if (lifecycle) await lifecycle.settled
    }
    const incidents = await db.select().from(fleetIncidents).where(eq(fleetIncidents.squadId, squadId))
    for (const incident of incidents)
      await db.delete(inbox).where(like(inbox.idempotencyKey, `fleet-incident:${incident.id}:%`))
    if (incidents.length) {
      await db.delete(fleetIncidentNotifications).where(
        inArray(
          fleetIncidentNotifications.incidentId,
          incidents.map((row) => row.id)
        )
      )
      await db.delete(fleetIncidents).where(
        inArray(
          fleetIncidents.id,
          incidents.map((row) => row.id)
        )
      )
    }
    const owners = await db.select({ id: agents.id }).from(agents).where(eq(agents.squadId, squadId))
    await db.delete(inbox).where(
      inArray(
        inbox.recipientId,
        owners.map((owner) => owner.id)
      )
    )
    await db.delete(schedules).where(eq(schedules.scopeId, squadId))
    await db.delete(squads).where(eq(squads.id, squadId))
    await db.delete(agentTypes).where(eq(agentTypes.id, agentTypeId))
    if (ownedUserIds.length) await db.delete(users).where(inArray(users.id, ownedUserIds))
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
            inArray(
              fleetIncidentNotifications.incidentId,
              incidents.map((row) => row.id)
            )
          )
      : []
    return { snapshot, incidents, alerts }
  }

  async function assertQuestionOpen() {
    const [wait] = await db.select().from(workStreamWaits).where(eq(workStreamWaits.id, waitId))
    const [question] = await db.select().from(agentQuestions).where(eq(agentQuestions.id, questionId))
    expect(wait!.closedAt).toBeNull()
    expect(question!.answer).toBeNull()
    expect(await db.select().from(slotPools).where(eq(slotPools.squadId, squadId))).toEqual([])
  }

  async function assignment() {
    const [message] = await db
      .insert(inbox)
      .values({
        recipientType: 'agent',
        recipientId: agentId,
        senderType: 'system',
        content: 'Workflow assignment',
        metadata: { source: 'workflow', workStreamId: streamId, attemptId: 1 },
        createdAt: START,
        idempotencyKey: `flow:${streamId}:1`,
      })
      .returning()
    return message!
  }

  test('an old stream waiting only on its explicit human question has no incident or outage', async () => {
    const result = await observe()
    expect(result.snapshot.count).toBe(0)
    expect(result.incidents).toEqual([])
    expect(result.alerts).toEqual([])
    await assertQuestionOpen()
    await db.update(workStreamWaits).set({ flowAttemptId: null }).where(eq(workStreamWaits.id, waitId))
    expect((await observe()).snapshot.count).toBe(0)
    expect((await observe()).incidents).toEqual([])
    await assertQuestionOpen()
  })

  test.each(['attempt', 'stream'] as const)(
    'an attributed assignment stays blocked and receives a new clock after its %s question closes',
    async (scope) => {
      if (scope === 'stream')
        await db.update(workStreamWaits).set({ flowAttemptId: null }).where(eq(workStreamWaits.id, waitId))
      const message = await assignment()
      expect(await isCurrentFlowMessage(message)).toBe(false)
      const agent = await Agent.mustFind(agentId)
      await expect(
        agent.queueExecution({
          message: 'Workflow assignment',
          metadata: { source: 'inbox', inboxMessageIds: [message.id] },
        })
      ).rejects.toThrow('waiting for input')
      expect(
        await db
          .select()
          .from(executions)
          .where(and(eq(executions.agentId, agentId), eq(executions.status, 'queued')))
      ).toEqual([])
      const held = await observe()
      expect(held.snapshot.count).toBe(0)
      expect(held.incidents).toEqual([])
      expect(held.alerts).toEqual([])
      await assertQuestionOpen()

      // Fixture-only human resolution; the real reporting question is never accessed.
      await db
        .update(workStreamWaits)
        .set({ closedAt: NOW, resolution: 'answered' })
        .where(eq(workStreamWaits.id, waitId))
      expect(await isCurrentFlowMessage(message)).toBe(true)
      const ready = await observe()
      expect(ready.snapshot.count).toBe(2)
      expect(ready.snapshot.unservedSince).toEqual(NOW)
      expect(ready.alerts).toEqual([])
      expect((await observe(at(120 - 1 / 60_000))).alerts).toEqual([])
      expect((await observe(at(120))).alerts.filter((row) => row.kind === 'alert')).toHaveLength(2)
      const accepted = await agent.queueExecution({
        message: 'Workflow assignment',
        metadata: { source: 'inbox', inboxMessageIds: [message.id] },
      })
      ownedExecutionIds.push(accepted.id)
      expect(accepted.status).toBe('queued')
    }
  )

  test.each(['queued', 'retry'] as const)(
    'a real accepted %s control turn is executable even though flow context names a waiting attempt',
    async (kind) => {
      const agent = await Agent.mustFind(agentId)
      const accepted = await agent.queueExecution({
        message: 'Independent control: report the outstanding question without continuing blocked work.',
      })
      ownedExecutionIds.push(accepted.id)
      expect(accepted.flowContext).toMatchObject({ workStreamId: streamId, attemptId: 1 })
      await db
        .update(executions)
        .set({
          startedAt: START,
          startupRetryAt: kind === 'retry' ? at(5) : null,
          startupRetryCount: kind === 'retry' ? 1 : 0,
        })
        .where(eq(executions.id, accepted.id))
      await accepted.reload()
      const pending = await observe()
      expect(pending.snapshot.count).toBe(1)
      expect(pending.alerts.filter((row) => row.kind === 'alert')).toHaveLength(2)
      await assertQuestionOpen()
      // Exercise the real pickup eligibility/CAS. Only the external runner is
      // replaced: no model, box or protected process is started by this fixture.
      const runner = spyOn(Execution.prototype, 'run').mockResolvedValue(undefined)
      try {
        expect(await attemptPickup(accepted)).toBe('started')
        expect(runner).toHaveBeenCalledTimes(1)
        await executionLifecycleRegistry.get(accepted.id)?.settled
        await accepted.reload()
        expect(accepted.status).toBe('running')
      } finally {
        runner.mockRestore()
      }
      await assertQuestionOpen()
    }
  )

  test.each(['ordinary', 'wait-resolution'] as const)(
    '%s inbox delivery remains actionable instead of blanket-blocking its owner',
    async (kind) => {
      const metadata =
        kind === 'wait-resolution'
          ? { source: 'workflow-wait-resolution', workStreamId: streamId, attemptId: 1 }
          : { source: 'independent-control', workStreamId: streamId, attemptId: 1 }
      const [message] = await db
        .insert(inbox)
        .values({
          recipientType: 'agent',
          recipientId: agentId,
          senderType: 'system',
          content: 'Control or answer delivery',
          metadata,
          createdAt: START,
        })
        .returning()
      expect(await isCurrentFlowMessage(message!)).toBe(true)
      const pending = await observe()
      expect(pending.snapshot.count).toBe(1)
      expect(pending.alerts.filter((row) => row.kind === 'alert')).toHaveLength(2)
      await deliverInboxMessagesToAgent(agentId)
      const [delivered] = await db.select().from(inbox).where(eq(inbox.id, message!.id))
      expect(delivered!.deliveredAt).not.toBeNull()
      const queued = await db
        .select()
        .from(executions)
        .where(and(eq(executions.agentId, agentId), eq(executions.status, 'queued')))
      expect(queued).toHaveLength(1)
      ownedExecutionIds.push(queued[0]!.id)
      await assertQuestionOpen()
    }
  )

  test('independent old inbox work cannot borrow the question closure clock or falsely recover its incident', async () => {
    await db.insert(inbox).values({
      recipientType: 'agent',
      recipientId: agentId,
      senderType: 'system',
      content: 'Independent control',
      metadata: { source: 'independent-control', workStreamId: streamId, attemptId: 1 },
      createdAt: START,
    })
    const pending = await observe()
    expect(pending.snapshot.unservedSince).toEqual(START)
    expect(pending.alerts.filter((row) => row.kind === 'alert')).toHaveLength(2)
    await db
      .update(workStreamWaits)
      .set({ closedAt: NOW, resolution: 'answered' })
      .where(eq(workStreamWaits.id, waitId))
    const ready = await observe()
    expect(ready.snapshot.count).toBe(2)
    expect(ready.snapshot.unservedSince).toEqual(START)
    expect(ready.incidents[0]!.id).toBe(pending.incidents[0]!.id)
    expect(ready.incidents[0]!.resolvedAt).toBeNull()
  })

  test('a saved answer uses its dedicated delivery protocol while a different human question still blocks the attempt', async () => {
    const [human] = await db
      .insert(users)
      .values({ email: `question-demand-${crypto.randomUUID()}@example.invalid`, displayName: 'Fixture respondent' })
      .returning()
    ownedUserIds.push(human!.id)
    const [answered] = await db
      .insert(agentQuestions)
      .values({
        agentId,
        squadId,
        executionId: originExecutionId,
        questionData: { questions: [{ id: 'other', type: 'text', question: 'Which fixture label should I use?' }] },
        status: 'answered',
        answer: 'Use the test label.',
        answeredByUserId: human!.id,
        answeredAt: at(5),
        answerDeliveryStatus: 'pending',
        answerDeliveryNextAttemptAt: at(5),
      })
      .returning()
    const result = await reconcileQuestionAnswerDeliveriesOnce({
      now: NOW,
      questionId: answered!.id,
      testHooks: {
        afterInboxPersisted: async () => {
          // Reproduce a durable answer intent that has waited long enough to be
          // overdue. Ordinary inbox delivery deliberately excludes this source.
          const [intent] = await db
            .update(inbox)
            .set({ createdAt: START })
            .where(eq(inbox.idempotencyKey, `agent-question-answer:v1:${answered!.id}`))
            .returning()
          expect(await isCurrentFlowMessage(intent!)).toBe(true)
          const pending = await observe()
          expect(pending.snapshot.count).toBe(1)
          expect(pending.alerts.filter((row) => row.kind === 'alert')).toHaveLength(2)
          await assertQuestionOpen()
        },
      },
    })
    expect(result.delivered).toBe(1)
    const [settled] = await db.select().from(agentQuestions).where(eq(agentQuestions.id, answered!.id))
    expect(settled!.answerDeliveryStatus).toBe('delivered')
    expect(settled!.answerDeliveryExecutionId).not.toBeNull()
    ownedExecutionIds.push(settled!.answerDeliveryExecutionId!)
    await assertQuestionOpen()
  })

  test('due scheduled inbox work has no attempt fence and can actually deliver while the question stays open', async () => {
    const [schedule] = await db
      .insert(schedules)
      .values({
        scopeType: 'squad',
        scopeId: squadId,
        name: 'Independent reminder',
        enabled: true,
        schedule: { runAt: START.toISOString() },
        action: {
          type: 'inbox_message',
          target: { type: 'agent', agentId },
          content: 'Report the outstanding question; do not bypass it.',
        },
        nextTriggerAt: START,
      })
      .returning()
    const due = await observe()
    expect(due.snapshot.count).toBe(1)
    expect(due.alerts.filter((row) => row.kind === 'alert')).toHaveLength(2)
    expect(await new Schedule(schedule!).triggerIfDue()).toBe(true)
    const [delivered] = await db.select().from(inbox).where(eq(inbox.recipientId, agentId))
    expect(delivered!.metadata).toMatchObject({ scheduleId: schedule!.id, type: 'schedule' })
    expect(delivered!.metadata).not.toHaveProperty('attemptId')
    expect(delivered!.deliveredAt).not.toBeNull()
    const queued = await db
      .select()
      .from(executions)
      .where(and(eq(executions.agentId, agentId), eq(executions.status, 'queued')))
    expect(queued).toHaveLength(1)
    ownedExecutionIds.push(queued[0]!.id)
    await assertQuestionOpen()
  })

  test.each(['sibling', 'unrelated'] as const)(
    'a runnable %s remains visible while the question blocks its own attempt',
    async (kind) => {
      const [other] = await db.insert(agents).values({ squadId, agentTypeId, status: 'idle' }).returning()
      if (kind === 'sibling') {
        const state = createWorkflowRun(definition)
        state.attempts.push({ ...state.attempts[0]!, id: 2 })
        await db
          .update(workStreamFlowRuns)
          .set({ state, attemptAgents: { '1': agentId, '2': other!.id } })
          .where(eq(workStreamFlowRuns.workStreamId, streamId))
        await db
          .update(workStreams)
          .set({ agentIds: [agentId, other!.id] })
          .where(eq(workStreams.id, streamId))
      } else {
        await db.insert(workStreams).values({
          squadId,
          title: 'Unrelated runnable work',
          status: 'active',
          assigneeAgentId: other!.id,
          createdAt: START,
        })
      }
      const result = await observe()
      expect(result.snapshot.count).toBe(1)
      expect(result.alerts.filter((row) => row.kind === 'alert')).toHaveLength(2)
      await assertQuestionOpen()
    }
  )
})
