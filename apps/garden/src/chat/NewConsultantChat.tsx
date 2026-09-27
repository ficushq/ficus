import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '@ficus/client-core'
import { useAgentConversation } from '@ficus/client-react'
import type { ChatScope } from '@ficus/shared'
import { useStableRef } from '../hooks/useStableRef'
import { SeedPacketIcon } from '../icons'
import { AgentConversation } from './ChatPanel'
import { ChatShell } from './ChatShell'
import { ConversationView, useCanSendChat } from './ConversationView'

export interface NewConsultantChatProps {
  squadId: string
  squadName: string
  onClose: () => void
  onStarted?: (agentId: string) => void
}

/**
 * True once `messagesInfinite(agentId)` is in the cache. The compose
 * conversation warms it as soon as the new agent id resolves; observed through
 * useSyncExternalStore like the web (a subscribe + setState can fire mid-render).
 */
function useMessagesCached(agentId: string | null): boolean {
  const queryClient = useQueryClient()
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!agentId) return () => {}
      const hash = JSON.stringify(queryKeys.agents.messagesInfinite(agentId))
      // Only data changes of that one query: 'added'/'observerAdded' fire while other components
      // render, and reacting to them would update this component mid-render.
      return queryClient.getQueryCache().subscribe((event) => {
        if ((event.type === 'updated' || event.type === 'removed') && JSON.stringify(event.query.queryKey) === hash)
          onChange()
      })
    },
    [agentId, queryClient]
  )
  const get = useCallback(
    () => !!agentId && queryClient.getQueryData(queryKeys.agents.messagesInfinite(agentId)) != null,
    [agentId, queryClient]
  )
  return useSyncExternalStore(subscribe, get, get)
}

function Compose({
  squadId,
  squadName,
  onCreated,
}: {
  squadId: string
  squadName: string
  onCreated: (agentId: string) => void
}) {
  const scope = useMemo<ChatScope>(() => ({ type: 'consultant', id: squadId }), [squadId])
  // No agentId: the first send goes to POST /chat with the consultant scope, which
  // creates the consultant and streams its id back (the web's compose flow).
  const conv = useAgentConversation({ scope })
  const { canSend } = useCanSendChat(squadId)
  const onCreatedRef = useStableRef(onCreated)
  const notified = useRef<string | null>(null)
  useEffect(() => {
    if (conv.agentId && notified.current !== conv.agentId) {
      notified.current = conv.agentId
      onCreatedRef.current(conv.agentId)
    }
  }, [conv.agentId, onCreatedRef])

  return (
    <ConversationView
      conv={conv}
      canSend={canSend}
      composerLabel={`Message a new consultant for ${squadName}`}
      placeholder={canSend ? 'Describe what you need…' : undefined}
      intro={
        <div className="g-chat-intro">
          <SeedPacketIcon className="g-chat-intro-icon" />
          <p className="g-chat-intro-title">What shall we grow in {squadName}?</p>
          <p className="g-chat-intro-text">
            Plant a question or an idea. A consultant sprouts to talk it through with you.
          </p>
        </div>
      }
    />
  )
}

/**
 * The seed packet: start a brand-new consultant for a squad. The first message
 * creates it; once its id is known and its history is cached, the view hands
 * off to the normal agent conversation so the first message and the streaming
 * reply stay on screen throughout.
 */
export function NewConsultantChat({ squadId, squadName, onClose, onStarted }: NewConsultantChatProps) {
  const queryClient = useQueryClient()
  const onStartedRef = useStableRef(onStarted)
  const [agentId, setAgentId] = useState<string | null>(null)
  const ready = useMessagesCached(agentId)

  const onCreated = useCallback(
    (id: string) => {
      setAgentId(id)
      void queryClient.invalidateQueries({ queryKey: queryKeys.squads.agents(squadId) })
      void queryClient.invalidateQueries({ queryKey: queryKeys.squads.agentsWithRecent(squadId) })
      onStartedRef.current?.(id)
    },
    [queryClient, squadId, onStartedRef]
  )

  return (
    <ChatShell title={agentId ? 'Consultant' : 'New consultant'} subtitle={squadName} onClose={onClose}>
      {agentId && ready ? (
        <AgentConversation agentId={agentId} />
      ) : (
        <Compose squadId={squadId} squadName={squadName} onCreated={onCreated} />
      )}
    </ChatShell>
  )
}
