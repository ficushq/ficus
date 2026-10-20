import { useState, useEffect, useRef, useCallback, type ReactNode } from 'react'
import { WebSocketContext, type WebSocketContextValue } from '../hooks/useWebSocket'
import { requestUpdateCheck } from '../lib/serviceWorker'
import { SocketLivenessTracker, watchSocketLiveness } from '../lib/socketLiveness'

interface WebSocketProviderProps {
  /** Resolve the WS URL per connection (mints a fresh single-use ticket each time). */
  getUrl: () => Promise<string>
  children: ReactNode
}

// Internal untyped callback — type safety is enforced at the subscribe() boundary
type AnyCallback = (entry: { event: string; data: unknown }) => void

const INITIAL_RECONNECT_DELAY = 1000
const MAX_RECONNECT_DELAY = 30000
const RECONNECT_BACKOFF = 1.5

export function WebSocketProvider({ getUrl, children }: WebSocketProviderProps) {
  const [isConnected, setIsConnected] = useState(false)
  const wsRef = useRef<WebSocket | null>(null)
  const subscribersRef = useRef<Map<string, Set<AnyCallback>>>(new Map())
  const pendingSubscriptionsRef = useRef<Set<string>>(new Set())
  const reconnectDelayRef = useRef(INITIAL_RECONNECT_DELAY)
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hasConnectedBeforeRef = useRef(false)
  const mountedRef = useRef(true)
  // Evidence for a stall: when this connection opened and last received a frame.
  // Reconnection happens only on a close event, so a half-open socket (or a stall
  // upstream of a healthy one) looks like a quiet connected one; these lines, next
  // to Core's own socket open/close log, show which it was.
  const livenessRef = useRef<SocketLivenessTracker | null>(null)
  livenessRef.current ??= new SocketLivenessTracker()

  useEffect(() => {
    mountedRef.current = true
    const liveness = livenessRef.current!

    function scheduleReconnect() {
      const delay = reconnectDelayRef.current
      reconnectDelayRef.current = Math.min(delay * RECONNECT_BACKOFF, MAX_RECONNECT_DELAY)
      reconnectTimeoutRef.current = setTimeout(() => {
        reconnectTimeoutRef.current = null
        if (mountedRef.current) connect()
      }, delay)
    }

    const stopWatching = watchSocketLiveness(
      (trigger) => {
        if (!mountedRef.current) return
        console.info('[WebSocket] liveness', trigger, {
          ...liveness.snapshot(wsRef.current?.readyState),
          visibility: document.visibilityState,
          online: navigator.onLine,
          reconnectPending: reconnectTimeoutRef.current !== null,
        })
      },
      { window, document }
    )

    async function connect() {
      if (!mountedRef.current) return

      // Resolve the URL per connection: in authenticated mode this mints a fresh
      // single-use WS ticket so the session bearer never sits in the URL.
      let resolvedUrl: string
      try {
        resolvedUrl = await getUrl()
      } catch (err) {
        console.error('[WebSocket] Failed to get connection URL:', err)
        scheduleReconnect()
        return
      }
      if (!mountedRef.current) return

      console.log('[WebSocket] Connecting')

      let ws: WebSocket
      try {
        ws = new WebSocket(resolvedUrl)
      } catch (err) {
        console.error('[WebSocket] Failed to construct WebSocket:', err)
        scheduleReconnect()
        return
      }

      wsRef.current = ws

      ws.onopen = () => {
        console.log('[WebSocket] Connected')
        if (!mountedRef.current) {
          ws.close()
          return
        }
        liveness.opened()
        setIsConnected(true)
        // Reset reconnect delay on successful connection
        reconnectDelayRef.current = INITIAL_RECONNECT_DELAY
        // A reconnect usually means the server restarted — likely with a new build.
        if (hasConnectedBeforeRef.current) requestUpdateCheck()
        hasConnectedBeforeRef.current = true
        for (const topic of pendingSubscriptionsRef.current) {
          ws.send(JSON.stringify({ type: 'subscribe', topic }))
        }
      }

      ws.onclose = (event) => {
        const { openForMs, sinceLastMessageMs } = liveness.snapshot(ws.readyState)
        liveness.closed()
        // Auto-reconnect with exponential backoff
        const delay = reconnectDelayRef.current
        console.log('[WebSocket] Disconnected', {
          code: event.code,
          reason: event.reason,
          openForMs,
          sinceLastMessageMs,
          reconnectInMs: delay,
        })
        if (!mountedRef.current) return
        setIsConnected(false)
        reconnectDelayRef.current = Math.min(delay * RECONNECT_BACKOFF, MAX_RECONNECT_DELAY)

        reconnectTimeoutRef.current = setTimeout(() => {
          reconnectTimeoutRef.current = null
          if (mountedRef.current) {
            connect()
          }
        }, delay)
      }

      ws.onerror = (event) => {
        console.error('[WebSocket] Error:', event)
        // onclose will be called after onerror, which handles reconnection
      }

      ws.onmessage = (event) => {
        liveness.message()
        try {
          const message = JSON.parse(event.data)
          if (message.type === 'event') {
            const callbacks = subscribersRef.current.get(message.topic)
            if (callbacks) {
              const entry = { event: message.event, data: message.data }
              for (const callback of callbacks) {
                callback(entry)
              }
            }
          }
        } catch {
          console.error('[WebSocket] Failed to parse message')
        }
      }
    }

    connect()

    return () => {
      mountedRef.current = false
      stopWatching()
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current)
        reconnectTimeoutRef.current = null
      }
      wsRef.current?.close()
    }
  }, [getUrl])

  // Internal implementation — the type safety comes from the overloaded
  // signatures declared on WebSocketContextValue.
  const subscribe = useCallback((topic: string, callback: AnyCallback) => {
    if (!subscribersRef.current.has(topic)) {
      subscribersRef.current.set(topic, new Set())
    }
    subscribersRef.current.get(topic)!.add(callback)
    pendingSubscriptionsRef.current.add(topic)

    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'subscribe', topic }))
    }

    return () => {
      const callbacks = subscribersRef.current.get(topic)
      if (callbacks) {
        callbacks.delete(callback)
        if (callbacks.size === 0) {
          subscribersRef.current.delete(topic)
          pendingSubscriptionsRef.current.delete(topic)
          if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({ type: 'unsubscribe', topic }))
          }
        }
      }
    }
  }, [])

  const value: WebSocketContextValue = {
    subscribe: subscribe as WebSocketContextValue['subscribe'],
    isConnected,
  }

  return <WebSocketContext.Provider value={value}>{children}</WebSocketContext.Provider>
}
