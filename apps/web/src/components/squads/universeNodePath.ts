import { agentChatPath } from '../../lib/entityReference'

/** Where clicking a node in the squad universe goes: the squad's page, or the agent's squad Chats tab. */
export function universeNodePath(
  node: { id: string; type: string; squadId?: string },
  slugFor: (squadId: string) => string
): string | null {
  if (node.type === 'squad') return `/squads/${slugFor(node.id)}`
  if (node.type === 'agent') return agentChatPath({ id: node.id, squadId: node.squadId ? slugFor(node.squadId) : null })
  return null
}
