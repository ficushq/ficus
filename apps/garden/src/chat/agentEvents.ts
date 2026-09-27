import { queryKeys, type WsClient, type WsClientOptions } from '@ficus/client-core'
import type { AgentEventEntry } from '@ficus/client-react'
import type { QueryKey } from '@tanstack/react-query'

/**
 * Per-agent live events for open conversations.
 *
 * `useAgentConversation` wants `subscribeToAgentEvents(agentId, cb)` — the web
 * app feeds it from its app-wide WebSocketProvider's `agents:<id>` topics. The
 * garden's farm socket (src/live/LiveUpdates.tsx) only listens to collection
 * topics and exposes no per-topic subscription, so this hub owns a second,
 * lazily opened `/ws` connection that carries just the `agents:<id>` topics of
 * the chats currently on screen. The two sockets could be merged into one
 * topic-multiplexing connection later; they are independent for now so the
 * farm's live layer doesn't change underneath chat.
 *
 * Every connection needs a fresh single-use ticket, so reconnects are driven
 * here (client-core's own socket reconnect would replay a spent ticket).
 */
export type AgentEventListener = (entry: AgentEventEntry) => void

export interface AgentEventHub {
  subscribe(agentId: string, listener: AgentEventListener): () => void
  /** Close the socket and drop every listener. */
  dispose(): void
}

export interface Timers {
  set(fn: () => void, ms: number): unknown
  clear(handle: unknown): void
}

export interface AgentEventHubDeps {
  fetchTicket: () => Promise<{ ticket: string }>
  socketUrl: (ticket: string) => string
  /** Normally client-core's `createWsClient`. */
  connect: (options: WsClientOptions) => WsClient
  /** Delay before reconnect attempt `attempt` (0-based, reset on a successful open). */
  backoff?: (attempt: number) => number
  /** How long an unused socket stays open, so switching chats doesn't churn connections. */
  idleMs?: number
  timers?: Timers
}

const MAX_BACKOFF_MS = 30_000
const TOPIC_PREFIX = 'agents:'

export function defaultBackoff(attempt: number): number {
  return Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempt) * (0.8 + Math.random() * 0.4)
}

const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

interface SocketEvent {
  type: 'event'
  topic: string
  event: string
  data?: unknown
}

function isSocketEvent(value: unknown): value is SocketEvent {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return v.type === 'event' && typeof v.topic === 'string' && typeof v.event === 'string'
}

export function createAgentEventHub(deps: AgentEventHubDeps): AgentEventHub {
  const backoff = deps.backoff ?? defaultBackoff
  const idleMs = deps.idleMs ?? 10_000
  const timers = deps.timers ?? realTimers
  const listeners = new Map<string, Set<AgentEventListener>>()
  let socket: WsClient | null = null
  let connecting = false
  let attempt = 0
  let retry: unknown = null
  let idle: unknown = null
  let disposed = false

  const topics = () => [...listeners.keys()].map((id) => `${TOPIC_PREFIX}${id}`)
  const wanted = () => !disposed && listeners.size > 0

  const dispatch = (data: unknown) => {
    if (!isSocketEvent(data) || !data.topic.startsWith(TOPIC_PREFIX)) return
    const set = listeners.get(data.topic.slice(TOPIC_PREFIX.length))
    if (!set) return
    const entry: AgentEventEntry = { event: data.event, data: data.data }
    for (const listener of [...set]) {
      try {
        listener(entry)
      } catch (error) {
        console.error('[garden chat] agent event listener failed', error)
      }
    }
  }

  const reconnectLater = () => {
    if (!wanted() || retry !== null) return
    const delay = backoff(attempt)
    attempt += 1
    retry = timers.set(() => {
      retry = null
      void connect()
    }, delay)
  }

  const connect = async () => {
    if (!wanted() || socket || connecting) return
    connecting = true
    let ticket: string
    try {
      ticket = (await deps.fetchTicket()).ticket
    } catch {
      connecting = false
      reconnectLater()
      return
    }
    connecting = false
    if (!wanted() || socket) return
    // Topics added while the ticket was in flight are included here; later ones go through subscribe().
    const own: { current: WsClient | null } = { current: null }
    own.current = deps.connect({
      url: deps.socketUrl(ticket),
      topics: topics(),
      reconnect: false,
      onOpen: () => {
        attempt = 0
      },
      onMessage: dispatch,
      onClose: () => {
        if (socket !== own.current) return // closed on purpose
        socket = null
        reconnectLater()
      },
    })
    socket = own.current
  }

  const closeSocket = () => {
    const current = socket
    socket = null
    current?.close()
  }

  const clearIdle = () => {
    if (idle !== null) timers.clear(idle)
    idle = null
  }

  return {
    subscribe(agentId, listener) {
      if (disposed) return () => {}
      clearIdle()
      let set = listeners.get(agentId)
      if (!set) {
        set = new Set()
        listeners.set(agentId, set)
        socket?.subscribe(`${TOPIC_PREFIX}${agentId}`)
      }
      set.add(listener)
      if (!socket && !connecting && retry === null) void connect()

      let active = true
      return () => {
        if (!active) return
        active = false
        const current = listeners.get(agentId)
        if (!current) return
        current.delete(listener)
        if (current.size > 0) return
        listeners.delete(agentId)
        socket?.unsubscribe(`${TOPIC_PREFIX}${agentId}`)
        if (listeners.size === 0) {
          clearIdle()
          idle = timers.set(() => {
            idle = null
            if (listeners.size > 0) return
            if (retry !== null) timers.clear(retry)
            retry = null
            attempt = 0
            closeSocket()
          }, idleMs)
        }
      }
    },
    dispose() {
      disposed = true
      listeners.clear()
      clearIdle()
      if (retry !== null) timers.clear(retry)
      retry = null
      closeSocket()
    },
  }
}

const TERMINAL_EXECUTION_EVENTS = new Set(['execution.completed', 'execution.failed', 'execution.stopped'])

/**
 * Queries of an OPEN conversation that an `agents:<id>` event makes stale, beyond
 * what the farm's live layer already refreshes (agent detail and lists). Mirrors
 * the web QueryInvalidator's conversation-relevant branches: execution frames
 * refresh the active-execution backstop the hook relies on, and terminal ones /
 * a cleared queue reconcile the message history.
 */
export function conversationKeysForAgentEvent(agentId: string, event: string): QueryKey[] {
  if (event === 'agent.queue-cleared') return [queryKeys.agents.messagesInfinite(agentId)]
  if (!event.startsWith('execution.')) return []
  const keys: QueryKey[] = [queryKeys.agents.activeExecution(agentId)]
  if (TERMINAL_EXECUTION_EVENTS.has(event)) keys.push(queryKeys.agents.messagesInfinite(agentId))
  return keys
}
