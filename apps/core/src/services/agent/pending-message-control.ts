import { acquireAgentQueueLock } from '../execution/agent-admission'
import { and, eq, sql } from 'drizzle-orm'
import { db, messages, chatSendReceipts } from '../../db'
import { eventEmitter } from '../../lib/infra/event-emitter'
import { notify } from '../../lib/infra/local-events'
import { mapMessage } from '../../entities/message-mapper'
import { messageEventData } from '../../entities/message-event'
import type { AgentSession } from '../../entities/AgentSession'
import type { MessageMetadata } from '@ficus/shared'

export type PendingMessageOperation = 'cancel' | 'steer' | 'follow-up'
export type PendingMessageResult = 'updated' | 'not_pending' | 'claimed' | 'unavailable'
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]
type Row = typeof messages.$inferSelect

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
  await publishChange(input.agentId, input.messageId, input.operation)
  return 'updated'
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
