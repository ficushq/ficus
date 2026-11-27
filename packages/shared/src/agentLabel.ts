/**
 * How an agent is identified in the UI.
 *
 * An agent has a short, stable, unique-per-squad NAME (the "who") and a self-set PURPOSE (the
 * "what"). For humans the purpose leads; the name is the secondary handle that also appears in
 * inbox messages and in how agents refer to each other. Render them together so the two identity
 * systems line up instead of competing.
 */
export interface AgentLabelParts {
  /** Shown prominently: the purpose if set, else the name, else a type fallback. */
  primary: string
  /** Shown alongside `primary`: the name, but only when the purpose is what's leading. */
  secondary?: string
}

export interface AgentLabelInput {
  name?: string | null
  purpose?: string | null
  agentTypeId?: string | null
  /** Used when neither purpose nor name is set. Defaults to agentTypeId, then "Agent". */
  fallback?: string
}

export function agentLabelParts(input: AgentLabelInput): AgentLabelParts {
  const name = input.name?.trim() || undefined
  const purpose = input.purpose?.trim() || undefined
  const fallback = input.fallback?.trim() || input.agentTypeId?.trim() || 'Agent'

  if (purpose) {
    // Purpose leads; keep the name as the secondary handle (unless it's redundant with the purpose).
    return { primary: purpose, secondary: name && name !== purpose ? name : undefined }
  }
  return { primary: name ?? fallback }
}

/** An agent type as people read it: "engineer" → "Engineer", "general-purpose" → "General Purpose". */
export function agentTypeLabel(agentTypeId: string | null | undefined): string {
  const id = agentTypeId?.trim()
  if (!id) return 'Agent'
  return id
    .split(/[-_]/)
    .map((word) => (word ? word[0]!.toUpperCase() + word.slice(1) : word))
    .join(' ')
}

/** The built-in general-purpose type: not a role, so people read it as "General Purpose agent". */
export const GENERAL_AGENT_TYPE_ID = 'general'

/**
 * An agent type as a noun for one agent: its configured name (`AgentType.name`) when known, else the
 * title-cased id ("Engineer"). The built-in general type is not a role, so it reads "General Purpose
 * agent" (or "<configured name> agent"), never a bare "General".
 */
export function agentTypeNoun(input: { agentTypeId?: string | null; typeName?: string | null }): string {
  const id = input.agentTypeId?.trim()
  const named = input.typeName?.trim()
  if (id === GENERAL_AGENT_TYPE_ID) {
    const type = named || 'General Purpose'
    // A configured name that already says "agent" ("Helper Agent") is not doubled.
    return /\bagent$/i.test(type) ? type : `${type} agent`
  }
  return named || agentTypeLabel(id)
}

export interface TypeFirstAgentLabelInput {
  agentTypeId?: string | null
  /** The type's configured name (`AgentType.name`), when known; else the type id is title-cased. */
  typeName?: string | null
  purpose?: string | null
  /** What the agent is working on, such as a work stream reference and step ("#12 · Implement"). */
  workingOn?: string | null
}

/**
 * How the app refers to one agent: its type leads, because a type means more to people than a
 * name. What the agent is working on follows in parentheses, or its purpose when there is no work
 * stream: "Engineer (#12 · Implement)", "Engineer (Onboarding)", "Engineer". A name is never shown
 * alone; a surface that needs the stable handle shows it beside this label. The type reads as
 * `agentTypeNoun` gives it, so the general type is "General Purpose agent (Docs)".
 */
export function typeFirstAgentLabel(input: TypeFirstAgentLabelInput): string {
  const type = agentTypeNoun(input)
  const detail = input.workingOn?.trim() || input.purpose?.trim()
  return detail ? `${type} (${detail})` : type
}

/**
 * How people see the agent that sent a message, from the sender metadata recorded at send time:
 * type first, never its name alone. Null when the sender is not an agent. Inbox metadata carries
 * identity only, so callers pass a purpose only when they may read it. Agents' own prompts keep the
 * name-first form they address each other by.
 */
export function agentSenderLabel(sender: unknown, agentTypeId?: string | null): string | null {
  const meta = (sender ?? {}) as { agentTypeId?: unknown; agentTypeName?: unknown; purpose?: unknown }
  const typeId = typeof meta.agentTypeId === 'string' && meta.agentTypeId ? meta.agentTypeId : agentTypeId
  if (!typeId) return null
  return typeFirstAgentLabel({
    agentTypeId: typeId,
    // The type's configured name, recorded with the message when it was sent.
    typeName: typeof meta.agentTypeName === 'string' ? meta.agentTypeName : null,
    purpose: typeof meta.purpose === 'string' ? meta.purpose : null,
  })
}

/** One-line "Purpose · Name" form for compact, single-line spots. */
export function formatAgentLabel(input: AgentLabelInput): string {
  const { primary, secondary } = agentLabelParts(input)
  return secondary ? `${primary} · ${secondary}` : primary
}
