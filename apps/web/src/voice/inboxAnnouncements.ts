import type { InboxMessageResponse } from '../api/inbox'
import { agentTypeDisplayName, noAgentTypeNames, type AgentTypeName } from '../lib/agentDisplay'

export function enqueueUniqueInboxMessages(
  queue: InboxMessageResponse[],
  messages: InboxMessageResponse[],
  seenIds: ReadonlySet<string>
): InboxMessageResponse[] {
  const queuedIds = new Set(queue.map((message) => message.id))
  const next = [...queue]
  for (const message of messages) {
    if (message.readAt || seenIds.has(message.id) || queuedIds.has(message.id)) continue
    next.push(message)
    queuedIds.add(message.id)
  }
  return next
}

/**
 * The prompt that has the voice assistant speak an inbox message. An agent sender is named by its type
 * as the app shows it (the configured name from `useAgentTypeNames`), never the raw type id.
 */
export function buildInboxAnnouncementPrompt(
  message: InboxMessageResponse,
  typeNames: AgentTypeName = noAgentTypeNames
): string {
  const sender = message.senderAgent
    ? `${agentTypeDisplayName(message.senderAgent.agentTypeId, typeNames)} (${message.senderAgent.id})`
    : message.senderId
      ? `${message.senderType} ${message.senderId}`
      : message.senderType

  return [
    'An agent or system update arrived for the user via their inbox.',
    '',
    'This may be a result or follow-up from something you or the user recently asked an agent to do. Do not mechanically announce it as a generic inbox alert if it is contextually related to the recent conversation. Summarize it naturally in your own words, briefly explain who/what it is from, and offer a sensible next step only if useful.',
    '',
    `Inbox message ID: ${message.id}`,
    `Sender: ${sender}`,
    message.subject ? `Subject: ${message.subject}` : null,
    'Content:',
    message.content,
  ]
    .filter((line): line is string => line !== null)
    .join('\n')
}
