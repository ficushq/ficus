import { and, eq, gte, sql } from 'drizzle-orm'
import { db, messages } from '../../db'
import { Agent } from '../../entities/Agent'
import type { ImageRow } from '../../entities/Image'
import {
  hasAgentResourcePermission,
  hasPermission,
  identityUserId,
  isUserlessAgentIdentity,
  type Identity,
} from '../rbac'

/**
 * Whether `identity` may read a stored image. One rule for every image reader (signing, work-stream
 * references), matching how the image's owner is protected everywhere else:
 *
 * - An upload that has not been sent yet (pending, with no message carrying it) is readable only by
 *   the user who uploaded it, even when it is already bound to an agent conversation.
 * - An image in an agent conversation follows that agent: squad agents need `agents:read` on the
 *   squad; a private (squad-less, user-owned) conversation is readable only by its owner, not even
 *   by another administrator. A sent message's images stay pending until the agent receives them,
 *   so a queued message's images are readable by the conversation's readers, like its text.
 * - The uploader's own unbound staged upload needs `agents:read` where it was staged.
 * - Other squad images (avatars) need `agents:read` on that squad.
 * - Ownerless legacy and system images keep the administrative path; a user-less agent token cannot
 *   reach them by substituting its own squad.
 */
export async function canReadImage(
  identity: Identity,
  image: Pick<ImageRow, 'id' | 'agentId' | 'squadId' | 'status' | 'uploadedByUserId' | 'createdAt'>
): Promise<boolean> {
  const staged = image.status === 'pending' && Boolean(image.uploadedByUserId)
  if (staged && identityUserId(identity) !== image.uploadedByUserId) {
    if (!image.agentId || !(await isInConversationMessage(image.id, image.agentId, image.createdAt))) return false
  }
  if (image.agentId) {
    const agent = await Agent.find(image.agentId, { eager: false })
    if (agent) return hasAgentResourcePermission(identity, agent, 'agents:read')
  }
  if (staged) {
    return image.squadId
      ? hasPermission(identity, 'agents:read', image.squadId)
      : hasPermission(identity, 'agents:read')
  }
  if (image.squadId) return hasPermission(identity, 'agents:read', image.squadId)
  if (isUserlessAgentIdentity(identity)) return false
  return hasPermission(identity, 'agents:read')
}

/**
 * Whether a message in `agentId`'s conversation carries the image: it was sent (perhaps still queued
 * for the agent), not merely uploaded. Such a message is always written after its images.
 */
async function isInConversationMessage(imageId: string, agentId: string, uploadedAt: Date): Promise<boolean> {
  const [row] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.agentId, agentId),
        eq(messages.role, 'human'),
        gte(messages.createdAt, uploadedAt),
        sql`${messages.metadata}->'imageIds' @> ${JSON.stringify([imageId])}::jsonb`
      )
    )
    .limit(1)
  return Boolean(row)
}
