import { Navigate, useParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { queries } from '../queryOptions'
import { useSquadSlugs } from '../hooks/useSquadSlugs'
import { agentChatPath } from '../lib/entityReference'
import { ChatSkeleton } from './loading/Skeleton'

/** Where the bare `/chat` page (and its `?new` link) goes: the Assistant, which replaced the chat list. */
const LEGACY_CHAT_LIST_DESTINATION = '/?chat=open'

/**
 * The legacy `/chat` and `/chat/:agentId` routes, kept for old bookmarks and already-sent
 * notifications. An agent link goes where every other agent link goes now (its squad Chats tab, or the
 * Assistant's view of a squadless agent); the bare page goes to the Assistant.
 */
export function LegacyChatRedirect() {
  const { agentId } = useParams<{ agentId?: string }>()
  const { slugFor } = useSquadSlugs()
  const agent = useQuery({ ...queries.agents.detail(agentId ?? ''), enabled: Boolean(agentId), retry: false })
  if (!agentId) return <Navigate to={LEGACY_CHAT_LIST_DESTINATION} replace />
  if (agent.isPending) return <ChatSkeleton label="Opening chat" />
  // An agent that cannot be loaded still opens in the Assistant, which explains what went wrong.
  const squadId = agent.data?.squadId
  return <Navigate to={agentChatPath({ id: agentId, squadId: squadId ? slugFor(squadId) : null })} replace />
}
