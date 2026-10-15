import { storedLegacyWorkStream } from '../../test-utils/stored-legacy-work-stream'
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import * as permissions from '../rbac/permissions'
import { and, eq, inArray, like, sql } from 'drizzle-orm'
import { db } from '../../db'
import {
  agentQuestionRecipients,
  agentQuestionWorkStreamOrigins,
  agentQuestions,
  agents,
  agentTypes,
  executions,
  inbox,
  messages,
  squads,
  users,
  workStreamContinuations,
  workStreams,
  workStreamWaits,
} from '../../db/schema'
import { Agent } from '../../entities/Agent'
import { Execution } from '../../entities/Execution'
import { AgentType } from '../../entities/AgentType'
import { Squad } from '../../entities/Squad'
import { makeDormant, reconcileAgentLifecycleRequest } from '../agent/lifecycle'
import {
  createAgentQuestion,
  answerAgentQuestion,
  dismissAgentQuestion,
  getAgentQuestion,
  listActionableAgentQuestions,
  listAgentQuestions,
  listAgentQuestionAttentionUserIds,
  listAgentQuestionNotifyUserIds,
  reconcileTerminatedAgentQuestionsOnce,
  resolveAgentQuestionWithRelayedAnswer,
  retryAgentQuestionAnswerDelivery,
  setQuestionBlocking,
} from './questions'
import { assignRole, cleanupTestRbac, createTestRole, createTestUser, type TestUser } from '../../test-utils'
import { eventEmitter } from '../../lib/infra/event-emitter'
import { WorkStream } from '../../entities/WorkStream'
import { isNull } from 'drizzle-orm'
import { subscribeToSquad } from '../squad/subscriptions'
import { subscribeToWorkStream } from '../work-streams/subscriptions'
import { getSettingsStore } from '../settings/store'
import { waitForQuestionAnswerDeliveryDrains } from './question-answer-delivery'
import * as admissionModule from '../work-streams/admission'

const QUESTION = { questions: [{ id: 'q1', type: 'text' as const, question: 'Ship it?' }] }

describe('async agent questions', () => {
  let prefix: string
  let agentTypeId: string
  let squad: Squad
  let user: TestUser
  let createdAgentIds: string[]
  let createdUserIds: string[]

  beforeEach(async () => {
    prefix = `aq-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    agentTypeId = `${prefix}-type`
    createdAgentIds = []
    createdUserIds = []
    await AgentType.create({
      id: agentTypeId,
      name: 'AQ Test',
      model: 'anthropic:claude-sonnet-4-5',
      systemPrompt: 'x',
    })
    squad = await Squad.create({ name: `${prefix} Squad`, purpose: 'agent question test' })
    user = await createTestUser({ prefix })
    createdUserIds.push(user.id)
  })

  afterEach(async () => {
    await waitForQuestionAnswerDeliveryDrains()
    await db.delete(inbox).where(inArray(inbox.recipientId, createdAgentIds.length ? createdAgentIds : ['__none__']))
    if (createdAgentIds.length) await db.delete(agents).where(inArray(agents.id, createdAgentIds))
    await db.delete(squads).where(like(squads.name, `${prefix}%`))
    await db.delete(agentTypes).where(eq(agentTypes.id, agentTypeId))
    if (createdUserIds.length) await cleanupTestRbac(prefix)
  })

  async function createAgent(opts: { squadId?: string; ownerUserId?: string }): Promise<Agent> {
    const agent = await Agent.create({ agentTypeId, ...opts })
    createdAgentIds.push(agent.id)
    return agent
  }

  async function createQuestion(
    agent: Agent,
    opts: Parameters<typeof createAgentQuestion>[2] = {},
    originWorkStreamIds: string[] = []
  ) {
    const [execution] = await db.insert(executions).values({ agentId: agent.id, status: 'running' }).returning()
    for (const workStreamId of originWorkStreamIds) {
      await db.insert(messages).values({
        agentId: agent.id,
        role: 'human',
        content: 'Trusted work stream delivery',
        pending: false,
        metadata: {
          source: 'work-stream-continuation',
          workStreamId,
          executionId: execution.id,
          // The question cutoff is assigned by PostgreSQL, not the host clock.
          consumedAt: execution.startedAt.toISOString(),
        },
      })
    }
    return createAgentQuestion({ agentId: agent.id, executionId: execution.id }, QUESTION, opts)
  }

  it('records an open question, emits lifecycle events, and answering delivers an inbox message', async () => {
    const agent = await createAgent({ squadId: squad.id })
    const createdEvents: unknown[] = []
    const answeredEvents: unknown[] = []
    const unsubscribeCreated = eventEmitter.on('agent-question.created', (event) => createdEvents.push(event))
    const unsubscribeAnswered = eventEmitter.on('agent-question.answered', (event) => answeredEvents.push(event))
    const q = await createQuestion(agent)
    unsubscribeCreated()
    expect(createdEvents).toEqual([{ questionId: q.id, agentId: agent.id, squadId: squad.id }])
    expect(q.status).toBe('open')
    expect(q.squadId).toBe(squad.id)

    const answered = await answerAgentQuestion(q.id, 'Yes, ship it', user.id)
    await waitForQuestionAnswerDeliveryDrains()
    unsubscribeAnswered()
    expect(answeredEvents).toEqual([{ questionId: q.id, agentId: agent.id, squadId: squad.id }])
    expect(answered?.status).toBe('answered')
    expect(answered?.answer).toBe('Yes, ship it')

    // answer delivered to the agent as an interrupt (steer) inbox message
    const msgs = await db
      .select()
      .from(inbox)
      .where(and(eq(inbox.recipientType, 'agent'), eq(inbox.recipientId, agent.id)))
    const answerMsg = msgs.find((m) => (m.metadata as { source?: string } | null)?.source === 'agent-question-answer')
    expect(answerMsg).toBeTruthy()
    expect(answerMsg?.deliveryMode).toBe('steer')
    expect(answerMsg?.content).toContain('Yes, ship it')
    expect(answerMsg?.content).toContain('Question')
    expect(answerMsg?.content).toContain('Answer')

    // answering again is a no-op
    expect(await answerAgentQuestion(q.id, 'again', user.id)).toBeNull()
  })

  it('keeps exact status filtering while supporting an ordered terminal status set', async () => {
    const agent = await createAgent({ squadId: squad.id })
    const open = await createQuestion(agent)
    const answered = await createQuestion(agent)
    const dismissed = await createQuestion(agent)
    await db
      .update(agentQuestions)
      .set({ status: 'open', createdAt: new Date('2026-09-01T00:00:00.000Z') })
      .where(eq(agentQuestions.id, open.id))
    await db
      .update(agentQuestions)
      .set({ status: 'answered', createdAt: new Date('2026-09-02T00:00:00.000Z') })
      .where(eq(agentQuestions.id, answered.id))
    await db
      .update(agentQuestions)
      .set({ status: 'dismissed', createdAt: new Date('2026-09-03T00:00:00.000Z') })
      .where(eq(agentQuestions.id, dismissed.id))

    expect((await listAgentQuestions(agent.id, { status: 'answered' })).map(({ id }) => id)).toEqual([answered.id])
    expect((await listAgentQuestions(agent.id, { statuses: ['answered', 'dismissed'] })).map(({ id }) => id)).toEqual([
      dismissed.id,
      answered.id,
    ])
    expect((await listAgentQuestions(agent.id, { status: 'open' })).map(({ id }) => id)).toEqual([open.id])
  })

  it('answers a dormant agent question once and wakes one delivery execution', async () => {
    const agentWarmup = await import('../sandbox/agent-warmup')
    const ensure = spyOn(agentWarmup, 'ensureAgentSandbox').mockResolvedValue('ensured')
    try {
      const agent = await createAgent({ squadId: squad.id })
      const q = await createQuestion(agent)
      await db.update(executions).set({ status: 'completed' }).where(eq(executions.agentId, agent.id))
      await makeDormant(agent)

      expect(await answerAgentQuestion(q.id, 'Wake with this answer', user.id)).not.toBeNull()
      await waitForQuestionAnswerDeliveryDrains()

      const answered = await listAgentQuestions(agent.id, { status: 'answered' })
      expect(answered.filter((item) => item.id === q.id)).toHaveLength(1)
      expect((await Agent.mustFind(agent.id)).status).toBe('idle')
      expect(await Execution.list({ agentId: agent.id, status: 'queued' })).toHaveLength(1)
      expect(await answerAgentQuestion(q.id, 'duplicate', user.id)).toBeNull()
      expect(ensure).toHaveBeenCalled()
    } finally {
      ensure.mockRestore()
    }
  })

  it('keeps dormant questions actionable while excluding final agents', async () => {
    const agent = await createAgent({ squadId: squad.id })
    const question = await createQuestion(agent)
    await db.update(executions).set({ status: 'completed' }).where(eq(executions.agentId, agent.id))
    await makeDormant(agent)

    expect((await listActionableAgentQuestions()).map(({ id }) => id)).toContain(question.id)

    await agent.update({ status: 'terminated', terminatedAt: new Date() })
    expect((await listActionableAgentQuestions()).map(({ id }) => id)).not.toContain(question.id)
  })

  it('retries a failed answer delivery to a dormant agent and wakes it once', async () => {
    const agentWarmup = await import('../sandbox/agent-warmup')
    const ensure = spyOn(agentWarmup, 'ensureAgentSandbox').mockResolvedValue('ensured')
    try {
      const agent = await createAgent({ squadId: squad.id })
      const question = await createQuestion(agent)
      await db.update(executions).set({ status: 'completed' }).where(eq(executions.agentId, agent.id))
      await db
        .update(agentQuestions)
        .set({
          status: 'answered',
          answer: 'accepted answer',
          answeredByUserId: user.id,
          answeredAt: new Date(),
          answerDeliveryStatus: 'failed',
        })
        .where(eq(agentQuestions.id, question.id))
      await makeDormant(agent)
      expect((await listActionableAgentQuestions()).map(({ id }) => id)).toContain(question.id)

      expect(await retryAgentQuestionAnswerDelivery(question.id)).not.toBeNull()
      await waitForQuestionAnswerDeliveryDrains()

      expect((await Agent.mustFind(agent.id)).status).toBe('idle')
      expect(await Execution.list({ agentId: agent.id, status: 'queued' })).toHaveLength(1)
      const [retried] = await db.select().from(agentQuestions).where(eq(agentQuestions.id, question.id))
      expect(retried.answerDeliveryStatus).toBe('delivered')
      expect(ensure).toHaveBeenCalled()
    } finally {
      ensure.mockRestore()
    }
  })

  it('resolves a personal question only to its owner', async () => {
    const personalAgent = await createAgent({ ownerUserId: user.id })
    const q = await createQuestion(personalAgent)

    expect(await listAgentQuestionAttentionUserIds(q.id)).toEqual([user.id])
  })

  it('excludes a disabled question owner while retaining an enabled owner', async () => {
    const disabledOwner = await createTestUser({ prefix })
    createdUserIds.push(disabledOwner.id)
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, disabledOwner.id))
    const enabledAgent = await createAgent({ ownerUserId: user.id })
    const disabledAgent = await createAgent({ ownerUserId: disabledOwner.id })
    const enabledQuestion = await createQuestion(enabledAgent)
    const disabledQuestion = await createQuestion(disabledAgent)

    expect(await listAgentQuestionAttentionUserIds(enabledQuestion.id)).toEqual([user.id])
    expect(await listAgentQuestionAttentionUserIds(disabledQuestion.id)).toEqual([])
  })

  it('resolves personal owners, direct recipients, and every authorized reader without leaking', async () => {
    const authorizedWatcher = await createTestUser({ prefix })
    const unauthorizedWatcher = await createTestUser({ prefix })
    createdUserIds.push(authorizedWatcher.id, unauthorizedWatcher.id)
    const role = await createTestRole({ prefix, permissions: ['actions:read'] })
    await assignRole({
      userId: authorizedWatcher.id,
      roleId: role.id,
      scope: 'squad',
      squadId: squad.id,
    })
    await Promise.all([
      subscribeToSquad(squad.id, user.id),
      subscribeToSquad(squad.id, authorizedWatcher.id),
      subscribeToSquad(squad.id, unauthorizedWatcher.id),
    ])
    const agent = await createAgent({ squadId: squad.id, ownerUserId: user.id })
    const q = await createQuestion(agent)

    // Watching is no longer part of visibility: actions:read on the squad is. The owner without
    // that permission stays out; the unauthorized watcher never gets in.
    const before = new Set(await listAgentQuestionAttentionUserIds(q.id))
    expect(before).toContain(authorizedWatcher.id)
    expect(before).not.toContain(unauthorizedWatcher.id)
    expect(before).not.toContain(user.id)

    await assignRole({ userId: user.id, roleId: role.id, scope: 'squad', squadId: squad.id })
    const after = new Set(await listAgentQuestionAttentionUserIds(q.id))
    expect(after).toContain(user.id)
    expect(after).toContain(authorizedWatcher.id)
    expect(after).not.toContain(unauthorizedWatcher.id)
    expect(await listAgentQuestionAttentionUserIds('00000000-0000-0000-0000-000000000000')).toEqual([])
  })

  it('excludes disabled squad watchers while retaining an enabled authorized watcher', async () => {
    const enabledWatcher = await createTestUser({ prefix })
    const disabledWatcher = await createTestUser({ prefix })
    createdUserIds.push(enabledWatcher.id, disabledWatcher.id)
    const role = await createTestRole({ prefix, permissions: ['actions:read'] })
    for (const userId of [enabledWatcher.id, disabledWatcher.id]) {
      await assignRole({ userId, roleId: role.id, scope: 'squad', squadId: squad.id })
      await subscribeToSquad(squad.id, userId)
    }
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, disabledWatcher.id))
    const agent = await createAgent({ squadId: squad.id })
    const q = await createQuestion(agent)

    const resolved = new Set(await listAgentQuestionAttentionUserIds(q.id))
    expect(resolved).toContain(enabledWatcher.id)
    expect(resolved).not.toContain(disabledWatcher.id)
  })

  it('pushes a squad question to notify-level readers only, while show-level readers still see it', async () => {
    const notifier = await createTestUser({ prefix })
    const shower = await createTestUser({ prefix })
    const muter = await createTestUser({ prefix })
    createdUserIds.push(notifier.id, shower.id, muter.id)
    const role = await createTestRole({ prefix, permissions: ['actions:read'] })
    for (const reader of [notifier, shower, muter]) {
      await assignRole({ userId: reader.id, roleId: role.id, scope: 'squad', squadId: squad.id })
    }
    await subscribeToSquad(squad.id, notifier.id)
    await subscribeToSquad(squad.id, muter.id, { decisions: 'mute', progress: 'mute' })
    const agent = await createAgent({ squadId: squad.id })
    const q = await createQuestion(agent)

    const notified = new Set(await listAgentQuestionNotifyUserIds(q.id))
    expect(notified).toContain(notifier.id)
    expect(notified).not.toContain(shower.id)
    expect(notified).not.toContain(muter.id)

    // The show-level reader is not pushed, but the question is still theirs to see.
    expect(new Set(await listAgentQuestionAttentionUserIds(q.id))).toContain(shower.id)
  })

  /**
   * The notify fan-out used to run under `Promise.all`: one unreadable subject rejected the whole
   * batch, so a single corrupt role chain silenced the push for every other notify-level reader.
   */
  it('still pushes to the other notify-level readers when one permission check throws', async () => {
    const healthy = await createTestUser({ prefix })
    const unreadable = await createTestUser({ prefix })
    createdUserIds.push(healthy.id, unreadable.id)
    const role = await createTestRole({ prefix, permissions: ['actions:read'] })
    for (const reader of [healthy, unreadable]) {
      await assignRole({ userId: reader.id, roleId: role.id, scope: 'squad', squadId: squad.id })
      await subscribeToSquad(squad.id, reader.id)
    }
    const agent = await createAgent({ squadId: squad.id })
    const q = await createQuestion(agent)

    const original = permissions.hasPermission
    const spy = spyOn(permissions, 'hasPermission').mockImplementation(async (identity, permission, scope) => {
      if (identity.type === 'user' && identity.userId === unreadable.id) throw new Error('role chain unreadable')
      return original(identity, permission, scope)
    })
    let notified: string[]
    try {
      notified = await listAgentQuestionNotifyUserIds(q.id)
    } finally {
      spy.mockRestore()
    }

    // Fail closed for the one that threw; the other is unaffected.
    expect(notified).toContain(healthy.id)
    expect(notified).not.toContain(unreadable.id)
  })

  it('never pushes a squad question to a notify-level user who cannot read actions', async () => {
    const loudButBlind = await createTestUser({ prefix })
    createdUserIds.push(loudButBlind.id)
    await subscribeToSquad(squad.id, loudButBlind.id)
    const agent = await createAgent({ squadId: squad.id })
    const q = await createQuestion(agent)

    expect(await listAgentQuestionNotifyUserIds(q.id)).not.toContain(loudButBlind.id)
  })

  it('never fans a squadless question out to instance-wide actions:read holders', async () => {
    const instanceReader = await createTestUser({ prefix })
    const direct = await createTestUser({ prefix })
    createdUserIds.push(instanceReader.id, direct.id)
    const role = await createTestRole({ prefix, permissions: ['actions:read'] })
    await assignRole({ userId: instanceReader.id, roleId: role.id, scope: 'system' })
    const personalAgent = await createAgent({ ownerUserId: user.id })
    const q = await createQuestion(personalAgent)
    await db.insert(agentQuestionRecipients).values({
      questionId: q.id,
      userId: direct.id,
      reason: 'execution-participant',
    })

    // A squadless question has no squad to read: its push audience is exactly its personal owner
    // and its direct recipients, never everyone holding the permission instance-wide.
    expect(new Set(await listAgentQuestionNotifyUserIds(q.id))).toEqual(new Set([user.id, direct.id]))
  })

  it('lets an origin stream mute a question from a squad the reader is notified about', async () => {
    const reader = await createTestUser({ prefix })
    createdUserIds.push(reader.id)
    const role = await createTestRole({ prefix, permissions: ['actions:read'] })
    await assignRole({ userId: reader.id, roleId: role.id, scope: 'squad', squadId: squad.id })
    await subscribeToSquad(squad.id, reader.id, { decisions: 'notify', progress: 'notify' })
    const agent = await createAgent({ squadId: squad.id })
    const muted = await storedLegacyWorkStream({
      squadId: squad.id,
      title: `${prefix} muted origin`,
      assigneeAgentId: agent.id,
      agentIds: [agent.id],
    })
    await subscribeToWorkStream(muted.id, reader.id, { decisions: 'mute', progress: 'notify' })

    // Origin precedence: the question IS its origin, so the muted stream row wins over the
    // notified squad row and the squad row alone can never add the reader back.
    const fromMutedStream = await createQuestion(agent, {}, [muted.id])
    expect(
      await db
        .select({ workStreamId: agentQuestionWorkStreamOrigins.workStreamId })
        .from(agentQuestionWorkStreamOrigins)
        .where(eq(agentQuestionWorkStreamOrigins.questionId, fromMutedStream.id))
    ).toEqual([{ workStreamId: muted.id }])
    expect(await listAgentQuestionNotifyUserIds(fromMutedStream.id)).not.toContain(reader.id)

    // With no origins the question is the squad's own, so the squad row decides.
    const squadLevel = await createQuestion(agent)
    expect(await listAgentQuestionNotifyUserIds(squadLevel.id)).toContain(reader.id)
  })

  describe('exact execution attention', () => {
    it('keeps writing and reading attention provenance when a stale off rollout row survives an upgrade', async () => {
      // An upgraded installation may still carry the retired rollout row (and its cached value).
      // Nothing may consult it: recipients, origins, provenance, and finalization stay on.
      const store = getSettingsStore()
      await store.set('AGENT_QUESTION_AUDIENCE_ROLLOUT', 'off')
      await store.initialize()
      try {
        const agent = await createAgent({ squadId: squad.id })
        const stream = await storedLegacyWorkStream({
          squadId: squad.id,
          title: `${prefix} stale-off origin`,
          assigneeAgentId: agent.id,
          agentIds: [agent.id],
        })
        const [execution] = await db.insert(executions).values({ agentId: agent.id, status: 'running' }).returning()
        const consumedAt = new Date(Date.now() - 1_000).toISOString()
        await db.insert(messages).values([
          {
            agentId: agent.id,
            role: 'human',
            content: 'trusted origin delivery',
            pending: false,
            metadata: {
              source: 'work-stream-continuation',
              workStreamId: stream.id,
              executionId: execution.id,
              consumedAt,
            },
          },
          {
            agentId: agent.id,
            role: 'human',
            content: 'consumed participant',
            pending: false,
            metadata: {
              source: 'user_chat',
              sender: { userId: user.id, name: 'User' },
              executionId: execution.id,
              consumedAt,
            },
          },
        ])

        const q = await createAgentQuestion({ agentId: agent.id, executionId: execution.id }, QUESTION)

        expect(q.executionId).toBe(execution.id)
        expect(q.audienceResolution).toBe('resolved') // physical compatibility field
        expect(
          await db
            .select({ userId: agentQuestionRecipients.userId, reason: agentQuestionRecipients.reason })
            .from(agentQuestionRecipients)
            .where(eq(agentQuestionRecipients.questionId, q.id))
        ).toContainEqual({ userId: user.id, reason: 'execution-participant' })
        expect(
          await db
            .select({ workStreamId: agentQuestionWorkStreamOrigins.workStreamId })
            .from(agentQuestionWorkStreamOrigins)
            .where(eq(agentQuestionWorkStreamOrigins.questionId, q.id))
        ).toEqual([{ workStreamId: stream.id }])
      } finally {
        await store.delete('AGENT_QUESTION_AUDIENCE_ROLLOUT')
      }
    })

    it('includes every consumed participant and excludes pending, reset, wrong-execution, and forged messages', async () => {
      const secondUser = await createTestUser({ prefix })
      createdUserIds.push(secondUser.id)
      const agent = await createAgent({ squadId: squad.id })
      const [execution] = await db.insert(executions).values({ agentId: agent.id, status: 'running' }).returning()
      const beforeAsk = new Date(Date.now() - 1_000).toISOString()
      await db.insert(messages).values([
        {
          agentId: agent.id,
          role: 'human',
          content: 'consumed A',
          pending: false,
          metadata: {
            source: 'user_chat',
            sender: { userId: user.id, name: 'A' },
            executionId: execution.id,
            consumedAt: beforeAsk,
          },
        },
        {
          agentId: agent.id,
          role: 'human',
          content: 'consumed B',
          pending: false,
          metadata: {
            source: 'user_chat',
            sender: { userId: secondUser.id, name: 'B' },
            executionId: execution.id,
            consumedAt: beforeAsk,
          },
        },
        {
          agentId: agent.id,
          role: 'human',
          content: 'later pending B',
          pending: true,
          injectedAt: new Date(),
          metadata: {
            source: 'user_chat',
            sender: { userId: secondUser.id, name: 'B' },
            executionId: execution.id,
          },
        },
        {
          agentId: agent.id,
          role: 'human',
          content: 'wrong execution',
          pending: false,
          metadata: {
            source: 'user_chat',
            sender: { userId: crypto.randomUUID(), name: 'wrong' },
            executionId: crypto.randomUUID(),
            consumedAt: beforeAsk,
          },
        },
        {
          agentId: agent.id,
          role: 'human',
          content: 'malformed authenticated sender',
          pending: false,
          metadata: {
            source: 'user_chat',
            sender: { userId: 'not-a-uuid', name: 'malformed' },
            executionId: execution.id,
            consumedAt: beforeAsk,
          },
        },
        {
          agentId: agent.id,
          role: 'human',
          content: 'forged source',
          pending: false,
          metadata: {
            source: 'chat',
            sender: { userId: crypto.randomUUID(), name: 'forged' },
            executionId: execution.id,
            consumedAt: beforeAsk,
          },
        },
      ])

      const question = await createAgentQuestion({ agentId: agent.id, executionId: execution.id }, QUESTION)
      const recipients = await db
        .select({ userId: agentQuestionRecipients.userId })
        .from(agentQuestionRecipients)
        .where(eq(agentQuestionRecipients.questionId, question.id))
      expect(new Set(recipients.map(({ userId }) => userId))).toEqual(new Set([user.id, secondUser.id]))
      expect(question.executionId).toBe(execution.id)
      expect(question.audienceResolution).toBe('resolved')
    })

    it('keeps consumed A when later B has only queued or reset evidence', async () => {
      const pendingOnlyUser = await createTestUser({ prefix })
      createdUserIds.push(pendingOnlyUser.id)
      const agent = await createAgent({ squadId: squad.id })
      const [execution] = await db.insert(executions).values({ agentId: agent.id, status: 'running' }).returning()
      const beforeAsk = new Date(Date.now() - 1_000).toISOString()
      await db.insert(messages).values([
        {
          agentId: agent.id,
          role: 'human',
          content: 'consumed A',
          pending: false,
          metadata: {
            source: 'user_chat',
            sender: { userId: user.id, name: 'A' },
            executionId: execution.id,
            consumedAt: beforeAsk,
          },
        },
        {
          agentId: agent.id,
          role: 'human',
          content: 'queued B',
          pending: true,
          injectedAt: new Date(),
          metadata: {
            source: 'user_chat',
            sender: { userId: pendingOnlyUser.id, name: 'B' },
            executionId: execution.id,
          },
        },
        {
          agentId: agent.id,
          role: 'human',
          content: 'reset B',
          pending: true,
          injectedAt: null,
          metadata: {
            source: 'user_chat',
            sender: { userId: pendingOnlyUser.id, name: 'B' },
            executionId: execution.id,
          },
        },
      ])

      const question = await createAgentQuestion({ agentId: agent.id, executionId: execution.id }, QUESTION)
      const recipients = await db
        .select({ userId: agentQuestionRecipients.userId })
        .from(agentQuestionRecipients)
        .where(eq(agentQuestionRecipients.questionId, question.id))
      expect(recipients).toEqual([{ userId: user.id }])
    })

    it('records an unroutable question with no system-inbox notice, still visible and answerable', async () => {
      const agent = await createAgent({ squadId: squad.id })
      const [execution] = await db.insert(executions).values({ agentId: agent.id, status: 'running' }).returning()
      const events: unknown[] = []
      const unsubscribe = eventEmitter.on('agent-question.created', (event) => events.push(event))

      const question = await createAgentQuestion({ agentId: agent.id, executionId: execution.id }, QUESTION)
      unsubscribe()

      // Unroutable is a durable audience state, not a failure: the question commits,
      // emits, stays visible to every agent reader, and remains answerable — but it
      // must NOT notify the system inbox (the unroutable-audience notice is removed).
      expect(question.audienceResolution).toBe('unroutable')
      expect(events).toEqual([{ questionId: question.id, agentId: agent.id, squadId: squad.id }])
      expect((await listAgentQuestions(agent.id, { status: 'open' })).map(({ id }) => id)).toContain(question.id)

      const systemNotices = await db
        .select({ id: inbox.id })
        .from(inbox)
        .where(and(sql`${inbox.metadata}->>'questionId' = ${question.id}`, eq(inbox.recipientType, 'system')))
      expect(systemNotices).toHaveLength(0)
      await db
        .delete(inbox)
        .where(and(sql`${inbox.metadata}->>'questionId' = ${question.id}`, eq(inbox.recipientType, 'system')))

      expect((await answerAgentQuestion(question.id, 'Yes, ship it', user.id))?.status).toBe('answered')
    })

    it('rejects an execution owned by another agent without writing a question', async () => {
      const agent = await createAgent({ squadId: squad.id })
      const other = await createAgent({ squadId: squad.id })
      const [execution] = await db.insert(executions).values({ agentId: other.id, status: 'running' }).returning()

      await expect(createAgentQuestion({ agentId: agent.id, executionId: execution.id }, QUESTION)).rejects.toThrow(
        'does not belong'
      )
      expect(await listAgentQuestions(agent.id)).toHaveLength(0)
    })

    it('persists exact consumed origins and their immutable requester', async () => {
      const agent = await createAgent({ squadId: squad.id })
      const stream = await storedLegacyWorkStream({
        squadId: squad.id,
        title: 'requested stream',
        assigneeAgentId: agent.id,
        agentIds: [agent.id],
        requestingUserId: user.id,
      })
      const [execution] = await db.insert(executions).values({ agentId: agent.id, status: 'running' }).returning()
      await db.insert(messages).values({
        agentId: agent.id,
        role: 'human',
        content: 'trusted delivery',
        pending: false,
        metadata: {
          source: 'work-stream-continuation',
          workStreamId: stream.id,
          executionId: execution.id,
          consumedAt: new Date(Date.now() - 1_000).toISOString(),
        },
      })

      const question = await createAgentQuestion({ agentId: agent.id, executionId: execution.id }, QUESTION)
      expect(
        await db
          .select({ workStreamId: agentQuestionWorkStreamOrigins.workStreamId })
          .from(agentQuestionWorkStreamOrigins)
          .where(eq(agentQuestionWorkStreamOrigins.questionId, question.id))
      ).toEqual([{ workStreamId: stream.id }])
      expect(
        await db
          .select({ userId: agentQuestionRecipients.userId, reason: agentQuestionRecipients.reason })
          .from(agentQuestionRecipients)
          .where(eq(agentQuestionRecipients.questionId, question.id))
      ).toEqual([{ userId: user.id, reason: 'workstream-requester' }])
    })
  })

  describe('blocking questions (typed question waits)', () => {
    async function createStreamFor(agentId: string, title: string): Promise<WorkStream> {
      return storedLegacyWorkStream({
        squadId: squad.id,
        title: `${prefix} ${title}`,
        assigneeAgentId: agentId,
        agentIds: [agentId],
      })
    }

    async function openQuestionWaits(workStreamId: string) {
      return db
        .select()
        .from(workStreamWaits)
        .where(
          and(
            eq(workStreamWaits.workStreamId, workStreamId),
            eq(workStreamWaits.type, 'question'),
            isNull(workStreamWaits.closedAt)
          )
        )
    }

    afterEach(async () => {
      await db.delete(workStreams).where(eq(workStreams.squadId, squad.id))
    })

    it('a non-blocking ask opens NO waits and has no scheduling effect (default pinned)', async () => {
      const agent = await createAgent({ squadId: squad.id })
      const ws = await createStreamFor(agent.id, 'default-async')

      const result = await createQuestion(agent)

      expect(result.openedWaitWorkStreamIds).toEqual([])
      expect(await openQuestionWaits(ws.id)).toHaveLength(0)
      // No scheduling effect: the stream is untouched and has zero open waits.
      const fresh = await WorkStream.mustFind(ws.id)
      expect(fresh.status).toBe('active')
      expect(await fresh.getOpenWaits()).toHaveLength(0)
    })

    it('a blocking ask with no waitable streams reports that it opened no waits', async () => {
      const agent = await createAgent({ squadId: squad.id })

      const q = await createQuestion(agent, { blocking: true })

      expect(q.openedWaitWorkStreamIds).toEqual([])
    })

    it('a blocking ask returns only applicable streams when associated terminal streams are excluded', async () => {
      const agent = await createAgent({ squadId: squad.id })
      const applicable = await createStreamFor(agent.id, 'applicable')
      const terminal = await createStreamFor(agent.id, 'terminal')
      await terminal.cancel()

      const q = await createQuestion(agent, { blocking: true }, [applicable.id, terminal.id])

      expect(await openQuestionWaits(applicable.id)).toHaveLength(1)
      expect(await openQuestionWaits(terminal.id)).toHaveLength(0)
      expect(q.openedWaitWorkStreamIds).toEqual([applicable.id])
    })

    it('rolls back the question, recipient rows, origins, and first wait when later wait creation fails', async () => {
      const agent = await createAgent({ squadId: squad.id })
      const first = await createStreamFor(agent.id, 'rollback-create-a')
      const second = await createStreamFor(agent.id, 'rollback-create-b')
      const [execution] = await db.insert(executions).values({ agentId: agent.id, status: 'running' }).returning()
      const consumedAt = new Date(Date.now() - 1_000).toISOString()
      await db.insert(messages).values([
        ...[first, second].map((stream) => ({
          agentId: agent.id,
          role: 'human' as const,
          content: 'trusted origin',
          pending: false,
          metadata: {
            source: 'work-stream-continuation',
            workStreamId: stream.id,
            executionId: execution.id,
            consumedAt,
          },
        })),
        {
          agentId: agent.id,
          role: 'human' as const,
          content: 'consumed requester',
          pending: false,
          metadata: {
            source: 'user_chat',
            sender: { userId: user.id, name: 'User' },
            executionId: execution.id,
            consumedAt,
          },
        },
      ])
      const recipientCountBefore = (await db.select().from(agentQuestionRecipients)).length
      const originCountBefore = (await db.select().from(agentQuestionWorkStreamOrigins)).length
      const updatedEvents: Array<{ workStreamId: string }> = []
      const unsubscribe = eventEmitter.on('workStream.updated', (event) => updatedEvents.push(event))

      await expect(
        createAgentQuestion({ agentId: agent.id, executionId: execution.id }, QUESTION, {
          blocking: true,
          testHooks: {
            afterWaitOpened: async (_workStreamId, openedCount) => {
              if (openedCount === 1) throw new Error('simulated second-wait failure')
            },
          },
        })
      ).rejects.toThrow('simulated second-wait failure')
      unsubscribe()

      expect(updatedEvents).toEqual([])
      expect(await listAgentQuestions(agent.id)).toHaveLength(0)
      expect(await openQuestionWaits(first.id)).toHaveLength(0)
      expect(await openQuestionWaits(second.id)).toHaveLength(0)
      expect(await db.select().from(agentQuestionRecipients)).toHaveLength(recipientCountBefore)
      expect(await db.select().from(agentQuestionWorkStreamOrigins)).toHaveLength(originCountBefore)
    })

    it('a blocking ask opens a question wait per stream; the answer closes it in the SAME transaction', async () => {
      const agent = await createAgent({ squadId: squad.id })
      const ws1 = await createStreamFor(agent.id, 'blocking-a')
      const ws2 = await createStreamFor(agent.id, 'blocking-b')
      const updatedEvents: Array<{ workStreamId: string }> = []
      const unsubscribe = eventEmitter.on('workStream.updated', (event) => updatedEvents.push(event))

      const q = await createQuestion(agent, { blocking: true }, [ws1.id, ws2.id])
      expect(new Set(q.openedWaitWorkStreamIds)).toEqual(new Set([ws1.id, ws2.id]))
      expect(updatedEvents.map((event) => event.workStreamId).sort()).toEqual([ws1.id, ws2.id].sort())

      for (const ws of [ws1, ws2]) {
        const waits = await openQuestionWaits(ws.id)
        expect(waits).toHaveLength(1)
        expect(waits[0].referenceId).toBe(q.id)
        expect(waits[0].message).toContain('Ship it?')
      }

      await answerAgentQuestion(q.id, 'Yes', user.id)
      unsubscribe()
      expect(updatedEvents.map((event) => event.workStreamId).sort()).toEqual([ws1.id, ws2.id, ws1.id, ws2.id].sort())
      for (const ws of [ws1, ws2]) {
        expect(await openQuestionWaits(ws.id)).toHaveLength(0)
      }
      const closed = await db
        .select()
        .from(workStreamWaits)
        .where(and(eq(workStreamWaits.referenceId, q.id), eq(workStreamWaits.type, 'question')))
      expect(closed).toHaveLength(2)
      for (const w of closed) expect(w.resolution).toBe('answered')
    })

    it('concurrent answers converge on exactly one accepted answer', async () => {
      const agent = await createAgent({ squadId: squad.id })
      const ws = await createStreamFor(agent.id, 'first-answer-wins')
      const q = await createQuestion(agent, { blocking: true }, [ws.id])
      const secondUser = await createTestUser({ prefix })
      createdUserIds.push(secondUser.id)

      // Orchestrate both transactions past the open-candidate read BEFORE either locks the
      // agent: whichever wins the agent row lock must be the only one to commit an answer.
      let reached = 0
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const beforeAgentScopeLock = async () => {
        reached += 1
        if (reached === 2) release()
        await gate
      }

      const answeredEvents: unknown[] = []
      const unsubscribe = eventEmitter.on('agent-question.answered', (event) => answeredEvents.push(event))

      const results = await Promise.all([
        answerAgentQuestion(q.id, 'answer A', user.id, { testHooks: { beforeAgentScopeLock } }),
        answerAgentQuestion(q.id, 'answer B', secondUser.id, { testHooks: { beforeAgentScopeLock } }),
      ])
      unsubscribe()
      await waitForQuestionAnswerDeliveryDrains()

      const winners = results.filter((result) => result !== null)
      const losers = results.filter((result) => result === null)
      expect(winners).toHaveLength(1)
      expect(losers).toHaveLength(1)

      // The persisted row is exactly the winner's (answer, author) pair — never a mix.
      const [row] = await db.select().from(agentQuestions).where(eq(agentQuestions.id, q.id))
      expect(row.status).toBe('answered')
      expect(
        [
          { answer: 'answer A', answeredByUserId: user.id },
          { answer: 'answer B', answeredByUserId: secondUser.id },
        ].some((pair) => pair.answer === row.answer && pair.answeredByUserId === row.answeredByUserId)
      ).toBe(true)
      expect({ answer: winners[0]?.answer, answeredByUserId: winners[0]?.answeredByUserId }).toEqual({
        answer: row.answer,
        answeredByUserId: row.answeredByUserId,
      })

      // Exactly one lifecycle event for the whole race.
      expect(answeredEvents).toEqual([{ questionId: q.id, agentId: agent.id, squadId: squad.id }])

      // The blocking wait closed exactly once, with the answered resolution.
      expect(await openQuestionWaits(ws.id)).toHaveLength(0)
      const closed = await db
        .select()
        .from(workStreamWaits)
        .where(and(eq(workStreamWaits.referenceId, q.id), eq(workStreamWaits.type, 'question')))
      expect(closed).toHaveLength(1)
      expect(closed[0].resolution).toBe('answered')

      // The delivery outbox converges on the stable per-question identity: one inbox message,
      // not one per racer.
      const answerMessages = (
        await db
          .select()
          .from(inbox)
          .where(and(eq(inbox.recipientType, 'agent'), eq(inbox.recipientId, agent.id)))
      ).filter((m) => (m.metadata as { source?: string } | null)?.source === 'agent-question-answer')
      expect(answerMessages).toHaveLength(1)
    })

    it('rolls back the answer, wait closure, and delivery intent when the answer transaction crashes', async () => {
      const agent = await createAgent({ squadId: squad.id })
      const ws = await createStreamFor(agent.id, 'answer-delivery-rollback')
      const q = await createQuestion(agent, { blocking: true }, [ws.id])

      await expect(
        answerAgentQuestion(q.id, 'Yes', user.id, {
          testHooks: {
            beforeAnswerCommit: async () => {
              throw new Error('simulated answer commit crash')
            },
          },
        })
      ).rejects.toThrow('simulated answer commit crash')

      const [row] = await db.select().from(agentQuestions).where(eq(agentQuestions.id, q.id))
      expect(row.status).toBe('open')
      expect(row.answerDeliveryStatus).toBeNull()
      expect(await openQuestionWaits(ws.id)).toHaveLength(1)
    })

    it('a failed wait-close rolls back the answer — no answered-but-still-waiting state', async () => {
      const agent = await createAgent({ squadId: squad.id })
      const ws = await createStreamFor(agent.id, 'rollback')
      const q = await createQuestion(agent, { blocking: true }, [ws.id])
      expect(await openQuestionWaits(ws.id)).toHaveLength(1)

      await expect(
        answerAgentQuestion(q.id, 'Yes', user.id, {
          testHooks: {
            duringWaitClose: async () => {
              throw new Error('simulated wait-close failure')
            },
          },
        })
      ).rejects.toThrow('simulated wait-close failure')

      // The answer rolled back with the wait-close: still open on both sides.
      const [fresh] = await listAgentQuestions(agent.id, { status: 'open' })
      expect(fresh?.id).toBe(q.id)
      expect(await openQuestionWaits(ws.id)).toHaveLength(1)

      // And a clean retry succeeds.
      expect((await answerAgentQuestion(q.id, 'Yes', user.id))?.status).toBe('answered')
      expect(await openQuestionWaits(ws.id)).toHaveLength(0)
    })

    it('dismisses open questions and terminally fails in-flight delivery when the asking agent terminates', async () => {
      const agent = await createAgent({ squadId: squad.id })
      const origin = await createStreamFor(agent.id, 'termination-cleanup')
      const open = await createQuestion(agent, { blocking: true }, [origin.id])
      const pending = await createQuestion(agent)
      const delivered = await createQuestion(agent)
      await db
        .update(agentQuestions)
        .set({
          status: 'answered',
          answer: 'pending answer',
          answeredAt: new Date(),
          answeredByUserId: user.id,
          answerDeliveryStatus: 'pending',
          answerDeliveryGeneration: 1,
          answerDeliveryNextAttemptAt: new Date(),
        })
        .where(eq(agentQuestions.id, pending.id))
      await db
        .update(agentQuestions)
        .set({
          status: 'answered',
          answer: 'delivered answer',
          answeredAt: new Date(),
          answeredByUserId: user.id,
          answerDeliveryStatus: 'delivered',
          answerDeliveryGeneration: 1,
          answerDeliveredAt: new Date(),
        })
        .where(eq(agentQuestions.id, delivered.id))
      const dismissedEvents: unknown[] = []
      const failedEvents: unknown[] = []
      const unsubscribeDismissed = eventEmitter.on('agent-question.dismissed', (event) => dismissedEvents.push(event))
      const unsubscribeFailed = eventEmitter.on('agent-question.delivery-failed', (event) => failedEvents.push(event))

      await db
        .update(executions)
        .set({ status: 'completed', endedAt: new Date() })
        .where(eq(executions.agentId, agent.id))
      await agent.update({ terminatedAt: new Date() })
      unsubscribeDismissed()
      unsubscribeFailed()

      const rows = await db.select().from(agentQuestions).where(eq(agentQuestions.agentId, agent.id))
      expect(rows.find((row) => row.id === open.id)).toMatchObject({
        status: 'dismissed',
        dismissalReason: 'asking-agent-terminated',
      })
      expect(rows.find((row) => row.id === pending.id)).toMatchObject({
        status: 'answered',
        answerDeliveryStatus: 'failed',
        answerDeliveryLastError: 'Asking agent terminated before answer delivery',
      })
      expect(rows.find((row) => row.id === delivered.id)?.answerDeliveryStatus).toBe('delivered')
      expect(await openQuestionWaits(origin.id)).toHaveLength(0)
      expect(dismissedEvents).toEqual([{ questionId: open.id, agentId: agent.id, squadId: squad.id }])
      expect(failedEvents).toEqual([{ questionId: pending.id, agentId: agent.id, squadId: squad.id }])
    })

    it('atomically cleans a question that races with normal agent termination', async () => {
      const agent = await createAgent({ squadId: squad.id })
      const origin = await createStreamFor(agent.id, 'termination-create-race')
      const locked = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const creating = createQuestion(
        agent,
        {
          blocking: true,
          testHooks: {
            afterAgentLocked: async () => {
              locked.resolve()
              await release.promise
            },
          },
        },
        [origin.id]
      )
      await locked.promise
      const terminating = agent.update({ terminatedAt: new Date() })
      release.resolve()
      const created = await creating
      await terminating
      await db
        .update(executions)
        .set({ status: 'completed', endedAt: new Date() })
        .where(eq(executions.agentId, agent.id))
      await reconcileAgentLifecycleRequest(agent.id)

      const [row] = await db.select().from(agentQuestions).where(eq(agentQuestions.id, created.id))
      expect(row.status).toBe('dismissed')
      expect(await openQuestionWaits(origin.id)).toHaveLength(0)
      await expect(createQuestion(agent)).rejects.toThrow('terminating or not live')
    })

    it('publishes a committed blocking wait even when later attention finalization fails', async () => {
      const agent = await createAgent({ squadId: squad.id })
      const origin = await createStreamFor(agent.id, 'attention-finalize-failure')
      const events: string[] = []
      const unsubscribe = eventEmitter.on('workStream.updated', ({ workStreamId }) => events.push(workStreamId))

      await expect(
        createQuestion(
          agent,
          {
            blocking: true,
            testHooks: { beforeAttentionFinalize: async () => Promise.reject(new Error('finalization failed')) },
          },
          [origin.id]
        )
      ).rejects.toThrow('finalization failed')
      unsubscribe()

      expect(await openQuestionWaits(origin.id)).toHaveLength(1)
      expect(events).toEqual([origin.id])
    })

    it('fences answer and retry when live owner or squad authority changes before mutation', async () => {
      const agent = await createAgent({ squadId: squad.id, ownerUserId: user.id })
      const answerQuestion = await createQuestion(agent)
      const oldScope = { ownerUserId: user.id, squadId: squad.id }
      expect(
        await answerAgentQuestion(answerQuestion.id, 'revoked answer', user.id, {
          expectedAgentScope: oldScope,
          testHooks: {
            beforeAgentScopeLock: async () => {
              await db.update(agents).set({ ownerUserId: null, squadId: null }).where(eq(agents.id, agent.id))
            },
          },
        })
      ).toBeNull()
      expect((await listAgentQuestions(agent.id, { status: 'open' })).some((row) => row.id === answerQuestion.id)).toBe(
        true
      )

      await db.update(agents).set({ ownerUserId: user.id, squadId: squad.id }).where(eq(agents.id, agent.id))
      const retryQuestion = await createQuestion(agent)
      await db
        .update(agentQuestions)
        .set({
          status: 'answered',
          answer: 'accepted',
          answeredByUserId: user.id,
          answeredAt: new Date(),
          answerDeliveryStatus: 'failed',
        })
        .where(eq(agentQuestions.id, retryQuestion.id))
      expect(
        await retryAgentQuestionAnswerDelivery(retryQuestion.id, {
          expectedAgentScope: oldScope,
          testHooks: {
            beforeAgentScopeLock: async () => {
              await db.update(agents).set({ pendingDormancyAt: new Date() }).where(eq(agents.id, agent.id))
            },
          },
        })
      ).toBeNull()
      const [retryRow] = await db.select().from(agentQuestions).where(eq(agentQuestions.id, retryQuestion.id))
      expect(retryRow.answerDeliveryStatus).toBe('failed')
    })

    it('fences answer and retry when normal termination wins the mutation race', async () => {
      const answerAgent = await createAgent({ squadId: squad.id, ownerUserId: user.id })
      const answerQuestion = await createQuestion(answerAgent)
      expect(
        await answerAgentQuestion(answerQuestion.id, 'too late', user.id, {
          expectedAgentScope: { ownerUserId: user.id, squadId: squad.id },
          testHooks: {
            beforeAgentScopeLock: async () => void (await answerAgent.update({ terminatedAt: new Date() })),
          },
        })
      ).toBeNull()

      const retryAgent = await createAgent({ squadId: squad.id, ownerUserId: user.id })
      const retryQuestion = await createQuestion(retryAgent)
      await db
        .update(agentQuestions)
        .set({
          status: 'answered',
          answer: 'accepted',
          answeredByUserId: user.id,
          answeredAt: new Date(),
          answerDeliveryStatus: 'failed',
        })
        .where(eq(agentQuestions.id, retryQuestion.id))
      expect(
        await retryAgentQuestionAnswerDelivery(retryQuestion.id, {
          expectedAgentScope: { ownerUserId: user.id, squadId: squad.id },
          testHooks: { beforeAgentScopeLock: async () => void (await retryAgent.update({ terminatedAt: new Date() })) },
        })
      ).toBeNull()
    })

    it('promotes after conversion-off and termination close question waits', async () => {
      const promotion = spyOn(admissionModule, 'promoteEligibleQueuedStreams').mockResolvedValue([])
      try {
        const first = await createAgent({ squadId: squad.id })
        const firstOrigin = await createStreamFor(first.id, 'conversion-promotion')
        const firstQuestion = await createQuestion(first, { blocking: true }, [firstOrigin.id])
        await setQuestionBlocking(firstQuestion.id, false)

        const second = await createAgent({ squadId: squad.id })
        const secondOrigin = await createStreamFor(second.id, 'termination-promotion')
        await createQuestion(second, { blocking: true }, [secondOrigin.id])
        await db
          .update(executions)
          .set({ status: 'completed', endedAt: new Date() })
          .where(eq(executions.agentId, second.id))
        await second.update({ terminatedAt: new Date() })

        expect(promotion.mock.calls.filter(([id]) => id === squad.id)).toHaveLength(2)
      } finally {
        promotion.mockRestore()
      }
    })

    it('periodically repairs questions left behind by an out-of-band termination', async () => {
      const agent = await createAgent({ squadId: squad.id })
      const question = await createQuestion(agent)
      await db.update(agents).set({ status: 'terminated', terminatedAt: new Date() }).where(eq(agents.id, agent.id))

      expect(await reconcileTerminatedAgentQuestionsOnce()).toBeGreaterThanOrEqual(1)
      const [row] = await db.select().from(agentQuestions).where(eq(agentQuestions.id, question.id))
      expect(row).toMatchObject({ status: 'dismissed', dismissalReason: 'asking-agent-terminated' })
    })

    it('manager conversion opens zero waits for a direct question with unrelated memberships', async () => {
      const agent = await createAgent({ squadId: squad.id })
      const unrelated = await createStreamFor(agent.id, 'unrelated')
      const q = await createQuestion(agent)

      await setQuestionBlocking(q.id, true)

      expect(await openQuestionWaits(unrelated.id)).toHaveLength(0)
    })

    it('fences continuation claims when blocking opens and resets the generation when answered', async () => {
      const agent = await createAgent({ squadId: squad.id })
      const origin = await createStreamFor(agent.id, 'continuation-fence')
      await db
        .update(workStreamContinuations)
        .set({
          generation: 4,
          status: 'pending',
          claimToken: crypto.randomUUID(),
          claimedAt: new Date(),
        })
        .where(eq(workStreamContinuations.workStreamId, origin.id))

      const q = await createQuestion(agent, { blocking: true }, [origin.id])
      let [cycle] = await db
        .select()
        .from(workStreamContinuations)
        .where(eq(workStreamContinuations.workStreamId, origin.id))
      expect(cycle.generation).toBe(5)
      expect(cycle.status).toBe('idle')
      expect(cycle.claimToken).toBeNull()

      await answerAgentQuestion(q.id, 'done', user.id)
      ;[cycle] = await db
        .select()
        .from(workStreamContinuations)
        .where(eq(workStreamContinuations.workStreamId, origin.id))
      expect(cycle.generation).toBe(6)
      expect(cycle.status).toBe('idle')
    })

    it('opens and clears trusted origin waits for a dormant question', async () => {
      const agent = await createAgent({ squadId: squad.id })
      const origin = await createStreamFor(agent.id, 'dormant-origin')
      const question = await createQuestion(agent, {}, [origin.id])
      await db.update(executions).set({ status: 'completed' }).where(eq(executions.agentId, agent.id))
      await makeDormant(agent)

      expect(await setQuestionBlocking(question.id, true)).not.toBeNull()
      expect(await openQuestionWaits(origin.id)).toHaveLength(1)
      expect((await Agent.mustFind(agent.id)).status).toBe('dormant')

      expect(await setQuestionBlocking(question.id, false)).not.toBeNull()
      expect(await openQuestionWaits(origin.id)).toHaveLength(0)
      expect((await Agent.mustFind(agent.id)).status).toBe('dormant')
    })

    it('manager conversion waits only on persisted exact origins and remains idempotent', async () => {
      const agent = await createAgent({ squadId: squad.id })
      const origin = await createStreamFor(agent.id, 'origin')
      const unrelated = await createStreamFor(agent.id, 'unrelated')
      const q = await createQuestion(agent, {}, [origin.id])
      const updatedEvents: Array<{ workStreamId: string }> = []
      const unsubscribe = eventEmitter.on('workStream.updated', (event) => updatedEvents.push(event))

      await setQuestionBlocking(q.id, true)
      await setQuestionBlocking(q.id, true)
      expect(updatedEvents.map((event) => event.workStreamId)).toEqual([origin.id])
      expect(await openQuestionWaits(origin.id)).toHaveLength(1)
      expect(await openQuestionWaits(unrelated.id)).toHaveLength(0)

      await setQuestionBlocking(q.id, false)
      unsubscribe()
      expect(updatedEvents.map((event) => event.workStreamId)).toEqual([origin.id, origin.id])
      expect(await openQuestionWaits(origin.id)).toHaveLength(0)
      const [cleared] = await db
        .select()
        .from(workStreamWaits)
        .where(and(eq(workStreamWaits.referenceId, q.id), eq(workStreamWaits.type, 'question')))
      expect(cleared.resolution).toBe('cleared')

      await answerAgentQuestion(q.id, 'done', user.id)
      expect(await setQuestionBlocking(q.id, true)).toBeNull()
    })
  })

  describe('question dismissal', () => {
    async function createStreamFor(agentId: string, title: string): Promise<WorkStream> {
      return storedLegacyWorkStream({
        squadId: squad.id,
        title: `${prefix} ${title}`,
        assigneeAgentId: agentId,
        agentIds: [agentId],
      })
    }

    afterEach(async () => {
      await db.delete(workStreams).where(eq(workStreams.squadId, squad.id))
    })

    it('dismisses an open question without delivering anything to the asking agent', async () => {
      const agent = await createAgent({ squadId: squad.id, ownerUserId: user.id })
      const dismissedEvents: unknown[] = []
      const unsubscribe = eventEmitter.on('agent-question.dismissed', (event) => dismissedEvents.push(event))
      const q = await createQuestion(agent)

      const dismissed = await dismissAgentQuestion(q.id, { dismissedBy: { type: 'user', userId: user.id } })
      unsubscribe()

      expect(dismissed?.status).toBe('dismissed')
      expect(dismissed?.dismissedAt).toBeTruthy()
      expect(dismissed?.dismissalReason).toBe('user-dismissed')
      expect(dismissed?.dismissedByUserId).toBe(user.id)
      expect(dismissed?.dismissedByAgentId).toBeNull()
      expect(dismissedEvents).toEqual([{ questionId: q.id, agentId: agent.id, squadId: squad.id }])

      const msgs = await db
        .select()
        .from(inbox)
        .where(and(eq(inbox.recipientType, 'agent'), eq(inbox.recipientId, agent.id)))
      expect(msgs).toHaveLength(0)
      expect(await dismissAgentQuestion(q.id, { dismissedBy: { type: 'user', userId: user.id } })).toBeNull()
      expect(await answerAgentQuestion(q.id, 'late', user.id)).toBeNull()
    })

    it('records agent attribution and an optional reason', async () => {
      const agent = await createAgent({ squadId: squad.id })
      const manager = await createAgent({ squadId: squad.id, ownerUserId: user.id })
      const q = await createQuestion(agent)

      const dismissed = await dismissAgentQuestion(q.id, {
        reason: '  stale question  ',
        dismissedBy: { type: 'agent', agentId: manager.id },
      })

      expect(dismissed?.dismissalReason).toBe('agent-dismissed: stale question')
      expect(dismissed?.dismissedByAgentId).toBe(manager.id)
      expect(dismissed?.dismissedByUserId).toBeNull()
    })

    it('closes blocking waits as cleared and resets continuations in the same transaction', async () => {
      const agent = await createAgent({ squadId: squad.id })
      const origin = await createStreamFor(agent.id, 'dismiss-wait')
      await db
        .update(workStreamContinuations)
        .set({ generation: 4, status: 'pending', claimToken: crypto.randomUUID(), claimedAt: new Date() })
        .where(eq(workStreamContinuations.workStreamId, origin.id))
      const q = await createQuestion(agent, { blocking: true }, [origin.id])

      const dismissed = await dismissAgentQuestion(q.id, { dismissedBy: { type: 'user', userId: user.id } })
      expect(dismissed?.status).toBe('dismissed')

      const waits = await db.select().from(workStreamWaits).where(eq(workStreamWaits.referenceId, q.id))
      expect(waits.length).toBeGreaterThan(0)
      expect(waits.every((wait) => wait.closedAt !== null && wait.resolution === 'cleared')).toBe(true)
      const [cycle] = await db
        .select()
        .from(workStreamContinuations)
        .where(eq(workStreamContinuations.workStreamId, origin.id))
      expect(cycle.generation).toBe(6)
      expect(cycle.status).toBe('idle')
      expect(cycle.claimToken).toBeNull()
    })

    it('rolls back the status and wait close when dismissal fails', async () => {
      const agent = await createAgent({ squadId: squad.id })
      const origin = await createStreamFor(agent.id, 'dismiss-rollback')
      const q = await createQuestion(agent, { blocking: true }, [origin.id])

      await expect(
        dismissAgentQuestion(q.id, {
          dismissedBy: { type: 'user', userId: user.id },
          testHooks: { duringWaitClose: () => Promise.reject(new Error('boom')) },
        })
      ).rejects.toThrow('boom')

      expect((await getAgentQuestion(q.id))?.status).toBe('open')
      const waits = await db.select().from(workStreamWaits).where(eq(workStreamWaits.referenceId, q.id))
      expect(waits.every((wait) => wait.closedAt === null)).toBe(true)
    })

    it('rejects dismissal when private ownership changes before the agent scope lock', async () => {
      const agent = await createAgent({ ownerUserId: user.id })
      const nextOwner = await createTestUser({ prefix })
      createdUserIds.push(nextOwner.id)
      const q = await createQuestion(agent)

      const dismissed = await dismissAgentQuestion(q.id, {
        dismissedBy: { type: 'user', userId: user.id },
        expectedAgentScope: { ownerUserId: user.id, squadId: null },
        testHooks: {
          beforeAgentScopeLock: () =>
            db
              .update(agents)
              .set({ ownerUserId: nextOwner.id })
              .where(eq(agents.id, agent.id))
              .then(() => undefined),
        },
      })

      expect(dismissed).toBeNull()
      expect((await getAgentQuestion(q.id))?.status).toBe('open')
    })

    it('dismisses when the asking agent is terminated', async () => {
      const agent = await createAgent({ squadId: squad.id })
      const q = await createQuestion(agent)
      await db.update(agents).set({ status: 'terminated', terminatedAt: new Date() }).where(eq(agents.id, agent.id))

      const dismissed = await dismissAgentQuestion(q.id, { dismissedBy: { type: 'user', userId: user.id } })
      expect(dismissed?.status).toBe('dismissed')
    })
  })

  describe('relayed answer resolution', () => {
    async function createStreamFor(agentId: string, title: string): Promise<WorkStream> {
      return storedLegacyWorkStream({
        squadId: squad.id,
        title: `${prefix} ${title}`,
        assigneeAgentId: agentId,
        agentIds: [agentId],
      })
    }

    afterEach(async () => {
      await db.delete(workStreams).where(eq(workStreams.squadId, squad.id))
    })

    const SOURCE = 'https://github.com/ficushq/ficus/pull/1#discussion_r1'

    it('records the relayed answer, closes only its own question waits, and delivers nothing', async () => {
      const agent = await createAgent({ squadId: squad.id })
      const otherAgent = await createAgent({ squadId: squad.id })
      const origin = await createStreamFor(agent.id, 'relay-wait')
      await db
        .update(workStreams)
        .set({ agentIds: [agent.id, otherAgent.id] })
        .where(eq(workStreams.id, origin.id))
      await db
        .update(workStreamContinuations)
        .set({ generation: 4, status: 'pending', claimToken: crypto.randomUUID(), claimedAt: new Date() })
        .where(eq(workStreamContinuations.workStreamId, origin.id))
      const q = await createQuestion(agent, { blocking: true }, [origin.id])
      const otherQuestion = await createQuestion(otherAgent, { blocking: true }, [origin.id])
      const unrelated = await db.transaction(async (tx) => {
        const { openWait } = await import('../work-streams/waits')
        const review = await openWait(tx, { workStreamId: origin.id, type: 'review', scope: 'stream' })
        const manual = await openWait(tx, { workStreamId: origin.id, type: 'manual', scope: 'stream' })
        return [review.wait.id, manual.wait.id]
      })
      const answeredEvents: unknown[] = []
      const unsubscribe = eventEmitter.on('agent-question.answered', (event) => answeredEvents.push(event))
      const ensureFlowDispatch = spyOn(await import('../workflows/execution'), 'ensureFlowDispatch')

      let resolved: Awaited<ReturnType<typeof resolveAgentQuestionWithRelayedAnswer>> = null
      try {
        resolved = await resolveAgentQuestionWithRelayedAnswer(q.id, {
          relayedByAgentId: agent.id,
          answer: '  Yes, ship it.  ',
          source: ` ${SOURCE} `,
        })
        expect(ensureFlowDispatch).toHaveBeenCalledWith(origin.id)
      } finally {
        ensureFlowDispatch.mockRestore()
        unsubscribe()
      }
      await waitForQuestionAnswerDeliveryDrains()

      expect(resolved).toMatchObject({
        status: 'answered',
        answer: 'Yes, ship it.',
        answerSource: SOURCE,
        answerRelayedByAgentId: agent.id,
        answeredByUserId: null,
      })
      expect(resolved?.answeredAt).toBeTruthy()
      expect(resolved?.answerDelivery).toBeUndefined()
      expect(answeredEvents).toEqual([{ questionId: q.id, agentId: agent.id, squadId: squad.id }])
      expect((await listAgentQuestions(agent.id, { statuses: ['answered', 'dismissed'] })).map((x) => x.id)).toEqual([
        q.id,
      ])

      const [ownWait] = await db.select().from(workStreamWaits).where(eq(workStreamWaits.referenceId, q.id))
      expect(ownWait.closedAt).not.toBeNull()
      expect(ownWait.resolution).toBe('answered')
      expect(ownWait.resolutionNote).toBe(`Answered outside Ficus; relayed by the asking agent from ${SOURCE}`)
      const [otherWait] = await db
        .select()
        .from(workStreamWaits)
        .where(eq(workStreamWaits.referenceId, otherQuestion.id))
      expect(otherWait.closedAt).toBeNull()
      const stillOpen = await db.select().from(workStreamWaits).where(inArray(workStreamWaits.id, unrelated))
      expect(stillOpen.every((wait) => wait.closedAt === null)).toBe(true)
      expect((await getAgentQuestion(otherQuestion.id))?.status).toBe('open')

      const [cycle] = await db
        .select()
        .from(workStreamContinuations)
        .where(eq(workStreamContinuations.workStreamId, origin.id))
      expect(cycle.status).toBe('idle')
      expect(cycle.claimToken).toBeNull()

      const msgs = await db
        .select()
        .from(inbox)
        .where(and(eq(inbox.recipientType, 'agent'), eq(inbox.recipientId, agent.id)))
      expect(msgs).toHaveLength(0)
      const [row] = await db.select().from(agentQuestions).where(eq(agentQuestions.id, q.id))
      expect(row.answerDeliveryStatus).toBeNull()
    })

    it("refuses another agent's question and any question that is no longer open", async () => {
      const agent = await createAgent({ squadId: squad.id })
      const otherAgent = await createAgent({ squadId: squad.id })
      const q = await createQuestion(agent)

      expect(
        await resolveAgentQuestionWithRelayedAnswer(q.id, {
          relayedByAgentId: otherAgent.id,
          answer: 'yes',
          source: SOURCE,
        })
      ).toBeNull()
      expect((await getAgentQuestion(q.id))?.status).toBe('open')

      await answerAgentQuestion(q.id, 'direct', user.id)
      expect(
        await resolveAgentQuestionWithRelayedAnswer(q.id, { relayedByAgentId: agent.id, answer: 'yes', source: SOURCE })
      ).toBeNull()
      expect(await getAgentQuestion(q.id)).toMatchObject({ answer: 'direct', answerRelayedByAgentId: null })

      const dismissedQuestion = await createQuestion(agent)
      await dismissAgentQuestion(dismissedQuestion.id, { dismissedBy: { type: 'user', userId: user.id } })
      expect(
        await resolveAgentQuestionWithRelayedAnswer(dismissedQuestion.id, {
          relayedByAgentId: agent.id,
          answer: 'yes',
          source: SOURCE,
        })
      ).toBeNull()
      expect((await getAgentQuestion(dismissedQuestion.id))?.status).toBe('dismissed')
    })

    it('requires a non-blank answer and source', async () => {
      const agent = await createAgent({ squadId: squad.id })
      const q = await createQuestion(agent)
      await expect(
        resolveAgentQuestionWithRelayedAnswer(q.id, { relayedByAgentId: agent.id, answer: '  ', source: SOURCE })
      ).rejects.toThrow('answer is required')
      await expect(
        resolveAgentQuestionWithRelayedAnswer(q.id, { relayedByAgentId: agent.id, answer: 'yes', source: ' ' })
      ).rejects.toThrow('source is required')
      expect((await getAgentQuestion(q.id))?.status).toBe('open')
    })

    it('rolls back the answer when the wait close fails', async () => {
      const agent = await createAgent({ squadId: squad.id })
      const origin = await createStreamFor(agent.id, 'relay-rollback')
      const q = await createQuestion(agent, { blocking: true }, [origin.id])

      await expect(
        resolveAgentQuestionWithRelayedAnswer(q.id, {
          relayedByAgentId: agent.id,
          answer: 'yes',
          source: SOURCE,
          testHooks: { duringWaitClose: () => Promise.reject(new Error('boom')) },
        })
      ).rejects.toThrow('boom')

      expect(await getAgentQuestion(q.id)).toMatchObject({ status: 'open', answer: null, answerSource: null })
      const waits = await db.select().from(workStreamWaits).where(eq(workStreamWaits.referenceId, q.id))
      expect(waits.length).toBeGreaterThan(0)
      expect(waits.every((wait) => wait.closedAt === null)).toBe(true)
    })
  })
})
