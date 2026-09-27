import { useCallback, type ReactNode } from 'react'
import { createWsClient, type FicusClient } from '@ficus/client-core'
import { ConversationClientProvider, type AgentEventEntry } from '@ficus/client-react'
import { useQueryClient } from '@tanstack/react-query'
import { client as gardenClient } from '../api/client'
import { conversationKeysForAgentEvent, createAgentEventHub, type AgentEventHub } from './agentEvents'

let sharedHub: AgentEventHub | null = null

/** The garden's one per-agent event socket, opened on first use. */
export function gardenAgentEventHub(): AgentEventHub {
  sharedHub ??= createAgentEventHub({
    fetchTicket: () => gardenClient.auth.fetchWsTicket(),
    socketUrl: (ticket) => gardenClient.transport.wsUrl('/ws', { ticket }),
    connect: createWsClient,
  })
  return sharedHub
}

/**
 * The conversation environment for garden chat, matching what the web app's
 * LiveConversationProvider passes to client-react's ConversationClientProvider:
 * the API client plus `subscribeToAgentEvents` fed from `agents:<id>` socket
 * topics. The web's QueryInvalidator also refreshes an open conversation's
 * active-execution and history queries on execution / queue-cleared frames; the
 * farm's live layer doesn't, so that happens here for subscribed agents.
 * (The web's message-invalidation suppression has no garden counterpart to
 * suppress: the farm never refetches message history on message events.)
 */
export function ChatProvider({
  children,
  client = gardenClient,
  hub,
}: {
  children: ReactNode
  client?: FicusClient
  hub?: AgentEventHub
}) {
  const queryClient = useQueryClient()
  const subscribeToAgentEvents = useCallback(
    (agentId: string, callback: (entry: AgentEventEntry) => void) =>
      (hub ?? gardenAgentEventHub()).subscribe(agentId, (entry) => {
        for (const queryKey of conversationKeysForAgentEvent(agentId, entry.event))
          void queryClient.invalidateQueries({ queryKey })
        callback(entry)
      }),
    [hub, queryClient]
  )
  return (
    <ConversationClientProvider client={client} subscribeToAgentEvents={subscribeToAgentEvents}>
      {children}
    </ConversationClientProvider>
  )
}
