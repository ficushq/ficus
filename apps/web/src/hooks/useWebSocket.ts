import { useContext, createContext } from 'react'
import type { AgentChatTypingClientMessage, CollectionTopic, InstanceTopic, TopicCallback } from '@ficus/shared'

/** Callback for an instance topic — receives the same events as its collection prefix. */
type InstanceCallbackFor<T extends InstanceTopic> = T extends `${infer P}:${string}`
  ? P extends CollectionTopic
    ? TopicCallback<P>
    : never
  : never

export interface WebSocketContextValue {
  subscribe<T extends CollectionTopic>(topic: T, callback: TopicCallback<T>): () => void
  subscribe<T extends InstanceTopic>(topic: T, callback: InstanceCallbackFor<T>): () => void
  isConnected: boolean
  /**
   * Sends a message to the server on the current connection. Returns false when there is no open
   * connection (nothing is queued: these messages are ephemeral, and a reconnect starts afresh).
   * Optional so stand-in providers (tests, embeds) can leave it out.
   */
  send?: (message: AgentChatTypingClientMessage) => boolean
  /**
   * The latest reconnect, or null before one: how long the page had gone without a
   * frame when the new connection opened. A long gap means missed events, which the
   * narrow reconnect repair cannot cover.
   */
  lastReconnect?: { gapMs: number } | null
}

export const WebSocketContext = createContext<WebSocketContextValue | null>(null)

export function useWebSocket(): WebSocketContextValue {
  const context = useContext(WebSocketContext)
  if (!context) {
    throw new Error('useWebSocket must be used within a WebSocketProvider')
  }
  return context
}
