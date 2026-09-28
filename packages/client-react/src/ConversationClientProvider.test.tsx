import { describe, expect, mock, test } from 'bun:test'
import { renderHook } from './test-utils'
import type { FicusClient } from '@ficus/client-core'
import {
  ConversationClientProvider,
  useConversationClient,
  useConversationEnvironment,
} from './ConversationClientProvider'

describe('ConversationClientProvider', () => {
  test('provides the client to consumers', async () => {
    const client = { marker: true } as unknown as FicusClient
    const { result } = await renderHook(() => useConversationClient(), {
      wrapper: ({ children }) => <ConversationClientProvider client={client}>{children}</ConversationClientProvider>,
    })
    expect(result.current).toBe(client)
  })

  test('provides the optional agent event subscriber in the conversation environment', async () => {
    const client = { marker: true } as unknown as FicusClient
    const subscribeToAgentEvents = mock(() => () => undefined)
    const { result } = await renderHook(() => useConversationEnvironment(), {
      wrapper: ({ children }) => (
        <ConversationClientProvider client={client} subscribeToAgentEvents={subscribeToAgentEvents}>
          {children}
        </ConversationClientProvider>
      ),
    })

    expect(result.current).toEqual({ client, subscribeToAgentEvents })
  })

  test('throws when used outside the provider', async () => {
    await expect(renderHook(() => useConversationClient())).rejects.toThrow(/ConversationClientProvider/)
  })
})
