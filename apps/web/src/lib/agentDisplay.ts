import type { Agent, AgentStatus } from '@ficus/shared'
import { activityAgentLabel, agentLabelParts, typeFirstAgentLabel } from '@ficus/shared'

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

/**
 * How the app names one agent: type first, then what it is working on, or its purpose when there is
 * no work stream ("Engineer (#12 · Implement)", "Engineer (Onboarding)", "Engineer"). Never the name
 * alone; surfaces that need the stable handle show `getAgentName` beside it.
 */
export function getAgentLabel(agent: Pick<Agent, 'agentTypeId' | 'metadata'>, workingOn?: string): string {
  return typeFirstAgentLabel({
    agentTypeId: agent.agentTypeId,
    purpose: getAgentPurpose(agent as Agent),
    workingOn,
  })
}

/**
 * Labels for a list of agents shown together: each is `getAgentLabel` ("Engineer (Onboarding)"). An
 * agent with no purpose that shares its type with another agent in the list adds what it is working
 * on (`workingOn`, such as "#12"), else its name, else a short ID ("Engineer (#12)", "Consultant
 * (Quartz)", "Engineer (1a2b3c4d)") so the rows stay distinguishable; the type always leads.
 */
export function agentListLabels(
  agents: readonly Agent[],
  workingOn: (agent: Agent) => string | undefined = () => undefined
): Map<string, string> {
  const typeCounts = new Map<string, number>()
  for (const agent of agents) typeCounts.set(agent.agentTypeId, (typeCounts.get(agent.agentTypeId) ?? 0) + 1)
  const labels = new Map<string, string>()
  for (const agent of agents) {
    const shared = (typeCounts.get(agent.agentTypeId) ?? 0) > 1
    if (getAgentPurpose(agent) || !shared) {
      labels.set(agent.id, getAgentLabel(agent))
      continue
    }
    const name = agent.metadata?.name
    const detail = workingOn(agent) ?? (typeof name === 'string' && name.trim() ? name.trim() : agent.id.slice(0, 8))
    labels.set(agent.id, getAgentLabel(agent, detail))
  }
  return labels
}

/**
 * How a conversation with an agent is titled: its topic (the agent's purpose), else the agent named
 * type first. Consultant chats read as conversations, so their topic leads; never the name alone.
 */
export function getConversationTitle(agent: Pick<Agent, 'agentTypeId' | 'metadata'>): string {
  return getAgentPurpose(agent as Agent) ?? getAgentLabel(agent)
}

/**
 * The title of one agent's own view (chat window, tray chip, Assistant header): "Manager" for the
 * squad's one manager, a consultant chat's topic, otherwise the type-first label.
 */
export function getAgentTitle(agent: Pick<Agent, 'agentTypeId' | 'metadata'>): string {
  if (agent.agentTypeId === 'manager') return 'Manager'
  if (agent.agentTypeId === 'consultant') return getConversationTitle(agent)
  return getAgentLabel(agent)
}

export function agentMatchesQuery(agent: Agent, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const purpose = getAgentPurpose(agent)?.toLowerCase() ?? ''
  const name = getAgentName(agent).toLowerCase()
  const type = agent.agentTypeId.toLowerCase()
  return purpose.includes(q) || name.includes(q) || type.includes(q)
}

/**
 * Type-first agent labels for one view: each agent is named by its type ("Engineer"). When two agents
 * of the same type appear together, each adds what it is working on, `workingOn` (a work stream
 * reference and step, such as "#12 · Implement"), or else its purpose, in parentheses:
 * "Engineer (#12 · Implement)", "Engineer (Onboarding)". A name is never shown alone; it is the
 * last resort only to tell two otherwise identical agents apart.
 */
export function typeFirstAgentLabels(
  agents: Agent[],
  workingOn: (agent: Agent) => string | undefined = () => undefined
): Map<string, string> {
  const unique = [...new Map(agents.map((agent) => [agent.id, agent])).values()]
  const typeCounts = new Map<string, number>()
  for (const agent of unique) typeCounts.set(agent.agentTypeId, (typeCounts.get(agent.agentTypeId) ?? 0) + 1)
  const labels = new Map<string, string>()
  for (const agent of unique) {
    const type = activityAgentLabel(agent.agentTypeId)
    if ((typeCounts.get(agent.agentTypeId) ?? 0) < 2) {
      labels.set(agent.id, type)
      continue
    }
    const name = agent.metadata?.name
    const detail =
      workingOn(agent) ??
      getAgentPurpose(agent) ??
      (typeof name === 'string' && name.trim() ? name.trim() : agent.id.slice(0, 8))
    labels.set(agent.id, `${type} (${detail})`)
  }
  return labels
}
