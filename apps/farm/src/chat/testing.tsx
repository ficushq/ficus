/**
 * Test harness for chat components: a recording fake FicusClient (the parts the
 * conversation engine and chat views call), a render helper and waitFor, in
 * the house style of packages/client-react/src/test-utils.tsx.
 */
import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query'
import type { AgentStreamCallbacks, RequestOptions, FicusClient, Transport } from '@ficus/client-core'
import type { ChatSSECallbacks, SendChatParams } from '@ficus/client-core'
import type { Agent, Message } from '@ficus/shared'
import { ChatProvider } from './ChatProvider'
import type { AgentEventHub } from './agentEvents'

// Route React Query notifications through act(), as client-react's test setup does.
notifyManager.setNotifyFunction(act)

// The farm's preload exposes only window/document/navigator; chat code also
// touches these DOM globals, so borrow them from the happy-dom window.
{
  const g = globalThis as unknown as Record<string, unknown>
  const win = g.window as Record<string, unknown>
  for (const name of ['HTMLElement', 'Element', 'Node', 'localStorage', 'getComputedStyle', 'MutationObserver']) {
    if (g[name] === undefined && win[name] !== undefined) g[name] = win[name]
  }
}

export { act }

export function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-1',
    agentTypeId: 'manager',
    squadId: 'squad-1',
    parentAgentId: null,
    status: 'idle',
    persist: true,
    modelOverride: null,
    metadata: { name: 'Farmer' },
    context: {},
    questionData: null,
    sessionUsage: null,
    dormantAt: null,
    terminatedAt: null,
    lastMessageAt: null,
    lastHumanMessageAt: null,
    lastMessagePreview: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    amtpHandle: null,
    identityPublicKey: null,
    inboundOpen: false,
    ...overrides,
  }
}

export function makeMessage(overrides: Partial<Message> & Pick<Message, 'id' | 'role' | 'content'>): Message {
  return {
    agentId: 'agent-1',
    metadata: null,
    pending: false,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  }
}

export interface Request {
  path: string
  options?: RequestOptions
}

export interface FakeClientOptions {
  agents?: Record<string, Agent>
  messages?: Record<string, Message[]>
  activeExecution?: { active: boolean; status?: string; executionId?: string }
  permissions?: string[]
  /** Transport responses for raw requests (assistant routes), by "METHOD path". */
  routes?: Record<string, unknown>
}

export function makeFakeClient(opts: FakeClientOptions = {}) {
  const agents = { ...(opts.agents ?? {}) }
  let activeExecution = opts.activeExecution ?? { active: false }
  const sent: Array<{ agentId: string; content: string; deliveryMode?: string; clientId?: string }> = []
  const chatSent: SendChatParams[] = []
  const stopped: string[] = []
  const cleared: string[] = []
  const requests: Request[] = []
  let chatCallbacks: ChatSSECallbacks | null = null
  const streams = new Map<string, AgentStreamCallbacks>()

  const transport: Transport = {
    request: async <T,>(path: string, options?: RequestOptions): Promise<T> => {
      requests.push({ path, options })
      const key = `${(options?.method ?? 'GET').toUpperCase()} ${path.split('?')[0]}`
      if (!(key in (opts.routes ?? {}))) throw new Error(`unexpected request ${key}`)
      return opts.routes![key] as T
    },
    openStream: async () => {
      throw new Error('not used')
    },
    wsUrl: (path) => `ws://test${path}`,
    url: (path) => `http://test/api${path}`,
  }

  const client = {
    transport,
    auth: {
      getCurrentUser: async () => ({ id: 'user-1', email: 'me@example.com' }),
      getMyPermissions: async () => ({ permissions: opts.permissions ?? ['*'], identity: { type: 'user' } }),
    },
    agents: {
      getAgent: async (id: string) => {
        const agent = agents[id]
        if (!agent) throw new Error(`no agent ${id}`)
        return agent
      },
      getActiveExecution: async () => activeExecution,
      getExecution: async (agentId: string, executionId: string) => ({
        agentId,
        executionId,
        status: activeExecution.status ?? 'completed',
        executionVersion: 1,
        active: activeExecution.active,
      }),
      getMessages: async (agentId: string) => {
        const messages = opts.messages?.[agentId] ?? []
        return { messages, pagination: { hasMore: false, totalCount: messages.length } }
      },
      getMessage: async (agentId: string, messageId: string) => {
        const message = opts.messages?.[agentId]?.find((m) => m.id === messageId)
        if (!message) throw new Error(`no message ${messageId}`)
        return message
      },
      subscribeToAgentStream: (agentId: string, callbacks: AgentStreamCallbacks) => {
        streams.set(agentId, callbacks)
        return () => {
          if (streams.get(agentId) === callbacks) streams.delete(agentId)
        }
      },
      sendMessage: async (agentId: string, content: string, options?: { deliveryMode?: string; clientId?: string }) => {
        sent.push({ agentId, content, deliveryMode: options?.deliveryMode, clientId: options?.clientId })
        return { success: true, status: activeExecution.active ? 'running' : 'queued' }
      },
      stopAgent: async (agentId: string) => {
        stopped.push(agentId)
        return { success: true }
      },
      clearQueue: async (agentId: string) => {
        cleared.push(agentId)
        return { success: true }
      },
      abortTool: async () => ({ success: true }),
    },
    chat: {
      sendChatMessage: async (params: SendChatParams, callbacks: ChatSSECallbacks) => {
        chatSent.push(params)
        chatCallbacks = callbacks
      },
    },
  } as unknown as FicusClient

  return {
    client,
    sent,
    chatSent,
    stopped,
    cleared,
    requests,
    setAgent: (agent: Agent) => {
      agents[agent.id] = agent
    },
    setActiveExecution: (next: { active: boolean; status?: string; executionId?: string }) => {
      activeExecution = next
    },
    chat: () => chatCallbacks,
    stream: (agentId: string) => streams.get(agentId),
  }
}

/** A hub that never opens a socket. */
export const silentHub: AgentEventHub = { subscribe: () => () => {}, dispose: () => {} }

export function createTestQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } })
}

export async function render(
  ui: ReactNode,
  { client, queryClient = createTestQueryClient() }: { client: FicusClient; queryClient?: QueryClient }
) {
  const doc = (globalThis as unknown as { document: Document }).document
  const container = doc.createElement('div')
  doc.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <ChatProvider client={client} hub={silentHub}>
          {ui}
        </ChatProvider>
      </QueryClientProvider>
    )
    await Promise.resolve()
  })
  await act(async () => {
    await Promise.resolve()
  })
  return {
    container,
    queryClient,
    unmount: () => {
      act(() => root.unmount())
      container.remove()
    },
  }
}

export async function waitFor(check: () => void, { timeout = 1500, interval = 10 } = {}): Promise<void> {
  const start = Date.now()
  let lastError: unknown
  while (Date.now() - start <= timeout) {
    try {
      check()
      return
    } catch (error) {
      lastError = error
      await act(async () => {
        await new Promise((r) => setTimeout(r, interval))
      })
    }
  }
  throw lastError
}

/** Set a textarea/input value the way React's onChange sees it. */
export function typeInto(el: HTMLTextAreaElement | HTMLInputElement, value: string) {
  const proto = Object.getPrototypeOf(el) as object
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  act(() => {
    setter?.call(el, value)
    el.dispatchEvent(
      new (el.ownerDocument.defaultView as unknown as typeof globalThis).Event('input', { bubbles: true })
    )
  })
}

/** Click, then let the async work it starts (sends, clears) settle inside act(). */
export async function click(el: Element | null | undefined) {
  if (!el) throw new Error('nothing to click')
  await act(async () => {
    ;(el as HTMLElement).click()
    await new Promise((r) => setTimeout(r, 0))
  })
}

export async function keyDown(el: Element, init: KeyboardEventInit) {
  const View = el.ownerDocument.defaultView as unknown as typeof globalThis
  await act(async () => {
    el.dispatchEvent(new View.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))
    await new Promise((r) => setTimeout(r, 0))
  })
}

export function byText<T extends Element = HTMLElement>(root: ParentNode, selector: string, text: string | RegExp): T {
  const match = [...root.querySelectorAll<T>(selector)].find((el) =>
    typeof text === 'string' ? el.textContent?.trim() === text : text.test(el.textContent ?? '')
  )
  if (!match) throw new Error(`no ${selector} with text ${String(text)}`)
  return match
}
