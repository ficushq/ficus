import { and, eq, inArray } from 'drizzle-orm'
import type { Message } from '@ficus/shared'
import { db, chatSendReceipts } from '../../db'

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
  return history.map((message) => {
    if (message.role !== 'human') return message
    const disposition = dispositions.get(message.id)
    const queued = message.pending && (disposition ? disposition === 'intervention' : !!message.metadata?.deliveryMode)
    return { ...message, queued }
  })
}
