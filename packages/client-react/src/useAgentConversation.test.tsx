import { afterEach, describe, expect, mock, setSystemTime, spyOn, test } from 'bun:test'
import { act, renderHook as renderHookBase, waitFor } from './test-utils'
import { focusManager, onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { FicusClient } from '@ficus/client-core'
import { createClient, queryKeys, type Transport } from '@ficus/client-core'
import { ConversationClientProvider, type SubscribeToAgentEvents } from './ConversationClientProvider'
import { useAgentConversation } from './useAgentConversation'
import type { Message, StreamEvent } from '@ficus/shared'

// Every mounted fixture owns its timers and focus/online subscriptions. Earlier
// tests omitted unmount, letting later focus events wake unrelated conversations.
const mountedHooks = new Set<() => void>()
afterEach(() => {
  for (const unmount of mountedHooks) unmount()
  mountedHooks.clear()
})
async function renderHook<T>(useHook: () => T, options?: Parameters<typeof renderHookBase>[1]) {
  const hook = await renderHookBase(useHook, options)
  const unmount = () => {
    mountedHooks.delete(unmount)
    hook.unmount()
  }
  mountedHooks.add(unmount)
  return { ...hook, unmount }
}

type StreamCb = Parameters<FicusClient['agents']['subscribeToAgentStream']>[1]
type ChatCb = Parameters<FicusClient['chat']['sendChatMessage']>[1]

function makeMockClient(opts?: {
  activeExecution?: { active: boolean; status?: string; executionId?: string }
  messages?: Message[]
  durableMessages?: Record<string, Message | Promise<Message>>
  getMessage?: (messageId: string) => Message | Promise<Message>
  getMessages?: (options?: {
    cursor?: string
    beforeId?: string
    limit?: number
  }) =>
    | { messages: Message[]; pagination: { hasMore: boolean; totalCount: number; nextCursor?: string } }
    | Promise<{ messages: Message[]; pagination: { hasMore: boolean; totalCount: number; nextCursor?: string } }>
  messagePages?: Record<
    string,
    { messages: Message[]; pagination: { hasMore: boolean; totalCount: number; nextCursor?: string } }
  >
}) {
  let activeExecution = opts?.activeExecution ?? { active: false }
  let messages = opts?.messages ?? []
  let streamCb: StreamCb | null = null
  let chatCb: ChatCb | null = null
  let subscribeCount = 0
  const subscribedExecutionIds: Array<string | undefined> = []
  let getMessagesCount = 0
  let getMessageCount = 0
  const agentEventSubscribers = new Map<string, Set<Parameters<SubscribeToAgentEvents>[1]>>()
  const getMessagesOptions: Array<{ cursor?: string; beforeId?: string; limit?: number } | undefined> = []
  const sent: Array<{ content: string; clientId?: string; imageIds?: string[]; pagePath?: string }> = []
  const chatSent: Array<{
    message: string
    scope?: unknown
    clientId?: string
    imageIds?: string[]
    deliveryMode?: string
    pagePath?: string
  }> = []
  const aborted: string[] = []
  let rejectNextSend = false
  let rejectNextChat = false
  let nextSendStatus: 'queued' | 'running' = 'queued'
  let sendGate: Promise<void> | null = null
  let releaseSendGate: (() => void) | null = null
  const client = {
    agents: {
      getMessage: async (_agentId: string, messageId: string) => {
        getMessageCount += 1
        const message = opts?.getMessage?.(messageId) ?? opts?.durableMessages?.[messageId]
        if (!message) throw new Error(`missing durable message ${messageId}`)
        return await message
      },
      getMessages: async (_agentId: string, options?: { cursor?: string; beforeId?: string; limit?: number }) => {
        getMessagesCount += 1
        getMessagesOptions.push(options)
        const page = await (opts?.getMessages?.(options) ??
          opts?.messagePages?.[options?.cursor ?? 'first'] ?? {
            messages,
            pagination: { hasMore: false, totalCount: messages.length },
          })
        return page
      },
      subscribeToAgentStream: (_id: string, cb: StreamCb, executionId?: string) => {
        streamCb = cb
        subscribeCount += 1
        subscribedExecutionIds.push(executionId)
        return () => {}
      },
      sendMessage: async (
        _id: string,
        content: string,
        opts?: { clientId?: string; imageIds?: string[]; pagePath?: string }
      ) => {
        sent.push({ content, clientId: opts?.clientId, imageIds: opts?.imageIds, pagePath: opts?.pagePath })
        if (sendGate) {
          const gate = sendGate
          sendGate = null
          await gate
        }
        if (rejectNextSend) {
          rejectNextSend = false
          throw new Error('network down')
        }
        const status = nextSendStatus
        nextSendStatus = 'queued'
        return { success: true, status }
      },
      clearQueue: async () => {
        messages = []
        return { success: true }
      },
      stopAgent: async () => ({ success: true }),
      getActiveExecution: async () => activeExecution,
      abortTool: async (agentId: string) => {
        aborted.push(agentId)
        return { success: true }
      },
    },
    chat: {
      sendChatMessage: async (
        params: {
          message: string
          scope?: unknown
          clientId?: string
          imageIds?: string[]
          deliveryMode?: string
          pagePath?: string
        },
        cb: ChatCb
      ) => {
        chatSent.push({
          message: params.message,
          scope: params.scope,
          clientId: params.clientId,
          imageIds: params.imageIds,
          deliveryMode: params.deliveryMode,
          pagePath: params.pagePath,
        })
        chatCb = cb
        if (rejectNextChat) {
          rejectNextChat = false
          throw new Error('network down')
        }
      },
    },
  } as unknown as FicusClient
  return {
    client,
    currentStream: () => streamCb!,
    currentChat: () => chatCb!,
    sent,
    chatSent,
    aborted,
    subscribeCount: () => subscribeCount,
    subscribedExecutionIds,
    getMessagesCount: () => getMessagesCount,
    getMessageCount: () => getMessageCount,
    subscribeToAgentEvents: ((agentId, callback) => {
      const callbacks = agentEventSubscribers.get(agentId) ?? new Set()
      callbacks.add(callback)
      agentEventSubscribers.set(agentId, callbacks)
      return () => callbacks.delete(callback)
    }) as SubscribeToAgentEvents,
    emitAgentEvent: (agentId: string, event: string, data: unknown) => {
      for (const callback of agentEventSubscribers.get(agentId) ?? []) callback({ event, data })
    },
    getMessagesOptions,
    setMessages: (next: Message[]) => {
      messages = next
    },
    setActiveExecution: (v: { active: boolean; status?: string; executionId?: string }) => {
      activeExecution = v
    },
    emit: (...args: Parameters<NonNullable<typeof streamCb>['onEvent']>) => streamCb?.onEvent(...args),
    emitCatchup: (events: Parameters<NonNullable<StreamCb['onCatchup']>>[0]) => streamCb?.onCatchup?.(events),
    emitChat: (event: StreamEvent) => chatCb?.onEvent(event),
    triggerDisconnect: () => streamCb?.onDisconnect?.(),
    triggerReconnect: () => streamCb?.onReconnect?.(),
    triggerError: () => streamCb?.onError?.(new Error('stream error')),
    triggerDone: () => streamCb?.onDone?.(),
    failNextSend: () => {
      rejectNextSend = true
    },
    failNextChat: () => {
      rejectNextChat = true
    },
    holdNextSend: () => {
      sendGate = new Promise<void>((resolve) => {
        releaseSendGate = resolve
      })
    },
    releaseNextSend: () => releaseSendGate?.(),
    runNextSendIntoActiveTurn: () => {
      nextSendStatus = 'running'
    },
  }
}

function wrap(client: FicusClient) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>
      <ConversationClientProvider client={client}>{children}</ConversationClientProvider>
    </QueryClientProvider>
  )
}

function wrapLive(mockClient: ReturnType<typeof makeMockClient>) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>
      <ConversationClientProvider client={mockClient.client} subscribeToAgentEvents={mockClient.subscribeToAgentEvents}>
        {children}
      </ConversationClientProvider>
    </QueryClientProvider>
  )
}

function wrapWith(qc: QueryClient, client: FicusClient) {
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>
      <ConversationClientProvider client={client}>{children}</ConversationClientProvider>
    </QueryClientProvider>
  )
}

describe('useAgentConversation', () => {
  describe('manual refresh', () => {
    test('refresh() invalidates conversation queries and bumps the stream', async () => {
      const mockClient = makeMockClient({ activeExecution: { active: false } })
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
      const invalidateSpy = spyOn(queryClient, 'invalidateQueries')

      const { result } = await renderHook(() => useAgentConversation({ agentId: 'agent-1' }), {
        wrapper: wrapWith(queryClient, mockClient.client),
      })
      await waitFor(() => expect(mockClient.subscribeCount()).toBe(1))

      act(() => result.current.refresh())

      expect(invalidateSpy).toHaveBeenCalled()
      await waitFor(() => expect(mockClient.subscribeCount()).toBe(2))
    })

    test('refresh() defers query invalidation and stream reconnect while a stream is active', async () => {
      const mockClient = makeMockClient({ activeExecution: { active: false } })
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
      const invalidateSpy = spyOn(queryClient, 'invalidateQueries')

      const { result } = await renderHook(() => useAgentConversation({ agentId: 'agent-1' }), {
        wrapper: wrapWith(queryClient, mockClient.client),
      })
      await waitFor(() => expect(mockClient.subscribeCount()).toBe(1))
      await act(async () => {
        mockClient.emit({ type: 'text', text: 'Hello', streamGroupId: 'S' })
        await Promise.resolve()
      })
      await waitFor(() => expect(result.current.executionStatus).toBe('running'))

      act(() => result.current.refresh())
      await act(async () => {
        await Promise.resolve()
      })

      expect(invalidateSpy).not.toHaveBeenCalled()
      expect(mockClient.subscribeCount()).toBe(1)

      await act(async () => {
        mockClient.emit({ type: 'done', response: 'Hello', streamGroupId: 'S', messageIds: ['m1'] })
        await Promise.resolve()
      })

      await waitFor(() => expect(invalidateSpy).toHaveBeenCalled())
      await waitFor(() => expect(mockClient.subscribeCount()).toBe(2))
    })
  })

  describe('stream reconnect on focus', () => {
    test('re-subscribes the agent stream when focus is regained', async () => {
      const mock = makeMockClient({ activeExecution: { active: false } })
      await renderHook(() => useAgentConversation({ agentId: 'agent-1' }), { wrapper: wrap(mock.client) })

      await waitFor(() => expect(mock.subscribeCount()).toBe(1))

      act(() => focusManager.setFocused(false))
      act(() => focusManager.setFocused(true))

      await waitFor(() => expect(mock.subscribeCount()).toBe(2))
    })

    test('replaces a frozen active stream and refetches durable history on focus regained', async () => {
      const mock = makeMockClient({ activeExecution: { active: false } })
      const { result } = await renderHook(() => useAgentConversation({ agentId: 'agent-1' }), {
        wrapper: wrap(mock.client),
      })
      await waitFor(() => expect(mock.subscribeCount()).toBe(1))
      await waitFor(() => expect(mock.getMessagesCount()).toBe(1))

      await act(async () => {
        mock.emit({ type: 'tool_start', toolCallId: 'tool-1', toolName: 'search', args: '{}', streamGroupId: 'S' })
        mock.emit({ type: 'tool_end', toolCallId: 'tool-1', result: 'ok', isError: false, streamGroupId: 'S' })
        mock.emit({ type: 'text', text: 'Final prefix', streamGroupId: 'S' })
        await Promise.resolve()
      })
      await waitFor(() => expect(result.current.executionStatus).toBe('running'))

      act(() => focusManager.setFocused(false))
      act(() => focusManager.setFocused(true))
      await act(async () => {
        await Promise.resolve()
      })

      await waitFor(() => expect(mock.subscribeCount()).toBe(2))
      await waitFor(() => expect(mock.getMessagesCount()).toBeGreaterThan(1))
      const streaming = result.current.items.find((i) => i.kind === 'streaming')
      expect(streaming?.kind === 'streaming' ? streaming.blocks.map((b) => b.type) : []).toEqual(['tool_use', 'text'])
    })

    test('releases an exact execution pin before reconnecting after terminal completion', async () => {
      const mock = makeMockClient({
        activeExecution: { active: true, executionId: 'exec-terminal', status: 'running' },
      })
      const { result } = await renderHook(() => useAgentConversation({ agentId: 'agent-1' }), {
        wrapper: wrap(mock.client),
      })
      await waitFor(() => expect(mock.subscribedExecutionIds).toContain('exec-terminal'))

      await act(async () => {
        mock.emit({ type: 'done', response: 'complete', streamGroupId: 'S', messageIds: ['m1'] })
        result.current.refresh()
        await Promise.resolve()
      })

      await waitFor(() => expect(mock.subscribeCount()).toBeGreaterThan(2))
      expect(mock.subscribedExecutionIds.at(-1)).toBeUndefined()
    })

    test('releases an exact execution pin after a stopped snapshot', async () => {
      const mock = makeMockClient({ activeExecution: { active: true, executionId: 'exec-stopped', status: 'running' } })
      await renderHook(() => useAgentConversation({ agentId: 'agent-1' }), { wrapper: wrap(mock.client) })
      await waitFor(() => expect(mock.subscribedExecutionIds).toContain('exec-stopped'))
      await act(async () => {
        mock.emit({
          type: 'execution_snapshot',
          executionId: 'exec-stopped',
          executionVersion: 2,
          status: 'stopped',
        } as any)
        focusManager.setFocused(false)
        focusManager.setFocused(true)
        await Promise.resolve()
      })
      await waitFor(() => expect(mock.subscribedExecutionIds.at(-1)).toBeUndefined())
    })

    test('does not reconnect when there is no agentId (compose mode)', async () => {
      const mock = makeMockClient()
      await renderHook(() => useAgentConversation({ agentId: undefined }), { wrapper: wrap(mock.client) })

      act(() => focusManager.setFocused(false))
      act(() => focusManager.setFocused(true))
      await act(async () => {
        await Promise.resolve()
      })

      expect(mock.subscribeCount()).toBe(0)
    })
  })

  test('streams deltas into a single streaming item', async () => {
    const mock = makeMockClient()
    const { result } = await renderHook(() => useAgentConversation({ agentId: 'a1' }), { wrapper: wrap(mock.client) })
    await act(async () => {
      mock.emit({ type: 'agent', agentId: 'a1' })
      mock.emit({ type: 'text', text: 'Hello', streamGroupId: 'S' })
      await Promise.resolve()
    })
    // Deltas merge into a single streaming item (the trailing 'working' indicator is a separate item).
    await waitFor(() => expect(result.current.items.filter((i) => i.kind === 'streaming')).toHaveLength(1))
    expect(result.current.items[0].kind).toBe('streaming')
  })

  test('send adds an optimistic pending item with a clientId and fires the call', async () => {
    const mock = makeMockClient()
    const { result } = await renderHook(() => useAgentConversation({ agentId: 'a1' }), { wrapper: wrap(mock.client) })
    let clientId = ''
    await act(async () => {
      clientId = result.current.send('hi there')
      await Promise.resolve()
    })
    await waitFor(() => expect(result.current.items.some((i) => i.kind === 'pending')).toBe(true))
    expect(clientId).toBeTruthy()
    await waitFor(() => expect(mock.sent[0]).toMatchObject({ content: 'hi there', clientId }))
  })

  test('sendAccepted exposes the stable client ID and resolves on HTTP acceptance', async () => {
    const mock = makeMockClient()
    mock.holdNextSend()
    const { result } = await renderHook(() => useAgentConversation({ agentId: 'a1' }), { wrapper: wrap(mock.client) })
    let accepted!: Promise<void>
    await act(async () => {
      const handle = result.current.sendAccepted('with image', {
        clientId: 'stable-client-id',
        imageIds: ['image-id'],
      })
      expect(handle.clientId).toBe('stable-client-id')
      accepted = handle.accepted
      await Promise.resolve()
    })
    let settled = false
    void accepted.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(mock.sent[0]).toMatchObject({
      content: 'with image',
      clientId: 'stable-client-id',
      imageIds: ['image-id'],
    })

    mock.releaseNextSend()
    await accepted
    expect(settled).toBe(true)
  })

  test('a rejected sendAccepted removes its composer-owned optimistic row', async () => {
    const mock = makeMockClient()
    mock.failNextSend()
    const { result } = await renderHook(() => useAgentConversation({ agentId: 'a1' }), { wrapper: wrap(mock.client) })
    let accepted!: Promise<void>
    await act(async () => {
      accepted = result.current.sendAccepted('retry me', { clientId: 'stable-retry' }).accepted
      await accepted.catch(() => undefined)
    })
    expect(result.current.items.some((item) => item.kind === 'pending' && item.id === 'stable-retry')).toBe(false)
  })

  test('a failed create-flow retry uses the create route with the same client ID', async () => {
    const mock = makeMockClient()
    mock.failNextChat()
    const { result } = await renderHook(() => useAgentConversation({ scope: { type: 'consultant', id: 'squad-id' } }), {
      wrapper: wrap(mock.client),
    })
    let clientId = ''
    await act(async () => {
      clientId = result.current.send('create me', {
        imageIds: ['staged-image'],
        deliveryMode: 'follow-up',
      })
      await Promise.resolve()
    })
    await waitFor(() =>
      expect(result.current.items.some((item) => item.kind === 'pending' && item.status === 'failed')).toBe(true)
    )
    await act(async () => {
      result.current.retrySend(clientId)
      await Promise.resolve()
    })
    await waitFor(() => expect(mock.chatSent).toHaveLength(2))
    expect(mock.chatSent.map((call) => call.clientId)).toEqual([clientId, clientId])
    expect(mock.chatSent[1]).toMatchObject({
      imageIds: ['staged-image'],
      deliveryMode: 'follow-up',
    })
  })

  test('a create-origin retry stays on the create route after another attempt resolves an agent', async () => {
    const mock = makeMockClient()
    mock.failNextChat()
    const { result } = await renderHook(() => useAgentConversation({ scope: { type: 'consultant', id: 'sq-1' } }), {
      wrapper: wrap(mock.client),
    })
    let failedClientId = ''
    await act(async () => {
      failedClientId = result.current.send('first create')
      await Promise.resolve()
    })
    await waitFor(() =>
      expect(result.current.items.some((item) => item.kind === 'pending' && item.status === 'failed')).toBe(true)
    )

    await act(async () => {
      result.current.send('second create')
      await Promise.resolve()
      mock.emitChat({ type: 'agent', agentId: 'resolved-by-second' })
      await Promise.resolve()
    })
    await waitFor(() => expect(result.current.agentId).toBe('resolved-by-second'))

    await act(async () => {
      result.current.retrySend(failedClientId)
      await Promise.resolve()
    })
    await waitFor(() => expect(mock.chatSent).toHaveLength(3))
    expect(mock.sent).toHaveLength(0)
    expect(mock.chatSent[2]?.clientId).toBe(failedClientId)
  })

  test('a failed send transitions the pending item to failed and retrySend re-fires', async () => {
    const mock = makeMockClient()
    const { result } = await renderHook(() => useAgentConversation({ agentId: 'a1' }), { wrapper: wrap(mock.client) })
    mock.failNextSend()
    let clientId = ''
    await act(async () => {
      clientId = result.current.send('flaky')
      await Promise.resolve()
    })
    await waitFor(() => {
      const p = result.current.items.find((i) => i.kind === 'pending')
      expect(p && p.kind === 'pending' && p.status).toBe('failed')
    })
    await act(async () => {
      result.current.retrySend(clientId)
      await Promise.resolve()
    })
    await waitFor(() => expect(mock.sent.length).toBe(2))
  })

  test('a successful send into a running turn is flagged queued', async () => {
    const mock = makeMockClient()
    const { result } = await renderHook(() => useAgentConversation({ agentId: 'a1' }), { wrapper: wrap(mock.client) })
    mock.runNextSendIntoActiveTurn()
    let clientId = ''
    await act(async () => {
      clientId = result.current.send('queued follow-up', { deliveryMode: 'follow-up' })
      await Promise.resolve()
    })
    await waitFor(() => {
      const p = result.current.items.find((i) => i.kind === 'pending' && i.id === clientId)
      expect(p && p.kind === 'pending' && p.queued).toBe(true)
    })
  })

  test('a turn-starting send stays a lone, non-queued pending', async () => {
    const mock = makeMockClient()
    const { result } = await renderHook(() => useAgentConversation({ agentId: 'a1' }), { wrapper: wrap(mock.client) })
    let clientId = ''
    await act(async () => {
      clientId = result.current.send('first message')
      await Promise.resolve()
    })
    await waitFor(() => expect(mock.sent.length).toBe(1))
    const p = result.current.items.find((i) => i.kind === 'pending' && i.id === clientId)
    expect(p && p.kind === 'pending' && p.queued).toBeFalsy()
  })

  test('streamStatus transitions live → reconnecting → live → ended', async () => {
    const mock = makeMockClient()
    const { result } = await renderHook(() => useAgentConversation({ agentId: 'a1' }), { wrapper: wrap(mock.client) })
    expect(result.current.streamStatus).toBe('live')
    await act(async () => {
      mock.triggerDisconnect()
      await Promise.resolve()
    })
    await waitFor(() => expect(result.current.streamStatus).toBe('reconnecting'))
    await act(async () => {
      mock.triggerReconnect()
      await Promise.resolve()
    })
    await waitFor(() => expect(result.current.streamStatus).toBe('live'))
    await act(async () => {
      mock.triggerDone()
      await Promise.resolve()
    })
    await waitFor(() => expect(result.current.streamStatus).toBe('ended'))
  })

  test('cancelAllPending clears queued + failed items', async () => {
    const mock = makeMockClient()
    const { result } = await renderHook(() => useAgentConversation({ agentId: 'a1' }), { wrapper: wrap(mock.client) })
    mock.failNextSend()
    await act(async () => {
      result.current.send('one')
      await Promise.resolve()
    })
    await waitFor(() => expect(result.current.items.some((i) => i.kind === 'pending')).toBe(true))
    await act(async () => {
      result.current.cancelAllPending()
      await Promise.resolve()
    })
    await waitFor(() => expect(result.current.items.some((i) => i.kind === 'pending')).toBe(false))
  })

  test('cancelAllPending refetches persisted queued messages after server clear', async () => {
    const queuedMessage: Message = {
      id: 'm-queued',
      agentId: 'a1',
      role: 'human',
      content: 'already persisted queued message',
      metadata: { deliveryMode: 'steer' },
      pending: true,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    }
    const mock = makeMockClient({ messages: [queuedMessage] })
    const { result } = await renderHook(() => useAgentConversation({ agentId: 'a1' }), { wrapper: wrap(mock.client) })

    await waitFor(() => expect(result.current.items.some((i) => i.kind === 'pending' && i.queued)).toBe(true))

    await act(async () => {
      await result.current.cancelAllPending()
    })

    await waitFor(() => expect(result.current.items.some((i) => i.kind === 'pending' && i.queued)).toBe(false))
  })

  test('navigation context travels separately, only after a page change, and survives a retry', async () => {
    const mock = makeMockClient()
    let pagePath = '/'
    const hook = await renderHook(() => useAgentConversation({ agentId: 'a1', pagePath }), {
      wrapper: wrap(mock.client),
    })
    try {
      await act(async () => {
        hook.result.current.send('First')
      })
      await act(async () => {
        hook.result.current.send('Same page')
      })
      expect(mock.sent.map((call) => call.pagePath)).toEqual(['/', undefined])
      expect(mock.sent.map((call) => call.content)).toEqual(['First', 'Same page'])
      pagePath = '/squads/tau'
      await hook.rerender()
      expect(mock.sent).toHaveLength(2) // navigation alone never sends
      mock.failNextSend()
      let clientId = ''
      await act(async () => {
        clientId = hook.result.current.send('Changed page')
      })
      await waitFor(() =>
        expect(hook.result.current.items.some((i) => i.kind === 'pending' && i.status === 'failed')).toBe(true)
      )
      pagePath = '/settings'
      await hook.rerender()
      await act(async () => {
        hook.result.current.retrySend(clientId)
      })
      await act(async () => {
        hook.result.current.send('New location')
      })
      expect(mock.sent.slice(2).map((call) => call.pagePath)).toEqual(['/squads/tau', '/squads/tau', '/settings'])
    } finally {
      hook.unmount()
    }
  })

  test('create flow: no agentId → first send streams via chat then resolves agentId', async () => {
    const mock = makeMockClient()
    const { result } = await renderHook(
      () => useAgentConversation({ scope: { type: 'system-manager' }, pagePath: '/' }),
      {
        wrapper: wrap(mock.client),
      }
    )
    expect(result.current.agentId).toBeUndefined()
    await act(async () => {
      result.current.send('hello')
      await Promise.resolve()
    })
    // chat.sendChatMessage was called with the message + scope + a clientId
    expect(mock.chatSent[0]).toMatchObject({ message: 'hello', scope: { type: 'system-manager' }, pagePath: '/' })
    expect(mock.chatSent[0].clientId).toBeTruthy()
    // server streams the agent event → agentId resolves and the agent stream subscription
    // takes over as the sole event source (chat-stream events after handoff are gated)
    await act(async () => {
      mock.emitChat({ type: 'agent', agentId: 'created-1' })
      await Promise.resolve()
    })
    await waitFor(() => expect(result.current.agentId).toBe('created-1'))
    // Content events now arrive via the agent stream (catchup/live), not the chat stream.
    await act(async () => {
      mock.emit({ type: 'text', text: 'hi', streamGroupId: 'S' })
      await Promise.resolve()
    })
    expect(result.current.items.some((i) => i.kind === 'streaming')).toBe(true)
  })

  test('abortTool calls the resource for the resolved agent', async () => {
    const mock = makeMockClient()
    const { result } = await renderHook(() => useAgentConversation({ agentId: 'a1' }), { wrapper: wrap(mock.client) })
    await act(async () => result.current.abortTool())
    await waitFor(() => expect(mock.aborted).toContain('a1'))
  })

  test('exposes pagination controls from the messages query', async () => {
    const mock = makeMockClient()
    const { result } = await renderHook(() => useAgentConversation({ agentId: 'a1' }), { wrapper: wrap(mock.client) })
    expect(typeof result.current.fetchOlder).toBe('function')
    expect(result.current.hasOlder).toBe(false)
  })

  test('fetchOlder forwards nextCursor and merges equal-timestamp pages with adversarial IDs', async () => {
    const tiedAt = new Date('2026-02-03T04:05:06.000Z')
    const message = (id: string, content: string, role: 'human' | 'assistant'): Message => ({
      id,
      agentId: 'a1',
      role,
      content,
      metadata: {},
      pending: false,
      createdAt: tiedAt,
    })
    const oldest = message('ffffffff-ffff-4fff-8fff-ffffffffffff', 'Oldest enqueue', 'human')
    const middle = message('88888888-8888-4888-8888-888888888888', 'Middle enqueue', 'assistant')
    const newest = message('00000000-0000-4000-8000-000000000000', 'Newest enqueue', 'human')
    const mock = makeMockClient({
      messagePages: {
        first: {
          messages: [middle, newest],
          pagination: { hasMore: true, totalCount: 3, nextCursor: 'opaque-tied-boundary' },
        },
        'opaque-tied-boundary': {
          messages: [oldest],
          pagination: { hasMore: false, totalCount: 0 },
        },
      },
    })
    const { result } = await renderHook(() => useAgentConversation({ agentId: 'a1' }), { wrapper: wrap(mock.client) })

    await waitFor(() => expect(result.current.hasOlder).toBe(true))
    await act(async () => result.current.fetchOlder())

    await waitFor(() => expect(mock.getMessagesOptions).toHaveLength(2))
    expect(mock.getMessagesOptions[1]).toMatchObject({ cursor: 'opaque-tied-boundary' })
    await waitFor(() =>
      expect(
        result.current.items
          .filter((item) => item.kind === 'persisted')
          .map((item) => (item.kind === 'persisted' ? item.message.id : ''))
          .sort()
      ).toEqual([oldest.id, middle.id, newest.id].sort())
    )
    expect(result.current.hasOlder).toBe(false)
  })

  test('onDone fires when the done event arrives on the agent stream', async () => {
    const mc = makeMockClient()
    const onDone = mock((_response: string, _metadata: unknown, _messageId?: string) => {})
    const { result } = await renderHook(() => useAgentConversation({ agentId: 'a1', onDone }), {
      wrapper: wrap(mc.client),
    })
    await act(async () => {
      mc.emit({ type: 'done', response: 'Hello done', metadata: { model: 'x' } as any, messageId: 'msg-1' })
      await Promise.resolve()
    })
    await waitFor(() => expect(onDone).toHaveBeenCalledWith('Hello done', { model: 'x' }, 'msg-1'))
    // Silence unused result warning
    void result
  })

  test('executionStatus tracks the stream: running on content, completed on done', async () => {
    const mc = makeMockClient()
    const { result } = await renderHook(() => useAgentConversation({ agentId: 'a1' }), { wrapper: wrap(mc.client) })
    await act(async () => {
      mc.emit({ type: 'agent', agentId: 'a1' })
      mc.emit({ type: 'text', text: 'working', streamGroupId: 'S' })
      await Promise.resolve()
    })
    await waitFor(() => expect(result.current.executionStatus).toBe('running'))
    // Regression: must terminalize so the "agent is working" indicator clears (was stuck at running).
    await act(async () => {
      mc.emit({ type: 'done', response: 'ok', metadata: null as any, messageId: 'm1' })
      await Promise.resolve()
    })
    await waitFor(() => expect(result.current.executionStatus).toBe('completed'))
  })

  test('done delivered via catchup (reconnect / late subscribe) terminalizes the indicator', async () => {
    const mc = makeMockClient()
    const { result } = await renderHook(() => useAgentConversation({ agentId: 'a1' }), { wrapper: wrap(mc.client) })
    await act(async () => {
      mc.emit({ type: 'text', text: 'working', streamGroupId: 'S' })
      await Promise.resolve()
    })
    await waitFor(() => expect(result.current.executionStatus).toBe('running'))
    // The turn's done arrives inside a catchup batch (reconnect / late subscribe).
    await act(async () => {
      mc.emitCatchup([
        {
          type: 'done',
          response: 'ok',
          metadata: null as any,
          messageId: 'm1',
          streamGroupId: 'S',
          messageIds: ['m1'],
        },
      ] as any)
      await Promise.resolve()
    })
    expect(result.current.executionStatus).toBe('completed')
  })

  describe('waitingForSandbox (sandbox wait indicator)', () => {
    test('execution_phase: waiting_sandbox tags the working item; a content event clears it', async () => {
      const mc = makeMockClient()
      const { result } = await renderHook(() => useAgentConversation({ agentId: 'a1' }), { wrapper: wrap(mc.client) })
      await act(async () => {
        mc.emit({ type: 'agent', agentId: 'a1' })
        mc.emit({ type: 'execution_phase', phase: 'waiting_sandbox' } as any)
        await Promise.resolve()
      })
      await waitFor(() =>
        expect(result.current.items.find((i) => i.kind === 'working')).toMatchObject({ waitingFor: 'sandbox' })
      )
      // A content event means the sandbox is definitely up — clears the label even without an
      // explicit sandbox_ready (belt and suspenders per the design).
      await act(async () => {
        mc.emit({ type: 'text', text: 'hi', streamGroupId: 'S' })
        await Promise.resolve()
      })
      const working = result.current.items.find((i) => i.kind === 'working') as { waitingFor?: string } | undefined
      expect(working?.waitingFor).toBeUndefined()
    })

    test('execution_phase: sandbox_ready clears the flag explicitly', async () => {
      const mc = makeMockClient()
      const { result } = await renderHook(() => useAgentConversation({ agentId: 'a1' }), { wrapper: wrap(mc.client) })
      await act(async () => {
        mc.emit({ type: 'agent', agentId: 'a1' })
        mc.emit({ type: 'execution_phase', phase: 'waiting_sandbox' } as any)
        await Promise.resolve()
      })
      await waitFor(() =>
        expect(result.current.items.find((i) => i.kind === 'working')).toMatchObject({ waitingFor: 'sandbox' })
      )
      await act(async () => {
        mc.emit({ type: 'execution_phase', phase: 'sandbox_ready' } as any)
        await Promise.resolve()
      })
      const working = result.current.items.find((i) => i.kind === 'working') as { waitingFor?: string } | undefined
      expect(working?.waitingFor).toBeUndefined()
    })

    test('is returned as a plain boolean alongside executionStatus (for header chrome outside the item list)', async () => {
      // AgentConversationBody's execution badge lives in a header OUTSIDE the
      // rendered item list, so it needs the raw signal — not just the tagged
      // working item — to say "Waiting for sandbox" while the DB row is 'running'.
      const mc = makeMockClient()
      const { result } = await renderHook(() => useAgentConversation({ agentId: 'a1' }), { wrapper: wrap(mc.client) })
      expect(result.current.waitingForSandbox).toBe(false)
      await act(async () => {
        mc.emit({ type: 'agent', agentId: 'a1' })
        mc.emit({ type: 'execution_phase', phase: 'waiting_sandbox' } as any)
        await Promise.resolve()
      })
      await waitFor(() => expect(result.current.waitingForSandbox).toBe(true))
      expect(result.current.executionStatus).toBe('running')
      await act(async () => {
        mc.emit({ type: 'execution_phase', phase: 'sandbox_ready' } as any)
        await Promise.resolve()
      })
      expect(result.current.waitingForSandbox).toBe(false)
      expect(result.current.executionStatus).toBe('running')
    })

    test('a terminal transition (done) clears the flag so a later plain busy window is not mislabeled', async () => {
      const mc = makeMockClient()
      const { result } = await renderHook(() => useAgentConversation({ agentId: 'a1' }), { wrapper: wrap(mc.client) })
      await act(async () => {
        mc.emit({ type: 'agent', agentId: 'a1' })
        mc.emit({ type: 'execution_phase', phase: 'waiting_sandbox' } as any)
        await Promise.resolve()
      })
      await waitFor(() =>
        expect(result.current.items.find((i) => i.kind === 'working')).toMatchObject({ waitingFor: 'sandbox' })
      )
      await act(async () => {
        mc.emit({ type: 'done', response: 'ok', metadata: null as any, messageId: 'm1' })
        await Promise.resolve()
      })
      expect(result.current.items.some((i) => i.kind === 'working')).toBe(false)
      // A later turn starts (optimistic send) with no execution_phase event — must not inherit the
      // stale sandbox label from the previous turn.
      await act(async () => {
        result.current.send('again')
        await Promise.resolve()
      })
      const working = result.current.items.find((i) => i.kind === 'working') as { waitingFor?: string } | undefined
      expect(working).toBeDefined()
      expect(working?.waitingFor).toBeUndefined()
    })
  })

  test('sandbox_recovery_wait keeps transport completion nonterminal', async () => {
    const mc = makeMockClient({ activeExecution: { active: false } })
    const { result } = await renderHook(() => useAgentConversation({ agentId: 'a1' }), {
      wrapper: wrap(mc.client),
    })
    await act(async () => {
      mc.emit({ type: 'execution_phase', phase: 'sandbox_recovery_wait' })
      mc.triggerDone()
      await Promise.resolve()
    })
    expect(result.current.streamStatus).toBe('ended')
    expect(result.current.executionStatus).toBe('waiting-sandbox')
    expect(result.current.items.find((item) => item.kind === 'working')).toMatchObject({ waitingFor: 'sandbox' })
  })

  test('keeps a closed recovery transport nonterminal and reconnects the same execution when queued', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const mc = makeMockClient({
      activeExecution: { active: true, executionId: 'exec-wait', status: 'waiting-sandbox' },
    })
    const { result } = await renderHook(() => useAgentConversation({ agentId: 'a1' }), {
      wrapper: wrapWith(qc, mc.client),
    })
    await waitFor(() => expect(result.current.executionStatus).toBe('waiting-sandbox'))
    await act(async () => {
      mc.emit({ type: 'execution_phase', phase: 'sandbox_recovery_wait' })
      mc.triggerDone()
      await Promise.resolve()
    })
    expect(result.current.streamStatus).toBe('ended')
    expect(result.current.executionStatus).toBe('waiting-sandbox')
    expect(result.current.items.find((item) => item.kind === 'working')).toMatchObject({ waitingFor: 'sandbox' })

    const subscriptionsBeforeResume = mc.subscribeCount()
    mc.setActiveExecution({ active: true, executionId: 'exec-wait', status: 'queued' })
    await act(async () => {
      await qc.invalidateQueries({ queryKey: queryKeys.agents.activeExecution('a1') })
    })
    await waitFor(() => expect(result.current.executionStatus).toBe('queued'))
    await waitFor(() => expect(mc.subscribeCount()).toBeGreaterThan(subscriptionsBeforeResume))
  })

  test('follows the same parked execution id through maintenance resume and terminal catchup', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const mc = makeMockClient({
      activeExecution: { active: true, executionId: 'exec-maintenance', status: 'waiting-maintenance' },
    })
    const { result } = await renderHook(() => useAgentConversation({ agentId: 'a1' }), {
      wrapper: wrapWith(qc, mc.client),
    })
    await waitFor(() => expect(result.current.executionStatus).toBe('waiting-maintenance'))
    await waitFor(() => expect(mc.subscribedExecutionIds).toContain('exec-maintenance'))

    mc.setActiveExecution({ active: true, executionId: 'exec-maintenance', status: 'running' })
    await act(async () => {
      await qc.invalidateQueries({ queryKey: queryKeys.agents.activeExecution('a1') })
    })
    await waitFor(() => expect(result.current.executionStatus).toBe('running'))
    expect(mc.subscribedExecutionIds.at(-1)).toBe('exec-maintenance')

    await act(async () => {
      mc.emitCatchup([
        { type: 'text', text: 'completed before reconnect', streamGroupId: 'S' },
        {
          type: 'done',
          response: 'completed before reconnect',
          metadata: null as any,
          messageId: 'm1',
          streamGroupId: 'S',
          messageIds: ['m1'],
        },
      ] as any)
      await Promise.resolve()
    })
    expect(result.current.executionStatus).toBe('completed')
    expect(result.current.items.some((item) => item.kind === 'streaming')).toBe(true)
  })

  test('re-subscribes to the agent stream when a new execution starts (follow-up turns stream live)', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const mc = makeMockClient({ activeExecution: { active: true, executionId: 'exec-1' } })
    const { result } = await renderHook(() => useAgentConversation({ agentId: 'a1' }), {
      wrapper: wrapWith(qc, mc.client),
    })
    // Let the first execution settle (mount subscribe + exec-1 reconnect).
    await waitFor(() => expect(mc.subscribeCount()).toBeGreaterThanOrEqual(1))
    await act(async () => {
      await Promise.resolve()
    })
    const afterFirst = mc.subscribeCount()
    // A new turn starts: the active execution now reports a different id. The per-execution worker
    // stream for exec-1 already closed on its 'done', so the hook must reconnect for exec-2.
    mc.setActiveExecution({ active: true, executionId: 'exec-2' })
    await act(async () => {
      await qc.invalidateQueries({ queryKey: queryKeys.agents.activeExecution('a1') })
      await Promise.resolve()
    })
    await waitFor(() => expect(mc.subscribeCount()).toBeGreaterThan(afterFirst))
    void result
  })

  test('queuedCount counts only sends into a running turn; cancelAllPending clears them', async () => {
    const mc = makeMockClient()
    try {
      const { result } = await renderHook(() => useAgentConversation({ agentId: 'a1' }), { wrapper: wrap(mc.client) })
      // A content event starts the turn (group.startedAt=1000) → active streaming group.
      setSystemTime(1000)
      await act(async () => {
        mc.emit({ type: 'text', text: 'working', streamGroupId: 'S' })
        await Promise.resolve()
      })
      // A message sent later (createdAt=2000 > startedAt) is a queued interrupt.
      setSystemTime(2000)
      await act(async () => {
        result.current.send('hold on')
        await Promise.resolve()
      })
      setSystemTime() // restore real clock before any waitFor (it reads Date.now)
      expect(result.current.queuedCount).toBe(1)
      expect(result.current.items.some((i) => i.kind === 'pending' && i.queued)).toBe(true)
      // Clearing removes it (the bug was clearing keyed on status 'queued', but interrupts stay 'sending').
      await act(async () => {
        result.current.cancelAllPending()
        await Promise.resolve()
      })
      expect(result.current.queuedCount).toBe(0)
      expect(result.current.items.some((i) => i.kind === 'pending')).toBe(false)
    } finally {
      setSystemTime()
    }
  })

  test('a lone send that starts the turn is not counted as queued (clear control stays hidden)', async () => {
    const mc = makeMockClient()
    const { result } = await renderHook(() => useAgentConversation({ agentId: 'a1' }), { wrapper: wrap(mc.client) })
    await act(async () => {
      result.current.send('start the turn')
      await Promise.resolve()
    })
    // No active group precedes it → region-A lone send, not a queued interrupt.
    expect(result.current.queuedCount).toBe(0)
  })

  test('send optimistically marks the agent running so the indicator shows before the first event', async () => {
    const mc = makeMockClient()
    const { result } = await renderHook(() => useAgentConversation({ agentId: 'a1' }), { wrapper: wrap(mc.client) })
    await act(async () => {
      result.current.send('do it')
      await Promise.resolve()
    })
    // No stream event has arrived yet, but executionStatus is already running and combine() emits a
    // working item — so the activity indicator never gaps between send and the first event.
    expect(result.current.executionStatus).toBe('running')
    expect(result.current.items.some((i) => i.kind === 'working')).toBe(true)
  })

  test('seeds executionStatus from the live activeExecution query (agent already running on open)', async () => {
    const mc = makeMockClient({ activeExecution: { active: true, status: 'running' } })
    const { result } = await renderHook(() => useAgentConversation({ agentId: 'a1' }), { wrapper: wrap(mc.client) })
    // No SSE event emitted — the indicator comes purely from the server-truth query.
    await waitFor(() => expect(result.current.executionStatus).toBe('running'))
    expect(result.current.items.some((i) => i.kind === 'working')).toBe(true)
  })

  test('a lagging terminal live status does not synchronously clobber an optimistic running send', async () => {
    // activeExecution still reports the PREVIOUS turn as completed when the next send goes out.
    const mc = makeMockClient({ activeExecution: { active: false, status: 'completed' } })
    const { result } = await renderHook(() => useAgentConversation({ agentId: 'a1' }), { wrapper: wrap(mc.client) })
    await act(async () => {
      result.current.send('go')
      await Promise.resolve()
    })
    // The backstop is debounced on stream-quiet, so the stale 'completed' must NOT clear the
    // just-sent running state (that would re-open the very gap the optimistic seed closes).
    expect(result.current.executionStatus).toBe('running')
    expect(result.current.items.some((i) => i.kind === 'working')).toBe(true)
  })

  test('clears a stuck-running indicator when the server reports the agent idle (active:false)', async () => {
    // Realistic idle response: the server's /active endpoint only ever reports queued/running/stopping;
    // once the turn ends there is no active execution, so it returns { active: false } with NO status.
    // (A dropped SSE 'done' — e.g. a reconnect whose catchup doesn't re-drive executionStatus — leaves
    // the local status stuck 'running'; the server-truth backstop must terminalize it.)
    const mc = makeMockClient({ activeExecution: { active: false } })
    // Fire the 4s backstop timer immediately (delegate all other timers to real ones), and use
    // setSystemTime so the stream-quiet gate (Date.now() - lastStreamAt >= STREAM_QUIET_MS) passes
    // without a real 4s wait. bun lacks advanceTimersByTime, so we short-circuit the one timer.
    const realSetTimeout = globalThis.setTimeout
    const STREAM_QUIET_MS = 4000
    globalThis.setTimeout = ((fn: (...a: unknown[]) => void, delay?: number, ...args: unknown[]) =>
      realSetTimeout(fn, delay === STREAM_QUIET_MS ? 0 : delay, ...args)) as typeof globalThis.setTimeout
    setSystemTime(1_700_000_000_000)
    try {
      const { result } = await renderHook(() => useAgentConversation({ agentId: 'a1' }), { wrapper: wrap(mc.client) })
      // Content event drives executionStatus to running; we deliberately never emit 'done'.
      await act(async () => {
        mc.emit({ type: 'text', text: 'working', streamGroupId: 'S' })
        await Promise.resolve()
      })
      expect(result.current.executionStatus).toBe('running')
      expect(result.current.items.some((i) => i.kind === 'working')).toBe(true)

      // Stream goes quiet: jump the clock past STREAM_QUIET_MS, then let the (now-immediate) backstop run.
      setSystemTime(1_700_000_000_000 + STREAM_QUIET_MS + 1000)
      await act(async () => {
        await new Promise((r) => realSetTimeout(r, 10))
      })

      // The activity indicator must clear even though the server returned active:false with no status.
      expect(result.current.executionStatus).not.toBe('running')
      expect(result.current.items.some((i) => i.kind === 'working')).toBe(false)
    } finally {
      globalThis.setTimeout = realSetTimeout
      setSystemTime()
    }
  })

  test('onDone fires on the chat-create path when a done event arrives', async () => {
    const mc = makeMockClient()
    const onDone = mock((_response: string, _metadata: unknown, _messageId?: string) => {})
    const { result } = await renderHook(() => useAgentConversation({ scope: { type: 'system-manager' }, onDone }), {
      wrapper: wrap(mc.client),
    })
    await act(async () => {
      result.current.send('hello')
      await Promise.resolve()
    })
    // chat.sendChatMessage was called
    expect(mc.chatSent[0]).toMatchObject({ message: 'hello', scope: { type: 'system-manager' } })
    // Emit done event on the chat-create stream
    await act(async () => {
      mc.emitChat({
        type: 'done',
        response: 'Created response',
        metadata: { model: 'y' } as any,
        messageId: 'msg-create-1',
      })
      await Promise.resolve()
    })
    await waitFor(() => expect(onDone).toHaveBeenCalledWith('Created response', { model: 'y' }, 'msg-create-1'))
    // Silence unused result warning
    void result
  })

  test('onDone fires exactly once when the same done event arrives on both streams (dedup by streamGroupId)', async () => {
    const mc = makeMockClient()
    const onDone = mock((_response: string, _metadata: unknown, _messageId?: string) => {})
    const { result } = await renderHook(() => useAgentConversation({ scope: { type: 'system-manager' }, onDone }), {
      wrapper: wrap(mc.client),
    })
    // Trigger the create flow
    await act(async () => {
      result.current.send('hello')
      await Promise.resolve()
    })
    expect(mc.chatSent[0]).toMatchObject({ message: 'hello', scope: { type: 'system-manager' } })

    // Emit an agent event (which sets resolvedAgentId and subscribes agent stream)
    await act(async () => {
      mc.emitChat({ type: 'agent', agentId: 'dedup-agent-1' })
      await Promise.resolve()
    })
    await waitFor(() => expect(result.current.agentId).toBe('dedup-agent-1'))

    const doneEvent: import('@ficus/shared').StreamEvent = {
      type: 'done',
      response: 'Dedup response',
      metadata: { model: 'z' } as any,
      messageId: 'msg-dedup-1',
      streamGroupId: 'group-dedup-1',
    }

    // Fire done on the chat-create stream first
    await act(async () => {
      mc.emitChat(doneEvent)
      await Promise.resolve()
    })
    // Fire the same done on the agent stream (double-fire scenario)
    await act(async () => {
      mc.emit(doneEvent)
      await Promise.resolve()
    })

    // onDone must have been called exactly once
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1))
    expect(onDone).toHaveBeenCalledWith('Dedup response', { model: 'z' }, 'msg-dedup-1')

    void result
  })

  test('onDone is deduplicated when reconnect catchup replays a live terminal event', async () => {
    const mc = makeMockClient({ activeExecution: { active: true, executionId: 'exec-dedup', status: 'running' } })
    const onDone = mock((_response: string, _metadata: unknown, _messageId?: string) => {})
    await renderHook(() => useAgentConversation({ agentId: 'a1', onDone }), { wrapper: wrap(mc.client) })
    const doneEvent = {
      type: 'done',
      response: 'durable result',
      metadata: null as any,
      messageId: 'msg-durable',
      streamGroupId: 'group-durable',
      messageIds: ['msg-durable'],
    } as StreamEvent

    await act(async () => {
      mc.emit(doneEvent)
      mc.emitCatchup([doneEvent])
      await Promise.resolve()
    })

    expect(onDone).toHaveBeenCalledTimes(1)
  })

  test('create flow: events are not duplicated when both chat and agent stream deliver them', async () => {
    const mc = makeMockClient()
    const { result } = await renderHook(() => useAgentConversation({ scope: { type: 'consultant', id: 'sq-1' } }), {
      wrapper: wrap(mc.client),
    })

    // Start the create flow.
    await act(async () => {
      result.current.send('hello')
      await Promise.resolve()
    })

    // Chat stream delivers the agent event -> resolves agentId + triggers agent stream subscription.
    await act(async () => {
      mc.emitChat({ type: 'agent', agentId: 'created-1' })
      await Promise.resolve()
    })
    await waitFor(() => expect(result.current.agentId).toBe('created-1'))

    // Both streams deliver the same text delta. The hook must ingest it exactly once.
    await act(async () => {
      mc.emitChat({ type: 'text', text: 'Hello world', streamGroupId: 'S' })
      mc.emit({ type: 'text', text: 'Hello world', streamGroupId: 'S' })
      await Promise.resolve()
    })

    const streamingItems = result.current.items.filter((i) => i.kind === 'streaming')
    expect(streamingItems).toHaveLength(1)
    const blocks = streamingItems[0].kind === 'streaming' ? streamingItems[0].blocks : []
    const textBlocks = blocks.filter((b) => b.type === 'text')
    expect(textBlocks).toHaveLength(1)
    expect(textBlocks[0]).toMatchObject({ content: 'Hello world' })
  })

  test('create flow: thinking blocks are not duplicated across chat and agent stream', async () => {
    const mc = makeMockClient()
    const { result } = await renderHook(() => useAgentConversation({ scope: { type: 'consultant', id: 'sq-1' } }), {
      wrapper: wrap(mc.client),
    })

    await act(async () => {
      result.current.send('hello')
      await Promise.resolve()
    })

    await act(async () => {
      mc.emitChat({ type: 'agent', agentId: 'created-2' })
      await Promise.resolve()
    })
    await waitFor(() => expect(result.current.agentId).toBe('created-2'))

    await act(async () => {
      mc.emitChat({ type: 'thinking', text: 'Planning', streamGroupId: 'S' })
      mc.emitChat({ type: 'thinking_end', durationMs: 500, streamGroupId: 'S' })
      mc.emit({ type: 'thinking', text: 'Planning', streamGroupId: 'S' })
      mc.emit({ type: 'thinking_end', durationMs: 500, streamGroupId: 'S' })
      await Promise.resolve()
    })

    const streamingItems = result.current.items.filter((i) => i.kind === 'streaming')
    expect(streamingItems).toHaveLength(1)
    const blocks = streamingItems[0].kind === 'streaming' ? streamingItems[0].blocks : []
    const thinkingBlocks = blocks.filter((b) => b.type === 'thinking')
    expect(thinkingBlocks).toHaveLength(1)
    expect(thinkingBlocks[0]).toMatchObject({ content: 'Planning' })
  })

  test('uses the shared messagesInfinite query key', async () => {
    // Spy: the mock getMessages records the agentId it was called with; assert the
    // QueryClient cache has an entry under queryKeys.agents.messagesInfinite('a1').
    const mock = makeMockClient()
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    await renderHook(() => useAgentConversation({ agentId: 'a1' }), { wrapper: wrapWith(qc, mock.client) })
    await waitFor(() => expect(qc.getQueryData(queryKeys.agents.messagesInfinite('a1'))).toBeDefined())
  })

  test('surfaces system_message events as system render items', async () => {
    const mock = makeMockClient()
    const { result } = await renderHook(() => useAgentConversation({ agentId: 'a1' }), { wrapper: wrap(mock.client) })
    await act(async () => {
      mock.emit({ type: 'system_message', text: 'Retrying (attempt 1/3)' })
      await Promise.resolve()
    })
    await waitFor(() => expect(result.current.items.some((i) => i.kind === 'system')).toBe(true))
    const sys = result.current.items.find((i) => i.kind === 'system')!
    expect(sys.kind === 'system' && sys.text).toBe('Retrying (attempt 1/3)')
  })

  test('removes transient system render items when a clear event arrives', async () => {
    const mock = makeMockClient()
    const { result } = await renderHook(() => useAgentConversation({ agentId: 'a1' }), { wrapper: wrap(mock.client) })
    await act(async () => {
      mock.emit({ type: 'system_message', text: 'Retrying (attempt 1/3)', transientId: 'auto-retry' })
      await Promise.resolve()
    })
    await waitFor(() => expect(result.current.items.some((i) => i.kind === 'system')).toBe(true))

    await act(async () => {
      mock.emit({ type: 'system_message_clear', transientId: 'auto-retry' })
      await Promise.resolve()
    })

    await waitFor(() => expect(result.current.items.some((i) => i.kind === 'system')).toBe(false))
    expect(result.current.executionStatus).not.toBe('running')
  })

  test('exposes compactionState from compaction_start/end', async () => {
    const mock = makeMockClient()
    const { result } = await renderHook(() => useAgentConversation({ agentId: 'a1' }), { wrapper: wrap(mock.client) })
    await act(async () => {
      mock.emit({ type: 'compaction_start', reason: 'auto' })
      await Promise.resolve()
    })
    await waitFor(() => expect(result.current.compactionState).toEqual({ reason: 'auto' }))
    await act(async () => {
      mock.emit({ type: 'compaction_end', success: true, aborted: false })
      await Promise.resolve()
    })
    await waitFor(() => expect(result.current.compactionState).toBeNull())
  })

  describe('live durable message reconciliation', () => {
    const durableMessage = (overrides: Partial<Message> = {}): Message => ({
      id: 'inbound-1',
      agentId: 'a1',
      role: 'human',
      content: 'incoming',
      metadata: {},
      pending: false,
      createdAt: new Date('2026-02-03T04:05:06.000Z'),
      ...overrides,
    })

    test('message.created inserts the fetched durable row without refetching history', async () => {
      const inbound = durableMessage()
      const mock = makeMockClient({ durableMessages: { [inbound.id]: inbound } })
      const { result } = await renderHook(() => useAgentConversation({ agentId: 'a1' }), {
        wrapper: wrapLive(mock),
      })
      await waitFor(() => expect(mock.getMessagesCount()).toBe(1))

      await act(async () => {
        mock.emitAgentEvent('a1', 'message.created', { agentId: 'a1', messageId: inbound.id })
        await Promise.resolve()
      })

      await waitFor(() =>
        expect(result.current.items.some((item) => item.kind === 'persisted' && item.message.id === inbound.id)).toBe(
          true
        )
      )
      expect(mock.getMessagesCount()).toBe(1)
      expect(mock.getMessageCount()).toBe(1)
    })

    test('an unresolved created event barriers a stream that begins afterward', async () => {
      let resolveMessage!: (message: Message) => void
      const fetched = new Promise<Message>((resolve) => (resolveMessage = resolve))
      const inbound = durableMessage()
      const mock = makeMockClient({ durableMessages: { [inbound.id]: fetched } })
      const { result } = await renderHook(() => useAgentConversation({ agentId: 'a1' }), {
        wrapper: wrapLive(mock),
      })
      await waitFor(() => expect(mock.getMessagesCount()).toBe(1))

      await act(async () => {
        mock.emitAgentEvent('a1', 'message.created', { agentId: 'a1', messageId: inbound.id })
        mock.emit({ type: 'text', text: 'response', streamGroupId: 'stream-1' })
        await Promise.resolve()
      })
      expect(result.current.items.some((item) => item.kind === 'streaming')).toBe(false)

      await act(async () => {
        resolveMessage(inbound)
        await fetched
      })
      await waitFor(() => {
        const persistedIndex = result.current.items.findIndex((item) => item.kind === 'persisted')
        const streamingIndex = result.current.items.findIndex((item) => item.kind === 'streaming')
        expect(persistedIndex).toBeGreaterThanOrEqual(0)
        expect(streamingIndex).toBeGreaterThan(persistedIndex)
      })
    })

    test('an authoritative history refetch retires the live override for the same durable ID', async () => {
      const live = durableMessage({
        role: 'assistant',
        content: 'working',
        metadata: {
          content: [
            {
              type: 'tool_use',
              id: 'tool-1',
              toolCall: { toolCallId: 'tool-1', toolName: 'read', args: '{}', result: '', isError: false },
            },
          ],
        },
      })
      const mock = makeMockClient({ durableMessages: { [live.id]: live } })
      const { result } = await renderHook(() => useAgentConversation({ agentId: 'a1' }), {
        wrapper: wrapLive(mock),
      })
      await act(async () => {
        mock.emitAgentEvent('a1', 'message.created', { agentId: 'a1', messageId: live.id })
        await Promise.resolve()
      })
      await waitFor(() => expect(result.current.items.some((item) => item.kind === 'persisted')).toBe(true))

      const completed = durableMessage({
        role: 'assistant',
        content: 'done',
        metadata: {
          content: [
            {
              type: 'tool_use',
              id: 'tool-1',
              toolCall: {
                toolCallId: 'tool-1',
                toolName: 'read',
                args: '{}',
                result: 'completed result',
                isError: false,
              },
            },
          ],
        },
      })
      mock.setMessages([completed])
      await act(async () => result.current.refresh())
      await waitFor(() => expect(mock.getMessagesCount()).toBeGreaterThanOrEqual(2))
      await waitFor(() => {
        const persisted = result.current.items.find((item) => item.kind === 'persisted')
        expect(persisted?.kind === 'persisted' ? persisted.message.content : '').toBe('done')
        expect(
          persisted?.kind === 'persisted'
            ? persisted.message.metadata?.content?.[0]?.type === 'tool_use' &&
                persisted.message.metadata.content[0].toolCall.result
            : ''
        ).toBe('completed result')
      })
    })

    test('an older collection request resolving after a live fetch does not retire the newer row', async () => {
      const stale = durableMessage({ content: 'stale collection' })
      const live = durableMessage({ content: 'new live row' })
      const collectionMarker = durableMessage({ id: 'collection-marker', content: 'collection resolved' })
      let resolveCollection!: (page: {
        messages: Message[]
        pagination: { hasMore: boolean; totalCount: number }
      }) => void
      const olderCollection = new Promise<{
        messages: Message[]
        pagination: { hasMore: boolean; totalCount: number }
      }>((resolve) => (resolveCollection = resolve))
      const mock = makeMockClient({
        durableMessages: { [live.id]: live },
        getMessages: () => olderCollection,
      })
      const { result } = await renderHook(() => useAgentConversation({ agentId: 'a1' }), {
        wrapper: wrapLive(mock),
      })
      await waitFor(() => expect(mock.getMessagesCount()).toBe(1))

      await act(async () => {
        mock.emitAgentEvent('a1', 'message.updated', { agentId: 'a1', messageId: live.id })
        await Promise.resolve()
      })
      await waitFor(() =>
        expect(
          result.current.items.some(
            (item) =>
              item.kind === 'persisted' && item.message.id === live.id && item.message.content === 'new live row'
          )
        ).toBe(true)
      )

      await act(async () => {
        resolveCollection({ messages: [stale, collectionMarker], pagination: { hasMore: false, totalCount: 2 } })
        await olderCollection
      })
      await waitFor(() =>
        expect(
          result.current.items.some((item) => item.kind === 'persisted' && item.message.id === collectionMarker.id)
        ).toBe(true)
      )
      await act(async () => {
        await Promise.resolve()
      })
      expect(
        result.current.items.some(
          (item) => item.kind === 'persisted' && item.message.id === live.id && item.message.content === 'new live row'
        )
      ).toBe(true)
    })

    test('a never-settling created fetch releases its stream barrier at the deadline', async () => {
      const realSetTimeout = globalThis.setTimeout
      const realClearTimeout = globalThis.clearTimeout
      let releaseBarrier: (() => void) | undefined
      globalThis.setTimeout = ((callback: () => void, delay?: number) => {
        if (delay === 5000) {
          releaseBarrier = callback
          return 987654 as unknown as ReturnType<typeof setTimeout>
        }
        return realSetTimeout(callback, delay)
      }) as typeof setTimeout
      globalThis.clearTimeout = ((timer: ReturnType<typeof setTimeout>) => {
        if ((timer as unknown as number) !== 987654) realClearTimeout(timer)
      }) as typeof clearTimeout
      setSystemTime(1_700_000_000_000)
      try {
        const never = new Promise<Message>(() => undefined)
        const mock = makeMockClient({ durableMessages: { 'never-1': never } })
        const { result } = await renderHook(() => useAgentConversation({ agentId: 'a1' }), {
          wrapper: wrapLive(mock),
        })
        await act(async () => {
          mock.emitAgentEvent('a1', 'message.created', { agentId: 'a1', messageId: 'never-1' })
          mock.emit({ type: 'text', text: 'response', streamGroupId: 'stream-1' })
          await Promise.resolve()
        })
        expect(result.current.items.some((item) => item.kind === 'streaming')).toBe(false)
        expect(releaseBarrier).toBeDefined()

        await act(async () => {
          releaseBarrier?.()
          await Promise.resolve()
        })
        expect(result.current.items.some((item) => item.kind === 'streaming')).toBe(true)
      } finally {
        globalThis.setTimeout = realSetTimeout
        globalThis.clearTimeout = realClearTimeout
        setSystemTime()
      }
    })

    test('a created fetch that resolves after the barrier deadline still inserts its durable row', async () => {
      const realSetTimeout = globalThis.setTimeout
      const realClearTimeout = globalThis.clearTimeout
      let releaseBarrier: (() => void) | undefined
      globalThis.setTimeout = ((callback: () => void, delay?: number) => {
        if (delay === 5000) {
          releaseBarrier = callback
          return 987654 as unknown as ReturnType<typeof setTimeout>
        }
        return realSetTimeout(callback, delay)
      }) as typeof setTimeout
      globalThis.clearTimeout = ((timer: ReturnType<typeof setTimeout>) => {
        if ((timer as unknown as number) !== 987654) realClearTimeout(timer)
      }) as typeof clearTimeout
      setSystemTime(1_700_000_000_000)
      try {
        let resolveMessage!: (message: Message) => void
        const delayed = new Promise<Message>((resolve) => (resolveMessage = resolve))
        const inbound = durableMessage({ id: 'delayed-1' })
        const mock = makeMockClient({ durableMessages: { [inbound.id]: delayed } })
        const { result } = await renderHook(() => useAgentConversation({ agentId: 'a1' }), {
          wrapper: wrapLive(mock),
        })
        await act(async () => {
          mock.emitAgentEvent('a1', 'message.created', { agentId: 'a1', messageId: inbound.id })
          await Promise.resolve()
        })
        expect(releaseBarrier).toBeDefined()

        await act(async () => {
          releaseBarrier?.()
          resolveMessage(inbound)
          await delayed
          for (let index = 0; index < 3; index += 1) await Promise.resolve()
        })
        expect(result.current.items.some((item) => item.kind === 'persisted' && item.message.id === inbound.id)).toBe(
          true
        )
      } finally {
        globalThis.setTimeout = realSetTimeout
        globalThis.clearTimeout = realClearTimeout
        setSystemTime()
      }
    })

    test('an updated fetch inherits an unresolved created barrier until the newest row resolves', async () => {
      let resolveCreated!: (message: Message) => void
      let resolveUpdated!: (message: Message) => void
      const createdFetch = new Promise<Message>((resolve) => (resolveCreated = resolve))
      const updatedFetch = new Promise<Message>((resolve) => (resolveUpdated = resolve))
      const fetches = [createdFetch, updatedFetch]
      const inbound = durableMessage()
      const mock = makeMockClient({ getMessage: () => fetches.shift()! })
      const { result } = await renderHook(() => useAgentConversation({ agentId: 'a1' }), {
        wrapper: wrapLive(mock),
      })
      await waitFor(() => expect(mock.getMessagesCount()).toBe(1))

      await act(async () => {
        mock.emitAgentEvent('a1', 'message.created', { agentId: 'a1', messageId: inbound.id })
        mock.emitAgentEvent('a1', 'message.updated', { agentId: 'a1', messageId: inbound.id })
        resolveCreated(inbound)
        await createdFetch
        mock.emit({ type: 'text', text: 'response', streamGroupId: 'stream-1' })
      })
      expect(result.current.items.some((item) => item.kind === 'streaming')).toBe(false)
      expect(result.current.items.some((item) => item.kind === 'persisted')).toBe(false)

      const newest = durableMessage({ content: 'newest' })
      await act(async () => {
        resolveUpdated(newest)
        await updatedFetch
      })
      await waitFor(() => {
        const persisted = result.current.items.find((item) => item.kind === 'persisted')
        expect(persisted?.kind === 'persisted' ? persisted.message.content : '').toBe('newest')
        expect(result.current.items.some((item) => item.kind === 'streaming')).toBe(true)
      })
    })

    test('a created message sorts above a stream that was already in flight', async () => {
      setSystemTime(new Date('2026-02-03T04:05:07.000Z'))
      const inbound = durableMessage()
      const mock = makeMockClient({ durableMessages: { [inbound.id]: inbound } })
      const { result } = await renderHook(() => useAgentConversation({ agentId: 'a1' }), {
        wrapper: wrapLive(mock),
      })
      await act(async () => {
        mock.emit({ type: 'text', text: 'response', streamGroupId: 'stream-1' })
        mock.emitAgentEvent('a1', 'message.created', { agentId: 'a1', messageId: inbound.id })
        await Promise.resolve()
      })
      await waitFor(() => {
        const persistedIndex = result.current.items.findIndex((item) => item.kind === 'persisted')
        const streamingIndex = result.current.items.findIndex((item) => item.kind === 'streaming')
        expect(persistedIndex).toBeGreaterThanOrEqual(0)
        expect(streamingIndex).toBeGreaterThan(persistedIndex)
      })
      setSystemTime()
    })

    test('dedupes the optimistic sender row by durable clientId', async () => {
      const durableMessages: Record<string, Message> = {}
      const mock = makeMockClient({ durableMessages })
      const { result } = await renderHook(() => useAgentConversation({ agentId: 'a1' }), {
        wrapper: wrapLive(mock),
      })
      let clientId = ''
      await act(async () => {
        clientId = result.current.send('incoming')
        await Promise.resolve()
      })
      const inbound = durableMessage({ metadata: { clientId } })
      durableMessages[inbound.id] = inbound
      await act(async () => {
        mock.emitAgentEvent('a1', 'message.created', { agentId: 'a1', messageId: inbound.id })
        await Promise.resolve()
      })
      await waitFor(() =>
        expect(
          result.current.items.filter((item) => item.kind === 'persisted' || item.kind === 'pending')
        ).toHaveLength(1)
      )
      expect(result.current.items.some((item) => item.kind === 'persisted' && item.message.id === inbound.id)).toBe(
        true
      )
    })

    test('history overlap, replay, and update keep one newest durable row', async () => {
      const initial = durableMessage({ content: 'old' })
      const durableMessages: Record<string, Message> = { [initial.id]: initial }
      const mock = makeMockClient({ messages: [initial], durableMessages })
      const { result } = await renderHook(() => useAgentConversation({ agentId: 'a1' }), {
        wrapper: wrapLive(mock),
      })
      await waitFor(() =>
        expect(
          result.current.items.some(
            (item) => item.kind === 'persisted' && item.message.id === initial.id && item.message.content === 'old'
          )
        ).toBe(true)
      )
      const updated = durableMessage({ content: 'new' })
      durableMessages[initial.id] = updated
      await act(async () => {
        mock.emitAgentEvent('a1', 'message.created', { agentId: 'a1', messageId: initial.id })
        mock.emitAgentEvent('a1', 'message.updated', { agentId: 'a1', messageId: initial.id })
        await Promise.resolve()
      })
      await waitFor(() => {
        const rows = result.current.items.filter((item) => item.kind === 'persisted' && item.message.id === initial.id)
        expect(rows).toHaveLength(1)
        expect(rows[0]?.kind === 'persisted' ? rows[0].message.content : '').toBe('new')
      })
    })

    test('each post-cap eviction schedules a snapshot that recovers the evicted row', async () => {
      const durableMessages = Object.fromEntries(
        Array.from({ length: 102 }, (_, index) => {
          const message = durableMessage({ id: `bounded-${index}` })
          return [message.id, message]
        })
      )
      type Page = { messages: Message[]; pagination: { hasMore: boolean; totalCount: number } }
      let resolveFirstCapSnapshot!: (page: Page) => void
      let resolvePostCapSnapshot!: (page: Page) => void
      const firstCapSnapshot = new Promise<Page>((resolve) => (resolveFirstCapSnapshot = resolve))
      const postCapSnapshot = new Promise<Page>((resolve) => (resolvePostCapSnapshot = resolve))
      let collectionRequest = 0
      const mock = makeMockClient({
        durableMessages,
        getMessages: () => {
          collectionRequest += 1
          if (collectionRequest === 1) return { messages: [], pagination: { hasMore: false, totalCount: 0 } }
          if (collectionRequest === 2) return firstCapSnapshot
          return postCapSnapshot
        },
      })
      const { result } = await renderHook(() => useAgentConversation({ agentId: 'a1' }), {
        wrapper: wrapLive(mock),
      })
      await waitFor(() => expect(mock.getMessagesCount()).toBe(1))

      await act(async () => {
        for (const messageId of Object.keys(durableMessages).slice(0, 101)) {
          mock.emitAgentEvent('a1', 'message.updated', { agentId: 'a1', messageId })
        }
        await Promise.resolve()
      })
      await waitFor(() => expect(result.current.items.filter((item) => item.kind === 'persisted')).toHaveLength(100))
      await waitFor(() => expect(mock.getMessagesCount()).toBe(2))

      await act(async () => {
        mock.emitAgentEvent('a1', 'message.updated', { agentId: 'a1', messageId: 'bounded-101' })
        await Promise.resolve()
        resolveFirstCapSnapshot({ messages: [], pagination: { hasMore: false, totalCount: 0 } })
        await firstCapSnapshot
      })
      await waitFor(() => expect(mock.getMessagesCount()).toBe(3))

      await act(async () => {
        resolvePostCapSnapshot({
          messages: [durableMessages['bounded-1']!],
          pagination: { hasMore: false, totalCount: 1 },
        })
        await postCapSnapshot
      })
      await waitFor(() =>
        expect(result.current.items.some((item) => item.kind === 'persisted' && item.message.id === 'bounded-1')).toBe(
          true
        )
      )
    })

    test('replay and persisted author variants remain idempotent', async () => {
      const variants = [
        durableMessage({ id: 'human-1', metadata: { sender: { userId: 'u1', name: 'User' } } }),
        durableMessage({ id: 'agent-1', role: 'assistant', content: 'agent reply', metadata: null }),
        durableMessage({
          id: 'system-1',
          role: 'assistant',
          content: '[System] recovered',
          metadata: { isSystem: true },
        }),
      ]
      const mock = makeMockClient({
        durableMessages: Object.fromEntries(variants.map((message) => [message.id, message])),
      })
      const { result } = await renderHook(() => useAgentConversation({ agentId: 'a1' }), {
        wrapper: wrapLive(mock),
      })

      await act(async () => {
        for (const message of variants) {
          mock.emitAgentEvent('a1', 'message.created', { agentId: 'a1', messageId: message.id })
          mock.emitAgentEvent('a1', 'message.created', { agentId: 'a1', messageId: message.id })
        }
        await Promise.resolve()
      })
      await waitFor(() => {
        const ids = result.current.items.flatMap((item) => (item.kind === 'persisted' ? [item.message.id] : []))
        expect(ids.sort()).toEqual(variants.map((message) => message.id).sort())
      })
    })

    test('an exact barrier does not expire at the legacy deadline and clears on fetch settlement', async () => {
      const realSetTimeout = globalThis.setTimeout
      let legacyDeadlineScheduled = false
      globalThis.setTimeout = ((callback: () => void, delay?: number) => {
        if (delay === 5000) legacyDeadlineScheduled = true
        return realSetTimeout(callback, delay)
      }) as typeof setTimeout
      setSystemTime(1_700_000_000_000)
      let resolveMessage!: (message: Message) => void
      const fetched = new Promise<Message>((resolve) => (resolveMessage = resolve))
      const inbound = durableMessage()
      const mock = makeMockClient({ durableMessages: { [inbound.id]: fetched } })
      try {
        const { result } = await renderHook(() => useAgentConversation({ agentId: 'a1' }), {
          wrapper: wrapLive(mock),
        })
        await waitFor(() => expect(mock.getMessagesCount()).toBe(1))

        await act(async () => {
          mock.emit({ type: 'agent', agentId: 'a1', executionId: 'execution-1' })
          mock.emitAgentEvent('a1', 'message.created', {
            agentId: 'a1',
            messageId: inbound.id,
            executionId: 'execution-1',
            streamGroupId: 'stream-1',
          })
          mock.emit({ type: 'text', text: 'target', streamGroupId: 'stream-1' })
          await Promise.resolve()
        })
        expect(result.current.items.some((item) => item.kind === 'streaming')).toBe(false)
        expect(legacyDeadlineScheduled).toBe(false)

        await act(async () => {
          resolveMessage(inbound)
          await fetched
        })
        await waitFor(() => expect(result.current.items.some((item) => item.kind === 'streaming')).toBe(true))
      } finally {
        globalThis.setTimeout = realSetTimeout
        setSystemTime()
      }
    })

    test('an exact target arriving after its event is hidden without stalling an unrelated group', async () => {
      let resolveMessage!: (message: Message) => void
      const fetched = new Promise<Message>((resolve) => (resolveMessage = resolve))
      const inbound = durableMessage()
      const mock = makeMockClient({ durableMessages: { [inbound.id]: fetched } })
      const { result } = await renderHook(() => useAgentConversation({ agentId: 'a1' }), {
        wrapper: wrapLive(mock),
      })
      await waitFor(() => expect(mock.getMessagesCount()).toBe(1))

      await act(async () => {
        mock.emitAgentEvent('a1', 'message.created', {
          agentId: 'a1',
          messageId: inbound.id,
          executionId: 'execution-1',
          streamGroupId: 'target-group',
        })
        mock.emit({ type: 'agent', agentId: 'a1', executionId: 'execution-2' })
        mock.emit({ type: 'text', text: 'unrelated', streamGroupId: 'other-group' })
        await Promise.resolve()
      })
      expect(result.current.items.filter((item) => item.kind === 'streaming')).toHaveLength(1)

      await act(async () => {
        mock.emit({ type: 'agent', agentId: 'a1', executionId: 'execution-1' })
        mock.emit({ type: 'text', text: 'target', streamGroupId: 'target-group' })
        await Promise.resolve()
      })
      const streaming = result.current.items.filter((item) => item.kind === 'streaming')
      expect(streaming).toHaveLength(1)
      expect(
        streaming[0]?.kind === 'streaming' ? streaming[0].blocks.find((block) => block.type === 'text')?.content : ''
      ).toBe('unrelated')

      await act(async () => {
        resolveMessage(inbound)
        await fetched
      })
      await waitFor(() => expect(result.current.items.filter((item) => item.kind === 'streaming')).toHaveLength(2))
    })

    test('durable rows of the group being streamed never hide or replace the live streaming item', async () => {
      // Server shape: each LLM segment of a turn persists an assistant row stamped with the CURRENT
      // stream group's identity (message.created), and each tool result patches that row
      // (message.updated). Neither may collapse the live group mid-stream; the durable copy only
      // takes over once the group is done and history holds every streamed block.
      const streamingItem = (items: ReturnType<typeof useAgentConversation>['items']) =>
        items.find((item): item is Extract<typeof item, { kind: 'streaming' }> => item.kind === 'streaming')
      const pendingFetches: Array<(message: Message) => void> = []
      const mock = makeMockClient({
        getMessage: () => new Promise<Message>((resolve) => pendingFetches.push(resolve)),
      })
      const { result } = await renderHook(() => useAgentConversation({ agentId: 'a1' }), {
        wrapper: wrapLive(mock),
      })
      await waitFor(() => expect(mock.getMessagesCount()).toBe(1))

      // Segment 1 streams live: thinking + a tool call that is still running.
      await act(async () => {
        mock.emit({ type: 'agent', agentId: 'a1', executionId: 'execution-1' })
        mock.emit({ type: 'thinking', text: 'Planning', streamGroupId: 'stream-1' })
        mock.emit({ type: 'thinking_end', durationMs: 5, streamGroupId: 'stream-1' })
        mock.emit({ type: 'tool_start', toolCallId: 'tool-1', toolName: 'bash', args: '{}', streamGroupId: 'stream-1' })
        await Promise.resolve()
      })
      expect(streamingItem(result.current.items)?.blocks.map((block) => block.type)).toEqual(['thinking', 'tool_use'])

      // The server persists segment 1's assistant row for the group being streamed.
      const row1: Message = {
        id: 'row-1',
        agentId: 'a1',
        role: 'assistant',
        content: '',
        metadata: {
          executionId: 'execution-1',
          streamGroupId: 'stream-1',
          content: [
            { type: 'thinking', id: 't1', content: 'Planning', durationMs: 5 },
            {
              type: 'tool_use',
              id: 'u1',
              toolCall: { toolCallId: 'tool-1', toolName: 'bash', args: '{}', result: '', isError: false },
            },
          ],
        },
        pending: false,
        createdAt: new Date('2026-02-03T04:05:06.000Z'),
      }
      await act(async () => {
        mock.emitAgentEvent('a1', 'message.created', {
          agentId: 'a1',
          messageId: row1.id,
          executionId: 'execution-1',
          streamGroupId: 'stream-1',
        })
        await Promise.resolve()
      })
      // While the durable fetch is in flight the live group must stay on screen, unchanged.
      expect(streamingItem(result.current.items)?.blocks.map((block) => block.type)).toEqual(['thinking', 'tool_use'])
      expect(result.current.items.some((item) => item.kind === 'persisted')).toBe(false)

      await act(async () => {
        pendingFetches.shift()!(row1)
        await Promise.resolve()
      })
      // The durable snapshot landed, but the group is still live: it must not be replaced by the
      // persisted (collapsed) shape.
      expect(streamingItem(result.current.items)?.blocks.map((block) => block.type)).toEqual(['thinking', 'tool_use'])
      expect(result.current.items.some((item) => item.kind === 'persisted')).toBe(false)

      // Tool result lands and the server patches the row (message.updated); the stream continues.
      await act(async () => {
        mock.emit({ type: 'tool_end', toolCallId: 'tool-1', result: 'ok', isError: false, streamGroupId: 'stream-1' })
        mock.emitAgentEvent('a1', 'message.updated', {
          agentId: 'a1',
          messageId: row1.id,
          executionId: 'execution-1',
          streamGroupId: 'stream-1',
        })
        await Promise.resolve()
      })
      expect(streamingItem(result.current.items)?.blocks.map((block) => block.type)).toEqual(['thinking', 'tool_use'])
      const patchedRow1: Message = {
        ...row1,
        metadata: {
          ...row1.metadata,
          content: [
            { type: 'thinking', id: 't1', content: 'Planning', durationMs: 5 },
            {
              type: 'tool_use',
              id: 'u1',
              toolCall: { toolCallId: 'tool-1', toolName: 'bash', args: '{}', result: 'ok', isError: false },
            },
          ],
        },
      }
      await act(async () => {
        pendingFetches.shift()!(patchedRow1)
        await Promise.resolve()
      })
      await act(async () => {
        mock.emit({ type: 'text', text: 'Final answer', streamGroupId: 'stream-1' })
        await Promise.resolve()
      })
      expect(streamingItem(result.current.items)?.blocks.map((block) => block.type)).toEqual([
        'thinking',
        'tool_use',
        'text',
      ])
      expect(result.current.items.some((item) => item.kind === 'persisted')).toBe(false)

      // Segment 2 (final text) persists as a second row of the same group, then the turn ends.
      const row2: Message = {
        id: 'row-2',
        agentId: 'a1',
        role: 'assistant',
        content: 'Final answer',
        metadata: {
          executionId: 'execution-1',
          streamGroupId: 'stream-1',
          content: [{ type: 'text', id: 'x1', content: 'Final answer' }],
        },
        pending: false,
        createdAt: new Date('2026-02-03T04:05:07.000Z'),
      }
      await act(async () => {
        mock.emitAgentEvent('a1', 'message.created', {
          agentId: 'a1',
          messageId: row2.id,
          executionId: 'execution-1',
          streamGroupId: 'stream-1',
        })
        await Promise.resolve()
      })
      expect(streamingItem(result.current.items)?.blocks.map((block) => block.type)).toEqual([
        'thinking',
        'tool_use',
        'text',
      ])
      await act(async () => {
        pendingFetches.shift()!(row2)
        mock.emit({
          type: 'done',
          response: 'Final answer',
          metadata: null as any,
          streamGroupId: 'stream-1',
          messageIds: ['row-1', 'row-2'],
        })
        await Promise.resolve()
      })
      // #1032's guarantee: once the group is done, the durable rows (delivered via getMessage, no
      // history refetch) take over as one merged persisted turn.
      await waitFor(() => {
        expect(result.current.items.some((item) => item.kind === 'streaming')).toBe(false)
        const persisted = result.current.items.find((item) => item.kind === 'persisted')
        expect(persisted?.kind === 'persisted' ? persisted.blocks.map((block) => block.type) : []).toEqual([
          'thinking',
          'tool_use',
          'text',
        ])
      })
      expect(mock.getMessagesCount()).toBe(1)
      expect(mock.getMessageCount()).toBe(3)
    })

    test('a standalone message.updated fetch does not create a stream barrier', async () => {
      const never = new Promise<Message>(() => undefined)
      const mock = makeMockClient({ durableMessages: { 'updated-only': never } })
      const { result } = await renderHook(() => useAgentConversation({ agentId: 'a1' }), {
        wrapper: wrapLive(mock),
      })
      await act(async () => {
        mock.emitAgentEvent('a1', 'message.updated', {
          agentId: 'a1',
          messageId: 'updated-only',
          executionId: 'execution-1',
          streamGroupId: 'group-1',
        })
        mock.emit({ type: 'agent', agentId: 'a1', executionId: 'execution-1' })
        mock.emit({ type: 'text', text: 'visible', streamGroupId: 'group-1' })
        await Promise.resolve()
      })
      expect(result.current.items.some((item) => item.kind === 'streaming')).toBe(true)
    })
  })
})

describe('first sends and intervention queues', () => {
  for (const deliveryMode of ['steer', 'follow-up'] as const) {
    test(`first ${deliveryMode} send stays above the loader and stream through its pending saved echo`, async () => {
      const mc = makeMockClient()
      const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
      const hook = await renderHook(() => useAgentConversation({ agentId: 'a1' }), { wrapper: wrapWith(qc, mc.client) })
      try {
        let clientId = ''
        setSystemTime(1000)
        await act(async () => {
          clientId = hook.result.current.send('start', { deliveryMode })
        })
        expect(hook.result.current.items.map((i) => i.kind)).toEqual(['pending', 'working'])
        expect(hook.result.current.queuedCount).toBe(0)
        await act(async () => {
          mc.emit({ type: 'agent', agentId: 'a1', executionId: 'e1' })
          mc.emit({ type: 'text', text: 'answer', streamGroupId: 'S' })
        })
        expect(hook.result.current.items.map((i) => i.kind)).toEqual(['pending', 'streaming', 'working'])
        setSystemTime()
        // Older production backends expose pending:true even on the accepted first row.
        mc.setMessages([
          {
            id: 'first-row',
            agentId: 'a1',
            role: 'human',
            content: 'start',
            pending: true,
            createdAt: new Date(1),
            metadata: { clientId, executionId: 'e1', deliveryMode },
          },
        ])
        await act(async () => {
          await qc.invalidateQueries({ queryKey: queryKeys.agents.messages('a1') })
        })
        await waitFor(() => expect(hook.result.current.items[0]?.id).toBe('first-row'))
        expect(hook.result.current.items.map((i) => i.kind)).toEqual(['persisted', 'streaming', 'working'])
        expect(hook.result.current.queuedCount).toBe(0)
        // Removing history cannot resurrect the retired optimistic send.
        mc.setMessages([])
        await act(async () => {
          await qc.invalidateQueries({ queryKey: queryKeys.agents.messages('a1') })
        })
        await waitFor(() => expect(hook.result.current.items.some((i) => i.id === 'first-row')).toBe(false))
        expect(hook.result.current.items.some((i) => i.id === clientId)).toBe(false)
      } finally {
        setSystemTime()
        hook.unmount()
        qc.clear()
      }
    })
  }

  test('a later queued follow-up cannot reclassify the first send', async () => {
    const mc = makeMockClient()
    const hook = await renderHook(() => useAgentConversation({ agentId: 'a1' }), { wrapper: wrap(mc.client) })
    try {
      let first = ''
      await act(async () => {
        first = hook.result.current.send('start')
      })
      mc.runNextSendIntoActiveTurn()
      await act(async () => {
        hook.result.current.send('follow up', { deliveryMode: 'follow-up' })
      })
      expect(hook.result.current.items.find((i) => i.id === first)).toMatchObject({ kind: 'pending', queued: false })
      expect(hook.result.current.queuedCount).toBe(1)
    } finally {
      hook.unmount()
    }
  })

  test('an intervention is queued before content starts or its submission resolves', async () => {
    const mc = makeMockClient({ activeExecution: { active: true, status: 'running', executionId: 'e1' } })
    const hook = await renderHook(() => useAgentConversation({ agentId: 'a1' }), { wrapper: wrap(mc.client) })
    try {
      await waitFor(() => expect(hook.result.current.executionStatus).toBe('running'))
      mc.holdNextSend()
      await act(async () => {
        hook.result.current.send('interrupt')
      })
      expect(hook.result.current.items.map((i) => i.kind)).toEqual(['working', 'pending'])
      expect(hook.result.current.queuedCount).toBe(1)
    } finally {
      await act(async () => {
        mc.releaseNextSend()
      })
      hook.unmount()
    }
  })

  test('authoritative acceptance corrects a send-time guess independently of execution status', async () => {
    const mc = makeMockClient({ activeExecution: { active: true, status: 'running' } })
    const acceptance = spyOn(mc.client.agents, 'sendMessage').mockResolvedValue({
      success: true,
      status: 'queued',
      queued: false,
    })
    const hook = await renderHook(() => useAgentConversation({ agentId: 'a1' }), { wrapper: wrap(mc.client) })
    try {
      await waitFor(() => expect(hook.result.current.executionStatus).toBe('running'))
      await act(async () => {
        await hook.result.current.sendAccepted('new turn').accepted
      })
      expect(hook.result.current.queuedCount).toBe(0)
      expect(hook.result.current.items[0]).toMatchObject({ kind: 'pending', queued: false })
    } finally {
      hook.unmount()
      acceptance.mockRestore()
    }
  })

  for (const method of ['send', 'sendAccepted'] as const) {
    test(`failed ${method} intervention preserves the running execution`, async () => {
      const mc = makeMockClient({ activeExecution: { active: true, status: 'running', executionId: 'e1' } })
      const hook = await renderHook(() => useAgentConversation({ agentId: 'a1' }), { wrapper: wrap(mc.client) })
      try {
        await act(async () => {
          mc.emit({ type: 'text', text: 'working', streamGroupId: 'S' })
        })
        mc.failNextSend()
        await act(async () => {
          if (method === 'sendAccepted') await hook.result.current.sendAccepted('interrupt').accepted.catch(() => {})
          else hook.result.current.send('interrupt')
        })
        expect(hook.result.current.executionStatus).toBe('running')
        expect(hook.result.current.items.some((i) => i.kind === 'working')).toBe(true)
      } finally {
        hook.unmount()
      }
    })
  }

  test('clearing an echoed queued send cannot resurrect its optimistic row', async () => {
    const mc = makeMockClient()
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const hook = await renderHook(() => useAgentConversation({ agentId: 'a1' }), { wrapper: wrapWith(qc, mc.client) })
    try {
      let clientId = ''
      mc.runNextSendIntoActiveTurn()
      await act(async () => {
        clientId = hook.result.current.send('followup', { deliveryMode: 'follow-up' })
      })
      mc.setMessages([
        {
          id: 'server-id',
          agentId: 'a1',
          role: 'human',
          content: 'followup',
          pending: true,
          createdAt: new Date(),
          metadata: { clientId, deliveryMode: 'follow-up' },
        },
      ])
      await act(async () => {
        await qc.invalidateQueries({ queryKey: queryKeys.agents.messages('a1') })
      })
      await waitFor(() => expect(hook.result.current.items.some((i) => i.id === 'server-id')).toBe(true))
      await act(async () => {
        await hook.result.current.cancelAllPending()
      })
      await waitFor(() => expect(hook.result.current.items.some((i) => i.id === 'server-id')).toBe(false))
      expect(hook.result.current.items.filter((i) => i.kind === 'pending')).toHaveLength(0)
    } finally {
      hook.unmount()
      qc.clear()
    }
  })
})

test('clear queue retires saved point-read overlays as well as optimistic rows', async () => {
  const message: Message = {
    id: 'live-row',
    agentId: 'a1',
    role: 'human',
    content: 'follow up',
    pending: true,
    queued: true,
    createdAt: new Date(),
    metadata: { clientId: 'local', deliveryMode: 'follow-up' },
  }
  const mc = makeMockClient({ durableMessages: { 'live-row': message } })
  const hook = await renderHook(() => useAgentConversation({ agentId: 'a1' }), { wrapper: wrapLive(mc) })
  try {
    await act(async () => {
      mc.emitAgentEvent('a1', 'message.created', { agentId: 'a1', messageId: 'live-row' })
    })
    await waitFor(() => expect(hook.result.current.queuedCount).toBe(1))
    await act(async () => {
      await hook.result.current.cancelAllPending()
    })
    expect(hook.result.current.items.some((i) => i.id === 'live-row')).toBe(false)
  } finally {
    hook.unmount()
  }
})

test('a rejected queue clear preserves an unacknowledged optimistic intervention', async () => {
  const mc = makeMockClient({ activeExecution: { active: true, status: 'running' } })
  const clear = spyOn(mc.client.agents, 'clearQueue').mockRejectedValue(new Error('worker unavailable'))
  const hook = await renderHook(() => useAgentConversation({ agentId: 'a1' }), { wrapper: wrap(mc.client) })
  try {
    await waitFor(() => expect(hook.result.current.executionStatus).toBe('running'))
    await act(async () => {
      hook.result.current.send('keep this')
    })
    await act(async () => {
      await hook.result.current.cancelAllPending()
    })
    expect(hook.result.current.queuedCount).toBe(1)
  } finally {
    hook.unmount()
    clear.mockRestore()
  }
})

test('a point-read started before queue clear cannot restore a confirmed deletion', async () => {
  const message: Message = {
    id: 'live-row',
    agentId: 'a1',
    role: 'human',
    content: 'follow up',
    pending: true,
    queued: true,
    createdAt: new Date(),
    metadata: { clientId: 'c', deliveryMode: 'follow-up' },
  }
  let resolveUpdate!: (message: Message) => void
  const update = new Promise<Message>((resolve) => {
    resolveUpdate = resolve
  })
  let reads = 0
  const mc = makeMockClient({ getMessage: () => (++reads === 1 ? message : update) })
  const hook = await renderHook(() => useAgentConversation({ agentId: 'a1' }), { wrapper: wrapLive(mc) })
  try {
    await act(async () => {
      mc.emitAgentEvent('a1', 'message.created', { agentId: 'a1', messageId: 'live-row' })
    })
    await waitFor(() => expect(hook.result.current.queuedCount).toBe(1))
    await act(async () => {
      mc.emitAgentEvent('a1', 'message.updated', { agentId: 'a1', messageId: 'live-row' })
    })
    await act(async () => {
      await hook.result.current.cancelAllPending()
    })
    await act(async () => {
      resolveUpdate(message)
      await update
    })
    expect(hook.result.current.queuedCount).toBe(0)
  } finally {
    resolveUpdate(message)
    await update
    hook.unmount()
  }
})

describe('live response reconciliation regressions', () => {
  test('full leading-flush replay never retracts text across intermediate renders or durable handoff', async () => {
    const partial: Message = {
      id: 'm1',
      agentId: 'a',
      role: 'assistant',
      content: '',
      pending: false,
      createdAt: new Date(),
      metadata: { streamGroupId: 'S', content: [{ type: 'thinking', id: 'p', content: 'Plan' }] },
    }
    const m = makeMockClient({ messages: [partial], activeExecution: { active: true, status: 'running' } })
    const renders: string[] = []
    const { result, unmount } = await renderHook(
      () => {
        const conversation = useAgentConversation({ agentId: 'a' })
        renders.push(
          conversation.items
            .flatMap((item) =>
              item.kind === 'streaming' || item.kind === 'persisted'
                ? item.blocks.flatMap((b) => (b.type === 'text' ? [b.content] : []))
                : []
            )
            .join('')
        )
        return conversation
      },
      { wrapper: wrap(m.client) }
    )
    await waitFor(() => expect(m.subscribeCount()).toBe(1))
    const events: StreamEvent[] = [
      { type: 'agent', agentId: 'a', executionId: 'e' },
      { type: 'flush_agent' },
      { type: 'thinking', text: 'Plan', streamGroupId: 'S' },
      { type: 'thinking_end', durationMs: 1, streamGroupId: 'S' },
      { type: 'text', text: 'Visible response', streamGroupId: 'S' },
    ]
    act(() => events.forEach(m.emit))
    const start = renders.length - 1
    for (const batch of [events, events, [], events.slice(0, 4), events.slice(0, 4)]) {
      act(() => m.emitCatchup(batch))
      expect(result.current.items.filter((item) => item.kind === 'working')).toHaveLength(1)
      expect(renders.slice(start).every((text) => text === 'Visible response')).toBe(true)
    }
    act(() => m.emit({ type: 'text', text: ' tail', streamGroupId: 'S' }))
    expect(renders.at(-1)).toBe('Visible response tail')
    act(() => m.emit({ type: 'done', response: '', streamGroupId: 'S', messageIds: ['m1', 'm2'] }))
    expect(result.current.items.filter((item) => item.kind === 'working')).toHaveLength(0)
    expect(renders.at(-1)).toBe('Visible response tail')
    m.setMessages([
      partial,
      {
        ...partial,
        id: 'm2',
        metadata: { streamGroupId: 'S', content: [{ type: 'text', id: 't', content: 'Visible response tail' }] },
      },
    ])
    await act(async () => {
      await result.current.refresh()
    })
    await waitFor(() => expect(result.current.items.filter((item) => item.kind === 'streaming')).toHaveLength(0))
    expect(renders.slice(start).every((text) => text.startsWith('Visible response'))).toBe(true)
    unmount()
  })

  test.each(['onDone', 'onError', 'onDisconnect', 'onReconnect', 'onCatchup', 'onEvent'] as const)(
    'replaced subscription ignores late %s',
    async (callback) => {
      const m = makeMockClient({ activeExecution: { active: true, status: 'running' } })
      const { result, unmount } = await renderHook(() => useAgentConversation({ agentId: 'a' }), {
        wrapper: wrap(m.client),
      })
      await waitFor(() => expect(m.subscribeCount()).toBe(1))
      const old = m.currentStream()
      act(() => {
        focusManager.setFocused(false)
        focusManager.setFocused(true)
      })
      await waitFor(() => expect(m.subscribeCount()).toBeGreaterThan(1))
      act(() => m.emit({ type: 'text', text: 'new', streamGroupId: 'S' }))
      const before = result.current.items
      act(() => {
        if (callback === 'onEvent') old.onEvent({ type: 'text', text: 'duplicate', streamGroupId: 'S' })
        else if (callback === 'onCatchup') old.onCatchup?.([{ type: 'error', message: 'old' }])
        else if (callback === 'onError') old.onError?.(new Error('old'))
        else old[callback]?.()
      })
      expect(result.current.streamStatus).toBe('live')
      expect(result.current.executionStatus).toBe('running')
      expect(result.current.items).toEqual(before)
      unmount()
    }
  )

  test('reused A to B hook resets status and rejects every previous-agent callback', async () => {
    const m = makeMockClient()
    let agentId = 'a'
    const { result, rerender, unmount } = await renderHook(() => useAgentConversation({ agentId }), {
      wrapper: wrap(m.client),
    })
    await waitFor(() => expect(m.subscribeCount()).toBe(1))
    const old = m.currentStream()
    act(() => m.emit({ type: 'text', text: 'A', streamGroupId: 'A' }))
    agentId = 'b'
    await rerender()
    await waitFor(() => expect(result.current.agentId).toBe('b'))
    expect(result.current.executionStatus).toBeNull()
    act(() => {
      old.onEvent({ type: 'agent', agentId: 'a', executionId: 'old' })
      old.onCatchup?.([{ type: 'text', text: 'A late', streamGroupId: 'A' }])
      old.onDone?.()
    })
    expect(result.current.items.some((item) => item.kind === 'streaming')).toBe(false)
    expect(result.current.streamStatus).toBe('live')
    unmount()
  })

  test('create handoff ignores a repeated late agent announcement', async () => {
    const m = makeMockClient()
    const { result, unmount } = await renderHook(() => useAgentConversation({}), { wrapper: wrap(m.client) })
    act(() => {
      result.current.send('hello')
    })
    const old = m.currentChat()
    act(() => old.onEvent({ type: 'agent', agentId: 'created' }))
    await waitFor(() => expect(result.current.agentId).toBe('created'))
    act(() => old.onEvent({ type: 'agent', agentId: 'late' }))
    expect(result.current.agentId).toBe('created')
    unmount()
  })
})

describe('bounded transport reconciliation', () => {
  test.each(['running', 'completed', 'failed'] as const)(
    'closed exact stream reconciles %s and fetches missed tail without navigation',
    async (status) => {
      const m = makeMockClient({ activeExecution: { active: true, executionId: 'e', status: 'running' } })
      let reads = 0
      m.client.agents.getExecution = async () => {
        reads++
        return { agentId: 'a', executionId: 'e', executionVersion: 2, status, active: status === 'running' }
      }
      const { result, unmount } = await renderHook(() => useAgentConversation({ agentId: 'a' }), {
        wrapper: wrap(m.client),
      })
      await waitFor(() => expect(m.subscribedExecutionIds.at(-1)).toBe('e'))
      act(() => m.emit({ type: 'text', text: 'prefix', streamGroupId: 'S' }))
      if (status !== 'running')
        m.setMessages([
          {
            id: 'm',
            agentId: 'a',
            role: 'assistant',
            content: 'prefix tail',
            pending: false,
            createdAt: new Date(),
            metadata: { streamGroupId: 'S', content: [{ type: 'text', id: 't', content: 'prefix tail' }] },
          },
        ])
      const before = m.subscribeCount()
      await act(async () => {
        m.triggerDone()
        await Promise.resolve()
      })
      await waitFor(() => expect(m.subscribeCount()).toBeGreaterThan(before))
      expect(reads).toBe(1)
      expect(result.current.executionStatus).toBe(status)
      expect(m.subscribedExecutionIds.at(-1)).toBe('e')
      if (status === 'running') {
        act(() =>
          m.emitCatchup([
            { type: 'text', text: 'prefix tail', streamGroupId: 'S' },
            { type: 'done', response: '', streamGroupId: 'S', messageIds: ['m'] },
          ])
        )
        expect(result.current.items.find((item) => item.kind === 'streaming')).toMatchObject({
          blocks: [{ content: 'prefix tail' }],
        })
      } else {
        // Terminal exact routes never proxy worker catchup: snapshot then EOF.
        act(() => {
          m.emit({ type: 'execution_snapshot', executionId: 'e', executionVersion: 2, status })
          m.triggerDone()
        })
        await waitFor(() =>
          expect(result.current.items.find((item) => item.kind === 'persisted')).toMatchObject({
            blocks: [{ content: 'prefix tail' }],
          })
        )
      }
      expect(result.current.items.some((item) => item.kind === 'working')).toBe(false)
      expect(result.current.executionStatus).toBe(status === 'failed' ? 'failed' : 'completed')
      unmount()
    }
  )

  test('failed exact reconciliation never invents success or loops', async () => {
    const m = makeMockClient({ activeExecution: { active: true, executionId: 'e', status: 'running' } })
    let reads = 0
    m.client.agents.getExecution = async () => {
      reads++
      throw new Error('offline')
    }
    const { result, unmount } = await renderHook(() => useAgentConversation({ agentId: 'a' }), {
      wrapper: wrap(m.client),
    })
    await waitFor(() => expect(m.subscribedExecutionIds.at(-1)).toBe('e'))
    act(() => m.emit({ type: 'text', text: 'prefix', streamGroupId: 'S' }))
    const before = m.subscribeCount()
    await act(async () => {
      m.emit({ type: 'error', message: 'Worker stream not ready' })
      m.triggerError()
      m.triggerDone()
      await Promise.resolve()
    })
    expect(reads).toBe(1)
    expect(m.subscribeCount()).toBe(before)
    expect(result.current.streamStatus).toBe('ended')
    expect(result.current.executionStatus).toBe('running')
    expect(result.current.items.find((item) => item.kind === 'streaming')).toMatchObject({
      blocks: [{ content: 'prefix' }],
      status: 'interrupted',
    })
    unmount()
  })

  test('repeated busy EOF recovery has a fixed budget', async () => {
    const m = makeMockClient({ activeExecution: { active: true, executionId: 'e', status: 'running' } })
    let reads = 0
    m.client.agents.getExecution = async () => {
      reads++
      return { agentId: 'a', executionId: 'e', executionVersion: 1, status: 'running', active: true }
    }
    const { result, unmount } = await renderHook(() => useAgentConversation({ agentId: 'a' }), {
      wrapper: wrap(m.client),
    })
    await waitFor(() => expect(m.subscribedExecutionIds.at(-1)).toBe('e'))
    for (let i = 0; i < 5; i++)
      await act(async () => {
        m.triggerDone()
        await Promise.resolve()
      })
    expect(reads).toBe(2)
    expect(result.current.streamStatus).toBe('ended')
    expect(result.current.executionStatus).toBe('running')
    unmount()
  })
})

test('quiet backstop rearms after same-status activity and verifies exact execution instead of stale idle', async () => {
  const m = makeMockClient({ activeExecution: { active: false } })
  let reads = 0
  m.client.agents.getExecution = async () => {
    reads++
    return { agentId: 'a', executionId: 'e', executionVersion: 1, status: 'running', active: true }
  }
  const realSetTimeout = globalThis.setTimeout
  const timers: Array<() => void> = []
  globalThis.setTimeout = ((fn: () => void, delay?: number, ...args: unknown[]) => {
    if (delay === 4000) {
      timers.push(fn)
      return realSetTimeout(() => {}, 100_000)
    }
    return realSetTimeout(fn, delay, ...args)
  }) as typeof globalThis.setTimeout
  let unmount: (() => void) | undefined
  setSystemTime(1_700_000_000_000)
  try {
    const hook = await renderHook(() => useAgentConversation({ agentId: 'a' }), { wrapper: wrap(m.client) })
    unmount = hook.unmount
    act(() => {
      m.emit({ type: 'agent', agentId: 'a', executionId: 'e' })
      m.emit({ type: 'text', text: 'prefix', streamGroupId: 'S' })
    })
    const first = timers.length
    setSystemTime(1_700_000_003_000)
    act(() => m.emit({ type: 'text', text: ' tail', streamGroupId: 'S' }))
    expect(timers.length).toBeGreaterThan(first)
    setSystemTime(1_700_000_008_000)
    await act(async () => {
      timers.at(-1)!()
      await Promise.resolve()
    })
    expect(reads).toBe(1)
    expect(hook.result.current.executionStatus).toBe('running')
  } finally {
    unmount?.()
    globalThis.setTimeout = realSetTimeout
    setSystemTime()
  }
})

test('a partial replay missing an observed done cannot restart the working indicator', async () => {
  const m = makeMockClient()
  const { result, unmount } = await renderHook(() => useAgentConversation({ agentId: 'a' }), {
    wrapper: wrap(m.client),
  })
  const prefix: StreamEvent[] = [
    { type: 'agent', agentId: 'a', executionId: 'e' },
    { type: 'text', text: 'prefix', streamGroupId: 'S' },
  ]
  act(() => {
    prefix.forEach(m.emit)
    m.emit({ type: 'done', response: '', streamGroupId: 'S', messageIds: ['m'] })
  })
  expect(result.current.executionStatus).toBe('completed')
  act(() => m.emitCatchup(prefix))
  expect(result.current.executionStatus).toBe('completed')
  expect(result.current.items.some((item) => item.kind === 'working')).toBe(false)
  // A genuinely different execution still starts normally.
  act(() => m.emit({ type: 'agent', agentId: 'a', executionId: 'next' }))
  expect(result.current.executionStatus).toBe('running')
  unmount()
})

test('parent adoption of the created agent keeps the subscription effective', async () => {
  const m = makeMockClient()
  let agentId: string | undefined = undefined
  const { result, rerender, unmount } = await renderHook(() => useAgentConversation({ agentId }), {
    wrapper: wrap(m.client),
  })
  act(() => {
    result.current.send('hello')
    m.emitChat({ type: 'agent', agentId: 'created' })
  })
  await waitFor(() => expect(result.current.agentId).toBe('created'))
  agentId = 'created'
  await rerender()
  act(() => m.emit({ type: 'text', text: 'adopted response', streamGroupId: 'S' }))
  expect(result.current.items.find((item) => item.kind === 'streaming')).toMatchObject({
    blocks: [{ content: 'adopted response' }],
  })
  unmount()
})

test('late exact reconciliation cannot complete a replacement execution', async () => {
  const m = makeMockClient({ activeExecution: { active: true, executionId: 'old', status: 'running' } })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  let finish!: (value: Awaited<ReturnType<FicusClient['agents']['getExecution']>>) => void
  m.client.agents.getExecution = () =>
    new Promise((resolve) => {
      finish = resolve
    })
  const { result, unmount } = await renderHook(() => useAgentConversation({ agentId: 'a' }), {
    wrapper: wrapWith(qc, m.client),
  })
  try {
    await waitFor(() => expect(m.subscribedExecutionIds.at(-1)).toBe('old'))
    await act(async () => {
      m.emit({ type: 'error', message: 'Stream connection lost' })
      m.triggerDone()
      await Promise.resolve()
    })
    m.setActiveExecution({ active: true, executionId: 'next', status: 'running' })
    await act(async () => {
      await qc.invalidateQueries({ queryKey: queryKeys.agents.activeExecution('a') })
    })
    await waitFor(() => expect(m.subscribedExecutionIds.at(-1)).toBe('next'))
    act(() => m.emit({ type: 'text', text: 'next response', streamGroupId: 'next' }))
    await act(async () => {
      finish({ agentId: 'a', executionId: 'old', executionVersion: 99, status: 'completed', active: false })
      await Promise.resolve()
    })
    expect(result.current.executionStatus).toBe('running')
    expect(result.current.streamStatus).toBe('live')
    expect(result.current.items.find((item) => item.kind === 'streaming')).toMatchObject({
      blocks: [{ content: 'next response' }],
    })
  } finally {
    unmount()
    qc.clear()
  }
})

test('no intermediate B render exposes A content, optimistic sends or busy state', async () => {
  const m = makeMockClient()
  let agentId = 'a'
  const renders: Array<{ agentId?: string; items: unknown[]; status: unknown }> = []
  const { result, rerender, unmount } = await renderHook(
    () => {
      const c = useAgentConversation({ agentId })
      renders.push({ agentId: c.agentId, items: c.items, status: c.executionStatus })
      return c
    },
    { wrapper: wrap(m.client) }
  )
  try {
    await act(async () => {
      result.current.send('A prompt')
      m.emit({ type: 'text', text: 'A response', streamGroupId: 'A' })
      await Promise.resolve()
    })
    agentId = 'b'
    await rerender()
    const bRenders = renders.filter((render) => render.agentId === 'b')
    expect(bRenders.length).toBeGreaterThan(0)
    for (const render of bRenders) {
      expect(render.items).toEqual([])
      expect(render.status).toBeNull()
    }
  } finally {
    unmount()
  }
})

test.each(['{}', '{"query":'] as const)(
  'snapshot-only terminal recovery adopts saved completed tool and answer after missing args/tool_end/text (args=%s)',
  async (args) => {
    const m = makeMockClient({ activeExecution: { active: true, executionId: 'e', status: 'running' } })
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    m.client.agents.getExecution = async () => ({
      agentId: 'a',
      executionId: 'e',
      status: 'completed',
      executionVersion: 2,
      active: false,
    })
    const { result, unmount } = await renderHook(() => useAgentConversation({ agentId: 'a' }), {
      wrapper: wrapWith(qc, m.client),
    })
    try {
      await waitFor(() => expect(m.subscribedExecutionIds.at(-1)).toBe('e'))
      act(() => {
        m.emit({ type: 'agent', agentId: 'a', executionId: 'e' })
        m.emit({ type: 'tool_start', streamGroupId: 'S', toolCallId: 't', toolName: 'search', args })
      })
      const finalMessage: Message = {
        id: 'm',
        agentId: 'a',
        role: 'assistant',
        content: 'final answer',
        pending: false,
        createdAt: new Date(),
        metadata: {
          streamGroupId: 'S',
          content: [
            {
              type: 'tool_use',
              id: 't',
              toolCall: {
                toolCallId: 't',
                toolName: 'search',
                args: args === '{}' ? '{}' : '{"query":"value"}',
                result: 'final tool result',
                isError: false,
              },
            },
            { type: 'text', id: 'answer', content: 'final answer' },
          ],
        },
      }
      m.setMessages([finalMessage])
      const before = m.subscribeCount()
      await act(async () => {
        m.triggerDone()
        await Promise.resolve()
      })
      await waitFor(() => expect(m.subscribeCount()).toBeGreaterThan(before))
      // The real terminal exact route sends only execution_snapshot, then closes.
      act(() => {
        m.emit({ type: 'execution_snapshot', executionId: 'e', status: 'completed', executionVersion: 2 })
        m.triggerDone()
      })
      await waitFor(() =>
        expect(
          qc.getQueryData<{ pages: Array<{ messages: Message[] }> }>(queryKeys.agents.messagesInfinite('a'))?.pages[0]
            .messages
        ).toEqual([finalMessage])
      )
      await waitFor(() =>
        expect(result.current.items.find((item) => item.kind === 'persisted')).toMatchObject({
          blocks: finalMessage.metadata!.content,
        })
      )
      expect(result.current.items.some((item) => item.kind === 'streaming' || item.kind === 'working')).toBe(false)
    } finally {
      unmount()
      qc.clear()
    }
  }
)

test('quiet backstop rearms for a silent foreground replacement and reconciles final history', async () => {
  const m = makeMockClient({ activeExecution: { active: false } })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  let reads = 0
  m.client.agents.getExecution = async () => {
    reads++
    return { agentId: 'a', executionId: 'e', status: 'completed', executionVersion: 2, active: false }
  }
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  const timers = new Map<ReturnType<typeof setTimeout>, () => void>()
  globalThis.setTimeout = ((fn: () => void, delay?: number, ...args: unknown[]) => {
    if (delay === 4000) {
      const id = realSetTimeout(() => {}, 100_000)
      timers.set(id, fn)
      return id
    }
    return realSetTimeout(fn, delay, ...args)
  }) as typeof setTimeout
  globalThis.clearTimeout = ((id: ReturnType<typeof setTimeout>) => {
    timers.delete(id)
    realClearTimeout(id)
  }) as typeof clearTimeout
  let unmount: (() => void) | undefined
  setSystemTime(1_700_000_000_000)
  try {
    const hook = await renderHook(() => useAgentConversation({ agentId: 'a' }), { wrapper: wrapWith(qc, m.client) })
    unmount = hook.unmount
    act(() => {
      m.emit({ type: 'agent', agentId: 'a', executionId: 'e' })
      m.emit({ type: 'text', text: 'prefix', streamGroupId: 'S' })
    })
    const before = m.subscribeCount()
    await act(async () => {
      focusManager.setFocused(false)
      focusManager.setFocused(true)
      await Promise.resolve()
    })
    expect(m.subscribeCount()).toBeGreaterThan(before)
    // Replacement is silent and the active query still says idle. No activity/status dependency changes.
    const beforeHistory = m.getMessagesCount()
    m.setMessages([
      {
        id: 'm',
        agentId: 'a',
        role: 'assistant',
        content: 'prefix tail',
        pending: false,
        createdAt: new Date(),
        metadata: { streamGroupId: 'S', content: [{ type: 'text', id: 't', content: 'prefix tail' }] },
      },
    ])
    setSystemTime(1_700_000_005_000)
    await act(async () => {
      ;[...timers.values()].at(-1)!()
      await Promise.resolve()
    })
    expect(reads).toBe(1)
    expect(hook.result.current.executionStatus).toBe('completed')
    expect(hook.result.current.items.some((item) => item.kind === 'working')).toBe(false)
    expect(m.getMessagesCount()).toBeGreaterThan(beforeHistory)
    expect(
      qc.getQueryData<{ pages: Array<{ messages: Message[] }> }>(queryKeys.agents.messagesInfinite('a'))?.pages[0]
        .messages[0].content
    ).toBe('prefix tail')
  } finally {
    unmount?.()
    qc.clear()
    for (const id of timers.keys()) realClearTimeout(id)
    globalThis.setTimeout = realSetTimeout
    globalThis.clearTimeout = realClearTimeout
    setSystemTime()
  }
})

test('terminal exact confirmation refetches history even if the pre-confirmation refresh was incomplete', async () => {
  const m = makeMockClient({ activeExecution: { active: true, executionId: 'e', status: 'running' } })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  let finish!: (value: Awaited<ReturnType<FicusClient['agents']['getExecution']>>) => void
  m.client.agents.getExecution = () =>
    new Promise((resolve) => {
      finish = resolve
    })
  const { result, unmount } = await renderHook(() => useAgentConversation({ agentId: 'a' }), {
    wrapper: wrapWith(qc, m.client),
  })
  try {
    await waitFor(() => expect(m.subscribedExecutionIds.at(-1)).toBe('e'))
    act(() => m.emit({ type: 'agent', agentId: 'a', executionId: 'e' }))
    act(() => m.emit({ type: 'tool_start', streamGroupId: 'S', toolCallId: 't', toolName: 'search', args: '{}' }))
    await act(async () => {
      m.triggerDone()
      await Promise.resolve()
    })
    expect(
      qc.getQueryData<{ pages: Array<{ messages: Message[] }> }>(queryKeys.agents.messagesInfinite('a'))?.pages[0]
        .messages
    ).toEqual([])
    const before = m.getMessagesCount()
    m.setMessages([
      {
        id: 'm',
        agentId: 'a',
        role: 'assistant',
        content: 'answer',
        pending: false,
        createdAt: new Date(),
        metadata: {
          streamGroupId: 'S',
          content: [
            {
              type: 'tool_use',
              id: 't',
              toolCall: { toolCallId: 't', toolName: 'search', args: '{}', result: 'final result', isError: false },
            },
            { type: 'text', id: 'answer', content: 'answer' },
          ],
        },
      },
    ])
    await act(async () => {
      finish({ agentId: 'a', executionId: 'e', status: 'completed', executionVersion: 2, active: false })
      await Promise.resolve()
    })
    act(() => {
      m.emit({ type: 'execution_snapshot', executionId: 'e', status: 'completed', executionVersion: 2 })
      m.triggerDone()
    })
    expect(m.getMessagesCount()).toBeGreaterThan(before)
    await waitFor(() =>
      expect(result.current.items.find((item) => item.kind === 'persisted')).toMatchObject({
        message: { content: 'answer' },
      })
    )
  } finally {
    unmount()
    qc.clear()
  }
})

test('an in-flight quiet backstop result cannot terminalize a replacement execution', async () => {
  const m = makeMockClient({ activeExecution: { active: false } })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  let finish!: (value: Awaited<ReturnType<FicusClient['agents']['getExecution']>>) => void
  m.client.agents.getExecution = () =>
    new Promise((resolve) => {
      finish = resolve
    })
  const realSetTimeout = globalThis.setTimeout
  const timers: Array<() => void> = []
  globalThis.setTimeout = ((fn: () => void, delay?: number, ...args: unknown[]) => {
    if (delay === 4000) {
      timers.push(fn)
      return realSetTimeout(() => {}, 100_000)
    }
    return realSetTimeout(fn, delay, ...args)
  }) as typeof setTimeout
  let unmount: (() => void) | undefined
  setSystemTime(1_700_000_000_000)
  try {
    const hook = await renderHook(() => useAgentConversation({ agentId: 'a' }), { wrapper: wrapWith(qc, m.client) })
    unmount = hook.unmount
    act(() => {
      m.emit({ type: 'agent', agentId: 'a', executionId: 'old' })
      m.emit({ type: 'text', text: 'old', streamGroupId: 'old' })
    })
    setSystemTime(1_700_000_005_000)
    act(() => timers.at(-1)!())
    m.setActiveExecution({ active: true, executionId: 'next', status: 'running' })
    await act(async () => {
      await qc.invalidateQueries({ queryKey: queryKeys.agents.activeExecution('a') })
    })
    act(() => {
      m.emit({ type: 'agent', agentId: 'a', executionId: 'next' })
      m.emit({ type: 'text', text: 'next', streamGroupId: 'next' })
    })
    await act(async () => {
      finish({ agentId: 'a', executionId: 'old', status: 'completed', executionVersion: 99, active: false })
      await Promise.resolve()
    })
    expect(hook.result.current.executionStatus).toBe('running')
    expect(hook.result.current.items.filter((item) => item.kind === 'working')).toHaveLength(1)
  } finally {
    unmount?.()
    qc.clear()
    globalThis.setTimeout = realSetTimeout
    setSystemTime()
  }
})

test.each(['terminal', 'error', 'flush', 'done', 'silent'] as const)(
  '%s preserves provisional tool output through every render until post-terminal history resolves',
  async (mode) => {
    const clock = mode === 'silent' ? reconciliationClock() : undefined
    const old: Message = {
      id: 'm',
      agentId: 'a',
      role: 'assistant',
      content: '',
      pending: false,
      createdAt: new Date(),
      metadata: {
        executionId: 'e',
        streamGroupId: 'S',
        content: [
          {
            type: 'tool_use',
            id: 't',
            toolCall: { toolCallId: 't', toolName: 'search', args: '{}', result: '', isError: false },
          },
        ],
      },
    }
    let delayed = false
    const pending: Array<
      (value: { messages: Message[]; pagination: { hasMore: boolean; totalCount: number } }) => void
    > = []
    const m = makeMockClient({
      activeExecution: { active: true, executionId: 'e', status: 'running' },
      getMessages: () =>
        delayed
          ? new Promise((resolve) => {
              pending.push(resolve)
            })
          : { messages: [old], pagination: { hasMore: false, totalCount: 1 } },
    })
    m.client.agents.getExecution = async () => ({
      agentId: 'a',
      executionId: 'e',
      executionVersion: 2,
      status: 'completed',
      active: false,
    })
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const renders: string[] = []
    const { result, unmount } = await renderHook(
      () => {
        const c = useAgentConversation({ agentId: 'a' })
        renders.push(
          c.items
            .flatMap((item) =>
              item.kind === 'streaming' || item.kind === 'persisted'
                ? item.blocks.flatMap((block) => (block.type === 'tool_use' ? [block.toolCall.result] : []))
                : []
            )
            .join('|')
        )
        return c
      },
      { wrapper: wrapWith(qc, m.client) }
    )
    try {
      await waitFor(() =>
        expect(
          qc.getQueryData<{ pages: Array<{ messages: Message[] }> }>(queryKeys.agents.messagesInfinite('a'))?.pages[0]
            .messages
        ).toEqual([old])
      )
      delayed = true
      act(() => {
        m.emit({ type: 'agent', agentId: 'a', executionId: 'e' })
        m.emit({ type: 'tool_start', streamGroupId: 'S', toolCallId: 't', toolName: 'search', args: '{}' })
        m.emit({ type: 'tool_update', streamGroupId: 'S', toolCallId: 't', result: 'visible progress' })
      })
      const start = renders.length - 1
      if (mode === 'error') act(() => m.emit({ type: 'error', message: 'interrupted' }))
      if (mode === 'done') act(() => m.emit({ type: 'done', response: '', streamGroupId: 'S', messageIds: ['m'] }))
      if (mode === 'flush') act(() => m.emit({ type: 'flush_agent' }))
      if (mode === 'silent') await clock!.advance(15000)
      else
        await act(async () => {
          m.triggerDone()
          await Promise.resolve()
        })
      if (mode !== 'done' && mode !== 'silent')
        act(() => {
          m.emit({ type: 'execution_snapshot', executionId: 'e', status: 'completed', executionVersion: 2 })
          m.triggerDone()
        })
      expect(renders.slice(start).every((text) => text === 'visible progress')).toBe(true)
      expect(pending.length).toBeGreaterThan(0)
      // A pre-confirmation request completing late is not terminal-history authority.
      if (mode === 'terminal') {
        await act(async () => {
          pending[0]({ messages: [old], pagination: { hasMore: false, totalCount: 1 } })
          await Promise.resolve()
        })
        expect(renders.slice(start).every((text) => text === 'visible progress')).toBe(true)
      }
      const final: Message = {
        ...old,
        content: 'answer',
        metadata: {
          ...old.metadata,
          content: [
            {
              type: 'tool_use',
              id: 't',
              toolCall: { toolCallId: 't', toolName: 'search', args: '{}', result: 'final result', isError: false },
            },
            { type: 'text', id: 'a', content: 'answer' },
          ],
        },
      }
      await act(async () => {
        for (const resolve of pending) resolve({ messages: [final], pagination: { hasMore: false, totalCount: 1 } })
        await Promise.resolve()
      })
      await waitFor(() =>
        expect(result.current.items.find((item) => item.kind === 'persisted')).toMatchObject({
          message: { content: 'answer' },
        })
      )
      expect(renders.slice(start).every((text) => text === 'visible progress' || text === 'final result')).toBe(true)
    } finally {
      unmount()
      qc.clear()
      clock?.restore()
    }
  }
)

test('cached collection generations from a previous hook cannot authorize provisional tool replacement', async () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const old: Message = {
    id: 'm',
    agentId: 'a',
    role: 'assistant',
    content: '',
    pending: false,
    createdAt: new Date(),
    metadata: {
      executionId: 'e',
      streamGroupId: 'S',
      content: [
        {
          type: 'tool_use',
          id: 't',
          toolCall: { toolCallId: 't', toolName: 'search', args: '{}', result: '', isError: false },
        },
      ],
    },
  }
  qc.setQueryData(queryKeys.agents.messagesInfinite('a'), {
    pages: [{ messages: [old], pagination: { hasMore: false, totalCount: 1 }, __collectionRequestGeneration: 100 }],
    pageParams: [undefined],
  })
  const m = makeMockClient({
    activeExecution: { active: true, executionId: 'e', status: 'running' },
    getMessages: () => new Promise(() => {}),
  })
  const { result, unmount } = await renderHook(() => useAgentConversation({ agentId: 'a' }), {
    wrapper: wrapWith(qc, m.client),
  })
  try {
    act(() => {
      m.emit({ type: 'agent', agentId: 'a', executionId: 'e' })
      m.emit({ type: 'tool_start', toolCallId: 't', toolName: 'search', args: '{}', streamGroupId: 'S' })
      m.emit({ type: 'tool_update', toolCallId: 't', result: 'visible progress', streamGroupId: 'S' })
    })
    act(() => {
      m.emit({ type: 'execution_snapshot', executionId: 'e', executionVersion: 2, status: 'completed' })
      m.triggerDone()
    })
    expect(result.current.items.find((item) => item.kind === 'streaming')).toMatchObject({
      blocks: [{ toolCall: { result: 'visible progress' } }],
    })
  } finally {
    unmount()
    qc.clear()
  }
})

test('concurrent views can both use the shared post-confirmation history read', async () => {
  const m = makeMockClient({ activeExecution: { active: true, executionId: 'e', status: 'running' } })
  const callbacks = new Set<StreamCb>()
  m.client.agents.subscribeToAgentStream = (_id, callback) => {
    callbacks.add(callback)
    return () => {
      callbacks.delete(callback)
    }
  }
  const emit = (event: StreamEvent) => {
    for (const callback of callbacks) callback.onEvent(event)
  }
  const { result, unmount } = await renderHook(
    () => ({ first: useAgentConversation({ agentId: 'a' }), second: useAgentConversation({ agentId: 'a' }) }),
    { wrapper: wrap(m.client) }
  )
  try {
    act(() => {
      emit({ type: 'agent', agentId: 'a', executionId: 'e' })
      emit({ type: 'tool_start', streamGroupId: 'S', toolCallId: 't', toolName: 'search', args: '{}' })
      emit({ type: 'tool_update', streamGroupId: 'S', toolCallId: 't', result: 'progress' })
    })
    m.setMessages([
      {
        id: 'm',
        agentId: 'a',
        role: 'assistant',
        content: 'answer',
        pending: false,
        createdAt: new Date(),
        metadata: {
          executionId: 'e',
          streamGroupId: 'S',
          content: [
            {
              type: 'tool_use',
              id: 't',
              toolCall: { toolCallId: 't', toolName: 'search', args: '{}', result: 'final', isError: false },
            },
          ],
        },
      },
    ])
    await act(async () => {
      emit({ type: 'execution_snapshot', executionId: 'e', executionVersion: 2, status: 'completed' })
      for (const callback of callbacks) callback.onDone?.()
      await Promise.resolve()
    })
    await waitFor(() => {
      for (const conversation of Object.values(result.current))
        expect(conversation.items.find((item) => item.kind === 'persisted')).toMatchObject({
          blocks: [{ toolCall: { result: 'final' } }],
        })
    })
  } finally {
    unmount()
  }
})

test('in-band proxy error is recoverable by generic same-execution retry without a snapshot or prefix loss', async () => {
  const m = makeMockClient({
    activeExecution: { active: true, status: 'running' },
    messages: [
      {
        id: 'm',
        agentId: 'a',
        role: 'assistant',
        content: 'prefix',
        pending: false,
        createdAt: new Date(),
        metadata: { streamGroupId: 'S', content: [{ type: 'text', id: 't', content: 'prefix' }] },
      },
    ],
  })
  const { result, unmount } = await renderHook(() => useAgentConversation({ agentId: 'a' }), {
    wrapper: wrap(m.client),
  })
  try {
    act(() => {
      m.emit({ type: 'agent', agentId: 'a', executionId: 'e', executionStatus: 'running' })
      m.emit({ type: 'text', text: 'prefix', streamGroupId: 'S' })
    })
    act(() => m.emit({ type: 'error', message: 'Stream connection lost' }))
    act(() => {
      m.triggerDisconnect()
      m.triggerReconnect()
      m.emitCatchup([
        { type: 'agent', agentId: 'a', executionId: 'e', executionStatus: 'running' },
        { type: 'text', text: 'prefix tail', streamGroupId: 'S' },
      ])
    })
    expect(result.current.executionStatus).toBe('running')
    expect(result.current.items.filter((item) => item.kind === 'working')).toHaveLength(1)
    act(() => m.emit({ type: 'text', text: ' continued', streamGroupId: 'S' }))
    expect(result.current.items.find((item) => item.kind === 'streaming')).toMatchObject({
      blocks: [{ content: 'prefix tail continued' }],
    })
  } finally {
    unmount()
  }
})

test.each(['running', 'completed', 'failed', 'stopped'] as const)(
  'proxy error plus exhausted EOF reconciles exact execution truth: %s',
  async (status) => {
    const m = makeMockClient({ activeExecution: { active: true, executionId: 'e', status: 'running' } })
    let reads = 0
    m.client.agents.getExecution = async () => {
      reads++
      return { agentId: 'a', executionId: 'e', status, executionVersion: 2, active: status === 'running' }
    }
    const { result, unmount } = await renderHook(() => useAgentConversation({ agentId: 'a' }), {
      wrapper: wrap(m.client),
    })
    try {
      await waitFor(() => expect(m.subscribedExecutionIds.at(-1)).toBe('e'))
      act(() => {
        m.emit({ type: 'agent', agentId: 'a', executionId: 'e', executionStatus: 'running' })
        m.emit({ type: 'tool_start', toolCallId: 't', toolName: 'search', args: '{}', streamGroupId: 'S' })
        m.emit({ type: 'tool_update', toolCallId: 't', result: 'progress', streamGroupId: 'S' })
      })
      m.setMessages([
        {
          id: 'm',
          agentId: 'a',
          role: 'assistant',
          content: 'answer',
          pending: false,
          createdAt: new Date(),
          metadata: {
            executionId: 'e',
            streamGroupId: 'S',
            content: [
              {
                type: 'tool_use',
                id: 't',
                toolCall: {
                  toolCallId: 't',
                  toolName: 'search',
                  args: '{}',
                  result: 'final',
                  isError: status === 'failed',
                },
              },
            ],
          },
        },
      ])
      const before = m.subscribeCount()
      await act(async () => {
        m.emit({ type: 'error', message: 'Worker stream not ready' })
        m.triggerDone()
        await Promise.resolve()
      })
      expect(reads).toBe(1)
      await waitFor(() => expect(m.subscribeCount()).toBeGreaterThan(before))
      expect(result.current.executionStatus).toBe(status)
      if (status !== 'running') {
        act(() => {
          m.emit({ type: 'execution_snapshot', executionId: 'e', executionVersion: 2, status })
          m.triggerDone()
        })
        await waitFor(() =>
          expect(result.current.items.find((item) => item.kind === 'persisted')).toMatchObject({
            blocks: [{ toolCall: { result: 'final' } }],
          })
        )
        act(() =>
          m.emitCatchup([
            { type: 'agent', agentId: 'a', executionId: 'e', executionStatus: 'running' },
            { type: 'text', text: 'stale', streamGroupId: 'S' },
          ])
        )
        expect(result.current.executionStatus).toBe(status)
        expect(result.current.items.some((item) => item.kind === 'working')).toBe(false)
      }
    } finally {
      unmount()
    }
  }
)

test('an error inside catchup is not authoritative terminal status or destructive lifecycle routing', async () => {
  const m = makeMockClient({ activeExecution: { active: true, status: 'running' } })
  const { result, unmount } = await renderHook(() => useAgentConversation({ agentId: 'a' }), {
    wrapper: wrap(m.client),
  })
  try {
    const events: StreamEvent[] = [
      { type: 'agent', agentId: 'a', executionId: 'e', executionStatus: 'running' },
      { type: 'text', text: 'prefix', streamGroupId: 'S' },
      { type: 'error', message: 'Unclassified stream failure' },
      { type: 'text', text: ' tail', streamGroupId: 'S' },
    ]
    act(() => m.emitCatchup(events))
    expect(result.current.executionStatus).toBe('running')
    expect(result.current.streamStatus).toBe('live')
    expect(result.current.items.find((item) => item.kind === 'streaming')).toMatchObject({
      status: 'streaming',
      blocks: [{ content: 'prefix tail' }],
    })
    act(() => m.emitCatchup(events))
    act(() => m.emit({ type: 'text', text: ' next', streamGroupId: 'S' }))
    expect(result.current.items.find((item) => item.kind === 'streaming')).toMatchObject({
      blocks: [{ content: 'prefix tail next' }],
    })
  } finally {
    unmount()
  }
})

// Own only reconciliation deadlines; React Query's notification timers stay real.
function reconciliationClock() {
  let now = 100_000
  let sequence = 0
  const timers = new Map<number, { at: number; run: () => void }>()
  const realSet = globalThis.setTimeout
  const realClear = globalThis.clearTimeout
  const time = spyOn(performance, 'now').mockImplementation(() => now)
  globalThis.setTimeout = ((run: () => void, ms?: number, ...args: unknown[]) => {
    if (ms !== undefined && ms > 0 && ms !== 10 && ms <= 60_000) {
      const id = --sequence
      timers.set(id, { at: now + ms, run })
      return id as unknown as ReturnType<typeof setTimeout>
    }
    return realSet(run, ms, ...args)
  }) as typeof setTimeout
  globalThis.clearTimeout = ((id: ReturnType<typeof setTimeout>) => {
    if (!timers.delete(id as unknown as number)) realClear(id)
  }) as typeof clearTimeout
  return {
    async advance(ms: number) {
      const end = now + ms
      while (true) {
        const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!next) break
        now = next[1].at
        timers.delete(next[0])
        await act(async () => {
          next[1].run()
          await Promise.resolve()
        })
      }
      now = end
      await act(async () => {
        await Promise.resolve()
      })
    },
    restore() {
      globalThis.setTimeout = realSet
      globalThis.clearTimeout = realClear
      time.mockRestore()
    },
  }
}

describe('silent-open liveness', () => {
  test('stale busy cache and silent open stream recover authoritative history without reconnect or remount', async () => {
    const clock = reconciliationClock()
    const m = makeMockClient({ activeExecution: { active: true, status: 'running', executionId: 'e' } })
    let reads = 0
    m.client.agents.getExecution = async () => {
      reads++
      return { agentId: 'a', executionId: 'e', executionVersion: 2, status: 'completed', active: false }
    }
    const renders: Array<ReturnType<typeof useAgentConversation>> = []
    const hook = await renderHook(
      () => {
        const value = useAgentConversation({ agentId: 'a' })
        renders.push(value)
        return value
      },
      { wrapper: wrap(m.client) }
    )
    try {
      await waitFor(() => expect(m.subscribedExecutionIds.at(-1)).toBe('e'))
      act(() =>
        m.emitCatchup([
          { type: 'agent', agentId: 'a', executionId: 'e', executionStatus: 'running' },
          { type: 'text', text: 'prefix', streamGroupId: 'S' },
        ])
      )
      const start = renders.length - 1
      m.setMessages([
        {
          id: 'm',
          agentId: 'a',
          role: 'assistant',
          content: 'prefix tail',
          pending: false,
          createdAt: new Date(),
          metadata: {
            streamGroupId: 'S',
            executionId: 'e',
            content: [{ type: 'text', id: 't', content: 'prefix tail' }],
          },
        },
      ])
      const subscriptions = m.subscribeCount()
      await clock.advance(14_999)
      expect(reads).toBe(0)
      await clock.advance(1)
      await waitFor(() => expect(hook.result.current.executionStatus).toBe('completed'))
      await waitFor(() => expect(hook.result.current.items.some((i) => i.kind === 'persisted')).toBe(true))
      expect(reads).toBe(1)
      expect(m.subscribeCount()).toBe(subscriptions)
      for (const render of renders.slice(start)) {
        const content = render.items.flatMap((i) => (i.kind === 'streaming' || i.kind === 'persisted' ? i.blocks : []))
        expect(
          content
            .filter((b) => b.type === 'text')
            .map((b) => b.content)
            .join('')
        ).toMatch(/^prefix(?: tail)?$/)
      }
    } finally {
      hook.unmount()
      clock.restore()
    }
  })

  test.each(
    (['completed', 'failed', 'stopped'] as const).flatMap((status) =>
      (['success', 'error', 'repeat', 'offline', 'foreground'] as const).map((mode) => ({ status, mode }))
    )
  )('idle manual refresh after exact $status binds only its own history request ($mode)', async ({ status, mode }) => {
    const clock = reconciliationClock()
    let wallNow = Date.now()
    const wallClock = spyOn(Date, 'now').mockImplementation(() => wallNow)
    let rejectHistory = false
    const m = makeMockClient({
      activeExecution: { active: true, status: 'running', executionId: 'e' },
      getMessages: () => {
        if (rejectHistory) throw new Error('history unavailable')
        return { messages: [], pagination: { hasMore: false, totalCount: 0 } }
      },
    })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    let reads = 0
    m.client.agents.getExecution = async () => {
      reads++
      return { agentId: 'a', executionId: 'e', executionVersion: 2, status, active: false }
    }
    const hook = await renderHook(() => useAgentConversation({ agentId: 'a' }), {
      wrapper: wrapWith(queryClient, m.client),
    })
    try {
      await waitFor(() => expect(m.subscribedExecutionIds.at(-1)).toBe('e'))
      act(() => m.emit({ type: 'text', text: 'retained prefix', streamGroupId: 'S' }))
      const subscriptions = m.subscribeCount()
      await clock.advance(15000)
      await waitFor(() => expect(hook.result.current.executionStatus).toBe(status))
      const query = queryClient.getQueryCache().find({ queryKey: queryKeys.agents.messagesInfinite('a') })!
      await waitFor(() => expect(query.state.fetchStatus).toBe('idle'))
      expect(m.subscribeCount()).toBe(subscriptions) // Automatic recovery is not a reconnect.
      await clock.advance(5000)
      wallNow += 20_000
      if (mode === 'foreground') {
        act(() => focusManager.setFocused(false))
        act(() => focusManager.setFocused(true))
        await waitFor(() => expect(query.state.fetchStatus).toBe('idle'))
      }
      if (mode === 'offline') act(() => onlineManager.setOnline(false))
      rejectHistory = mode === 'error'
      const history = m.getMessagesCount()
      const oldPromise = query.promise
      const items = hook.result.current.items
      const currentSubscriptions = m.subscribeCount()
      const presses = mode === 'repeat' ? 2 : 1
      act(() => {
        let previousPromise = oldPromise
        for (let press = 1; press <= presses; press++) {
          hook.result.current.refresh()
          // A mobile caller binds synchronously, never by waiting for the next fetch.
          expect(m.getMessagesCount()).toBe(history + (mode === 'offline' ? 0 : press))
          expect(query.state.fetchStatus).toBe(mode === 'offline' ? 'paused' : 'fetching')
          expect(query.promise).not.toBe(previousPromise)
          previousPromise = query.promise
        }
      })
      if (mode === 'offline') {
        // A paused request is not feedback-worthy dispatch. No deferred Core intent
        // may later claim the online-triggered fetch as a new explicit invocation.
        act(() => onlineManager.setOnline(true))
      }
      await waitFor(() => expect(query.state.fetchStatus).toBe('idle'))
      if (mode === 'error') expect(query.state.status).toBe('error')
      expect(hook.result.current.executionStatus).toBe(status)
      expect(hook.result.current.items).toEqual(items) // Empty/error history cannot retire uncovered content.
      expect(reads).toBe(1)
      expect(m.subscribeCount()).toBe(currentSubscriptions)
      expect(m.subscribedExecutionIds.at(-1)).toBe('e')
      await clock.advance(30000)
      expect(m.getMessagesCount()).toBe(history + presses) // No deferred duplicate.
      expect(reads).toBe(1)
    } finally {
      hook.unmount()
      onlineManager.setOnline(true)
      focusManager.setFocused(true)
      wallClock.mockRestore()
      clock.restore()
    }
  })

  test('one early manual press drains at quiet without a terminal event; repeated presses coalesce', async () => {
    const clock = reconciliationClock()
    const m = makeMockClient()
    const hook = await renderHook(() => useAgentConversation({ agentId: 'a' }), { wrapper: wrap(m.client) })
    try {
      act(() => m.emit({ type: 'text', text: 'prefix', streamGroupId: 'S' }))
      const history = m.getMessagesCount()
      const subscriptions = m.subscribeCount()
      act(() => {
        hook.result.current.refresh()
        hook.result.current.refresh()
      })
      expect(m.getMessagesCount()).toBe(history)
      await clock.advance(3999)
      expect(m.subscribeCount()).toBe(subscriptions)
      await clock.advance(1)
      await waitFor(() => expect(m.getMessagesCount()).toBeGreaterThan(history))
      expect(m.subscribeCount()).toBe(subscriptions + 1)
      expect(hook.result.current.items.find((i) => i.kind === 'streaming')).toMatchObject({
        blocks: [{ content: 'prefix' }],
      })
    } finally {
      hook.unmount()
      clock.restore()
    }
  })
})

describe('silent recovery bounds and ownership', () => {
  test('quiet running tool keeps content, probes at 15/45/105 seconds and exhausts its budget', async () => {
    const clock = reconciliationClock()
    const m = makeMockClient({ activeExecution: { active: true, status: 'running', executionId: 'e' } })
    let reads = 0
    m.client.agents.getExecution = async () => {
      reads++
      return { agentId: 'a', executionId: 'e', executionVersion: 1, status: 'running', active: true }
    }
    const hook = await renderHook(() => useAgentConversation({ agentId: 'a' }), { wrapper: wrap(m.client) })
    try {
      await waitFor(() => expect(m.subscribedExecutionIds.at(-1)).toBe('e'))
      act(() => m.emit({ type: 'text', text: 'retained', streamGroupId: 'S' }))
      const subscriptions = m.subscribeCount()
      for (const [ms, count] of [
        [15000, 1],
        [29999, 1],
        [1, 2],
        [59999, 2],
        [1, 3],
        [300000, 3],
      ]) {
        await clock.advance(ms!)
        expect(reads).toBe(count)
        expect(hook.result.current.executionStatus).toBe('running')
        expect(hook.result.current.items.find((i) => i.kind === 'streaming')).toMatchObject({
          blocks: [{ content: 'retained' }],
        })
        expect(m.subscribeCount()).toBe(subscriptions)
      }
    } finally {
      hook.unmount()
      clock.restore()
    }
  })

  test('offline defers manual intent; online recovery drains it once', async () => {
    const clock = reconciliationClock()
    const m = makeMockClient()
    const hook = await renderHook(() => useAgentConversation({ agentId: 'a' }), { wrapper: wrap(m.client) })
    try {
      act(() => m.emit({ type: 'text', text: 'retained', streamGroupId: 'S' }))
      const subscriptions = m.subscribeCount()
      act(() => {
        onlineManager.setOnline(false)
        hook.result.current.refresh()
      })
      await clock.advance(60000)
      expect(m.subscribeCount()).toBe(subscriptions)
      await act(async () => {
        onlineManager.setOnline(true)
        await Promise.resolve()
      })
      await waitFor(() => expect(m.subscribeCount()).toBe(subscriptions + 1))
    } finally {
      hook.unmount()
      onlineManager.setOnline(true)
      clock.restore()
    }
  })

  test('resumed activity postpones quiet drain but cannot starve explicit history intent beyond 30s', async () => {
    const clock = reconciliationClock()
    const m = makeMockClient({ activeExecution: { active: true, status: 'running', executionId: 'e' } })
    let reads = 0
    m.client.agents.getExecution = async () => {
      reads++
      return { agentId: 'a', executionId: 'e', executionVersion: 1, status: 'running', active: true }
    }
    const hook = await renderHook(() => useAgentConversation({ agentId: 'a' }), { wrapper: wrap(m.client) })
    try {
      await waitFor(() => expect(m.subscribedExecutionIds.at(-1)).toBe('e'))
      act(() => m.emit({ type: 'text', text: 'x', streamGroupId: 'S' }))
      const subscriptions = m.subscribeCount()
      const history = m.getMessagesCount()
      act(() => hook.result.current.refresh())
      for (let i = 0; i < 10; i++) {
        await clock.advance(3000)
        act(() => m.emit({ type: 'text', text: 'x', streamGroupId: 'S' }))
      }
      await waitFor(() => expect(m.getMessagesCount()).toBeGreaterThan(history))
      expect(reads).toBe(1)
      expect(m.subscribeCount()).toBe(subscriptions)
      expect(hook.result.current.executionStatus).toBe('running')
    } finally {
      hook.unmount()
      clock.restore()
    }
  })
})

test('two mounted views share silent-open exact/history recovery through real resource and SSE parser', async () => {
  const clock = reconciliationClock()
  const controllers: ReadableStreamDefaultController<Uint8Array>[] = []
  let exact = 0
  let history = 0
  let rows: Message[] = []
  const transport: Transport = {
    request: async <T,>(path: string) => {
      if (path.includes('/executions/')) {
        exact++
        return { agentId: 'a', executionId: 'e', executionVersion: 2, status: 'completed', active: false } as T
      }
      if (path.includes('/messages')) {
        history++
        return { messages: rows, pagination: { hasMore: false, totalCount: rows.length } } as T
      }
      if (path.endsWith('/active')) return { active: true, status: 'running', executionId: 'e' } as T
      return {} as T
    },
    openStream: async () =>
      new ReadableStream<Uint8Array>({
        start(c) {
          controllers.push(c)
        },
      }).getReader(),
    url: (path) => path,
    wsUrl: (path) => path,
  }
  const client = createClient(transport)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = wrapWith(qc, client)
  const renders: ReturnType<typeof useAgentConversation>[] = []
  const useTracked = () => {
    const value = useAgentConversation({ agentId: 'a' })
    renders.push(value)
    return value
  }
  const a = await renderHook(useTracked, { wrapper })
  const b = await renderHook(useTracked, { wrapper })
  try {
    await waitFor(() => expect(controllers.length).toBeGreaterThanOrEqual(3))
    // The initial unpinned view is canceled on active-query resolution. Only live readers receive bytes.
    await act(async () => {
      for (const c of controllers) {
        try {
          for (const event of [
            { type: 'agent', agentId: 'a', executionId: 'e', executionStatus: 'running' },
            { type: 'text', text: 'prefix', streamGroupId: 'S' },
          ])
            c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`))
        } catch {
          /* Owned reader already canceled by exact subscription adoption. */
        }
      }
      await Promise.resolve()
    })
    await waitFor(() => expect(b.result.current.items.find((i) => i.kind === 'streaming')).toBeDefined())
    const start = renders.length
    const before = history
    rows = [
      {
        id: 'm',
        agentId: 'a',
        role: 'assistant',
        content: 'prefix tail',
        pending: false,
        createdAt: new Date(),
        metadata: {
          streamGroupId: 'S',
          executionId: 'e',
          content: [{ type: 'text', id: 't', content: 'prefix tail' }],
        },
      },
    ]
    await clock.advance(15000)
    await waitFor(() => {
      expect(a.result.current.items.find((i) => i.kind === 'persisted')).toBeDefined()
      expect(b.result.current.items.find((i) => i.kind === 'persisted')).toBeDefined()
    })
    expect(exact).toBe(1)
    expect(history).toBe(before + 1)
    for (const render of renders.slice(start)) {
      const texts = render.items.flatMap((i) =>
        i.kind === 'persisted' || i.kind === 'streaming'
          ? i.blocks.flatMap((b) => (b.type === 'text' ? [b.content] : []))
          : []
      )
      expect(texts).toHaveLength(1)
      expect(texts[0]).toMatch(/^prefix(?: tail)?$/)
    }
    // A cached late observer consumes existing exact truth rather than spending
    // another probe or remaining busy on a stale active-execution cache.
    const late = await renderHook(useTracked, { wrapper })
    try {
      await waitFor(() => expect(late.result.current.executionStatus).toBe('completed'))
      expect(exact).toBe(1)
    } finally {
      late.unmount()
    }
  } finally {
    a.unmount()
    b.unmount()
    qc.clear()
    clock.restore()
  }
})

test('pending exact probe times out honestly; late completion cannot mutate a switched conversation', async () => {
  const clock = reconciliationClock()
  const m = makeMockClient({ activeExecution: { active: true, status: 'running', executionId: 'e' } })
  let resolve!: (value: Awaited<ReturnType<FicusClient['agents']['getExecution']>>) => void
  let signal: AbortSignal | undefined
  let reads = 0
  m.client.agents.getExecution = async (_a, _e, s) => {
    reads++
    signal = s
    return new Promise((r) => {
      resolve = r
    })
  }
  let agentId = 'a'
  const hook = await renderHook(() => useAgentConversation({ agentId }), { wrapper: wrap(m.client) })
  try {
    await waitFor(() => expect(m.subscribedExecutionIds.at(-1)).toBe('e'))
    act(() => m.emit({ type: 'text', text: 'retained', streamGroupId: 'S' }))
    await clock.advance(15000)
    expect(reads).toBe(1)
    await clock.advance(10000)
    expect(signal?.aborted).toBe(true)
    expect(hook.result.current.executionStatus).toBe('running')
    expect(hook.result.current.items.find((i) => i.kind === 'streaming')).toMatchObject({
      blocks: [{ content: 'retained' }],
    })
    agentId = 'b'
    m.setActiveExecution({ active: false })
    await hook.rerender()
    await act(async () => {
      resolve({ agentId: 'a', executionId: 'e', executionVersion: 2, status: 'completed', active: false })
      await Promise.resolve()
    })
    expect(hook.result.current.agentId).toBe('b')
    expect(hook.result.current.executionStatus).toBeNull()
    expect(hook.result.current.items).toEqual([])
    await clock.advance(300000)
    expect(reads).toBe(1)
  } finally {
    hook.unmount()
    clock.restore()
  }
})

test('failed probes are bounded and a later explicit refresh can recover exact terminal history', async () => {
  const clock = reconciliationClock()
  const m = makeMockClient({ activeExecution: { active: true, status: 'running', executionId: 'e' } })
  let reads = 0
  let offline = true
  m.client.agents.getExecution = async () => {
    reads++
    if (offline) throw new Error('offline')
    return { agentId: 'a', executionId: 'e', executionVersion: 2, status: 'completed', active: false }
  }
  const hook = await renderHook(() => useAgentConversation({ agentId: 'a' }), { wrapper: wrap(m.client) })
  try {
    await waitFor(() => expect(m.subscribedExecutionIds.at(-1)).toBe('e'))
    act(() => m.emit({ type: 'text', text: 'retained', streamGroupId: 'S' }))
    await clock.advance(300000)
    expect(reads).toBe(3)
    expect(hook.result.current.executionStatus).toBe('running')
    offline = false
    act(() => hook.result.current.refresh())
    await waitFor(() => expect(hook.result.current.executionStatus).toBe('completed'))
    expect(reads).toBe(4)
    expect(hook.result.current.items.find((i) => i.kind === 'streaming')).toMatchObject({
      blocks: [{ content: 'retained' }],
    })
  } finally {
    hook.unmount()
    clock.restore()
  }
})

test('unmount cancels deferred manual intent and an in-flight exact read', async () => {
  const clock = reconciliationClock()
  const m = makeMockClient({ activeExecution: { active: true, status: 'running', executionId: 'e' } })
  let signal: AbortSignal | undefined
  m.client.agents.getExecution = async (_a, _e, s) => {
    signal = s
    return new Promise(() => {})
  }
  const hook = await renderHook(() => useAgentConversation({ agentId: 'a' }), { wrapper: wrap(m.client) })
  try {
    await waitFor(() => expect(m.subscribedExecutionIds.at(-1)).toBe('e'))
    act(() => m.emit({ type: 'text', text: 'retained', streamGroupId: 'S' }))
    await clock.advance(15000)
    act(() => hook.result.current.refresh())
    const history = m.getMessagesCount()
    hook.unmount()
    expect(signal?.aborted).toBe(true)
    await clock.advance(300000)
    expect(m.getMessagesCount()).toBe(history)
  } finally {
    clock.restore()
  }
})

test('foreground refresh satisfies an early manual intent without a second quiet refresh', async () => {
  const clock = reconciliationClock()
  const m = makeMockClient({ activeExecution: { active: true, status: 'running', executionId: 'e' } })
  const hook = await renderHook(() => useAgentConversation({ agentId: 'a' }), { wrapper: wrap(m.client) })
  try {
    await waitFor(() => expect(m.subscribedExecutionIds.at(-1)).toBe('e'))
    act(() => m.emit({ type: 'text', text: 'retained', streamGroupId: 'S' }))
    act(() => hook.result.current.refresh())
    await act(async () => {
      focusManager.setFocused(false)
      focusManager.setFocused(true)
      await Promise.resolve()
    })
    const subscriptions = m.subscribeCount()
    const history = m.getMessagesCount()
    await clock.advance(4000)
    expect(m.subscribeCount()).toBe(subscriptions)
    expect(m.getMessagesCount()).toBe(history)
    expect(hook.result.current.items.find((i) => i.kind === 'streaming')).toMatchObject({
      blocks: [{ content: 'retained' }],
    })
  } finally {
    hook.unmount()
    focusManager.setFocused(true)
    clock.restore()
  }
})

test.each(['execution', 'activity', 'foreground'] as const)(
  'pending silent result cannot overwrite %s replacement state',
  async (replacement) => {
    const clock = reconciliationClock()
    const m = makeMockClient({ activeExecution: { active: true, status: 'running', executionId: 'e' } })
    let finish!: (value: Awaited<ReturnType<FicusClient['agents']['getExecution']>>) => void
    m.client.agents.getExecution = () =>
      new Promise((resolve) => {
        finish = resolve
      })
    const hook = await renderHook(() => useAgentConversation({ agentId: 'a' }), { wrapper: wrap(m.client) })
    try {
      await waitFor(() => expect(m.subscribedExecutionIds.at(-1)).toBe('e'))
      act(() => m.emit({ type: 'text', text: 'retained', streamGroupId: 'S' }))
      await clock.advance(15000)
      expect(finish).toBeDefined()
      act(() => {
        if (replacement === 'execution') {
          m.emit({ type: 'execution_snapshot', executionId: 'next', executionVersion: 1, status: 'running' })
          m.emit({ type: 'text', text: 'next', streamGroupId: 'next' })
        } else if (replacement === 'activity') m.emit({ type: 'text', text: ' tail', streamGroupId: 'S' })
        else {
          focusManager.setFocused(false)
          focusManager.setFocused(true)
        }
      })
      await act(async () => {
        finish({ agentId: 'a', executionId: 'e', executionVersion: 99, status: 'completed', active: false })
        await Promise.resolve()
      })
      expect(hook.result.current.executionStatus).toBe('running')
      expect(hook.result.current.items.some((i) => i.kind === 'streaming')).toBe(true)
      if (replacement === 'activity') {
        act(() => m.emit({ type: 'text', text: ' still running', streamGroupId: 'S' }))
        // Drain the next timer turn (including a cached-result deadline of zero).
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0))
        })
        expect(hook.result.current.executionStatus).toBe('running')
        await clock.advance(30000)
        expect(hook.result.current.executionStatus).toBe('running')
      }
    } finally {
      hook.unmount()
      focusManager.setFocused(true)
      clock.restore()
    }
  }
)

test('two foreground observers invalidate shared history only once', async () => {
  const m = makeMockClient()
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = wrapWith(qc, m.client)
  const a = await renderHook(() => useAgentConversation({ agentId: 'a' }), { wrapper })
  const b = await renderHook(() => useAgentConversation({ agentId: 'a' }), { wrapper })
  try {
    const before = m.getMessagesCount()
    await act(async () => {
      focusManager.setFocused(false)
      focusManager.setFocused(true)
      await Promise.resolve()
    })
    expect(m.getMessagesCount()).toBe(before + 1)
  } finally {
    a.unmount()
    b.unmount()
    qc.clear()
    focusManager.setFocused(true)
  }
})

async function drainTimerTurns(count = 3) {
  for (let i = 0; i < count; i++)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
}

test.each([true, false])(
  'replacement rejects old pending result when reused from cache (manual=%s)',
  async (manual) => {
    const clock = reconciliationClock()
    const m = makeMockClient({ activeExecution: { active: true, status: 'running', executionId: 'e' } })
    let finish!: (value: Awaited<ReturnType<FicusClient['agents']['getExecution']>>) => void
    m.client.agents.getExecution = () =>
      new Promise((resolve) => {
        finish = resolve
      })
    const hook = await renderHook(() => useAgentConversation({ agentId: 'a' }), { wrapper: wrap(m.client) })
    try {
      await waitFor(() => expect(m.subscribedExecutionIds.at(-1)).toBe('e'))
      act(() => m.emit({ type: 'text', text: 'retained', streamGroupId: 'S' }))
      await clock.advance(15000)
      await act(async () => {
        focusManager.setFocused(false)
        focusManager.setFocused(true)
        await Promise.resolve()
      })
      await act(async () => {
        finish({ agentId: 'a', executionId: 'e', executionVersion: 99, status: 'completed', active: false })
        await Promise.resolve()
      })
      expect(hook.result.current.executionStatus).toBe('running')
      if (manual) act(() => hook.result.current.refresh())
      else
        act(() => {
          onlineManager.setOnline(false)
          onlineManager.setOnline(true)
        })
      await drainTimerTurns()
      expect(hook.result.current.executionStatus).toBe('running')
      const oldRead = finish
      await clock.advance(manual ? 4000 : 30000)
      expect(finish).not.toBe(oldRead)
      await act(async () => {
        finish({ agentId: 'a', executionId: 'e', executionVersion: 100, status: 'completed', active: false })
        await Promise.resolve()
      })
      expect(hook.result.current.executionStatus).toBe('completed')
    } finally {
      hook.unmount()
      focusManager.setFocused(true)
      onlineManager.setOnline(true)
      clock.restore()
    }
  }
)

test.each(['success', 'failure', 'online'] as const)(
  'manual %s at 12s cannot spin at the first automatic deadline',
  async (mode) => {
    const clock = reconciliationClock()
    const m = makeMockClient({ activeExecution: { active: true, status: 'running', executionId: 'e' } })
    let reads = 0
    let renders = 0
    m.client.agents.getExecution = async () => {
      reads++
      if (mode === 'failure') throw new Error('offline')
      return { agentId: 'a', executionId: 'e', executionVersion: 1, status: 'running', active: true }
    }
    const hook = await renderHook(
      () => {
        renders++
        return useAgentConversation({ agentId: 'a' })
      },
      { wrapper: wrap(m.client) }
    )
    try {
      await waitFor(() => expect(m.subscribedExecutionIds.at(-1)).toBe('e'))
      act(() => m.emit({ type: 'text', text: 'retained', streamGroupId: 'S' }))
      await clock.advance(12000)
      act(() => {
        if (mode === 'online') onlineManager.setOnline(false)
        hook.result.current.refresh()
      })
      if (mode === 'online') act(() => onlineManager.setOnline(true))
      await drainTimerTurns()
      expect(reads).toBe(1)
      await clock.advance(3000)
      await drainTimerTurns()
      const settled = renders
      await drainTimerTurns(10)
      expect(renders).toBe(settled)
      expect(reads).toBe(1)
      await clock.advance(1000)
      expect(reads).toBe(2)
      await clock.advance(30000)
      expect(reads).toBe(3)
      await clock.advance(60000)
      expect(reads).toBe(4)
      await clock.advance(300000)
      expect(reads).toBe(4)
      expect(hook.result.current.executionStatus).toBe('running')
    } finally {
      hook.unmount()
      onlineManager.setOnline(true)
      clock.restore()
    }
  }
)

test.each(['failure', 'timeout'] as const)('two manual observers share the %s history fallback', async (mode) => {
  const clock = reconciliationClock()
  const m = makeMockClient({ activeExecution: { active: true, status: 'running', executionId: 'e' } })
  let reads = 0
  m.client.agents.getExecution = async () => {
    reads++
    if (mode === 'failure') throw new Error('offline')
    return new Promise(() => {})
  }
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = wrapWith(qc, m.client)
  const a = await renderHook(() => useAgentConversation({ agentId: 'a' }), { wrapper })
  const b = await renderHook(() => useAgentConversation({ agentId: 'a' }), { wrapper })
  try {
    await waitFor(() => {
      expect(m.subscribedExecutionIds.filter((id) => id === 'e')).toHaveLength(2)
      expect(a.result.current.executionStatus).toBe('running')
      expect(b.result.current.executionStatus).toBe('running')
      expect(qc.isFetching()).toBe(0)
    })
    const before = m.getMessagesCount()
    act(() => {
      a.result.current.refresh()
      b.result.current.refresh()
      a.result.current.refresh()
      b.result.current.refresh()
    })
    await clock.advance(4000)
    if (mode === 'timeout') await clock.advance(10000)
    await drainTimerTurns()
    expect(reads).toBe(1)
    expect(m.getMessagesCount()).toBe(before + 1)
    expect(a.result.current.executionStatus).toBe('running')
    expect(b.result.current.executionStatus).toBe('running')
  } finally {
    a.unmount()
    b.unmount()
    qc.clear()
    clock.restore()
  }
})

test('one replacement floor does not revoke a shared result from another valid observer', async () => {
  const clock = reconciliationClock()
  const m = makeMockClient({ activeExecution: { active: true, status: 'running', executionId: 'e' } })
  let finish!: (value: Awaited<ReturnType<FicusClient['agents']['getExecution']>>) => void
  let reads = 0
  m.client.agents.getExecution = () => {
    reads++
    return new Promise((resolve) => {
      finish = resolve
    })
  }
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = wrapWith(qc, m.client)
  const a = await renderHook(() => useAgentConversation({ agentId: 'a' }), { wrapper })
  let b: Awaited<ReturnType<typeof renderHook<ReturnType<typeof useAgentConversation>>>> | undefined
  try {
    await waitFor(() => expect(m.subscribedExecutionIds.at(-1)).toBe('e'))
    act(() => m.emit({ type: 'text', text: 'retained', streamGroupId: 'S' }))
    await clock.advance(15000)
    act(() => focusManager.setFocused(false))
    // B has never observed a foreground loss, so only A replaces its subscription.
    b = await renderHook(() => useAgentConversation({ agentId: 'a' }), { wrapper })
    await waitFor(() => expect(b!.result.current.executionStatus).toBe('running'))
    await act(async () => {
      focusManager.setFocused(true)
      await Promise.resolve()
    })
    await act(async () => {
      finish({ agentId: 'a', executionId: 'e', executionVersion: 2, status: 'completed', active: false })
      await Promise.resolve()
    })
    act(() => {
      onlineManager.setOnline(false)
      onlineManager.setOnline(true)
    })
    await drainTimerTurns()
    expect(a.result.current.executionStatus).toBe('running')
    expect(b.result.current.executionStatus).toBe('completed')
    expect(reads).toBe(1)
  } finally {
    a.unmount()
    b?.unmount()
    qc.clear()
    focusManager.setFocused(true)
    onlineManager.setOnline(true)
    clock.restore()
  }
})
