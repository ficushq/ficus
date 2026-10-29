import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import type { Message } from '@ficus/shared'
import { db, chatSendReceipts, executions, messages, type DbTx } from '../../db'
import { isActiveExecutionStatus } from '../execution/status'

/**
 * The one queue rule. A pending human row is queued input (shown as an interrupt or follow-up, editable and
 * clearable) unless it is the opening message of a turn that is still active: that turn already holds the
 * message, and its execution keeps the text as a fallback prompt, so deleting the row would not cancel it.
 * A turn that ends without consuming its opening message (stopped before it started) leaves ordinary queued
 * input that the next turn delivers. Legacy rows with neither a receipt nor a delivery mode are never queued.
 */
function queuedFor(
  row: Pick<Message, 'id' | 'role' | 'pending' | 'metadata'>,
  disposition: string | null | undefined,
  activeOpening: () => Promise<ActiveOpening>
): Promise<boolean> | boolean {
  if (row.role !== 'human' || !row.pending) return false
  if (disposition === 'intervention') return true
  if (!disposition && !row.metadata?.deliveryMode) return false
  if (!row.metadata?.executionId) return true
  // A `turn` receipt already names this row as the turn's opening message; legacy rows match by content.
  return activeOpening().then(({ active, openingId }) =>
    disposition === 'turn' ? !active : !active || openingId !== row.id
  )
}

interface ActiveOpening {
  active: boolean
  openingId?: string
}

/** Whether an execution is still active, and if so its opening message: its first bound human row, when
 * that row still carries the execution's text (legacy sends without receipts match this way). */
async function activeOpening(tx: typeof db | DbTx, agentId: string, executionId: string): Promise<ActiveOpening> {
  const [execution] = await tx
    .select({ status: executions.status, message: executions.message })
    .from(executions)
    .where(and(eq(executions.id, executionId), eq(executions.agentId, agentId)))
  if (!execution || !isActiveExecutionStatus(execution.status)) return { active: false }
  const [first] = await tx
    .select({ id: messages.id, content: messages.content })
    .from(messages)
    .where(
      and(
        eq(messages.agentId, agentId),
        eq(messages.role, 'human'),
        sql`${messages.metadata}->>'executionId' = ${executionId}`
      )
    )
    .orderBy(asc(messages.createdAt), asc(messages.enqueueOrder))
    .limit(1)
  return { active: true, openingId: first && first.content === (execution.message ?? '') ? first.id : undefined }
}

/** Whether one pending row is queued input, by the same rule chat history uses. */
export async function isQueuedIntervention(
  tx: typeof db | DbTx,
  row: Pick<Message, 'id' | 'agentId' | 'role' | 'pending' | 'metadata'>
): Promise<boolean> {
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
  return queuedFor(row, receipt?.disposition, () => activeOpening(tx, row.agentId, row.metadata!.executionId!))
}

/**
 * Derive chat queue placement from acceptance receipts and the active turn. pending remains the internal
 * consumption flag, which is also true for a turn's opening message.
 */
export async function withChatQueueState(agentId: string, history: Message[]): Promise<Message[]> {
  const pendingIds = history.flatMap((message) => (message.role === 'human' && message.pending ? [message.id] : []))
  const receipts = pendingIds.length
    ? await db
        .select({ messageId: chatSendReceipts.messageId, disposition: chatSendReceipts.disposition })
        .from(chatSendReceipts)
        .where(
          and(
            eq(chatSendReceipts.agentId, agentId),
            eq(chatSendReceipts.state, 'accepted'),
            inArray(chatSendReceipts.messageId, pendingIds)
          )
        )
    : []
  const dispositions = new Map(receipts.map((receipt) => [receipt.messageId, receipt.disposition]))
  // Share in-flight reads within this history refresh, never across refreshes or
  // mutation transactions. Many inputs can share one execution.
  const openings = new Map<string, Promise<ActiveOpening>>()
  return Promise.all(
    history.map(async (message) => {
      if (message.role !== 'human') return message
      const queued = await queuedFor(message, dispositions.get(message.id), () => {
        const executionId = message.metadata!.executionId!
        let opening = openings.get(executionId)
        if (!opening) {
          opening = activeOpening(db, message.agentId, executionId)
          openings.set(executionId, opening)
        }
        return opening
      })
      return { ...message, queued }
    })
  )
}
