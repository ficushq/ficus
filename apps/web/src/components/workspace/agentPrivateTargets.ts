/** Pure helpers for the Workspace tab's agent target (kept apart from components for fast refresh). */

import { isLiveAgentStatus, isUserAssistantAgentType, type Agent } from '@ficus/shared'
import type { AgentPrivateStatus } from '../../api/agentPrivate'
import { getAgentPrimaryLabel } from '../../lib/agentDisplay'

/**
 * Agents with a private box of their own, live agents first. Subagents share
 * their parent's box, consultant chats share a squad runtime and a person's
 * assistants share one box, so none of those is listed.
 */
export function privateAreaAgents(agents: Agent[]): Agent[] {
  return agents
    .filter(
      (agent) =>
        !agent.parentAgentId &&
        agent.status !== 'terminated' &&
        agent.agentTypeId !== 'consultant' &&
        !isUserAssistantAgentType(agent.agentTypeId)
    )
    .sort((a, b) => {
      const liveA = isLiveAgentStatus(a.status)
      const liveB = isLiveAgentStatus(b.status)
      if (liveA !== liveB) return liveA ? -1 : 1
      return getAgentPrimaryLabel(a).localeCompare(getAgentPrimaryLabel(b))
    })
}

const SANDBOX_STATUS_LABELS: Record<string, string> = {
  running: 'Sandbox running',
  not_found: 'Sandbox stopped',
  pending: 'Sandbox starting',
  starting: 'Sandbox starting',
  terminating: 'Sandbox stopping',
  failed: 'Sandbox failed',
}

export function sandboxStatusLabel(status: AgentPrivateStatus): string {
  if (!status.live) return 'Agent dormant · sandbox stopped'
  return SANDBOX_STATUS_LABELS[status.sandbox.status] ?? `Sandbox ${status.sandbox.status.replace(/_/g, ' ')}`
}

/** Validates a private-folder-relative file path as the server would accept it. */
export function newFilePathError(path: string): string | null {
  const parts = path.split('/').filter(Boolean)
  if (parts.length === 0) return 'Enter a file name'
  if (parts.some((part) => part === '..' || part === '.')) return 'Use a path inside the private folder'
  if (parts.some((part) => part.startsWith('.'))) return 'Names starting with a dot are reserved for the platform'
  if (parts[0] === 'chat-attachments') return 'Chat attachments are managed by the platform'
  if (parts.length === 1 && parts[0] === 'identity.pem') return 'This name is reserved for the agent’s identity key'
  return null
}
