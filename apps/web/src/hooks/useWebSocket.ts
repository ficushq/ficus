import { useContext, createContext } from 'react'
import type { CollectionTopic, InstanceTopic, TopicCallback } from '@ficus/shared'

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
}

export const WebSocketContext = createContext<WebSocketContextValue | null>(null)

export function useWebSocket(): WebSocketContextValue {
  const context = useContext(WebSocketContext)
  if (!context) {
    throw new Error('useWebSocket must be used within a WebSocketProvider')
  }
  return context
}
