/**
 * Where the web app opens a conversation with an agent. Web links and Core notification URLs both use
 * this, so every surface lands in the same place.
 *
 * - A squad agent opens in its squad's Chats tab (`/squads/:squadId/agents?agent=:agentId`). The
 *   squad may be given by id or by slug; the squad page accepts either.
 * - A squadless agent (a system manager, an artifact builder, any other standalone agent) has no
 *   squad page, so it opens in the Assistant's conversation view over the Feed, through the stable
 *   `/assistant/agents/:agentId` route (see {@link assistantAgentChatPath}).
 *
 * The legacy `/chat/:agentId` page is no longer a destination; that route only redirects here.
 */
export function agentChatPath(agent: { id: string; squadId?: string | null }): string {
  if (agent.squadId) return `/squads/${encodeURIComponent(agent.squadId)}/agents?agent=${encodeURIComponent(agent.id)}`
  return assistantAgentChatPath(agent.id)
}

/** The web route that opens one agent's conversation in the Assistant; see {@link assistantAgentChatPath}. */
export const ASSISTANT_AGENT_ROUTE = '/assistant/agents/:agentId'

/**
 * The Assistant's conversation view of one agent, over the Feed; any agent, with or without a squad.
 *
 * This is a short, stable route rather than the Assistant's own URL state (`?chat=open&commandStack=…`),
 * which is internal and may change between releases. Notification URLs persist, so they use this; the
 * web app redirects it to whatever the Assistant reads today.
 */
export function assistantAgentChatPath(agentId: string): string {
  return `/assistant/agents/${encodeURIComponent(agentId)}`
}

const ASSISTANT_AGENT_PATH = /(?:^|\/)assistant\/agents\/([^/]+)\/?$/

/**
 * The agent an {@link assistantAgentChatPath} pathname opens, or null for any other path. The app's
 * base path may precede the route.
 */
export function agentIdFromAssistantAgentPath(pathname: string): string | null {
  const encoded = pathname.match(ASSISTANT_AGENT_PATH)?.[1]
  if (!encoded) return null
  try {
    return decodeURIComponent(encoded) || null
  } catch {
    return null
  }
}
