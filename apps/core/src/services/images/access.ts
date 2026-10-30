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
 * - An image in an agent conversation follows that agent: squad agents need `agents:read` on the
 *   squad; a private (squad-less, user-owned) conversation is readable only by its owner, not even
 *   by another administrator.
 * - A staged upload (pending, not yet sent) is readable only by the user who uploaded it.
 * - Other squad images (avatars) need `agents:read` on that squad.
 * - Ownerless legacy and system images keep the administrative path; a user-less agent token cannot
 *   reach them by substituting its own squad.
 */
export async function canReadImage(
  identity: Identity,
  image: Pick<ImageRow, 'agentId' | 'squadId' | 'status' | 'uploadedByUserId'>
): Promise<boolean> {
  if (image.agentId) {
    const agent = await Agent.find(image.agentId, { eager: false })
    if (agent) return hasAgentResourcePermission(identity, agent, 'agents:read')
  }
  if (image.status === 'pending' && image.uploadedByUserId) {
    if (identityUserId(identity) !== image.uploadedByUserId) return false
    return image.squadId
      ? hasPermission(identity, 'agents:read', image.squadId)
      : hasPermission(identity, 'agents:read')
  }
  if (image.squadId) return hasPermission(identity, 'agents:read', image.squadId)
  if (isUserlessAgentIdentity(identity)) return false
  return hasPermission(identity, 'agents:read')
}
