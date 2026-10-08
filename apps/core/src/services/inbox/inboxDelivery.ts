import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db, chatSendReceipts } from '../../db'
import type { DeliveryMode } from '@ficus/shared'
import { githubOutputPass, withGitHubOutputPass, withGitHubCandidate } from '../integrations/github/feedback-pass'
import { readOutputCandidate, readOutputInbox } from '../integrations/github/feedback-pass-read'
import { selectGitHubInboxPage } from '../integrations/github/feedback-inbox'
import { Agent } from '../../entities/Agent'
import {
  formatInboxMessageSender,
  formatInboxMessages,
  InboxMessage,
  isInboxMessageWakeEligible,
} from '../../entities/InboxMessage'

/**
 * `githubMessageIds` names GitHub notices the caller just persisted for this agent. They join the
 * pass's selected cohort (each still charged as one WORK unit) instead of waiting a tick when the
 * ordinary cohort was selected earlier in the same pass. It never widens to a mailbox sweep.
 */
export async function deliverInboxMessagesToAgent(agentId: string, githubMessageIds: string[] = []): Promise<void> {
  return withGitHubOutputPass(() => deliverInboxInPass(agentId, githubMessageIds))
}

async function deliverInboxInPass(agentId: string, githubMessageIds: string[]): Promise<void> {
  const { pausedWorkStreamForAgent } = await import('../work-streams/pause')
  const paused = await pausedWorkStreamForAgent(agentId)
  const agent = await Agent.mustFind(agentId)
  const cohort = githubOutputPass()?.ordinary
  const selected = cohort ? (cohort.get(agent.id) ?? []) : (await selectGitHubInboxPage(agent.id)).map((row) => row.id)
  const ids = [...new Set([...selected, ...githubMessageIds.filter((id) => z.string().uuid().safeParse(id).success)])]
  cohort?.delete(agent.id)
  const { renewKnownGitHubOutputs } = await import('../integrations/github/feedback-renewal')
  for (const id of ids) {
    await withGitHubCandidate(async () => {
      if (paused) return
      const row = await readOutputInbox(db, id)
      if (!row || row.recipientId !== agent.id || row.readAt || row.deliveredAt) return
      const eventId = row.metadata?.integrationEventId
      if (typeof eventId !== 'string' || !z.string().uuid().safeParse(eventId).success) return
      const clientId = `github-feedback:${eventId}:${id}`
      const [receipt] = await db
        .select({
          messageId: chatSendReceipts.messageId,
          executionId: chatSendReceipts.executionId,
          acceptedAt: chatSendReceipts.acceptedAt,
        })
        .from(chatSendReceipts)
        .where(
          and(
            eq(chatSendReceipts.agentId, agent.id),
            eq(chatSendReceipts.clientId, clientId),
            eq(chatSendReceipts.state, 'accepted')
          )
        )
      if (!receipt?.messageId || !receipt.executionId || !receipt.acceptedAt) {
        const event = await readOutputCandidate(db, eventId)
        if (!event || event.integration !== 'github') return
        await renewKnownGitHubOutputs([eventId])
      }
      await acceptGitHubNotification(agent, new InboxMessage(row), eventId)
    }, undefined)
  }
  // Ordinary non-GitHub mail keeps its existing batching/lifecycle behavior. GitHub bodies
  // must never be materialized by this unbounded legacy mailbox query.
  if (paused) return
  const pending = await InboxMessage.listUndeliveredUnread('agent', agent.id, true)
  const { isCurrentFlowMessage } = await import('../workflows/execution')
  const messages: InboxMessage[] = []
  // Observer mail is informational, never a lifecycle wake. Recheck at delivery:
  // an agent may have been stopped/deleted or lost access after the terminal commit.
  const hasObserverMail = pending.some((message) => message.metadata?.source === 'work-stream-observer')
  const latest = hasObserverMail ? await agent.getLatestExecution() : null
  for (const message of pending) {
    if (message.metadata?.source === 'work-stream-observer') {
      const { hasPermission } = await import('../rbac/permissions')
      const squadId = message.metadata.squadId
      if (
        agent.pendingDormancyAt ||
        ['terminated', 'dormant', 'waiting-input'].includes(agent.status) ||
        (latest && ['stopping', 'stopped', 'failed'].includes(latest.status)) ||
        typeof squadId !== 'string' ||
        agent.squadId !== squadId ||
        !(await hasPermission(
          { type: 'agent', agentId: agent.id, squadId: agent.squadId },
          'workstreams:read',
          squadId
        ))
      ) {
        await message.markAsRead()
        continue
      }
    }
    if (message.metadata?.source === 'work-stream-observer') {
      // A stable chat receipt, rather than a pre-send deliveredAt claim, closes
      // both crash windows: before acceptance and after acceptance before ack.
      // Keep the mode/payload stable even if the conversation becomes active.
      const delivery = prepareInboxDelivery([message], 'follow-up', 'follow-up')
      try {
        const result = await agent.sendMessage(delivery.prompt, {
          deliveryMode: 'follow-up',
          metadata: { ...delivery.metadata, clientId: `work-stream-observer:${message.id}` },
        })
        if (result.success) await message.update({ deliveredAt: new Date() })
      } catch {
        // The committed inbox row remains pending; receipt replay is safe.
      }
      continue
    }
    if (await isCurrentFlowMessage(message)) messages.push(message)
  }
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

async function acceptGitHubNotification(agent: Agent, message: InboxMessage, eventId: string): Promise<void> {
  const clientId = `github-feedback:${eventId}:${message.id}`
  const receipt = async () =>
    (
      await db
        .select()
        .from(chatSendReceipts)
        .where(
          and(
            eq(chatSendReceipts.agentId, agent.id),
            eq(chatSendReceipts.clientId, clientId),
            eq(chatSendReceipts.state, 'accepted')
          )
        )
    )[0]
  try {
    let accepted = await receipt()
    if (!accepted) {
      if (agent.status === 'terminated' || (agent.status === 'dormant' && !isInboxMessageWakeEligible(message))) return
      const { isCurrentFlowMessage } = await import('../workflows/execution')
      if (!(await isCurrentFlowMessage(message))) return
      const prepared = prepareInboxDelivery([message], message.deliveryMode, message.deliveryMode)
      const result = await agent.sendMessage(prepared.prompt, {
        deliveryMode: message.deliveryMode,
        metadata: { ...prepared.metadata, clientId },
      })
      if (!result.success) return
      accepted = await receipt()
    }
    if (accepted?.messageId && accepted.executionId && accepted.acceptedAt)
      await message.update({ deliveredAt: accepted.acceptedAt })
  } catch {
    // The persisted row remains pending. Enqueue/success without a receipt is not delivery.
    const { withholdRevokedAutomaticGitHubOutput } = await import('../integrations/github/feedback-renewal')
    await withholdRevokedAutomaticGitHubOutput(eventId)
  }
}
