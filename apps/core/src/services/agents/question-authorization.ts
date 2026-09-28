import { isAddressableAgentStatus, type AgentStatus } from '@ficus/shared'
import { eq } from 'drizzle-orm'
import { db } from '../../db'
import { agents } from '../../db/schema'
import { hasAgentResourcePermission, type Identity } from '../rbac'

/**
 * Can this identity answer (or retry delivery of) an agent question?
 *
 * Response authority follows the target agent snapshot: canonical `agents:run` resource
 * policy plus the addressable lifecycle transaction fence (dormant is addressable;
 * pending dormancy/terminated is not). By default the helper loads the current target; callers
 * that must bind authorization to another scope-fenced operation may pass their already-loaded
 * target snapshot. A stored `ownerUserId` on a squad-bound agent is legacy metadata, not an
 * entitlement — squad RBAC decides there — while a private (squadless) agent stays owner-exclusive.
 * Route authorization is deliberately not the last word: the question mutation's
 * `expectedAgentScope` row lock re-checks all of this at commit time.
 */
export interface AgentQuestionAuthorizationTarget {
  id: string
  squadId: string | null
  ownerUserId: string | null
  status: AgentStatus
  pendingDormancyAt: Date | null
}

export async function canAnswerAgentQuestion(
  identity: Identity,
  question: { agentId: string },
  opts: { allowTerminatedAgent?: boolean; target?: AgentQuestionAuthorizationTarget } = {}
): Promise<boolean> {
  let target = opts.target
  if (!target) {
    const [currentTarget] = await db
      .select({
        id: agents.id,
        squadId: agents.squadId,
        ownerUserId: agents.ownerUserId,
        status: agents.status,
        pendingDormancyAt: agents.pendingDormancyAt,
      })
      .from(agents)
      .where(eq(agents.id, question.agentId))
    target = currentTarget
  }

  if (!target || target.id !== question.agentId) return false
  if (!opts.allowTerminatedAgent && (!isAddressableAgentStatus(target.status) || target.pendingDormancyAt)) return false
  return hasAgentResourcePermission(identity, target, 'agents:run')
}
