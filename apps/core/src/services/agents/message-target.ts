import { isUserAssistantAgentType } from '@ficus/shared'
import { ARTIFACT_BUILDER_AGENT_TYPE_ID } from '../../entities/agent-runners/constants'

/**
 * Whether people may message this agent directly (`POST /api/agents/:id/message`): system
 * managers, squad managers and workers, and artifact builders only while they wait for input.
 */
export function isAllowedMessageTarget(agent: { agentTypeId: string; status: string; squadId: string | null }) {
  if (agent.agentTypeId === ARTIFACT_BUILDER_AGENT_TYPE_ID) return agent.status === 'waiting-input'
  if (isUserAssistantAgentType(agent.agentTypeId)) return true
  return !!agent.squadId
}
