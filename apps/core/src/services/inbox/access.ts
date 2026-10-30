import {
  Permissions,
  parseAssistantInboxConversationId,
  parseWorkspaceVoiceUserId,
  type InboxRecipientType,
} from '@ficus/shared'
import { Agent } from '../../entities/Agent'
import { InboxAttachment } from '../../entities/InboxAttachment'
import { InboxMessage } from '../../entities/InboxMessage'
import { assistantInboxOwner } from '../assistant-inbox'
import { hasAgentResourcePermission, hasPermission, resolveActingUser, type Identity } from '../rbac'

/** Why an inbox read or write is refused; the route answers 401 or 403. */
export type InboxDenial = 'unauthorized' | 'forbidden'

/**
 * Whether `identity` may read or write one recipient's inbox (null when allowed). Shared by the
 * inbox routes and the read_attachment tool, so both apply exactly the same rule.
 */
export async function inboxRecipientDenial(
  identity: Identity | undefined,
  type: InboxRecipientType,
  recipientId: string,
  permission: 'inbox:read' | 'inbox:write'
): Promise<InboxDenial | null> {
  if (!identity) return 'unauthorized'

  if (identity.type === 'agent' && type === 'agent') {
    const targetAgent = await Agent.find(recipientId)
    if (!targetAgent) return 'forbidden'
    if (!targetAgent.squadId) {
      return (await hasAgentResourcePermission(identity, targetAgent, permission)) ? null : 'forbidden'
    }
    // Squad-scoped agents may touch their own inbox. Cross-agent reads require
    // the dedicated squad permission; cross-agent writes remain forbidden.
    if (identity.agentId === recipientId) return null
    if (permission === Permissions.INBOX_WRITE) return 'forbidden'
    return (await hasPermission(identity, Permissions.INBOX_READ_SQUAD, targetAgent.squadId)) ? null : 'forbidden'
  }

  const user = await resolveActingUser(identity)
  if (identity.type === 'agent' && type !== 'agent' && !user) {
    return 'forbidden'
  }

  if (type === 'agent') {
    const agent = await Agent.find(recipientId)
    if (!agent) return 'forbidden'
    return (await hasAgentResourcePermission(identity, agent, permission)) ? null : 'forbidden'
  }

  // A user may only access their own personal inbox.
  if (type === 'user') {
    return user?.userId === recipientId ? null : 'forbidden'
  }

  // A user may only access their own per-user voice (workspace:<userId>) inbox.
  if (type === 'voice_assistant') {
    if (parseAssistantInboxConversationId(recipientId))
      return user && (await assistantInboxOwner(recipientId)) === user.userId ? null : 'forbidden'
    return user && parseWorkspaceVoiceUserId(recipientId) === user.userId ? null : 'forbidden'
  }

  // The shared system inbox requires the inbox:system permission.
  if (type === 'system') {
    return (await hasPermission(identity, 'inbox:system')) ? null : 'forbidden'
  }

  return 'forbidden'
}

/**
 * An inbox attachment and its message, with the reason it is refused (if it is). A missing
 * attachment and a withheld notification look exactly like a forbidden one.
 */
export async function inboxAttachmentAccess(
  identity: Identity | undefined,
  attachmentId: string,
  permission: 'inbox:read' | 'inbox:write'
): Promise<{
  denial: InboxDenial | null
  attachment?: Awaited<ReturnType<typeof InboxAttachment.findById>>
  message?: InboxMessage
}> {
  if (!identity) return { denial: 'unauthorized' }
  const attachment = await InboxAttachment.findById(attachmentId)
  if (!attachment) return { denial: 'forbidden' }
  const message = await InboxMessage.find(attachment.messageId)
  if (!message || (await InboxMessage.isWithheldGitHubNotification(message.id))) return { denial: 'forbidden' }
  const denial = await inboxRecipientDenial(identity, message.recipientType, message.recipientId, permission)
  return { denial, attachment, message }
}
