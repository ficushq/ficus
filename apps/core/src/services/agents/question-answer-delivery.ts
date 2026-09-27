import { FlowWaitSupersededError } from '../work-streams/wait-scope'
import { and, eq, isNotNull, lte, or, sql } from 'drizzle-orm'
import { db } from '../../db'
import { agentQuestions, agents, chatSendReceipts, executions, inbox, messages } from '../../db/schema'
import { Agent } from '../../entities/Agent'
import { chatSendRequestHashes } from './chat-send-request-hash'
import { InboxMessage } from '../../entities/InboxMessage'
import { createPeriodicRunner, type PeriodicRunner } from '../../lib/infra/PeriodicRunner'
import { createLogger } from '../../lib/infra/logger'
import { eventEmitter } from '../../lib/infra/event-emitter'
import { prepareInboxDelivery } from '../inbox/inboxDelivery'
import {
  ensureQuestionDeliveryFailureAlert,
  reconcileQuestionDeliveryFailureAlertsOnce,
} from './question-delivery-failure-alert'

const log = createLogger('question-answer-delivery')

export const QUESTION_ANSWER_DELIVERY_INTERVAL_MS = 30_000
export const QUESTION_ANSWER_DELIVERY_LEASE_MS = 2 * 60_000
export const QUESTION_ANSWER_DELIVERY_MAX_ATTEMPTS = 5
const QUESTION_ANSWER_DELIVERY_BATCH_SIZE = 20
const QUESTION_ANSWER_DELIVERY_MAX_BACKOFF_MS = 5 * 60_000

let runner: PeriodicRunner | null = null
const inlineDrains = new Set<Promise<unknown>>()

async function alertTerminalFailure(questionId: string): Promise<void> {
  try {
    await ensureQuestionDeliveryFailureAlert(questionId)
  } catch (error) {
    log.warn(`Failure alert for question ${questionId.slice(0, 8)} will be retried:`, error)
  }
}

export interface QuestionAnswerDeliveryTestHooks {
  afterInboxPersisted?: () => Promise<void>
  afterAgentSend?: () => Promise<void>
}

export interface ReconcileQuestionAnswerDeliveriesOptions {
  now?: Date
  questionId?: string
  testHooks?: QuestionAnswerDeliveryTestHooks
}

function retryDelay(attempt: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, attempt - 1), QUESTION_ANSWER_DELIVERY_MAX_BACKOFF_MS)
}

function answerContent(row: typeof agentQuestions.$inferSelect): string {
  const data = row.questionData as { questions?: Array<{ question?: string }> } | null
  const questionText = data?.questions
    ?.map((question) => question.question)
    .filter(Boolean)
    .join('\n')
  return questionText ? `**Question:** ${questionText}\n\n**Answer:** ${row.answer ?? ''}` : (row.answer ?? '')
}

async function claimDueDeliveries(now: Date, questionId?: string) {
  const leaseExpiredAt = new Date(now.getTime() - QUESTION_ANSWER_DELIVERY_LEASE_MS)
  const due = or(
    and(
      eq(agentQuestions.answerDeliveryStatus, 'pending'),
      isNotNull(agentQuestions.answerDeliveryNextAttemptAt),
      lte(agentQuestions.answerDeliveryNextAttemptAt, now)
    ),
    and(
      eq(agentQuestions.answerDeliveryStatus, 'delivering'),
      isNotNull(agentQuestions.answerDeliveryClaimToken),
      isNotNull(agentQuestions.answerDeliveryClaimedAt),
      lte(agentQuestions.answerDeliveryClaimedAt, leaseExpiredAt)
    )
  )
  const candidates = await db
    .select({ id: agentQuestions.id, generation: agentQuestions.answerDeliveryGeneration })
    .from(agentQuestions)
    .where(and(eq(agentQuestions.status, 'answered'), due, ...(questionId ? [eq(agentQuestions.id, questionId)] : [])))
    .limit(QUESTION_ANSWER_DELIVERY_BATCH_SIZE)

  const claims: Array<{ id: string; generation: number; token: string }> = []
  for (const candidate of candidates) {
    const token = crypto.randomUUID()
    const [claimed] = await db
      .update(agentQuestions)
      .set({ answerDeliveryStatus: 'delivering', answerDeliveryClaimToken: token, answerDeliveryClaimedAt: now })
      .where(
        and(eq(agentQuestions.id, candidate.id), eq(agentQuestions.answerDeliveryGeneration, candidate.generation), due)
      )
      .returning({ id: agentQuestions.id })
    if (claimed) claims.push({ ...candidate, token })
  }
  return claims
}

async function settleFailure(
  claim: { id: string; generation: number; token: string },
  error: unknown,
  now: Date,
  terminal = false
): Promise<boolean> {
  const [row] = await db
    .select({ attemptCount: agentQuestions.answerDeliveryAttemptCount })
    .from(agentQuestions)
    .where(
      and(
        eq(agentQuestions.id, claim.id),
        eq(agentQuestions.answerDeliveryGeneration, claim.generation),
        eq(agentQuestions.answerDeliveryStatus, 'delivering'),
        eq(agentQuestions.answerDeliveryClaimToken, claim.token)
      )
    )
  if (!row) return false
  const attemptCount = row.attemptCount + 1
  const failed = terminal || attemptCount >= QUESTION_ANSWER_DELIVERY_MAX_ATTEMPTS
  const rawMessage = (error instanceof Error ? error.message : String(error)).slice(0, 2_000)
  const message = rawMessage
  const [settled] = await db
    .update(agentQuestions)
    .set({
      answerDeliveryStatus: failed ? 'failed' : 'pending',
      answerDeliveryAttemptCount: attemptCount,
      answerDeliveryNextAttemptAt: failed ? null : new Date(now.getTime() + retryDelay(attemptCount)),
      answerDeliveryClaimToken: null,
      answerDeliveryClaimedAt: null,
      answerDeliveryLastError: message,
    })
    .where(
      and(
        eq(agentQuestions.id, claim.id),
        eq(agentQuestions.answerDeliveryGeneration, claim.generation),
        eq(agentQuestions.answerDeliveryStatus, 'delivering'),
        eq(agentQuestions.answerDeliveryClaimToken, claim.token)
      )
    )
    .returning({ id: agentQuestions.id })
  return Boolean(settled && failed)
}

async function deliverClaim(
  claim: { id: string; generation: number; token: string },
  now: Date,
  testHooks?: QuestionAnswerDeliveryTestHooks
): Promise<'delivered' | 'failed' | 'retry'> {
  const [row] = await db.select().from(agentQuestions).where(eq(agentQuestions.id, claim.id))
  if (!row || row.answerDeliveryGeneration !== claim.generation) return 'retry'
  const [target] = await db
    .select({ status: agents.status, pendingDormancyAt: agents.pendingDormancyAt })
    .from(agents)
    .where(eq(agents.id, row.agentId))
  if (!target || target.status === 'terminated' || target.pendingDormancyAt) {
    const failed = await settleFailure(
      claim,
      new Error('Asking agent is missing, terminating, or terminated'),
      now,
      true
    )
    if (failed) {
      eventEmitter.emit('agent-question.delivery-failed', {
        questionId: row.id,
        agentId: row.agentId,
        squadId: row.squadId,
      })
      await alertTerminalFailure(row.id)
    }
    return 'failed'
  }

  const inboxKey = `agent-question-answer:v1:${row.id}`
  const clientId = `${inboxKey}:inbox`
  try {
    const winner = await InboxMessage.sendOnce(
      {
        recipientType: 'agent',
        recipientId: row.agentId,
        senderType: 'user',
        senderId: row.answeredByUserId ?? undefined,
        subject: 'Answer to your question',
        content: answerContent(row),
        deliveryMode: 'steer',
        metadata: { source: 'agent-question-answer', questionId: row.id },
        deferDelivery: true,
      },
      inboxKey
    )
    await testHooks?.afterInboxPersisted?.()
    const delivery = prepareInboxDelivery([winner.message], 'steer', 'steer')
    const agent = await Agent.mustFind(row.agentId)
    const sent = await agent.sendMessage(delivery.prompt, {
      deliveryMode: 'steer',
      metadata: { ...delivery.metadata, clientId },
      ...(delivery.imageIds.length ? { imageIds: delivery.imageIds } : {}),
    })
    if (!sent.success) throw new Error(`Agent.sendMessage returned success=false (${sent.status})`)
    await testHooks?.afterAgentSend?.()
    const [receipt] = await db
      .select({ messageId: chatSendReceipts.messageId, executionId: chatSendReceipts.executionId })
      .from(chatSendReceipts)
      .where(and(eq(chatSendReceipts.agentId, row.agentId), eq(chatSendReceipts.clientId, clientId)))
    if (!receipt?.messageId || !receipt.executionId)
      throw new Error('Accepted chat receipt is missing delivery identities')

    const settled = await db.transaction(async (tx) => {
      const [question] = await tx
        .update(agentQuestions)
        .set({
          answerDeliveryStatus: 'delivered',
          answerDeliveryClaimToken: null,
          answerDeliveryClaimedAt: null,
          answerDeliveryNextAttemptAt: null,
          answerDeliveryLastError: null,
          answerDeliveryInboxMessageId: winner.message.id,
          answerDeliveryMessageId: receipt.messageId,
          answerDeliveryExecutionId: receipt.executionId,
          answerDeliveredAt: now,
        })
        .where(
          and(
            eq(agentQuestions.id, claim.id),
            eq(agentQuestions.answerDeliveryGeneration, claim.generation),
            eq(agentQuestions.answerDeliveryStatus, 'delivering'),
            eq(agentQuestions.answerDeliveryClaimToken, claim.token)
          )
        )
        .returning({ id: agentQuestions.id })
      if (!question) return false
      await tx.update(inbox).set({ deliveredAt: now }).where(eq(inbox.id, winner.message.id))
      return true
    })
    if (settled) return 'delivered'
    const [authoritative] = await db
      .select({ status: agentQuestions.answerDeliveryStatus })
      .from(agentQuestions)
      .where(eq(agentQuestions.id, claim.id))
    return authoritative?.status === 'delivered' ? 'delivered' : 'retry'
  } catch (error) {
    if (error instanceof FlowWaitSupersededError) {
      await settleFailure(claim, error, now, true)
      eventEmitter.emit('agent-question.delivery-failed', {
        questionId: row.id,
        agentId: row.agentId,
        squadId: row.squadId,
      })
      return 'failed'
    }
    log.warn(`Answer delivery for question ${claim.id.slice(0, 8)} will be retried:`, error)
    const failed = await settleFailure(claim, error, now)
    if (failed) {
      eventEmitter.emit('agent-question.delivery-failed', {
        questionId: row.id,
        agentId: row.agentId,
        squadId: row.squadId,
      })
      await alertTerminalFailure(row.id)
    }
    return failed ? 'failed' : 'retry'
  }
}

/**
 * An accepted chat receipt (with both persisted identities) and the original answer inbox row
 * prove agent-send acceptance. An inbox row or unread/read flag alone does NOT prove delivery.
 * Reconcile terminal failures without a new send: a late/failed settlement can outlive acceptance.
 */
export async function reconcileAcceptedQuestionAnswerFailuresOnce(
  questionId?: string,
  now = new Date()
): Promise<number> {
  const candidates = await db
    .select({
      question: agentQuestions,
      answerInbox: inbox,
      requestHash: chatSendReceipts.requestHash,
      messageId: chatSendReceipts.messageId,
      executionId: chatSendReceipts.executionId,
    })
    .from(agentQuestions)
    .innerJoin(
      chatSendReceipts,
      and(
        eq(chatSendReceipts.agentId, agentQuestions.agentId),
        eq(
          chatSendReceipts.clientId,
          sql<string>`'agent-question-answer:v1:' || ${agentQuestions.id}::text || ':inbox'`
        ),
        eq(chatSendReceipts.state, 'accepted'),
        isNotNull(chatSendReceipts.messageId),
        isNotNull(chatSendReceipts.executionId)
      )
    )
    .innerJoin(
      inbox,
      and(
        eq(inbox.idempotencyKey, sql<string>`'agent-question-answer:v1:' || ${agentQuestions.id}::text`),
        eq(inbox.recipientType, 'agent'),
        eq(inbox.recipientId, sql<string>`${agentQuestions.agentId}::text`)
      )
    )
    .where(
      and(
        eq(agentQuestions.status, 'answered'),
        eq(agentQuestions.answerDeliveryStatus, 'failed'),
        ...(questionId ? [eq(agentQuestions.id, questionId)] : [])
      )
    )
    .limit(QUESTION_ANSWER_DELIVERY_BATCH_SIZE)
  let delivered = 0
  for (const candidate of candidates) {
    const question = candidate.question
    const answerInbox = candidate.answerInbox
    // An accepted receipt for the same predictable client ID is not enough: bind the
    // inbox contents, prepared prompt and request hash to the saved answer.
    const metadata = answerInbox.metadata as { source?: string; questionId?: string } | null
    if (
      answerInbox.senderType !== 'user' ||
      answerInbox.senderId !== question.answeredByUserId ||
      answerInbox.subject !== 'Answer to your question' ||
      answerInbox.content !== answerContent(question) ||
      answerInbox.deliveryMode !== 'steer' ||
      metadata?.source !== 'agent-question-answer' ||
      metadata.questionId !== question.id
    )
      continue
    const delivery = prepareInboxDelivery([new InboxMessage(answerInbox)], 'steer', 'steer')
    const clientId = `agent-question-answer:v1:${question.id}:inbox`
    const hashes = chatSendRequestHashes({
      agentId: question.agentId,
      clientId,
      content: delivery.prompt,
      imageIds: delivery.imageIds,
      deliveryMode: 'steer',
    })
    if (candidate.requestHash !== hashes.current && candidate.requestHash !== hashes.legacy) continue
    const [boundMessage] = await db
      .select({ content: messages.content, metadata: messages.metadata })
      .from(messages)
      .where(and(eq(messages.id, candidate.messageId!), eq(messages.agentId, question.agentId)))
    const [boundExecution] = await db
      .select({ id: executions.id })
      .from(executions)
      .where(and(eq(executions.id, candidate.executionId!), eq(executions.agentId, question.agentId)))
    const messageMetadata = boundMessage?.metadata as {
      executionId?: string
      inboxMessageIds?: string[]
      imageIds?: string[]
      deliveryMode?: string
    } | null
    if (
      !boundExecution ||
      boundMessage?.content !== delivery.prompt ||
      messageMetadata?.executionId !== candidate.executionId ||
      messageMetadata?.deliveryMode !== 'steer' ||
      JSON.stringify(messageMetadata?.inboxMessageIds) !== JSON.stringify([answerInbox.id]) ||
      JSON.stringify(messageMetadata?.imageIds ?? []) !== JSON.stringify(delivery.imageIds)
    )
      continue
    const updated = await db.transaction(async (tx) => {
      const [settled] = await tx
        .update(agentQuestions)
        .set({
          answerDeliveryStatus: 'delivered',
          answerDeliveryClaimToken: null,
          answerDeliveryClaimedAt: null,
          answerDeliveryNextAttemptAt: null,
          answerDeliveryLastError: null,
          answerDeliveryInboxMessageId: answerInbox.id,
          answerDeliveryMessageId: candidate.messageId,
          answerDeliveryExecutionId: candidate.executionId,
          answerDeliveredAt: now,
        })
        .where(
          and(
            eq(agentQuestions.id, question.id),
            eq(agentQuestions.status, 'answered'),
            eq(agentQuestions.answerDeliveryStatus, 'failed'),
            eq(agentQuestions.answerDeliveryGeneration, question.answerDeliveryGeneration)
          )
        )
        .returning({ id: agentQuestions.id })
      if (settled) await tx.update(inbox).set({ deliveredAt: now }).where(eq(inbox.id, answerInbox.id))
      return Boolean(settled)
    })
    if (updated) delivered++
  }
  return delivered
}

export async function reconcileQuestionAnswerDeliveriesOnce(
  options: ReconcileQuestionAnswerDeliveriesOptions = {}
): Promise<{ processed: number; delivered: number; failed: number }> {
  const now = options.now ?? new Date()
  const reconciled = await reconcileAcceptedQuestionAnswerFailuresOnce(options.questionId, now)
  const claims = await claimDueDeliveries(now, options.questionId)
  let delivered = reconciled
  let failed = 0
  for (const claim of claims) {
    const result = await deliverClaim(claim, now, options.testHooks)
    if (result === 'delivered') delivered += 1
    if (result === 'failed') failed += 1
  }
  return { processed: claims.length, delivered, failed }
}

export function drainQuestionAnswerDeliverySoon(questionId: string): void {
  const drain = reconcileQuestionAnswerDeliveriesOnce({ questionId })
    .catch((error) => log.warn(`Inline answer delivery drain failed for question ${questionId.slice(0, 8)}:`, error))
    .finally(() => inlineDrains.delete(drain))
  inlineDrains.add(drain)
}

export async function waitForQuestionAnswerDeliveryDrains(): Promise<void> {
  await Promise.all([...inlineDrains])
}

export function startQuestionAnswerDeliverySweep(): void {
  if (runner) return
  runner = createPeriodicRunner({
    name: 'question-answer-delivery',
    intervalMs: QUESTION_ANSWER_DELIVERY_INTERVAL_MS,
    runImmediately: true,
    task: async () => {
      const { reconcileTerminatedAgentQuestionsOnce } = await import('./questions')
      await reconcileTerminatedAgentQuestionsOnce()
      await reconcileQuestionAnswerDeliveriesOnce()
      await reconcileQuestionDeliveryFailureAlertsOnce()
    },
  })
  runner.start()
}

export async function stopQuestionAnswerDeliverySweep(): Promise<void> {
  if (!runner) return
  await runner.stop()
  runner = null
}
