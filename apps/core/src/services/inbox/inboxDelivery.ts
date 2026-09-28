import type { DeliveryMode } from '@ficus/shared'
import { Agent } from '../../entities/Agent'
import {
  formatInboxMessageSender,
  formatInboxMessages,
  InboxMessage,
  isInboxMessageWakeEligible,
} from '../../entities/InboxMessage'

export async function deliverInboxMessagesToAgent(agentId: string): Promise<void> {
  const { pausedWorkStreamForAgent } = await import('../work-streams/pause')
  if (await pausedWorkStreamForAgent(agentId)) return
  const agent = await Agent.mustFind(agentId)
  const pending = await InboxMessage.listUndeliveredUnread('agent', agent.id)
  const { isCurrentFlowMessage } = await import('../workflows/execution')
  const messages: InboxMessage[] = []
  for (const message of pending) if (await isCurrentFlowMessage(message)) messages.push(message)
  if (messages.length === 0) return
  if (agent.status === 'terminated') return
  if (agent.status === 'dormant' && !messages.some(isInboxMessageWakeEligible)) return

  const activeExecution = await agent.getActiveExecution()
  // Keep resume instructions durable and unclaimed until the interrupted turn
  // has settled; steering them into a stopping session could lose the resume.
  if (
    activeExecution?.status === 'stopping' &&
    messages.some((message) => (message.metadata as { workStreamResume?: boolean } | null)?.workStreamResume)
  )
    return
  if (!activeExecution) {
    const inboxDeliveryMode = messages.every((message) => message.deliveryMode === messages[0].deliveryMode)
      ? messages[0].deliveryMode
      : 'steer'
    await deliverInboxBatch(agent, inboxDeliveryMode, messages, 'steer')
    return
  }

  const steer = messages.filter((message) => message.deliveryMode === 'steer')
  const followUp = messages
    .filter((message) => message.deliveryMode === 'follow-up')
    .toSorted((a, b) => a.createdAt.getTime() - b.createdAt.getTime())

  if (steer.length > 0) await deliverInboxBatch(agent, 'steer', steer, 'steer')

  // Pi processes follow-ups one turn at a time, so preserve one inbox message
  // per SDK queued follow-up. This lets pending DB rows, delivery claims, and
  // session_message_persisted confirmations advance in the same unit/order the
  // SDK consumes them.
  for (const message of followUp) {
    await deliverInboxBatch(agent, 'follow-up', [message], 'follow-up')
  }
}

async function deliverInboxBatch(
  agent: Agent,
  batchMode: DeliveryMode,
  messages: InboxMessage[],
  effectiveMode: DeliveryMode
): Promise<void> {
  if (messages.length === 0) return

  const deliveredAt = new Date()
  const claimedMessages = await InboxMessage.claimForDelivery(messages, deliveredAt)
  if (claimedMessages.length === 0) return

  const delivery = prepareInboxDelivery(claimedMessages, batchMode, effectiveMode)

  try {
    const result = await agent.sendMessage(delivery.prompt, {
      deliveryMode: effectiveMode,
      metadata: delivery.metadata,
      ...(delivery.imageIds.length ? { imageIds: delivery.imageIds } : {}),
    })
    if (!result.success) {
      throw new Error(`Agent.sendMessage returned success=false (status: ${result.status})`)
    }
  } catch {
    await InboxMessage.resetDeliveryClaim(claimedMessages, deliveredAt)
  }
}

export function prepareInboxDelivery(messages: InboxMessage[], batchMode: DeliveryMode, effectiveMode: DeliveryMode) {
  return {
    prompt: formatInboxMessages(messages),
    imageIds: messages.flatMap((message) => {
      const value = message.metadata?.imageIds
      return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []
    }),
    metadata: {
      source: 'inbox' as const,
      deliveryMode: effectiveMode,
      inboxDeliveryMode: batchMode,
      inboxMessageIds: messages.map((message) => message.id),
      wakeEligible: messages.some(isInboxMessageWakeEligible),
      inboxMessageSummaries: messages.map((message) => {
        const meta = (message.metadata ?? {}) as { workStreamId?: string; squadId?: string }
        return {
          id: message.id,
          senderType: message.senderType,
          senderId: message.senderId,
          subject: message.subject,
          preview: message.content.slice(0, 160),
          senderDisplay: formatInboxMessageSender(message),
          ...(effectiveMode === 'follow-up' ? { deferredUntil: 'next-turn' as const } : {}),
          ...(meta.workStreamId ? { workStreamId: meta.workStreamId } : {}),
          ...(meta.squadId ? { squadId: meta.squadId } : {}),
        }
      }),
    },
  }
}
