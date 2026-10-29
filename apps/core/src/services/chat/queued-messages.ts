import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import type { Message } from '@ficus/shared'
import { db, chatSendReceipts, executions, messages, type DbTx } from '../../db'

/**
 * Derive chat queue placement from existing acceptance receipts. pending remains the
 * internal consumption flag, which is also true for a turn's initial prompt.
 */
export async function withChatQueueState(agentId: string, history: Message[]): Promise<Message[]> {
  const clientIds = history.flatMap((message) =>
    message.role === 'human' && message.pending && message.metadata?.clientId ? [message.metadata.clientId] : []
  )
  const receipts = clientIds.length
    ? await db
        .select({ messageId: chatSendReceipts.messageId, disposition: chatSendReceipts.disposition })
        .from(chatSendReceipts)
        .where(
          and(
            eq(chatSendReceipts.agentId, agentId),
            eq(chatSendReceipts.state, 'accepted'),
            inArray(chatSendReceipts.clientId, clientIds)
          )
        )
    : []
  const dispositions = new Map(receipts.map((receipt) => [receipt.messageId, receipt.disposition]))
  return Promise.all(
    history.map(async (message) => {
      if (message.role !== 'human') return message
      const disposition = dispositions.get(message.id)
      const queued =
        message.pending && (disposition ? disposition === 'intervention' : !!message.metadata?.deliveryMode)
      return { ...message, queued: queued && (disposition ? true : !(await isExecutionInitialMessage(db, message))) }
    })
  )
}

/** Legacy sends without acceptance receipts still have an initial execution row. */
export async function isExecutionInitialMessage(
  tx: typeof db | DbTx,
  row: Pick<Message, 'id' | 'agentId' | 'content' | 'metadata'>
): Promise<boolean> {
  const executionId = row.metadata?.executionId
  if (!executionId) return false
  const [execution] = await tx
    .select({ message: executions.message })
    .from(executions)
    .where(and(eq(executions.id, executionId), eq(executions.agentId, row.agentId)))
  if (!execution || (execution.message ?? '') !== row.content) return false
  const [first] = await tx
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.agentId, row.agentId),
        eq(messages.role, 'human'),
        sql`${messages.metadata}->>'executionId' = ${executionId}`
      )
    )
    .orderBy(asc(messages.createdAt), asc(messages.enqueueOrder))
    .limit(1)
  return first?.id === row.id
}
