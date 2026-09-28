/**
 * Minimal reconnecting WebSocket client shared across hosts.
 *
 * Both browsers and React Native expose a global `WebSocket`, so the connection +
 * topic-subscription + reconnect logic is portable. Auth differs only in the URL
 * (built via Transport.wsUrl — `?ticket=` on web, `?token=` on mobile), so this
 * client takes a fully-formed URL and stays auth-agnostic.
 */
export interface WsClientOptions {
  url: string
  /** Topics to (re)subscribe on every (re)connect. */
  topics?: string[]
  onMessage: (data: unknown) => void
  onOpen?: () => void
  onClose?: (info: { code: number; reason: string }) => void
  onError?: (error: unknown) => void
  /** Auto-reconnect with exponential backoff (default true). */
  reconnect?: boolean
  reconnectDelayMs?: number
  maxReconnectDelayMs?: number
}

export interface WsClient {
  subscribe(topic: string): void
  unsubscribe(topic: string): void
  /**
   * Sends a message now, if connected (nothing is queued; returns whether it
   * went). State the server should keep across reconnects, like farm presence,
   * is re-sent from `onOpen`. Optional so existing hand-written clients (fakes,
   * vendored copies) still satisfy the interface; `createWsClient` always has it.
   */
  send?(message: object): boolean
  /** Permanently close (disables reconnect). */
  close(): void
}

export function createWsClient(options: WsClientOptions): WsClient {
  const {
    url,
    onMessage,
    onOpen,
    onClose,
    onError,
    reconnect = true,
    reconnectDelayMs = 1000,
    maxReconnectDelayMs = 30000,
  } = options

  const topics = new Set<string>(options.topics ?? [])
  let ws: WebSocket | null = null
  let closedByUser = false
  let attempt = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null

  function send(obj: unknown): boolean {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false
    ws.send(JSON.stringify(obj))
    return true
  }

  function connect() {
    ws = new WebSocket(url)

    ws.onopen = () => {
      attempt = 0
      for (const topic of topics) send({ type: 'subscribe', topic })
      onOpen?.()
    }
    ws.onmessage = (event: MessageEvent) => {
      try {
        onMessage(typeof event.data === 'string' ? JSON.parse(event.data) : event.data)
      } catch (err) {
        onError?.(err)
      }
    }
    ws.onerror = (err: unknown) => onError?.(err)
    ws.onclose = (event: CloseEvent) => {
      onClose?.({ code: event.code, reason: event.reason })
      if (!closedByUser && reconnect) scheduleReconnect()
    }
  }

  function scheduleReconnect() {
    if (reconnectTimer) return
    const delay = Math.min(maxReconnectDelayMs, reconnectDelayMs * 2 ** attempt)
    const jitter = delay * 0.2 * Math.random()
    attempt += 1
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connect()
    }, delay + jitter)
  }

  connect()

  return {
    subscribe(topic: string) {
      topics.add(topic)
      send({ type: 'subscribe', topic })
    },
    unsubscribe(topic: string) {
      topics.delete(topic)
      send({ type: 'unsubscribe', topic })
    },
    send(message: object) {
      return send(message)
    },
    close() {
      closedByUser = true
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      ws?.close()
    },
  }
}
