import { act } from 'react'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { acquireDomHarness } from '../test/domHarness'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { FicusClient } from '@ficus/client-core'
import { useAgentConversation, type RenderItem } from '@ficus/client-react'
import type { Message } from '@ficus/shared'
import { LiveConversationProvider } from './LiveConversationProvider'
import { WebSocketProvider } from './WebSocketProvider'
import { QueryInvalidator } from '../components/QueryInvalidator'
import { hasLiveConversation } from '../lib/messageInvalidationSuppression'

class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  static OPEN = 1
  readyState = 0
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this)
  }
  send(frame: string) {
    this.sent.push(frame)
  }
  open() {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.()
  }
  serverMessage(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent)
  }
  close() {
    this.readyState = 3
  }
}

type StreamCallbacks = Parameters<FicusClient['agents']['subscribeToAgentStream']>[1]

function makeClient(getMessage: (messageId: string) => Promise<Message>) {
  let streamCallbacks: StreamCallbacks | null = null
  let getMessagesCount = 0
  let getMessageCount = 0
  const client = {
    agents: {
      getMessage: (_agentId: string, messageId: string) => {
        getMessageCount += 1
        return getMessage(messageId)
      },
      getMessages: async () => {
        getMessagesCount += 1
        return { messages: [], pagination: { hasMore: false, totalCount: 0 } }
      },
      getActiveExecution: async () => ({ active: false }),
      subscribeToAgentStream: (_agentId: string, callbacks: StreamCallbacks) => {
        streamCallbacks = callbacks
        return () => undefined
      },
    },
  } as unknown as FicusClient
  return {
    client,
    getMessagesCount: () => getMessagesCount,
    getMessageCount: () => getMessageCount,
    emitAgent: (executionId: string) => streamCallbacks?.onEvent({ type: 'agent', agentId: 'a1', executionId }),
    emitStream: (text: string, streamGroupId = 'stream-1') =>
      streamCallbacks?.onEvent({ type: 'text', text, streamGroupId }),
  }
}

function ConversationProbe({ onItems }: { onItems: (items: RenderItem[]) => void }) {
  const { items } = useAgentConversation({ agentId: 'a1' })
  onItems(items)
  return null
}

const inbound: Message = {
  id: 'm1',
  agentId: 'a1',
  role: 'human',
  content: 'incoming',
  metadata: {},
  pending: false,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
}

async function flushEffects() {
  await act(async () => {
    for (let index = 0; index < 5; index += 1) await Promise.resolve()
  })
}

describe('LiveConversationProvider', () => {
  let dom: Awaited<ReturnType<typeof acquireDomHarness>>
  let oldWebSocket: typeof globalThis.WebSocket
  let root: import('react-dom/client').Root

  beforeEach(async () => {
    FakeWebSocket.instances = []
    oldWebSocket = globalThis.WebSocket
    dom = await acquireDomHarness({ url: 'http://localhost/' })
    globalThis.WebSocket = FakeWebSocket as unknown as typeof globalThis.WebSocket
    root = dom.createRoot().root
  })

  afterEach(async () => {
    globalThis.WebSocket = oldWebSocket
    await dom.cleanup()
  })

  async function mountConversation(mockClient: ReturnType<typeof makeClient>) {
    let items: RenderItem[] = []
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <WebSocketProvider getUrl={async () => 'ws://test/ws'}>
            <LiveConversationProvider client={mockClient.client}>
              <QueryInvalidator />
              <ConversationProbe onItems={(next) => (items = next)} />
            </LiveConversationProvider>
          </WebSocketProvider>
        </QueryClientProvider>
      )
      await Promise.resolve()
    })
    const socket = FakeWebSocket.instances[0]
    await act(async () => socket.open())
    return { socket, getItems: () => items }
  }

  function createdFrame() {
    return {
      type: 'event',
      topic: 'agents:a1',
      event: 'message.created',
      data: { agentId: 'a1', messageId: inbound.id },
    }
  }

  test('a socket event immediately fetches and inserts the durable row without refetching history', async () => {
    const mockClient = makeClient(async () => inbound)
    const { socket, getItems } = await mountConversation(mockClient)
    expect(socket.sent.map((frame) => JSON.parse(frame))).toContainEqual({ type: 'subscribe', topic: 'agents:a1' })

    await act(async () => {
      socket.serverMessage({ ...createdFrame(), topic: 'agents' })
      socket.serverMessage(createdFrame())
    })
    await flushEffects()

    expect(getItems().some((item) => item.kind === 'persisted' && item.message.id === inbound.id)).toBe(true)
    expect(mockClient.getMessagesCount()).toBe(1)
  })

  test('an abort update repairs the stale tool row once without duplicates or a refetch loop', async () => {
    let durable = {
      ...inbound,
      role: 'assistant' as const,
      content: 'tool pending',
      metadata: {
        content: [
          {
            type: 'tool_use' as const,
            id: 'tool-abort',
            toolCall: { toolCallId: 'tool-abort', toolName: 'bash', args: '{}', result: '', isError: false },
          },
        ],
      },
    }
    const mockClient = makeClient(async () => durable)
    const { socket, getItems } = await mountConversation(mockClient)
    await act(async () => socket.serverMessage(createdFrame()))
    await flushEffects()

    durable = {
      ...durable,
      content: 'tool stopped',
      metadata: {
        content: [
          {
            type: 'tool_use' as const,
            id: 'tool-abort',
            toolCall: {
              toolCallId: 'tool-abort',
              toolName: 'bash',
              args: '{}',
              result: 'Command aborted',
              isError: true,
            },
          },
        ],
      },
    }
    await act(async () => socket.serverMessage({ ...createdFrame(), event: 'message.updated' }))
    await flushEffects()
    await flushEffects()

    const persisted = getItems().filter((item) => item.kind === 'persisted')
    expect(persisted).toHaveLength(1)
    expect(persisted[0]?.kind === 'persisted' ? persisted[0].message.content : '').toBe('tool stopped')
    expect(
      persisted[0]?.kind === 'persisted' && persisted[0].message.metadata?.content?.[0]?.type === 'tool_use'
        ? persisted[0].message.metadata.content[0].toolCall
        : null
    ).toMatchObject({ result: 'Command aborted', isError: true })
    expect(mockClient.getMessageCount()).toBe(2)
    expect(mockClient.getMessagesCount()).toBe(1)
  })

  test('unmount releases collection invalidation suppression for the conversation', async () => {
    const mockClient = makeClient(async () => inbound)
    await mountConversation(mockClient)
    expect(hasLiveConversation('a1')).toBe(true)

    await act(async () => root.unmount())
    expect(hasLiveConversation('a1')).toBe(false)
    root = dom.createRoot().root
  })

  test('a tool-result update fetches the completed durable row without a collection history refetch', async () => {
    let durable = { ...inbound, role: 'assistant' as const, content: 'tool pending' }
    const mockClient = makeClient(async () => durable)
    const { socket, getItems } = await mountConversation(mockClient)
    await act(async () => socket.serverMessage(createdFrame()))
    await flushEffects()

    durable = {
      ...durable,
      content: 'tool completed',
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
    }
    const updatedFrame = { ...createdFrame(), event: 'message.updated' }
    await act(async () => {
      socket.serverMessage({ ...updatedFrame, topic: 'agents' })
      socket.serverMessage(updatedFrame)
    })
    await flushEffects()

    const persisted = getItems().find((item) => item.kind === 'persisted')
    expect(persisted?.kind === 'persisted' ? persisted.message.content : '').toBe('tool completed')
    expect(
      persisted?.kind === 'persisted' && persisted.message.metadata?.content?.[0]?.type === 'tool_use'
        ? persisted.message.metadata.content[0].toolCall.result
        : ''
    ).toBe('completed result')
    expect(mockClient.getMessagesCount()).toBe(1)
  })

  test('a durable row is inserted above a stream that began before its socket event', async () => {
    const mockClient = makeClient(async () => inbound)
    const { socket, getItems } = await mountConversation(mockClient)
    await act(async () => mockClient.emitStream('response'))
    expect(getItems().some((item) => item.kind === 'streaming')).toBe(true)

    await act(async () => socket.serverMessage(createdFrame()))
    await flushEffects()

    const persistedIndex = getItems().findIndex((item) => item.kind === 'persisted')
    const streamingIndex = getItems().findIndex((item) => item.kind === 'streaming')
    expect(persistedIndex).toBeGreaterThanOrEqual(0)
    expect(streamingIndex).toBeGreaterThan(persistedIndex)
  })

  test('an enriched event hides only its exact response group that begins after it', async () => {
    const deferred = new Promise<Message>(() => undefined)
    const mockClient = makeClient(async () => deferred)
    const { socket, getItems } = await mountConversation(mockClient)

    await act(async () => {
      socket.serverMessage({
        ...createdFrame(),
        data: {
          agentId: 'a1',
          messageId: inbound.id,
          executionId: 'execution-1',
          streamGroupId: 'group-1',
        },
      })
      mockClient.emitAgent('execution-2')
      mockClient.emitStream('unrelated response', 'group-2')
      mockClient.emitAgent('execution-1')
      mockClient.emitStream('target response', 'group-1')
      await Promise.resolve()
    })

    const streaming = getItems().filter((item) => item.kind === 'streaming')
    expect(streaming).toHaveLength(1)
    expect(
      streaming[0]?.kind === 'streaming' ? streaming[0].blocks.find((block) => block.type === 'text')?.content : ''
    ).toBe('unrelated response')
  })

  test('an enriched event for the group already streaming does not collapse the live response', async () => {
    // The server persists each segment of the streaming group as an assistant row carrying the
    // group's own identity; that socket event must not hide the response mid-stream.
    const deferred = new Promise<Message>(() => undefined)
    const mockClient = makeClient(async () => deferred)
    const { socket, getItems } = await mountConversation(mockClient)

    await act(async () => {
      mockClient.emitAgent('execution-1')
      mockClient.emitStream('live response', 'group-1')
      await Promise.resolve()
    })
    expect(getItems().some((item) => item.kind === 'streaming')).toBe(true)

    await act(async () => {
      socket.serverMessage({
        ...createdFrame(),
        data: {
          agentId: 'a1',
          messageId: 'assistant-row-1',
          executionId: 'execution-1',
          streamGroupId: 'group-1',
        },
      })
      await Promise.resolve()
    })

    const streaming = getItems().filter((item) => item.kind === 'streaming')
    expect(streaming).toHaveLength(1)
    expect(
      streaming[0]?.kind === 'streaming' ? streaming[0].blocks.find((block) => block.type === 'text')?.content : ''
    ).toBe('live response')
  })

  test('an unresolved socket event barriers a stream that begins afterward', async () => {
    let resolveMessage!: (message: Message) => void
    const deferred = new Promise<Message>((resolve) => (resolveMessage = resolve))
    const mockClient = makeClient(async () => deferred)
    const { socket, getItems } = await mountConversation(mockClient)

    await act(async () => {
      socket.serverMessage(createdFrame())
      mockClient.emitStream('response')
      await Promise.resolve()
    })
    expect(getItems().some((item) => item.kind === 'streaming')).toBe(false)

    resolveMessage(inbound)
    await flushEffects()
    const persistedIndex = getItems().findIndex((item) => item.kind === 'persisted')
    const streamingIndex = getItems().findIndex((item) => item.kind === 'streaming')
    expect(persistedIndex).toBeGreaterThanOrEqual(0)
    expect(streamingIndex).toBeGreaterThan(persistedIndex)
  })
})
