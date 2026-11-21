import { assistantNavigationParams } from '../hooks/useAssistantNavigation'

/**
 * Where an agent's stable Assistant route (`/assistant/agents/:agentId`, from `assistantAgentChatPath`
 * in `@ficus/shared`) goes: the Feed with the Assistant open on that agent's conversation. The
 * Assistant keeps its navigation in the URL (`?chat=open&commandStack=…`); that format is internal, so
 * links that outlive a release (notification URLs, bookmarks) point at the route and only this
 * redirect knows the format.
 */
export function assistantAgentDestination(agentId: string): string {
  const params = assistantNavigationParams(
    new URLSearchParams(),
    [{ kind: 'chat', id: agentId, agentId, label: 'Conversation' }],
    ''
  )
  return `/?${params}`
}
