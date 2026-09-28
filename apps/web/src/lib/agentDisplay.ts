import type { Agent, AgentStatus } from '@ficus/shared'
import { agentLabelParts } from '@ficus/shared'

export const AGENT_STATUS_LABELS: Record<AgentStatus, string> = {
  active: 'Working',
  idle: 'Idle',
  'waiting-input': 'Waiting for input',
  compacting: 'Compacting',
  resetting: 'Resetting',
  dormant: 'Dormant',
  terminated: 'Terminated',
}

export function getAgentPurpose(agent: Agent): string | undefined {
  const purpose = agent.metadata?.purpose
  return typeof purpose === 'string' && purpose.trim() ? purpose.trim() : undefined
}

export function getAgentName(agent: Agent): string {
  const name = agent.metadata?.name
  return typeof name === 'string' && name.trim() ? name.trim() : agent.agentTypeId
}

function labelParts(agent: Agent) {
  return agentLabelParts({
    name: agent.metadata?.name as string | undefined,
    purpose: agent.metadata?.purpose as string | undefined,
    agentTypeId: agent.agentTypeId,
  })
}

/** Prominent label: the purpose if set, else the name. */
export function getAgentPrimaryLabel(agent: Agent): string {
  return labelParts(agent).primary
}

/** Secondary (gray, smaller) label shown beside the primary — the name, only when a purpose leads. */
export function getAgentSecondaryLabel(agent: Agent): string | undefined {
  return labelParts(agent).secondary
}

export function agentMatchesQuery(agent: Agent, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const purpose = getAgentPurpose(agent)?.toLowerCase() ?? ''
  const name = getAgentName(agent).toLowerCase()
  const type = agent.agentTypeId.toLowerCase()
  return purpose.includes(q) || name.includes(q) || type.includes(q)
}

export function countableSquadAgents(agents: Agent[]): Agent[] {
  return agents.filter((a) => a.agentTypeId !== 'consultant')
}
