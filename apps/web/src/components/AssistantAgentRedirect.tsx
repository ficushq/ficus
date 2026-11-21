import { Navigate, useParams } from 'react-router'
import { assistantAgentDestination } from '../lib/assistantAgentDestination'

/** The `/assistant/agents/:agentId` route: opens that agent's conversation in the Assistant over the Feed. */
export function AssistantAgentRedirect() {
  const { agentId } = useParams<{ agentId: string }>()
  return <Navigate to={agentId ? assistantAgentDestination(agentId) : '/?chat=open'} replace />
}
