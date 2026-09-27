import { useCallback, type ReactNode } from 'react'
import type { FicusClient } from '@ficus/client-core'
import { ConversationClientProvider, type AgentEventEntry } from '@ficus/client-react'
import { useWebSocket } from '../hooks/useWebSocket'
import { retainLiveConversation } from '../lib/messageInvalidationSuppression'

export function LiveConversationProvider({ client, children }: { client: FicusClient; children: ReactNode }) {
  const { subscribe } = useWebSocket()
  // Agent topics are authorized by the server's current squad or private-owner relation.
  const subscribeToAgentEvents = useCallback(
    (agentId: string, callback: (entry: AgentEventEntry) => void) => {
      const releaseInvalidationSuppression = retainLiveConversation(agentId)
      const unsubscribe = subscribe(`agents:${agentId}`, ({ event, data }) => callback({ event, data }))
      return () => {
        unsubscribe()
        releaseInvalidationSuppression()
      }
    },
    [subscribe]
  )
  return (
    <ConversationClientProvider client={client} subscribeToAgentEvents={subscribeToAgentEvents}>
      {children}
    </ConversationClientProvider>
  )
}
