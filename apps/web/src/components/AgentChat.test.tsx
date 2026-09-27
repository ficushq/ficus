/**
 * AgentChat integration tests (happy-dom + bun:test).
 *
 * React 19 does not fire synthetic onChange/onKeyDown for programmatically
 * dispatched DOM events (isTrusted=false) in happy-dom. To test the send and
 * create-flow behaviours without going through the full ChatView form submission,
 * we capture ChatView's onSend prop via a mock and call it directly.
 *
 * This correctly verifies that AgentChat wires conv.sendAccepted → ChatView.onSend and
 * that the onAgentCreated useEffect fires when conv.agentId resolves — the two
 * responsibilities that are unique to AgentChat vs. the underlying hook or ChatView.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ChatApiProvider } from '../api/ChatApiProvider'
import { queryKeys } from '../queryKeys'
import type { FicusClient } from '@ficus/client-core'
import { ConversationClientProvider } from '@ficus/client-react'
import type { RenderItem } from '@ficus/client-react'
import { acquireDomHarness } from '../test/domHarness'

// ---------------------------------------------------------------------------
// Capture hook: intercepts ChatView props so the test can inspect and call them.
// ---------------------------------------------------------------------------

let _capturedOnSend: ((message: string, imageIds?: string[]) => void | Promise<void>) | null = null
let _capturedItems: RenderItem[] = []
let _capturedAfterMessages: React.ReactNode = null
let _capturedBeforeComposer: React.ReactNode = null
let _capturedHideComposer: boolean = false
let _capturedDeliveryMode: string | null = null
let _capturedOnDeliveryModeChange: ((m: string) => void) | null = null
let _capturedSendLabel: string | undefined = undefined
let _capturedOnStop: (() => void) | undefined
let _capturedOnCancelQueue: (() => void) | undefined

// ---------------------------------------------------------------------------
// Module mocks — must be declared before any lazy imports
// ---------------------------------------------------------------------------

// Mock ChatView: renders its items as testable markup AND captures the onSend callback.
const TestChatView = ({
  items,
  onSend,
  hideComposer,
  afterMessages,
  beforeComposer,
  deliveryMode,
  onDeliveryModeChange,
  sendLabel,
  onStop,
  onCancelQueue,
}: {
  items: RenderItem[]
  onSend: (message: string, imageIds?: string[]) => void | Promise<void>
  hideComposer?: boolean
  afterMessages?: React.ReactNode
  beforeComposer?: React.ReactNode
  deliveryMode?: string
  onDeliveryModeChange?: (m: string) => void
  sendLabel?: string
  onStop?: () => void
  onCancelQueue?: () => void
  [key: string]: unknown
}) => {
  _capturedOnSend = onSend
  _capturedItems = items
  _capturedAfterMessages = afterMessages ?? null
  _capturedBeforeComposer = beforeComposer ?? null
  _capturedHideComposer = hideComposer ?? false
  _capturedDeliveryMode = deliveryMode ?? null
  _capturedOnDeliveryModeChange = onDeliveryModeChange ?? null
  _capturedSendLabel = sendLabel
  _capturedOnStop = onStop
  _capturedOnCancelQueue = onCancelQueue
  return (
    <div
      data-testid="chat-view"
      data-hide-composer={String(hideComposer ?? false)}
      data-delivery-mode={deliveryMode ?? ''}
      data-send-label={sendLabel ?? ''}
    >
      {items.map((item) => (
        <div key={item.id} data-kind={item.kind} data-item-id={item.id}>
          {item.kind === 'streaming'
            ? item.blocks.map((b) => ('content' in b ? b.content : '')).join('')
            : item.kind === 'pending'
              ? item.content
              : 'kind' in item && item.kind === 'persisted'
                ? item.message.content
                : ''}
        </div>
      ))}
      <div data-testid="after-messages">{afterMessages}</div>
      <div data-testid="before-composer">{beforeComposer}</div>
    </div>
  )
}

// Per-render API fixtures
const _agentStore: Record<
  string,
  { id: string; terminatedAt: Date | null; status: string; squadId?: string | null; questionData?: unknown }
> = {}
let _openQuestions: unknown[] = []
let _agentQuestionFetchCount = 0

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type StreamCb = Parameters<FicusClient['agents']['subscribeToAgentStream']>[1]
type ChatCb = Parameters<FicusClient['chat']['sendChatMessage']>[1]

// ---------------------------------------------------------------------------
// Mock client
// ---------------------------------------------------------------------------

function makeMockClient() {
  let streamCb: StreamCb | null = null
  let chatCb: ChatCb | null = null
  const sent: Array<{ content: string; clientId?: string; imageIds?: string[] }> = []
  const chatSent: Array<{ message: string; scope?: unknown; clientId?: string }> = []

  const client = {
    agents: {
      getMessages: async (_id: string) => ({ messages: [], pagination: { hasMore: false, totalCount: 0 } }),
      subscribeToAgentStream: (_id: string, cb: StreamCb) => {
        streamCb = cb
        return () => {}
      },
      sendMessage: async (_id: string, content: string, opts?: { clientId?: string; imageIds?: string[] }) => {
        sent.push({ content, clientId: opts?.clientId, imageIds: opts?.imageIds })
        return { success: true, status: 'queued' }
      },
      clearQueue: async () => ({ success: true }),
      stopAgent: async () => ({ success: true }),
      getActiveExecution: async () => ({ active: false }),
      abortTool: async () => ({ success: true }),
    },
    chat: {
      sendChatMessage: async (params: { message: string; scope?: unknown; clientId?: string }, cb: ChatCb) => {
        chatSent.push({ message: params.message, scope: params.scope, clientId: params.clientId })
        chatCb = cb
      },
    },
  } as unknown as FicusClient

  return {
    client,
    sent,
    chatSent,
    emit: (...args: Parameters<NonNullable<StreamCb>['onEvent']>) => streamCb?.onEvent(...args),
    catchup: (events: import('@ficus/shared').StreamEvent[]) => streamCb?.onCatchup?.(events),
    emitChat: (event: import('@ficus/shared').StreamEvent) => chatCb?.onEvent(event),
  }
}

// ---------------------------------------------------------------------------
// DOM setup
// ---------------------------------------------------------------------------

let activeDom: Awaited<ReturnType<typeof acquireDomHarness>> | undefined

async function installDom() {
  return (activeDom = await acquireDomHarness({
    url: 'http://localhost/',
    configureWindow(window) {
      window.requestAnimationFrame = (callback: FrameRequestCallback) => window.setTimeout(callback, 0)
      window.cancelAnimationFrame = (id: number) => window.clearTimeout(id)
      window.ResizeObserver = class ResizeObserver {
        observe() {}
        disconnect() {}
      }
    },
  }))
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

const queryClients = new Set<QueryClient>()

function makeProviders(client: FicusClient) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClients.add(qc)
  function Providers({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={qc}>
        <ChatApiProvider
          overrides={{
            getAgent: async (id) =>
              ({ ...(_agentStore[id] ?? { id, terminatedAt: null, status: 'running', questionData: null }) }) as never,
            getAgentQuestions: async () => {
              _agentQuestionFetchCount += 1
              return _openQuestions as never
            },
          }}
        >
          <ConversationClientProvider client={client}>{children}</ConversationClientProvider>
        </ChatApiProvider>
      </QueryClientProvider>
    )
  }
  return { Providers, qc }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function flush(ms = 30) {
  await activeDom!.act(async () => {
    await new Promise((r) => setTimeout(r, ms))
  })
}

async function waitFor(
  check: () => void,
  { timeout = 2000, interval = 20 }: { timeout?: number; interval?: number } = {}
): Promise<void> {
  const start = Date.now()
  let lastErr: unknown
  while (Date.now() - start <= timeout) {
    try {
      check()
      return
    } catch (err) {
      lastErr = err
      await activeDom!.act(async () => {
        await new Promise((r) => setTimeout(r, interval))
      })
    }
  }
  throw lastErr
}

// ---------------------------------------------------------------------------
// Lazy import (after all mocks are established)
// ---------------------------------------------------------------------------

const { AgentChat } = await import('./AgentChat')

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

afterEach(async () => {
  for (const queryClient of queryClients) {
    await queryClient.cancelQueries()
    queryClient.clear()
  }
  queryClients.clear()
  await activeDom?.cleanup()
  activeDom = undefined
})

describe('AgentChat', () => {
  test('existing-agent: renders history items and streams', async () => {
    _capturedOnSend = null
    _capturedItems = []
    const dom = await installDom()
    const { window } = dom
    const mc = makeMockClient()
    const { Providers } = makeProviders(mc.client)

    const { root } = dom.createRoot()

    await dom.act(async () => {
      root.render(
        <Providers>
          <AgentChat dependencies={{ ChatViewComponent: TestChatView }} agentId="a1" />
        </Providers>
      )
    })
    await flush()

    // Emit a streaming event
    await dom.act(async () => {
      mc.emit({ type: 'agent', agentId: 'a1' })
      mc.emit({ type: 'text', text: 'Hello from agent', streamGroupId: 'S' })
    })
    await flush()

    // The streaming item should be in ChatView's items prop
    await waitFor(() => {
      expect(_capturedItems.some((i) => i.kind === 'streaming')).toBe(true)
    })

    // The mocked ChatView renders the block content
    expect(window.document.body.innerHTML).toContain('Hello from agent')
  })

  test('send shows optimistic pending item', async () => {
    _capturedOnSend = null
    _capturedItems = []
    const dom = await installDom()
    const { window } = dom
    const mc = makeMockClient()
    const { Providers } = makeProviders(mc.client)

    const { root } = dom.createRoot()

    await dom.act(async () => {
      root.render(
        <Providers>
          <AgentChat dependencies={{ ChatViewComponent: TestChatView }} agentId="a1" />
        </Providers>
      )
    })
    await flush()

    // Verify onSend was captured and call it directly (simulates what ChatView does when the user submits)
    expect(_capturedOnSend).not.toBeNull()

    await dom.act(async () => {
      _capturedOnSend!('test message')
    })
    await flush()

    // conv.sendAccepted was called → pending item added → appears in items
    await waitFor(() => {
      expect(_capturedItems.some((i) => i.kind === 'pending')).toBe(true)
    })
    // And the api was called
    await waitFor(() => {
      expect(mc.sent.length).toBeGreaterThan(0)
    })
    expect(mc.sent[0].content).toBe('test message')
  })

  test('awaits successful transport acceptance with image IDs', async () => {
    _capturedOnSend = null
    const dom = await installDom()
    const mc = makeMockClient()
    const { Providers } = makeProviders(mc.client)
    const { root } = dom.createRoot()

    await dom.act(async () => {
      root.render(
        <Providers>
          <AgentChat dependencies={{ ChatViewComponent: TestChatView }} agentId="a1" />
        </Providers>
      )
    })
    await flush()

    await dom.act(async () => {
      await expect(_capturedOnSend!('with image', ['image-1'])).resolves.toBeUndefined()
    })
    expect(mc.sent).toContainEqual(expect.objectContaining({ content: 'with image', imageIds: ['image-1'] }))
  })

  test('rejects the composer callback when the transport rejects an attachment', async () => {
    _capturedOnSend = null
    const dom = await installDom()
    const mc = makeMockClient()
    mc.client.agents.sendMessage = async () => {
      throw new Error('Invalid attachment')
    }
    const { Providers } = makeProviders(mc.client)
    const { root } = dom.createRoot()

    await dom.act(async () => {
      root.render(
        <Providers>
          <AgentChat dependencies={{ ChatViewComponent: TestChatView }} agentId="a1" />
        </Providers>
      )
    })
    await flush()

    await dom.act(async () => {
      await expect(_capturedOnSend!('with image', ['image-1'])).rejects.toThrow('Invalid attachment')
    })
  })

  test('create flow fires onAgentCreated when the agent resolves', async () => {
    _capturedOnSend = null
    _capturedItems = []
    const dom = await installDom()
    const { window } = dom
    const mc = makeMockClient()
    const { Providers } = makeProviders(mc.client)
    const onCreated = mock(() => {})

    const { root } = dom.createRoot()

    await dom.act(async () => {
      root.render(
        <Providers>
          <AgentChat
            dependencies={{ ChatViewComponent: TestChatView }}
            scope={{ type: 'system-manager' }}
            onAgentCreated={onCreated}
          />
        </Providers>
      )
    })
    await flush()

    // Call onSend directly (create-flow path: no agentId → chat.sendChatMessage)
    expect(_capturedOnSend).not.toBeNull()
    await dom.act(async () => {
      _capturedOnSend!('hello')
    })
    await flush()

    // chat.sendChatMessage was called; chatCb is now stored in mc
    expect(mc.chatSent.length).toBeGreaterThan(0)
    expect(mc.chatSent[0].message).toBe('hello')

    // Emit the agent event via chat stream
    await dom.act(async () => {
      mc.emitChat({ type: 'agent', agentId: 'created-1' })
    })
    await flush()

    // The useEffect in AgentChat fires: conv.agentId ('created-1') !== agentId (undefined) → onAgentCreated
    await waitFor(() => {
      expect(onCreated).toHaveBeenCalledWith('created-1')
    })
  })

  // Regression: the consultant composer keeps agentId undefined and passes an inline onAgentCreated,
  // so its identity changes every render. AgentChat must notify ONCE per created agent — re-firing on
  // callback-identity churn re-ran setSearchParams in a loop ("Too many calls to Location or History APIs").
  test('create flow notifies once per agent despite onAgentCreated identity churn', async () => {
    _capturedOnSend = null
    _capturedItems = []
    const dom = await installDom()
    const { window } = dom
    const mc = makeMockClient()
    const { Providers } = makeProviders(mc.client)

    let calls = 0
    // Fresh callback identity on every render, exactly like an inline arrow prop.
    const makeApp = () => (
      <Providers>
        <AgentChat
          dependencies={{ ChatViewComponent: TestChatView }}
          scope={{ type: 'system-manager' }}
          onAgentCreated={() => {
            calls += 1
          }}
        />
      </Providers>
    )

    const { root } = dom.createRoot()

    await dom.act(async () => {
      root.render(makeApp())
    })
    await flush()

    await dom.act(async () => {
      _capturedOnSend!('hello')
    })
    await flush()

    await dom.act(async () => {
      mc.emitChat({ type: 'agent', agentId: 'created-1' })
    })
    await flush()

    // Force several re-renders with a brand-new onAgentCreated identity each time.
    for (let i = 0; i < 3; i++) {
      await dom.act(async () => {
        root.render(makeApp())
      })
      await flush()
    }

    expect(calls).toBe(1)
  })

  test('terminated agent hides composer', async () => {
    _capturedOnSend = null
    _capturedItems = []
    _agentStore['term-1'] = { id: 'term-1', terminatedAt: null, status: 'terminated' }
    try {
      const dom = await installDom()
      const { window } = dom
      const mc = makeMockClient()
      const { Providers } = makeProviders(mc.client)
      const { root } = dom.createRoot()

      await dom.act(async () => {
        root.render(
          <Providers>
            <AgentChat dependencies={{ ChatViewComponent: TestChatView }} agentId="term-1" />
          </Providers>
        )
      })

      // Wait for the agent detail query to resolve and set isTerminated=true
      // The mocked ChatView reflects hideComposer via data-hide-composer attribute
      await waitFor(
        () => {
          const chatView = window.document.querySelector('[data-testid="chat-view"]')
          expect(chatView?.getAttribute('data-hide-composer')).toBe('true')
        },
        { timeout: 3000 }
      )
    } finally {
      delete _agentStore['term-1']
    }
  })

  test('dormant agent keeps the composer and explains that sending wakes it', async () => {
    _capturedOnSend = null
    _capturedItems = []
    _agentStore['dormant-1'] = {
      id: 'dormant-1',
      terminatedAt: new Date('2025-01-01'),
      status: 'dormant',
    }
    try {
      const dom = await installDom()
      const { window } = dom
      const mc = makeMockClient()
      const { Providers } = makeProviders(mc.client)
      const { root } = dom.createRoot()

      await dom.act(async () => {
        root.render(
          <Providers>
            <AgentChat dependencies={{ ChatViewComponent: TestChatView }} agentId="dormant-1" />
          </Providers>
        )
      })

      await waitFor(() => {
        expect(window.document.querySelector('[data-testid="chat-view"]')?.getAttribute('data-hide-composer')).toBe(
          'false'
        )
        expect(window.document.querySelector('[data-testid="after-messages"]')?.textContent).toContain(
          'Sending a message will wake it'
        )
      })
    } finally {
      delete _agentStore['dormant-1']
    }
  })

  test('waiting-input agent: hides composer and renders question form in afterMessages', async () => {
    _capturedOnSend = null
    _capturedItems = []
    _agentStore['wi-1'] = {
      id: 'wi-1',
      terminatedAt: null,
      status: 'waiting-input',
      questionData: {
        questions: [{ id: 'q1', question: 'What is your name?', type: 'text' }],
      },
    }
    try {
      const dom = await installDom()
      const { window } = dom
      const mc = makeMockClient()
      const { Providers } = makeProviders(mc.client)
      const { root } = dom.createRoot()

      await dom.act(async () => {
        root.render(
          <Providers>
            <AgentChat dependencies={{ ChatViewComponent: TestChatView }} agentId="wi-1" />
          </Providers>
        )
      })

      // Wait for agent data to load; composer should be hidden
      await waitFor(
        () => {
          const chatView = window.document.querySelector('[data-testid="chat-view"]')
          expect(chatView?.getAttribute('data-hide-composer')).toBe('true')
        },
        { timeout: 3000 }
      )

      // afterMessages should contain the question form text (question label is rendered)
      await waitFor(
        () => {
          const after = window.document.querySelector('[data-testid="after-messages"]')
          expect(after?.textContent).toContain('What is your name?')
        },
        { timeout: 3000 }
      )
    } finally {
      delete _agentStore['wi-1']
    }
  })

  test('waiting-input: submitting question calls conv.send', async () => {
    _capturedOnSend = null
    _capturedItems = []
    _agentStore['wi-2'] = {
      id: 'wi-2',
      terminatedAt: null,
      status: 'waiting-input',
      questionData: {
        questions: [{ id: 'q1', question: 'Confirm?', type: 'text' }],
      },
    }
    try {
      const dom = await installDom()
      const { window } = dom
      const mc = makeMockClient()
      const { Providers } = makeProviders(mc.client)
      const { root } = dom.createRoot()

      await dom.act(async () => {
        root.render(
          <Providers>
            <AgentChat dependencies={{ ChatViewComponent: TestChatView }} agentId="wi-2" />
          </Providers>
        )
      })

      // Wait for the question form to appear
      await waitFor(
        () => {
          const after = window.document.querySelector('[data-testid="after-messages"]')
          expect(after?.textContent).toContain('Confirm?')
        },
        { timeout: 3000 }
      )

      // The QuestionInput's onSubmit is wired to conv.send.
      // We verify this by calling _capturedOnSend with a message — the question form
      // calls onSubmit which internally calls conv.send, but since happy-dom won't fire form events,
      // we test the wiring by ensuring AgentChat provides a functional onSend that goes through conv.send
      // when isReview is false.
      expect(_capturedOnSend).not.toBeNull()
      await dom.act(async () => {
        _capturedOnSend!('my answer')
      })
      await flush()

      // conv.send sends → mc.sent has the message
      await waitFor(() => {
        expect(mc.sent.length).toBeGreaterThan(0)
      })
      expect(mc.sent[0].content).toBe('my answer')
    } finally {
      delete _agentStore['wi-2']
    }
  })

  test('isReview: composer send routes to onReviewFeedback, not conv.send', async () => {
    _capturedOnSend = null
    _capturedItems = []
    const dom = await installDom()
    const { window } = dom
    const mc = makeMockClient()
    const { Providers } = makeProviders(mc.client)
    const onReviewFeedback = mock(async (_msg: string) => {})

    const { root } = dom.createRoot()

    await dom.act(async () => {
      root.render(
        <Providers>
          <AgentChat
            dependencies={{ ChatViewComponent: TestChatView }}
            agentId="a1"
            isReview
            onReviewFeedback={onReviewFeedback}
          />
        </Providers>
      )
    })
    await flush()

    expect(_capturedOnSend).not.toBeNull()
    await dom.act(async () => {
      _capturedOnSend!('please revise')
    })
    await flush()

    // onReviewFeedback was called, NOT conv.send
    await waitFor(() => {
      expect(onReviewFeedback).toHaveBeenCalledWith('please revise')
    })
    // conv.send was NOT called
    expect(mc.sent.length).toBe(0)
  })

  test('open async question renders a composer banner without an inline chat card', async () => {
    _capturedOnSend = null
    _capturedItems = []
    // Populate the open questions mock
    ;(_openQuestions as unknown[]).length = 0
    ;(_openQuestions as unknown[]).push({
      id: 'q-async-1',
      agentId: 'a1',
      status: 'open',
      answer: null,
      createdAt: new Date(),
      questionData: {
        questions: [{ id: 'qa1', question: 'Pick a color?', type: 'text' }],
      },
    })
    try {
      const dom = await installDom()
      const { window } = dom
      const mc = makeMockClient()
      const { Providers, qc } = makeProviders(mc.client)
      const { root } = dom.createRoot()

      await dom.act(async () => {
        root.render(
          <Providers>
            <AgentChat dependencies={{ ChatViewComponent: TestChatView }} agentId="a1" />
          </Providers>
        )
      })

      await waitFor(
        () => {
          const banner = window.document.querySelector('[data-testid="before-composer"]')
          expect(banner?.textContent).toContain('1 pending question from Agent')
        },
        { timeout: 3000 }
      )

      const after = window.document.querySelector('[data-testid="after-messages"]')
      expect(after?.textContent).not.toContain('Pick a color?')
      expect(window.document.body.textContent).not.toContain('Pick a color?')

      const bannerButton = window.document.querySelector('[data-testid="before-composer"] button')
      await dom.act(async () => {
        bannerButton?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      })
      expect(window.document.querySelector('[role="dialog"]')?.textContent).toContain('Pick a color?')

      // An answered event from another user invalidates this query; the refetch removes the banner and modal live.
      _openQuestions = []
      await dom.act(async () => {
        await qc.invalidateQueries({ queryKey: queryKeys.agentQuestions.all })
      })
      await waitFor(() => {
        expect(window.document.querySelector('[data-testid="before-composer"]')?.textContent).toBe('')
        expect(window.document.querySelector('[role="dialog"]')).toBeNull()
      })
    } finally {
      ;(_openQuestions as unknown[]).length = 0
    }
  })

  test('squad-less agent questions use the scoped fallback to become live without an event', async () => {
    _agentStore['personal-agent'] = {
      id: 'personal-agent',
      terminatedAt: null,
      status: 'running',
      squadId: null,
    }
    _openQuestions = []
    _agentQuestionFetchCount = 0
    try {
      const dom = await installDom()
      const { window } = dom
      const mc = makeMockClient()
      const { Providers } = makeProviders(mc.client)
      const { root } = dom.createRoot()

      await dom.act(async () => {
        root.render(
          <Providers>
            <AgentChat
              dependencies={{ ChatViewComponent: TestChatView, pendingQuestionsFallbackIntervalMs: 20 }}
              agentId="personal-agent"
            />
          </Providers>
        )
      })
      await waitFor(() => expect(_agentQuestionFetchCount).toBeGreaterThan(0))
      _openQuestions = [
        {
          id: 'personal-question',
          agentId: 'personal-agent',
          status: 'open',
          questionData: { questions: [{ id: 'item-1', question: 'Personal question?', type: 'text' }] },
        },
      ]
      await waitFor(
        () =>
          expect(window.document.querySelector('[data-testid="before-composer"]')?.textContent).toContain(
            '1 pending question'
          ),
        { timeout: 1000 }
      )
      expect(_agentQuestionFetchCount).toBeGreaterThan(1)
    } finally {
      delete _agentStore['personal-agent']
      _openQuestions = []
    }
  })

  test('squad agents do not use the squad-less fallback poll', async () => {
    _agentStore['squad-agent'] = {
      id: 'squad-agent',
      terminatedAt: null,
      status: 'running',
      squadId: 'squad-1',
    }
    _openQuestions = []
    _agentQuestionFetchCount = 0
    try {
      const dom = await installDom()
      const { window } = dom
      const mc = makeMockClient()
      const { Providers } = makeProviders(mc.client)
      const { root } = dom.createRoot()

      await dom.act(async () => {
        root.render(
          <Providers>
            <AgentChat
              dependencies={{ ChatViewComponent: TestChatView, pendingQuestionsFallbackIntervalMs: 20 }}
              agentId="squad-agent"
            />
          </Providers>
        )
      })
      await waitFor(() => expect(_agentQuestionFetchCount).toBe(1))
      await flush(80)
      expect(_agentQuestionFetchCount).toBe(1)
    } finally {
      delete _agentStore['squad-agent']
      _openQuestions = []
    }
  })

  test('deliveryMode defaults to steer and is forwarded to ChatView', async () => {
    _capturedDeliveryMode = null
    _capturedOnDeliveryModeChange = null
    const dom = await installDom()
    const { window } = dom
    const mc = makeMockClient()
    const { Providers } = makeProviders(mc.client)

    const { root } = dom.createRoot()

    await dom.act(async () => {
      root.render(
        <Providers>
          <AgentChat dependencies={{ ChatViewComponent: TestChatView }} agentId="a1" />
        </Providers>
      )
    })
    await flush()

    // deliveryMode 'steer' is forwarded to ChatView
    expect(_capturedDeliveryMode).toBe('steer')
    // onDeliveryModeChange is also provided
    expect(_capturedOnDeliveryModeChange).not.toBeNull()

    // Toggling deliveryMode updates the captured value on next render
    await dom.act(async () => {
      _capturedOnDeliveryModeChange!('follow-up')
    })
    await flush()
    expect(_capturedDeliveryMode).toBe('follow-up')
  })

  test('waiting-input with inputDisabled: question form submit button is disabled', async () => {
    _capturedOnSend = null
    _capturedAfterMessages = null
    _agentStore['wi-rbac'] = {
      id: 'wi-rbac',
      terminatedAt: null,
      status: 'waiting-input',
      questionData: {
        questions: [{ id: 'q1', question: 'Confirm action?', type: 'text' }],
      },
    }
    try {
      const dom = await installDom()
      const { window } = dom
      const mc = makeMockClient()
      const { Providers } = makeProviders(mc.client)
      const { root } = dom.createRoot()

      await dom.act(async () => {
        root.render(
          <Providers>
            <AgentChat dependencies={{ ChatViewComponent: TestChatView }} agentId="wi-rbac" inputDisabled={true} />
          </Providers>
        )
      })

      // Wait for the question form to appear
      await waitFor(
        () => {
          const after = window.document.querySelector('[data-testid="after-messages"]')
          expect(after?.textContent).toContain('Confirm action?')
        },
        { timeout: 3000 }
      )

      // The Submit Answer button should be disabled when inputDisabled=true
      await waitFor(
        () => {
          const after = window.document.querySelector('[data-testid="after-messages"]')
          const buttons = after?.querySelectorAll('button')
          const submitBtn = Array.from(buttons ?? []).find((b) => b.textContent?.includes('Submit Answer'))
          expect(submitBtn).not.toBeUndefined()
          expect(submitBtn?.disabled).toBe(true)
        },
        { timeout: 3000 }
      )
    } finally {
      delete _agentStore['wi-rbac']
    }
  })

  test('inputDisabled=true: onStop and onCancelQueue passed to ChatView are undefined', async () => {
    const dom = await installDom()
    const { window } = dom
    const mc = makeMockClient()
    const { Providers } = makeProviders(mc.client)

    const { root } = dom.createRoot()

    // inputDisabled=true → onStop and onCancelQueue must be undefined
    await dom.act(async () => {
      root.render(
        <Providers>
          <AgentChat dependencies={{ ChatViewComponent: TestChatView }} agentId="a1" inputDisabled={true} />
        </Providers>
      )
    })
    await flush()

    expect(_capturedOnStop).toBeUndefined()
    expect(_capturedOnCancelQueue).toBeUndefined()

    // Now test inputDisabled=false → onStop and onCancelQueue must be functions
    const { root: root2 } = dom.createRoot()

    await dom.act(async () => {
      root2.render(
        <Providers>
          <AgentChat dependencies={{ ChatViewComponent: TestChatView }} agentId="a1" inputDisabled={false} />
        </Providers>
      )
    })
    await flush()

    expect(typeof _capturedOnStop).toBe('function')
    expect(typeof _capturedOnCancelQueue).toBe('function')
  })

  test('compactionState: renders compaction banner in afterMessages', async () => {
    _capturedAfterMessages = null
    const dom = await installDom()
    const { window } = dom
    const mc = makeMockClient()
    const { Providers } = makeProviders(mc.client)

    const { root } = dom.createRoot()

    await dom.act(async () => {
      root.render(
        <Providers>
          <AgentChat dependencies={{ ChatViewComponent: TestChatView }} agentId="a1" />
        </Providers>
      )
    })
    await flush()

    // Emit compaction_start so the hook sets compactionState
    await dom.act(async () => {
      mc.emit({ type: 'compaction_start', reason: 'auto' })
    })
    await flush()

    // afterMessages should contain the compaction banner text
    await waitFor(
      () => {
        const after = window.document.querySelector('[data-testid="after-messages"]')
        expect(after?.textContent).toContain('Compacting context')
        const banner = after?.querySelector('.border-status-attention-border')
        expect(banner?.className).toContain('bg-status-attention-surface')
        expect(banner?.className).toContain('text-status-attention-fg')
        expect(banner?.className).not.toContain('blue')
      },
      { timeout: 3000 }
    )
  })

  test('isReview: ChatView receives sendLabel="Send Feedback"', async () => {
    _capturedSendLabel = undefined
    const dom = await installDom()
    const { window } = dom
    const mc = makeMockClient()
    const { Providers } = makeProviders(mc.client)
    const onReviewFeedback = mock(async (_msg: string) => {})

    const { root } = dom.createRoot()

    await dom.act(async () => {
      root.render(
        <Providers>
          <AgentChat
            dependencies={{ ChatViewComponent: TestChatView }}
            agentId="a1"
            isReview
            onReviewFeedback={onReviewFeedback}
          />
        </Providers>
      )
    })
    await flush()

    expect(_capturedSendLabel).toBe('Send Feedback')
  })

  // Subagents are a separate tab owned by the page wrappers (ChatPage, SquadAgentThreads, …).
  // AgentChat must NOT render its own SubagentsInlinePanel: doing so put the subagent menu below
  // the composer, broke the chat's full height, and — because the panel renders AgentChat again —
  // recursed, with each nested instance fighting over the ?subagent URL param (History API loop).
  test('does not render an inline subagents panel', async () => {
    const dom = await installDom()
    const { window } = dom
    const mc = makeMockClient()
    const { Providers } = makeProviders(mc.client)

    const { root, container } = dom.createRoot()

    await dom.act(async () => {
      root.render(
        <Providers>
          <AgentChat dependencies={{ ChatViewComponent: TestChatView }} agentId="a1" />
        </Providers>
      )
    })
    await flush()

    expect(container.querySelector('[data-testid="subagents-panel"]')).toBeNull()
  })
})

describe('Assistant launcher sends', () => {
  test('starts a new conversation with its message exactly once across rerenders', async () => {
    const dom = await installDom()
    const mc = makeMockClient()
    const { Providers, qc } = makeProviders(mc.client)
    qc.setQueryData(queryKeys.system.pause(), { effective: false })
    const { root } = dom.createRoot()
    const render = (disabled = false) => (
      <Providers>
        <AgentChat
          dependencies={{ ChatViewComponent: TestChatView }}
          scope={{ type: 'system-manager' }}
          initialMessage={{ content: 'Summarize progress across my squads' }}
          inputDisabled={disabled}
        />
      </Providers>
    )
    await dom.act(async () => root.render(render(true)))
    expect(mc.chatSent).toHaveLength(0)
    await dom.act(async () => root.render(render()))
    await waitFor(() => expect(mc.chatSent).toHaveLength(1))
    expect(mc.chatSent[0]).toMatchObject({
      message: 'Summarize progress across my squads',
      scope: { type: 'system-manager' },
    })
    await dom.act(async () => root.render(render()))
    expect(mc.chatSent).toHaveLength(1)
    expect(
      _capturedItems.some((item) => item.kind === 'pending' && item.content === 'Summarize progress across my squads')
    ).toBe(true)
  })

  test('keeps a failed initial send visible for retry without silently resending it', async () => {
    const dom = await installDom()
    const mc = makeMockClient()
    const rejected = mock(async () => {
      throw new Error('Unavailable')
    })
    mc.client.chat.sendChatMessage = rejected
    const { Providers, qc } = makeProviders(mc.client)
    qc.setQueryData(queryKeys.system.pause(), { effective: false })
    const { root } = dom.createRoot()
    await dom.act(async () =>
      root.render(
        <Providers>
          <AgentChat
            dependencies={{ ChatViewComponent: TestChatView }}
            scope={{ type: 'system-manager' }}
            initialMessage={{ content: 'Keep this request' }}
          />
        </Providers>
      )
    )
    await waitFor(() =>
      expect(
        _capturedItems.some(
          (item) => item.kind === 'pending' && item.content === 'Keep this request' && item.status === 'failed'
        )
      ).toBe(true)
    )
    expect(rejected).toHaveBeenCalledTimes(1)
  })
})

test('an editor preparation failure keeps the initial prompt retryable without dispatching it', async () => {
  const dom = await installDom()
  const mc = makeMockClient()
  const { Providers, qc } = makeProviders(mc.client)
  qc.setQueryData(queryKeys.system.pause(), { effective: false })
  const { root, container } = dom.createRoot()
  const beforeSend = mock(async () => {})
  beforeSend.mockImplementationOnce(async () => {
    throw new Error('Draft changed; retry')
  })
  await dom.act(async () =>
    root.render(
      <Providers>
        <AgentChat
          dependencies={{ ChatViewComponent: TestChatView }}
          scope={{ type: 'system-manager' }}
          initialMessage={{ content: 'Edit this draft' }}
          beforeSend={beforeSend}
        />
      </Providers>
    )
  )
  expect(mc.chatSent).toHaveLength(0)
  expect(container.textContent).toContain('Draft changed; retry')
  const retry = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Retry sending')!
  await dom.act(async () => retry.click())
  await waitFor(() => expect(mc.chatSent).toHaveLength(1))
  expect(mc.chatSent[0]!.message).toBe('Edit this draft')
  expect(container.textContent).not.toContain('Draft changed; retry')
})

test('mounted web conversation preserves live response through repeated leading-flush catchup', async () => {
  const dom = await installDom()
  const mc = makeMockClient()
  mc.client.agents.getMessages = async () => ({
    messages: [
      {
        id: 'm',
        agentId: 'a1',
        role: 'assistant',
        content: 'Plan',
        pending: false,
        createdAt: new Date(),
        metadata: { streamGroupId: 'S', content: [{ type: 'thinking', id: 'p', content: 'Plan' }] },
      },
    ],
    pagination: { hasMore: false, totalCount: 1 },
  })
  mc.client.agents.getActiveExecution = async () => ({ active: true, status: 'running' })
  const { Providers } = makeProviders(mc.client)
  const snapshots: RenderItem[][] = []
  const CaptureView = (props: Parameters<typeof TestChatView>[0]) => {
    snapshots.push(props.items)
    return <TestChatView {...props} />
  }
  const { root } = dom.createRoot()
  await dom.act(async () =>
    root.render(
      <Providers>
        <AgentChat dependencies={{ ChatViewComponent: CaptureView }} agentId="a1" />
      </Providers>
    )
  )
  await flush()
  const events: import('@ficus/shared').StreamEvent[] = [
    { type: 'agent', agentId: 'a1', executionId: 'e' },
    { type: 'flush_agent' },
    { type: 'thinking', text: 'Plan', streamGroupId: 'S' },
    { type: 'thinking_end', durationMs: 1, streamGroupId: 'S' },
    { type: 'text', text: 'Visible response', streamGroupId: 'S' },
  ]
  await dom.act(async () => events.forEach(mc.emit))
  const start = snapshots.length - 1
  for (let i = 0; i < 2; i++) await dom.act(async () => mc.catchup(events))
  await dom.act(async () => mc.emit({ type: 'text', text: ' tail', streamGroupId: 'S' }))
  for (const items of snapshots.slice(start)) {
    expect(items.filter((item) => item.kind === 'working')).toHaveLength(1)
    const response = items.find((item) => item.kind === 'streaming')
    expect(
      response?.kind === 'streaming' &&
        response.blocks.some((block) => block.type === 'text' && block.content.startsWith('Visible response'))
    ).toBe(true)
  }
  expect(dom.window.document.body.textContent).toContain('Visible response tail')
})
