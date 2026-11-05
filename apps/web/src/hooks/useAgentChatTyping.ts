import { useCallback, useContext, useEffect, useRef, useState } from 'react'
import {
  AGENT_CHAT_TYPER_STALE_MS,
  AGENT_CHAT_TYPING_HEARTBEAT_MS,
  AGENT_CHAT_TYPING_IDLE_MS,
  type AgentChatTypingEventData,
} from '@ficus/shared'
import { WebSocketContext } from './useWebSocket'
import { useStableRef } from './useStableRef'

/** A teammate typing in the chat right now, named as the server lets this viewer see them. */
export interface AgentChatTyper {
  userId: string
  name: string
}

export interface AgentChatTyping {
  /** Everyone else typing in this chat, in the order they started. */
  typers: AgentChatTyper[]
  /**
   * Call on every change a person makes to the composer (typing, pasting, deleting, inserting a
   * draft or an image), with whether anything is left in it. Content marks them as typing (said
   * again every few seconds while they keep going); an empty composer stops it straight away.
   */
  composerChanged: (hasContent: boolean) => void
  /** Stop typing now (the message was sent). Also happens on unmount, on another agent, and after AGENT_CHAT_TYPING_IDLE_MS. */
  stopTyping: () => void
}

interface OwnTyping {
  agentId: string
  heartbeat: ReturnType<typeof setInterval>
  idle: ReturnType<typeof setTimeout>
}

/**
 * Live typing in an agent's chat: shows who else is typing in it, and tells
 * them when this person is. Only people see it; the server checks who may read
 * the conversation and never sends anyone their own typing (from any tab). The
 * draft itself never leaves the page. Inert without an agent (a chat not yet
 * created) or outside a WebSocket provider.
 */
export function useAgentChatTyping(
  agentId: string | undefined,
  {
    selfUserId,
    timing,
  }: {
    /** The signed-in person: never shown as a typer (the server already leaves them out). */
    selfUserId?: string | null
    /** A test seam; the shared constants are the product. */
    timing?: Partial<{ idleMs: number; heartbeatMs: number; staleMs: number }>
  } = {}
): AgentChatTyping {
  const idleMs = timing?.idleMs ?? AGENT_CHAT_TYPING_IDLE_MS
  const heartbeatMs = timing?.heartbeatMs ?? AGENT_CHAT_TYPING_HEARTBEAT_MS
  const staleMs = timing?.staleMs ?? AGENT_CHAT_TYPER_STALE_MS
  const socket = useContext(WebSocketContext)
  const subscribe = socket?.subscribe
  const isConnected = socket?.isConnected ?? false
  const [typers, setTypers] = useState<AgentChatTyper[]>([])

  const sendRef = useStableRef(socket?.send)
  const agentIdRef = useStableRef(agentId)
  const selfUserIdRef = useStableRef(selfUserId)

  // Who else is typing. Every typer drops on their own after AGENT_CHAT_TYPER_STALE_MS without a
  // heartbeat, so a lost "stopped" never leaves a bubble behind; all of them drop when the
  // connection does (the server stops them for everyone anyway).
  useEffect(() => {
    if (!agentId || !subscribe || !isConnected) return
    const seen = new Map<string, { name: string; stale: ReturnType<typeof setTimeout> }>()
    const publish = () => setTypers([...seen].map(([userId, { name }]) => ({ userId, name })))
    const drop = (userId: string) => {
      const typer = seen.get(userId)
      if (!typer) return
      clearTimeout(typer.stale)
      seen.delete(userId)
      publish()
    }
    const unsubscribe = subscribe(`agents:${agentId}`, (entry) => {
      if (entry.event !== 'agentChat.typing') return
      const data: AgentChatTypingEventData = entry.data
      if (data.agentId !== agentId || data.userId === selfUserIdRef.current) return
      if (!data.typing) return drop(data.userId)
      const previous = seen.get(data.userId)
      if (previous) clearTimeout(previous.stale)
      seen.set(data.userId, { name: data.name, stale: setTimeout(() => drop(data.userId), staleMs) })
      if (previous?.name !== data.name) publish()
    })
    return () => {
      unsubscribe()
      for (const { stale } of seen.values()) clearTimeout(stale)
      setTypers([])
    }
  }, [agentId, subscribe, isConnected, staleMs, selfUserIdRef])

  // This person's own typing, for whichever agent it started in.
  const ownRef = useRef<OwnTyping | null>(null)
  const stopTyping = useCallback(() => {
    const own = ownRef.current
    if (!own) return
    ownRef.current = null
    clearInterval(own.heartbeat)
    clearTimeout(own.idle)
    sendRef.current?.({ type: 'agentChat.typing', agentId: own.agentId, typing: false })
  }, [sendRef])

  const composerChanged = useCallback(
    (hasContent: boolean) => {
      const agentId = agentIdRef.current
      if (!hasContent || !agentId) return stopTyping()
      if (ownRef.current && ownRef.current.agentId !== agentId) stopTyping()
      const own = ownRef.current
      const idle = setTimeout(stopTyping, idleMs)
      if (own) {
        clearTimeout(own.idle)
        own.idle = idle
        return
      }
      const say = () => sendRef.current?.({ type: 'agentChat.typing', agentId, typing: true })
      say()
      // While they keep typing, say so again every few seconds (and again after a reconnect).
      ownRef.current = { agentId, heartbeat: setInterval(say, heartbeatMs), idle }
    },
    [stopTyping, idleMs, heartbeatMs, agentIdRef, sendRef]
  )

  // Leaving the chat (unmount, or on to another agent) stops typing in it.
  useEffect(() => stopTyping, [agentId, stopTyping])

  return { typers, composerChanged, stopTyping }
}
