import { isExecutionInitialMessage } from '../chat/queued-messages'
import { acquireAgentQueueLock } from '../execution/agent-admission'
import { and, eq, isNotNull, sql } from 'drizzle-orm'
import { db, messages, chatSendReceipts } from '../../db'
import { eventEmitter } from '../../lib/infra/event-emitter'
import { notify } from '../../lib/infra/local-events'
import { mapMessage } from '../../entities/message-mapper'
import { messageEventData } from '../../entities/message-event'
import type { AgentSession } from '../../entities/AgentSession'
import type { MessageMetadata } from '@ficus/shared'
import { userSentMessage } from './pending-delivery'

export type PendingMessageOperation = 'cancel' | 'steer' | 'follow-up'
export type PendingMessageResult = 'updated' | 'not_pending' | 'not_allowed' | 'claimed' | 'unavailable'
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]
type Row = typeof messages.$inferSelect

/** The initial prompt is pending consumption, but is not an editable intervention.
 * Its execution also retains fallback text, so deleting only its message would lie
 * about cancellation. Receipts are authoritative; older/non-idempotent sends use
 * the first human row bound to the execution instead.
 */
/** Inbox deliveries already claimed their inbox items, so deleting the row would lose them: they may
 * only change delivery mode. Question answers are always interrupts (their delivery recovery binds the
 * row only while it is still `steer`), and monitor deliveries are never edited. */
export function allowsPendingOperation(
  metadata: MessageMetadata | null | undefined,
  operation: PendingMessageOperation
): boolean {
  if (metadata?.source === 'monitor') return false
  if (metadata?.inboxMessageSummaries?.some((summary) => summary.questionAnswer != null)) return false
  if (metadata?.source === 'inbox') return operation !== 'cancel'
  return true
}

async function isEditableIntervention(tx: Tx, row: Row): Promise<boolean> {
  const [receipt] = await tx
    .select({ disposition: chatSendReceipts.disposition })
    .from(chatSendReceipts)
    .where(
      and(
        eq(chatSendReceipts.agentId, row.agentId),
        eq(chatSendReceipts.messageId, row.id),
        eq(chatSendReceipts.state, 'accepted')
      )
    )
  if (receipt) return receipt.disposition === 'intervention'
  const message = mapMessage(row)
  if (!message.metadata?.deliveryMode) return false
  return !(await isExecutionInitialMessage(tx, message))
}

async function commitChange(tx: Tx, row: Row, operation: PendingMessageOperation): Promise<void> {
  if (operation === 'cancel') {
    // Keep the accepted send receipt as a tombstone: replay must not resurrect this message.
    await tx.update(chatSendReceipts).set({ messageId: null }).where(eq(chatSendReceipts.messageId, row.id))
    await tx.delete(messages).where(eq(messages.id, row.id))
  } else {
    await tx
      .update(messages)
      .set({ metadata: { ...(row.metadata ?? {}), deliveryMode: operation } })
      .where(eq(messages.id, row.id))
  }
}

async function publishChange(agentId: string, messageId: string, operation: PendingMessageOperation) {
  if (operation === 'cancel') {
    eventEmitter.emit('agent.queue-cleared', { agentId, cleared: 1, deleted: 1, owned: true, ok: true })
  } else {
    const [row] = await db.select().from(messages).where(eq(messages.id, messageId))
    if (row) eventEmitter.emit('message.updated', messageEventData(mapMessage(row)))
  }
}

/** A row lock arbitrates against initial claims and the live intervention drain. */
export async function updateUnclaimedMessage(
  agentId: string,
  messageId: string,
  operation: PendingMessageOperation
): Promise<PendingMessageResult> {
  const result = await db.transaction(async (tx) => {
    await acquireAgentQueueLock(tx, agentId)
    const [row] = await tx
      .select()
      .from(messages)
      .where(and(eq(messages.id, messageId), eq(messages.agentId, agentId)))
      .for('update')
    if (!row || row.role !== 'human' || !row.pending) return 'not_pending' as const
    if (!allowsPendingOperation(row.metadata as MessageMetadata | null, operation)) return 'not_allowed' as const
    if (!(await isEditableIntervention(tx, row))) return 'not_pending' as const
    if (row.injectedAt) return 'claimed' as const
    await commitChange(tx, row, operation)
    return 'updated' as const
  })
  if (result === 'updated') await publishChange(agentId, messageId, operation)
  return result
}

/** Only the worker holding this execution may mutate its SDK queue. */
export async function updateClaimedMessage(input: {
  agentId: string
  messageId: string
  executionId: string
  operation: PendingMessageOperation
  session: AgentSession
  stillOwned: () => boolean
  expiresAt: number
  /** Bulk clear sends one acknowledgement for the whole queue instead of one per message. */
  announce?: boolean
}): Promise<PendingMessageResult> {
  const [snapshot] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.id, input.messageId), eq(messages.agentId, input.agentId)))
  const claim = (snapshot?.metadata as MessageMetadata | null)?.sessionDelivery
  if (!snapshot?.pending || snapshot.role !== 'human' || !claim || claim.executionId !== input.executionId)
    return 'not_pending'
  const updated = await input.session.pi.updateQueuedMessage(
    claim.id,
    input.operation === 'follow-up' ? 'followUp' : input.operation,
    async () => {
      await db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL statement_timeout = '5s'`)
        await acquireAgentQueueLock(tx, input.agentId)
        const [row] = await tx
          .select()
          .from(messages)
          .where(and(eq(messages.id, input.messageId), eq(messages.agentId, input.agentId)))
          .for('update')
        const current = (row?.metadata as MessageMetadata | null)?.sessionDelivery
        if (
          !input.stillOwned() ||
          Date.now() >= input.expiresAt ||
          !row?.pending ||
          !allowsPendingOperation(row.metadata as MessageMetadata | null, input.operation) ||
          !(await isEditableIntervention(tx, row)) ||
          !row.injectedAt ||
          current?.id !== claim.id ||
          current.generation !== claim.generation ||
          current.executionId !== input.executionId
        ) {
          throw new Error('Pending delivery changed before queue update')
        }
        await commitChange(tx, row, input.operation)
      })
    }
  )
  if (!updated) return 'not_pending'
  if (input.announce !== false) await publishChange(input.agentId, input.messageId, input.operation)
  return 'updated'
}

/**
 * Cancel each user-sent message this execution's session holds in its SDK queue, one at a
 * time, so inbox and monitor deliveries already handed to the session stay queued.
 * @returns The number of messages canceled.
 */
export async function cancelClaimedUserMessages(input: {
  agentId: string
  executionId: string
  session: AgentSession
  stillOwned: () => boolean
  expiresAt: number
}): Promise<number> {
  const claimed = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.agentId, input.agentId),
        eq(messages.role, 'human'),
        eq(messages.pending, true),
        isNotNull(messages.injectedAt),
        userSentMessage,
        sql`${messages.metadata}->'sessionDelivery'->>'executionId' = ${input.executionId}`
      )
    )
    .orderBy(messages.createdAt, messages.enqueueOrder)
  let canceled = 0
  for (const { id } of claimed) {
    // A message the session consumed meanwhile is being delivered and stays.
    const result = await updateClaimedMessage({ ...input, messageId: id, operation: 'cancel', announce: false })
    if (result === 'updated') canceled++
  }
  return canceled
}

export async function updatePendingMessage(
  agentId: string,
  messageId: string,
  operation: PendingMessageOperation
): Promise<PendingMessageResult> {
  const unclaimed = await updateUnclaimedMessage(agentId, messageId, operation)
  if (unclaimed !== 'claimed') return unclaimed
  const [row] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.id, messageId), eq(messages.agentId, agentId)))
  const executionId = (row?.metadata as MessageMetadata | null)?.sessionDelivery?.executionId
  if (!executionId) return 'unavailable'
  const requestId = crypto.randomUUID()
  const expiresAt = Date.now() + 10_000
  let unsubscribe = () => {}
  let timer: ReturnType<typeof setTimeout> | undefined
  const response = new Promise<PendingMessageResult>((resolve) => {
    unsubscribe = eventEmitter.on('agent.queue-message-updated', (event) => {
      if (
        event.requestId === requestId &&
        event.agentId === agentId &&
        event.executionId === executionId &&
        event.messageId === messageId
      )
        resolve(event.result)
    })
    timer = setTimeout(() => resolve('unavailable'), 10_000)
  })
  try {
    await notify(
      'agent_control',
      JSON.stringify({
        action: 'update-pending-message',
        agentId,
        executionId,
        messageId,
        requestId,
        expiresAt,
        operation,
      })
    )
    return await response
  } finally {
    unsubscribe()
    clearTimeout(timer)
  }
}
