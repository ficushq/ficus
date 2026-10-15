/**
 * Who may reach one agent's private area and its own sandbox (`agent_<id>`).
 *
 * The private area holds the agent's key custody and whatever a person saved
 * there for that agent alone, so the bar is higher than squad workspace access:
 *
 * - The caller must be a person (a user session, or the bootstrap admin
 *   session). Agents and system API tokens never pass, whatever they hold:
 *   reaching another agent's private files is exactly what isolation forbids.
 * - It needs `agents:private-access` (Admin and Operator by default) in the
 *   agent's squad — or, for an agent with no squad, it must be the agent's
 *   owner (`hasAgentResourcePermission`).
 * - A terminal additionally needs `terminal:access` under the same rule.
 *
 * The agent, its squad and its sandbox id are always resolved from the agent
 * row; a client-supplied sandbox id is only parsed for the agent id. Only
 * top-level, personally boxed agents qualify: subagents share their parent's
 * box, consultant chats share a squad runtime, and a user's system managers
 * share one box, so none of those has a private area of its own to open.
 * Every miss — unknown id, another squad, a non-qualifying agent, a missing
 * permission — returns the same denial, so callers cannot probe for agents.
 */

import { isUserAssistantAgentType, Permissions } from '@ficus/shared'
import { Agent, agentWorkspaceSandboxId } from '../../entities/Agent'
import { hasAgentResourcePermission } from '../rbac/agent-resource-access'
import type { Identity } from '../rbac'

const AGENT_SANDBOX_PREFIX = 'agent_'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface AgentPrivateTarget {
  agent: Agent
  /** Always `agent_<agent.id>`, derived from the row. */
  sandboxId: string
  squadId: string | null
  /** Whether the agent may run (and so may have its box started). Dormant agents are not live. */
  live: boolean
}

/** The agent id named by an `agent_<uuid>` sandbox id, or null for any other sandbox id. */
export function parseAgentSandboxId(sandboxId: string): string | null {
  if (!sandboxId.startsWith(AGENT_SANDBOX_PREFIX)) return null
  const agentId = sandboxId.slice(AGENT_SANDBOX_PREFIX.length)
  return UUID_RE.test(agentId) ? agentId.toLowerCase() : null
}

/** Whether a sandbox id is an agent's own box (`agent_<uuid>`). */
export function isAgentSandboxId(sandboxId: string): boolean {
  return parseAgentSandboxId(sandboxId) !== null
}

/**
 * Load the agent behind an agent id if it owns a private box of its own:
 * top-level, not terminated, not a consultant chat or a user's system manager.
 */
export async function resolveAgentPrivateTarget(agentId: string): Promise<AgentPrivateTarget | null> {
  if (!UUID_RE.test(agentId)) return null
  const agent = await Agent.find(agentId, { eager: false })
  if (!agent || agent.status === 'terminated' || agent.parentAgentId) return null
  if (agent.agentTypeId === 'consultant' || isUserAssistantAgentType(agent.agentTypeId)) return null
  return {
    agent,
    sandboxId: agentWorkspaceSandboxId(agent.id),
    squadId: agent.squadId,
    live: agent.status !== 'dormant',
  }
}

/** Person identities only; see the module doc. */
function isPersonIdentity(identity: Identity): boolean {
  return identity.type === 'user' || identity.type === 'legacy'
}

/**
 * Whether `identity` may browse (and, with `terminal`, open a shell in) the
 * target agent's private area. The single permission check for this surface.
 */
export async function canAccessAgentPrivateArea(
  identity: Identity,
  target: AgentPrivateTarget,
  options: { terminal?: boolean } = {}
): Promise<boolean> {
  if (!isPersonIdentity(identity)) return false
  const resource = { squadId: target.squadId, ownerUserId: target.agent.ownerUserId }
  if (!(await hasAgentResourcePermission(identity, resource, Permissions.AGENTS_PRIVATE_ACCESS))) return false
  if (options.terminal && !(await hasAgentResourcePermission(identity, resource, Permissions.TERMINAL_ACCESS))) {
    return false
  }
  return true
}

/**
 * Resolve and authorize in one step. Returns null for every kind of miss so
 * callers answer 403 uniformly.
 */
export async function authorizeAgentPrivateArea(
  identity: Identity,
  agentId: string,
  options: { terminal?: boolean } = {}
): Promise<AgentPrivateTarget | null> {
  const target = await resolveAgentPrivateTarget(agentId)
  if (!target) return null
  return (await canAccessAgentPrivateArea(identity, target, options)) ? target : null
}
