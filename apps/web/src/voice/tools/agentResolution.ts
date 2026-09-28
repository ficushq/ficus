import type { Agent } from '@ficus/shared'
import type { getAgent, listAgents } from '../../api/agents'

export type AgentResolutionDependencies = {
  getAgent: typeof getAgent
  listAgents: typeof listAgents
}

/**
 * The first UUID segment of an agent reference: what the Assistant's instructions show for squad
 * managers and what it is told to say aloud. Undefined for anything that is not hex-shaped.
 */
export function agentHandle(reference: string): string | undefined {
  return reference
    .trim()
    .match(/^[0-9a-f]{8}(?![0-9a-z])/i)?.[0]
    .toLowerCase()
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && /\b404\b/.test(error.message)
}

/**
 * Resolve what the model passed as an agent id. A full id that exists wins. Otherwise the first
 * segment is matched against live agents: the realtime model reliably keeps the first segment of
 * an id it read but can splice the rest from a neighbouring id, so a unique first-segment match
 * is the reference it meant. Ambiguity or no match is an error, never a guess.
 */
export async function resolveAgentByReference(reference: string, deps: AgentResolutionDependencies): Promise<Agent> {
  const trimmed = reference.trim()
  const handle = agentHandle(trimmed)
  // Anything longer than a bare handle may be a real id: look it up exactly first.
  if (trimmed.length !== handle?.length) {
    try {
      return await deps.getAgent(trimmed)
    } catch (error) {
      if (!isNotFound(error) || !handle) throw error
    }
  }
  const candidates = (await deps.listAgents()).filter(
    (agent) => agent.status !== 'terminated' && agent.id.toLowerCase().startsWith(handle)
  )
  if (candidates.length === 1) return candidates[0]!
  if (candidates.length > 1)
    throw new Error(`Agent handle ${handle} is ambiguous (${candidates.length} agents). Pass the full agent ID.`)
  throw new Error(`Unknown agent ${handle}. Use an agent handle or ID from your instructions or a tool result.`)
}
