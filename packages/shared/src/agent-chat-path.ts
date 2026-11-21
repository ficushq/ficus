/**
 * Where the web app opens a conversation with an agent. Web links and Core notification URLs both use
 * this, so every surface lands in the same place.
 *
 * - A squad agent opens in its squad's Chats tab (`/squads/:squadId/agents?agent=:agentId`). The
 *   squad may be given by id or by slug; the squad page accepts either.
 * - A squadless agent (a system manager, an artifact builder, any other standalone agent) has no
 *   squad page, so it opens in the Assistant's conversation view over the Feed: the same inline chat
 *   the Assistant shows when it opens an agent conversation. The query is the Assistant's navigation
 *   stack (`commandStack`, read by `readAssistantNavigation` in `apps/web`) with one agent chat entry.
 *
 * The legacy `/chat/:agentId` page is no longer a destination; that route only redirects here.
 */
export function agentChatPath(agent: { id: string; squadId?: string | null }): string {
  if (agent.squadId) return `/squads/${encodeURIComponent(agent.squadId)}/agents?agent=${encodeURIComponent(agent.id)}`
  return assistantAgentChatPath(agent.id)
}

/** The Assistant's conversation view of one agent, over the Feed; any agent, with or without a squad. */
export function assistantAgentChatPath(agentId: string): string {
  const params = new URLSearchParams({
    chat: 'open',
    commandStack: JSON.stringify([['chat', agentId, '', agentId, '']]),
  })
  return `/?${params}`
}
