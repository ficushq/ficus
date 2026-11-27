import type { Agent, AgentStatus } from '@ficus/shared'
import { agentLabelParts, agentTypeNoun, typeFirstAgentLabel } from '@ficus/shared'

/** The squad's configured name for an agent type (`AgentType.name`), or undefined when it is not known. */
export type AgentTypeName = (agentTypeId: string) => string | undefined

/** No configured names: every type reads as its title-cased id. */
export const noAgentTypeNames: AgentTypeName = () => undefined

/**
 * An agent type as people read it: its configured name when known ("Builder" for `engineer`), else the
 * title-cased id ("Engineer"); the general type reads "General Purpose agent".
 */
export function agentTypeDisplayName(
  agentTypeId: string | null | undefined,
  typeNames: AgentTypeName = noAgentTypeNames
): string {
  return agentTypeNoun({ agentTypeId, typeName: agentTypeId ? typeNames(agentTypeId) : undefined })
}

/** "Open Engineer agent thread"; a type that already reads as an agent is not doubled ("Open Helper Agent thread"). */
export function agentThreadLinkTitle(typeLabel: string): string {
  return /\bagent$/i.test(typeLabel) ? `Open ${typeLabel} thread` : `Open ${typeLabel} agent thread`
}

export const AGENT_STATUS_LABELS: Record<AgentStatus, string> = {
  active: 'Working',
  idle: 'Idle',
  'waiting-input': 'Waiting for input',
  compacting: 'Compacting',
  resetting: 'Resetting',
  dormant: 'Dormant',
  terminated: 'Terminated',
}

export function getAgentPurpose(agent: Pick<Agent, 'metadata'>): string | undefined {
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
export function getAgentLabel(
  agent: Pick<Agent, 'agentTypeId' | 'metadata'>,
  workingOn?: string,
  /** The squad's names for agent types (`useAgentTypeNames`); without them the type id is title-cased. */
  typeNames: AgentTypeName = noAgentTypeNames
): string {
  return typeFirstAgentLabel({
    agentTypeId: agent.agentTypeId,
    typeName: typeNames(agent.agentTypeId),
    purpose: getAgentPurpose(agent),
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
  workingOn: (agent: Agent) => string | undefined = () => undefined,
  typeNames: AgentTypeName = noAgentTypeNames
): Map<string, string> {
  const typeCounts = new Map<string, number>()
  for (const agent of agents) typeCounts.set(agent.agentTypeId, (typeCounts.get(agent.agentTypeId) ?? 0) + 1)
  const labels = new Map<string, string>()
  for (const agent of agents) {
    const shared = (typeCounts.get(agent.agentTypeId) ?? 0) > 1
    if (getAgentPurpose(agent) || !shared) {
      labels.set(agent.id, getAgentLabel(agent, undefined, typeNames))
      continue
    }
    const name = agent.metadata?.name
    const detail = workingOn(agent) ?? (typeof name === 'string' && name.trim() ? name.trim() : agent.id.slice(0, 8))
    labels.set(agent.id, getAgentLabel(agent, detail, typeNames))
  }
  return labels
}

/**
 * How a conversation with an agent is titled: its topic (the agent's purpose), else the agent named
 * type first. Consultant chats read as conversations, so their topic leads; never the name alone.
 */
export function getConversationTitle(
  agent: Pick<Agent, 'agentTypeId' | 'metadata'>,
  typeNames: AgentTypeName = noAgentTypeNames
): string {
  return getAgentPurpose(agent as Agent) ?? getAgentLabel(agent, undefined, typeNames)
}

/**
 * The title of one agent's own view (chat window, tray chip, Assistant header): "Manager" for the
 * squad's one manager, a consultant chat's topic, otherwise the type-first label.
 */
export function getAgentTitle(
  agent: Pick<Agent, 'agentTypeId' | 'metadata'>,
  typeNames: AgentTypeName = noAgentTypeNames
): string {
  if (agent.agentTypeId === 'manager') return 'Manager'
  if (agent.agentTypeId === 'consultant') return getConversationTitle(agent, typeNames)
  return getAgentLabel(agent, undefined, typeNames)
}

/**
 * Hover detail for an agent's row: the type as people read it first, then the agent's name (the handle
 * used with `ficus inbox send`) and its full ID, then any `details` ("Engineer · Quinn · 1a2b… · 1 pending
 * question"). `typeNote` qualifies the type ("Consultant via Assistant"). The raw type id is never shown;
 * admins find it on the agent type's settings page.
 */
export function agentHoverTitle(
  agent: Pick<Agent, 'id' | 'agentTypeId' | 'metadata'>,
  typeNames: AgentTypeName = noAgentTypeNames,
  { typeNote, details = [] }: { typeNote?: string; details?: ReadonlyArray<string | undefined> } = {}
): string {
  const type = agentTypeDisplayName(agent.agentTypeId, typeNames)
  const name = agent.metadata?.name
  return [
    typeNote ? `${type} ${typeNote}` : type,
    typeof name === 'string' && name.trim() ? name.trim() : undefined,
    agent.id,
    ...details,
  ]
    .filter(Boolean)
    .join(' · ')
}

export function agentMatchesQuery(agent: Agent, query: string, typeNames: AgentTypeName = noAgentTypeNames): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const purpose = getAgentPurpose(agent)?.toLowerCase() ?? ''
  const name = getAgentName(agent).toLowerCase()
  const type = agent.agentTypeId.toLowerCase()
  // The type as it is shown, so searching for a label someone just read finds the agent.
  const shownType = agentTypeDisplayName(agent.agentTypeId, typeNames).toLowerCase()
  return purpose.includes(q) || name.includes(q) || type.includes(q) || shownType.includes(q)
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
  workingOn: (agent: Agent) => string | undefined = () => undefined,
  typeNames: AgentTypeName = noAgentTypeNames
): Map<string, string> {
  const unique = [...new Map(agents.map((agent) => [agent.id, agent])).values()]
  const typeCounts = new Map<string, number>()
  for (const agent of unique) typeCounts.set(agent.agentTypeId, (typeCounts.get(agent.agentTypeId) ?? 0) + 1)
  const labels = new Map<string, string>()
  for (const agent of unique) {
    const type = agentTypeDisplayName(agent.agentTypeId, typeNames)
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
