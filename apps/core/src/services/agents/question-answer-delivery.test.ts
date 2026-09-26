import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { and, eq, like } from 'drizzle-orm'
import { db } from '../../db'
import { agentQuestions, agents, agentTypes, chatSendReceipts, executions, inbox, squads, users } from '../../db/schema'
import { Agent } from '../../entities/Agent'
import { InboxMessage } from '../../entities/InboxMessage'
import { AgentType } from '../../entities/AgentType'
import { Squad } from '../../entities/Squad'
import { User } from '../../entities/User'
import { eventEmitter } from '../../lib/infra/event-emitter'
import { QUESTION_ANSWER_DELIVERY_LEASE_MS, reconcileQuestionAnswerDeliveriesOnce } from './question-answer-delivery'
import { retryAgentQuestionAnswerDelivery } from './questions'
import { reconcileQuestionDeliveryFailureAlertsOnce } from './question-delivery-failure-alert'

const QUESTION = { questions: [{ id: 'q1', type: 'text' as const, question: 'Ship it?' }] }

describe('question answer delivery outbox', () => {
  let prefix: string
  let agentTypeId: string
  let squad: Squad
  let agent: Agent
  let user: User

  beforeEach(async () => {
    prefix = `question-delivery-${crypto.randomUUID()}`
    agentTypeId = `${prefix}-type`
    await AgentType.create({ id: agentTypeId, name: 'Question delivery', model: 'test:model', systemPrompt: 'test' })
    squad = await Squad.create({ name: prefix, purpose: 'answer delivery tests' })
    agent = await Agent.create({ agentTypeId, squadId: squad.id })
    user = await User.create({ email: `${prefix}@example.com`, displayName: 'Answerer' })
  })

  afterEach(async () => {
    await db.delete(agents).where(eq(agents.id, agent.id))
    await db.delete(squads).where(eq(squads.id, squad.id))
    await db.delete(agentTypes).where(eq(agentTypes.id, agentTypeId))
    await db.delete(users).where(eq(users.id, user.id))
  })

  async function createPendingDelivery() {
    const now = new Date('2026-08-29T00:00:00.000Z')
    const [question] = await db
      .insert(agentQuestions)
      .values({
        agentId: agent.id,
        squadId: squad.id,
        questionData: QUESTION,
        status: 'answered',
        answer: 'Yes, ship it',
        answeredByUserId: user.id,
        answeredAt: now,
        answerDeliveryStatus: 'pending',
        answerDeliveryNextAttemptAt: now,
      })
      .returning()
    return { question, now }
  }

  it('claims and durably delivers one pending answer exactly once', async () => {
    const { question, now } = await createPendingDelivery()

    const [first, second] = await Promise.all([
      reconcileQuestionAnswerDeliveriesOnce({ now }),
      reconcileQuestionAnswerDeliveriesOnce({ now }),
    ])

    expect(first.processed + second.processed).toBe(1)
    const [row] = await db.select().from(agentQuestions).where(eq(agentQuestions.id, question.id))
    expect(row.answerDeliveryStatus).toBe('delivered')
    expect(row.answerDeliveryInboxMessageId).not.toBeNull()
    expect(row.answerDeliveryMessageId).not.toBeNull()
    expect(row.answerDeliveryExecutionId).not.toBeNull()
    expect(
      await db
        .select()
        .from(inbox)
        .where(eq(inbox.idempotencyKey, `agent-question-answer:v1:${question.id}`))
    ).toHaveLength(1)
    expect(
      await db
        .select()
        .from(chatSendReceipts)
        .where(eq(chatSendReceipts.clientId, `agent-question-answer:v1:${question.id}:inbox`))
    ).toHaveLength(1)

    expect(await reconcileQuestionAnswerDeliveriesOnce({ now })).toEqual({ processed: 0, delivered: 0, failed: 0 })
  })

  it('adopts the same durable inbox and chat receipts after crashes', async () => {
    const { question, now } = await createPendingDelivery()

    await reconcileQuestionAnswerDeliveriesOnce({
      now,
      testHooks: { afterInboxPersisted: async () => Promise.reject(new Error('crash after inbox')) },
    })
    let [row] = await db.select().from(agentQuestions).where(eq(agentQuestions.id, question.id))
    expect(row.answerDeliveryStatus).toBe('pending')
    expect(row.answerDeliveryAttemptCount).toBe(1)
    const unread = await InboxMessage.listUnread('agent', agent.id)
    expect(unread).toHaveLength(1)
    expect(await InboxMessage.listUndeliveredUnread('agent', agent.id)).toHaveLength(0)
    expect(await InboxMessage.claimForDelivery(unread)).toHaveLength(0)
    await db.update(agentQuestions).set({ answerDeliveryNextAttemptAt: now }).where(eq(agentQuestions.id, question.id))

    await reconcileQuestionAnswerDeliveriesOnce({ now })
    ;[row] = await db.select().from(agentQuestions).where(eq(agentQuestions.id, question.id))
    expect(row.answerDeliveryStatus).toBe('delivered')
    expect(
      await db
        .select()
        .from(inbox)
        .where(like(inbox.idempotencyKey, `agent-question-answer:v1:${question.id}%`))
    ).toHaveLength(1)
    expect(
      await db
        .select()
        .from(chatSendReceipts)
        .where(eq(chatSendReceipts.clientId, `agent-question-answer:v1:${question.id}:inbox`))
    ).toHaveLength(1)
  })

  it('adopts accepted delivery when termination wins before question settlement', async () => {
    const { question, now } = await createPendingDelivery()
    expect(
      await reconcileQuestionAnswerDeliveriesOnce({
        now,
        questionId: question.id,
        testHooks: { afterAgentSend: async () => void (await agent.update({ terminatedAt: new Date() })) },
      })
    ).toEqual({ processed: 1, delivered: 1, failed: 0 })

    const [row] = await db.select().from(agentQuestions).where(eq(agentQuestions.id, question.id))
    expect(row.answerDeliveryStatus).toBe('delivered')
    expect(row.answerDeliveryMessageId).not.toBeNull()
    expect(row.answerDeliveryExecutionId).not.toBeNull()
    expect(row.answerDeliveryInboxMessageId).not.toBeNull()
    expect(
      (await db.select().from(inbox)).filter(
        (message) =>
          (message.metadata as { source?: string; questionId?: string } | null)?.source ===
            'agent-question-delivery-failure' &&
          (message.metadata as { questionId?: string } | null)?.questionId === question.id
      )
    ).toHaveLength(0)
  })

  it('reclaims an expired delivery lease', async () => {
    const { question, now } = await createPendingDelivery()
    await db
      .update(agentQuestions)
      .set({
        answerDeliveryStatus: 'delivering',
        answerDeliveryClaimToken: crypto.randomUUID(),
        answerDeliveryClaimedAt: new Date(now.getTime() - QUESTION_ANSWER_DELIVERY_LEASE_MS - 1),
      })
      .where(eq(agentQuestions.id, question.id))

    expect(await reconcileQuestionAnswerDeliveriesOnce({ now })).toEqual({ processed: 1, delivered: 1, failed: 0 })
  })

  it('backs off transient failures, exhausts at the max, and deduplicates the durable system alert', async () => {
    const { question, now } = await createPendingDelivery()
    let attemptAt = now
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      expect(
        await reconcileQuestionAnswerDeliveriesOnce({
          now: attemptAt,
          testHooks: { afterInboxPersisted: async () => Promise.reject(new Error(`transient ${attempt}`)) },
        })
      ).toEqual({ processed: 1, delivered: 0, failed: attempt === 5 ? 1 : 0 })
      const [row] = await db.select().from(agentQuestions).where(eq(agentQuestions.id, question.id))
      expect(row.answerDeliveryAttemptCount).toBe(attempt)
      if (attempt < 5) {
        expect(row.answerDeliveryStatus).toBe('pending')
        expect(row.answerDeliveryNextAttemptAt!.getTime()).toBeGreaterThan(attemptAt.getTime())
        attemptAt = row.answerDeliveryNextAttemptAt!
      } else {
        expect(row.answerDeliveryStatus).toBe('failed')
      }
    }

    await reconcileQuestionDeliveryFailureAlertsOnce()
    const alerts = (await db.select().from(inbox)).filter(
      (message) =>
        message.recipientType === 'system' &&
        (message.metadata as { source?: string; questionId?: string } | null)?.source ===
          'agent-question-delivery-failure' &&
        (message.metadata as { questionId?: string } | null)?.questionId === question.id
    )
    expect(alerts).toHaveLength(1)
  })

  it('paginates past durable alerts instead of starving later failed generations', async () => {
    const ids = [
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
      '00000000-0000-4000-8000-000000000003',
    ]
    await db.insert(agentQuestions).values(
      ids.map((id) => ({
        id,
        agentId: agent.id,
        squadId: squad.id,
        questionData: QUESTION,
        status: 'answered' as const,
        answer: 'accepted',
        answeredByUserId: user.id,
        answeredAt: new Date(),
        answerDeliveryStatus: 'failed' as const,
        answerDeliveryGeneration: 7,
        answerDeliveryLastError: 'terminal',
      }))
    )

    await reconcileQuestionDeliveryFailureAlertsOnce(2)
    await reconcileQuestionDeliveryFailureAlertsOnce(2)
    const alerts = (await db.select().from(inbox)).filter((message) => {
      const metadata = message.metadata as { source?: string; questionId?: string } | null
      return metadata?.source === 'agent-question-delivery-failure' && ids.includes(metadata.questionId ?? '')
    })
    expect(alerts.map((message) => (message.metadata as { questionId: string }).questionId).sort()).toEqual(ids)
  })

  it('retries a failed alert write because no durable idempotency record exists', async () => {
    const id = '00000000-0000-4000-8000-000000000000'
    await db.insert(agentQuestions).values({
      id,
      agentId: agent.id,
      squadId: squad.id,
      questionData: QUESTION,
      status: 'answered',
      answer: 'accepted',
      answeredByUserId: user.id,
      answeredAt: new Date(),
      answerDeliveryStatus: 'failed',
      answerDeliveryGeneration: 9,
      answerDeliveryLastError: 'terminal',
    })

    await expect(
      reconcileQuestionDeliveryFailureAlertsOnce(1, {
        alert: async () => Promise.reject(new Error('inbox write unavailable')),
      })
    ).rejects.toThrow('inbox write unavailable')
    expect(
      await db
        .select()
        .from(inbox)
        .where(like(inbox.idempotencyKey, `%${id}:9`))
    ).toHaveLength(0)

    await reconcileQuestionDeliveryFailureAlertsOnce(1)
    expect(
      await db
        .select()
        .from(inbox)
        .where(like(inbox.idempotencyKey, `%${id}:9`))
    ).toHaveLength(1)
  })

  it('reconciles terminal failure from an accepted receipt without resending or changing the answer', async () => {
    const { question, now } = await createPendingDelivery()
    await reconcileQuestionAnswerDeliveriesOnce({
      now,
      testHooks: {
        afterAgentSend: async () => {
          throw new Error('lost confirmation after acceptance')
        },
      },
    })
    await db
      .update(agentQuestions)
      .set({ answerDeliveryStatus: 'failed', answerDeliveryNextAttemptAt: null })
      .where(eq(agentQuestions.id, question.id))

    expect(await reconcileQuestionAnswerDeliveriesOnce({ now, questionId: question.id })).toEqual({
      processed: 0,
      delivered: 1,
      failed: 0,
    })
    const [row] = await db.select().from(agentQuestions).where(eq(agentQuestions.id, question.id))
    expect(row).toMatchObject({ status: 'answered', answer: 'Yes, ship it', answerDeliveryStatus: 'delivered' })
    expect(row.answerDeliveryMessageId).not.toBeNull()
    expect(row.answerDeliveryExecutionId).not.toBeNull()
    expect(
      await db
        .select()
        .from(chatSendReceipts)
        .where(eq(chatSendReceipts.clientId, `agent-question-answer:v1:${question.id}:inbox`))
    ).toHaveLength(1)
  })

  it('reconciles accepted failure on explicit retry without incrementing generation or sending again', async () => {
    const { question, now } = await createPendingDelivery()
    await reconcileQuestionAnswerDeliveriesOnce({
      now,
      testHooks: {
        afterAgentSend: async () => {
          throw new Error('lost settlement')
        },
      },
    })
    await db
      .update(agentQuestions)
      .set({ answerDeliveryStatus: 'failed', answerDeliveryNextAttemptAt: null })
      .where(eq(agentQuestions.id, question.id))
    expect((await retryAgentQuestionAnswerDelivery(question.id))?.answerDelivery).toMatchObject({
      status: 'delivered',
      generation: 1,
    })
    expect(
      await db
        .select()
        .from(chatSendReceipts)
        .where(eq(chatSendReceipts.clientId, `agent-question-answer:v1:${question.id}:inbox`))
    ).toHaveLength(1)
  })

  it('requires an accepted receipt, not only receipt identities, and never sends on a failed-row sweep', async () => {
    const { question, now } = await createPendingDelivery()
    await reconcileQuestionAnswerDeliveriesOnce({
      now,
      testHooks: {
        afterAgentSend: async () => {
          throw new Error('lost settlement')
        },
      },
    })
    const clientId = `agent-question-answer:v1:${question.id}:inbox`
    await db.update(chatSendReceipts).set({ state: 'pending' }).where(eq(chatSendReceipts.clientId, clientId))
    await db
      .update(agentQuestions)
      .set({ answerDeliveryStatus: 'failed', answerDeliveryNextAttemptAt: null })
      .where(eq(agentQuestions.id, question.id))
    expect(await reconcileQuestionAnswerDeliveriesOnce({ now, questionId: question.id })).toEqual({
      processed: 0,
      delivered: 0,
      failed: 0,
    })
    await db.update(chatSendReceipts).set({ state: 'accepted' }).where(eq(chatSendReceipts.clientId, clientId))
    expect(await reconcileQuestionAnswerDeliveriesOnce({ now, questionId: question.id })).toEqual({
      processed: 0,
      delivered: 1,
      failed: 0,
    })
    expect(await db.select().from(chatSendReceipts).where(eq(chatSendReceipts.clientId, clientId))).toHaveLength(1)
  })

  it('does not reconcile a failed answer from inbox persistence alone', async () => {
    const { question, now } = await createPendingDelivery()
    await reconcileQuestionAnswerDeliveriesOnce({
      now,
      testHooks: {
        afterInboxPersisted: async () => {
          throw new Error('not accepted')
        },
      },
    })
    await db
      .update(agentQuestions)
      .set({ answerDeliveryStatus: 'failed', answerDeliveryNextAttemptAt: null })
      .where(eq(agentQuestions.id, question.id))
    expect(await reconcileQuestionAnswerDeliveriesOnce({ now, questionId: question.id })).toEqual({
      processed: 0,
      delivered: 0,
      failed: 0,
    })
    const [row] = await db.select().from(agentQuestions).where(eq(agentQuestions.id, question.id))
    expect(row.answerDeliveryStatus).toBe('failed')
    expect(row.answerDeliveredAt).toBeNull()
  })

  it('adopts a prior Agent.sendMessage acceptance after a crash', async () => {
    const { question, now } = await createPendingDelivery()
    await reconcileQuestionAnswerDeliveriesOnce({
      now,
      testHooks: { afterAgentSend: async () => Promise.reject(new Error('crash after acceptance')) },
    })
    await db.update(agentQuestions).set({ answerDeliveryNextAttemptAt: now }).where(eq(agentQuestions.id, question.id))

    expect(await reconcileQuestionAnswerDeliveriesOnce({ now })).toEqual({ processed: 1, delivered: 1, failed: 0 })
    expect(
      await db
        .select()
        .from(chatSendReceipts)
        .where(eq(chatSendReceipts.clientId, `agent-question-answer:v1:${question.id}:inbox`))
    ).toHaveLength(1)
  })

  it('cannot settle a stale generation after acceptance', async () => {
    const { question, now } = await createPendingDelivery()
    await reconcileQuestionAnswerDeliveriesOnce({
      now,
      testHooks: {
        afterAgentSend: async () => {
          await db
            .update(agentQuestions)
            .set({
              answerDeliveryGeneration: 2,
              answerDeliveryStatus: 'pending',
              answerDeliveryClaimToken: null,
              answerDeliveryClaimedAt: null,
              answerDeliveryNextAttemptAt: new Date(now.getTime() + 60_000),
            })
            .where(eq(agentQuestions.id, question.id))
        },
      },
    })
    const [row] = await db.select().from(agentQuestions).where(eq(agentQuestions.id, question.id))
    expect(row).toMatchObject({ answerDeliveryGeneration: 2, answerDeliveryStatus: 'pending' })
    expect(row.answerDeliveredAt).toBeNull()
  })

  it('never selects legacy answered rows with null delivery state', async () => {
    const [legacy] = await db
      .insert(agentQuestions)
      .values({
        agentId: agent.id,
        squadId: squad.id,
        questionData: QUESTION,
        status: 'answered',
        answer: 'legacy',
        answeredByUserId: user.id,
        answeredAt: new Date(),
        answerDeliveryStatus: null,
        answerDeliveryNextAttemptAt: null,
      })
      .returning()

    expect(await reconcileQuestionAnswerDeliveriesOnce({ now: new Date(), questionId: legacy.id })).toEqual({
      processed: 0,
      delivered: 0,
      failed: 0,
    })
  })

  it('fails safely before accepting delivery while agent termination is pending', async () => {
    const { question, now } = await createPendingDelivery()
    await db.update(agents).set({ pendingDormancyAt: now }).where(eq(agents.id, agent.id))

    expect(await reconcileQuestionAnswerDeliveriesOnce({ now, questionId: question.id })).toEqual({
      processed: 1,
      delivered: 0,
      failed: 1,
    })
    const [row] = await db.select().from(agentQuestions).where(eq(agentQuestions.id, question.id))
    expect(row.answerDeliveryStatus).toBe('failed')
    expect(row.answerDeliveryLastError).toContain('terminating')
    expect(
      await db
        .select()
        .from(inbox)
        .where(and(eq(inbox.recipientId, agent.id), eq(inbox.recipientType, 'agent')))
    ).toHaveLength(0)
    expect(
      await db
        .select()
        .from(chatSendReceipts)
        .where(eq(chatSendReceipts.clientId, `agent-question-answer:v1:${question.id}:inbox`))
    ).toHaveLength(0)
    expect(await db.select().from(executions).where(eq(executions.agentId, agent.id))).toHaveLength(0)
  })

  it('marks a terminated recipient as a visible terminal delivery failure', async () => {
    const { question, now } = await createPendingDelivery()
    await db.update(agents).set({ status: 'terminated', terminatedAt: now }).where(eq(agents.id, agent.id))
    const events: unknown[] = []
    const unsubscribe = eventEmitter.on('agent-question.delivery-failed', (event) => events.push(event))

    expect(await reconcileQuestionAnswerDeliveriesOnce({ now })).toEqual({ processed: 1, delivered: 0, failed: 1 })
    unsubscribe()
    expect(events).toEqual([{ questionId: question.id, agentId: agent.id, squadId: squad.id }])
    const [row] = await db.select().from(agentQuestions).where(eq(agentQuestions.id, question.id))
    expect(row.answerDeliveryStatus).toBe('failed')
    expect(row.answerDeliveryLastError).toContain('terminated')
    await reconcileQuestionDeliveryFailureAlertsOnce()
    expect(
      (await db.select().from(inbox)).filter(
        (message) =>
          message.recipientType === 'system' &&
          (message.metadata as { source?: string; questionId?: string } | null)?.source ===
            'agent-question-delivery-failure' &&
          (message.metadata as { questionId?: string } | null)?.questionId === question.id
      )
    ).toHaveLength(1)
    expect(
      await db
        .select()
        .from(inbox)
        .where(and(eq(inbox.recipientId, agent.id), eq(inbox.recipientType, 'agent')))
    ).toHaveLength(0)
  })
})
