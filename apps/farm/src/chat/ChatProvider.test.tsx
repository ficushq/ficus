import { describe, expect, it, spyOn } from 'bun:test'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import { queryKeys } from '@ficus/client-core'
import { useConversationEnvironment, type AgentEventEntry } from '@ficus/client-react'
import { ChatProvider } from './ChatProvider'
import type { AgentEventHub, AgentEventListener } from './agentEvents'
import { act, createTestQueryClient, makeFakeClient } from './testing'

describe('ChatProvider', () => {
  it('feeds subscribeToAgentEvents from the hub and refreshes the open conversation’s execution queries', async () => {
    const listeners = new Map<string, AgentEventListener>()
    let released = 0
    const hub: AgentEventHub = {
      subscribe: (agentId, listener) => {
        listeners.set(agentId, listener)
        return () => {
          released += 1
        }
      },
      dispose: () => {},
    }
    const { client } = makeFakeClient()
    const queryClient = createTestQueryClient()
    const invalidate = spyOn(queryClient, 'invalidateQueries')
    const received: AgentEventEntry[] = []
    let unsubscribe = () => {}

    function Probe() {
      const env = useConversationEnvironment()
      if (env.client !== client) throw new Error('wrong client')
      unsubscribe = env.subscribeToAgentEvents!('a1', (entry) => received.push(entry))
      return null
    }

    const container = document.createElement('div')
    const root = createRoot(container)
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ChatProvider client={client} hub={hub}>
            <Probe />
          </ChatProvider>
        </QueryClientProvider>
      )
    })

    listeners.get('a1')!({ event: 'execution.completed', data: { agentId: 'a1' } })
    expect(received).toEqual([{ event: 'execution.completed', data: { agentId: 'a1' } }])
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.agents.activeExecution('a1') })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.agents.messagesInfinite('a1') })
    unsubscribe()
    expect(released).toBe(1)
    act(() => root.unmount())
  })
})
