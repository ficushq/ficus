import { ToolRenderersContext } from '../lib/ToolRenderersContext'
import { AssistantConversationContext } from '../voice/AssistantConversationContext'
import { AssistantConversationLinkRow } from './AssistantConversationLinkRow'
import { AssistantPageLinkRow } from './AssistantPageLinkRow'
import { AssistantSummarySources } from './AssistantSummarySources'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { useAssistantPageNavigation } from '../hooks/useAssistantPageNavigation'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { type AssistantEntry, type MessageMetadata } from '@ficus/shared'
import { assistantApi } from '../api/assistant'
import { assistantQueries } from '../queryOptions'
import { assistantQueryKeys, queryKeys } from '../queryKeys'
import { useAssistantActivity } from '../hooks/useAssistantActivity'
import { useStableRef } from '../hooks/useStableRef'
import { durableAssistantConversationLinks, type AssistantConversationLink } from '../lib/assistantConversationLinks'
import { durableAssistantPageLinks } from '../lib/assistantPageLinks'
import { siteAssistantToolRenderers, type ToolRenderers } from '../lib/tool-renderers'
import type { PageEditorBridge } from '../voice/AssistantConversationContext'
import { useRealtimeVoiceAssistant } from '../voice/useRealtimeVoiceAssistant'
import { AssistantVoiceReceipts, createAssistantVoiceChannel } from '../voice/assistantVoiceChannel'
import { VoiceCompanionButton } from '../voice/VoiceCompanionWidget'
import { AgentChat, type AgentChatController } from './AgentChat'
import { AssistantAgentQuestions, AssistantTaskQuestions } from './AssistantQuestions'
import { MarkdownContent } from './MarkdownContent'

export interface AssistantViewControls {
  startVoice: () => Promise<void>
  live: boolean
  connecting: boolean
  connectionFailed?: boolean
}
export interface AssistantConversationViewProps {
  id: string
  onOpenConversation?: (conversation: AssistantConversationLink) => void
  pageEditor?: PageEditorBridge
  toolRenderers?: ToolRenderers
  existing?: boolean
  realtime: boolean
  initialMessage?: { id: string; text: string }
  focusTaskId?: string
  compact: boolean
  visible: boolean
  onControls: (controls: AssistantViewControls) => void
  onCreated: (id: string) => void
  onExpand: () => void
  positionControl: React.ReactNode
  dependencies?: { api?: typeof assistantApi; useAssistant?: typeof useRealtimeVoiceAssistant; Chat?: typeof AgentChat }
}

/** Text, voice and task summaries share the normal deterministic agent conversation engine. */
export function AssistantConversationView(props: AssistantConversationViewProps) {
  return (
    <AssistantConversationContext.Provider
      value={{
        pageEditor: props.pageEditor,
        openConversation: props.onOpenConversation,
      }}
    >
      <ToolRenderersContext.Provider value={props.toolRenderers ?? siteAssistantToolRenderers}>
        <DurableConversation key={props.id} {...props} />
      </ToolRenderersContext.Provider>
    </AssistantConversationContext.Provider>
  )
}

function DurableConversation(props: AssistantConversationViewProps) {
  const api = props.dependencies?.api ?? assistantApi
  const Chat = props.dependencies?.Chat ?? AgentChat
  const propsRef = useStableRef(props)
  const navigate = useAssistantPageNavigation()
  const pagePath = useLocation().pathname
  const queryClient = useQueryClient()
  const { ownerId } = useAssistantActivity({ enabled: false })
  const [agentId, setAgentId] = useState<string>()
  const [archive, setArchive] = useState<AssistantEntry[]>([])
  const [archiveBefore, setArchiveBefore] = useState<number>()
  const [archiveHasMore, setArchiveHasMore] = useState(false)
  const [error, setError] = useState<string>()
  const [voiceRequested, setVoiceRequested] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const controller = useRef<AgentChatController | null>(null)
  const voiceReceipts = useRef(new AssistantVoiceReceipts())
  const sourceIds = useRef(new Map<string, string>())
  const answerIds = useRef(new Map<string, string>())
  const ensure = useRef<Promise<{ history: Awaited<ReturnType<typeof api.history>>; agentId: string }> | null>(null)
  useEffect(() => {
    let active = true
    if (!props.visible && !props.existing && !props.initialMessage && !props.pageEditor && !voiceRequested) return
    if (!ensure.current)
      ensure.current = (async () => {
        await propsRef.current.pageEditor?.prepare()
        if (!propsRef.current.existing)
          await api.create(
            props.id,
            propsRef.current.initialMessage?.text.slice(0, 120),
            propsRef.current.pageEditor ? 'page-editor' : 'assistant'
          )
        const history = await api.history(props.id)
        const binding = await api.ensureAgent(props.id)
        return { history, agentId: binding.agentId }
      })().catch((cause) => {
        ensure.current = null
        throw cause
      })
    void ensure.current
      .then(({ history, agentId }) => {
        if (!active) return
        setArchive(history.entries)
        setArchiveBefore(history.before)
        setArchiveHasMore(history.hasMore)
        setAgentId(agentId)
        setError(undefined)
        propsRef.current.onCreated(props.id)
        void queryClient.invalidateQueries({ queryKey: assistantQueryKeys.all })
      })
      .catch((cause) => {
        if (active) setError(cause instanceof Error ? cause.message : 'Conversation could not be loaded.')
      })
    return () => {
      active = false
    }
  }, [
    api,
    props.id,
    props.visible,
    props.existing,
    props.initialMessage,
    props.pageEditor,
    voiceRequested,
    attempt,
    propsRef,
    queryClient,
  ])

  const submitVoice = useStableRef((text: string, sourceId: string) => {
    if (sourceIds.current.has(sourceId)) return
    const current = controller.current
    if (!current) {
      setError('Conversation is still loading. Please try again.')
      return
    }
    const clientId = crypto.randomUUID()
    sourceIds.current.set(sourceId, clientId)
    // Register before send: a fast response can finish before acceptance reaches the browser.
    voiceReceipts.current.register(clientId)
    void (async () => {
      try {
        await propsRef.current.pageEditor?.prepare()
      } catch (cause) {
        sourceIds.current.delete(sourceId)
        voiceReceipts.current.forget(clientId)
        throw cause
      }
      await current.sendAccepted(text, { clientId }).accepted
    })().catch((cause) =>
      setError(
        cause instanceof Error ? cause.message : 'Voice message could not be sent. Retry it in the conversation.'
      )
    )
  })
  const voiceDefinition = useMemo(
    () => createAssistantVoiceChannel(() => ({ submit: (text, id) => submitVoice.current(text, id) })),
    [submitVoice]
  )
  const voice = (props.dependencies?.useAssistant ?? useRealtimeVoiceAssistant)(voiceDefinition, {
    textOnly: true,
    autoReconnect: true,
    maxReconnectAttempts: 3,
  })
  const voiceRef = useStableRef(voice)
  const speakReady = useCallback(() => {
    if (!voiceRef.current.isLiveAudio || !controller.current) return
    for (const response of voiceReceipts.current.ready(controller.current.items))
      voiceRef.current.enqueueMessage({
        id: `assistant-response:${response.id}`,
        dedupeKey: response.id,
        text: `Read this completed Assistant response aloud. Do not add new claims or perform actions:\n${response.text}`,
      })
  }, [voiceRef])
  const onDone = useCallback(
    (text: string, metadata: MessageMetadata | null, messageId?: string) => {
      if (!messageId || !voiceRef.current.isLiveAudio) return
      voiceReceipts.current.complete(messageId, text, metadata)
      speakReady()
    },
    [speakReady, voiceRef]
  )
  const onConversation = useCallback(
    (value: AgentChatController) => {
      controller.current = value
      speakReady()
    },
    [speakReady]
  )
  const startVoice = useCallback(async () => {
    if (!propsRef.current.realtime) return
    if (!controller.current) {
      setVoiceRequested(true)
      return
    }
    await voiceRef.current.setLiveAudio(true)
  }, [propsRef, voiceRef])
  useEffect(() => {
    if (!voiceRequested || !agentId || !controller.current) return
    void voiceRef.current
      .setLiveAudio(true)
      .catch((cause) => setError(cause instanceof Error ? cause.message : 'Voice could not start'))
      .finally(() => setVoiceRequested(false))
  }, [voiceRequested, agentId, voiceRef])
  useEffect(() => {
    propsRef.current.onControls({
      startVoice,
      live: voice.isLiveAudio,
      connecting: voiceRequested || voice.status === 'connecting',
      connectionFailed: Boolean(voice.error) && !voice.isConnected,
    })
  }, [propsRef, startVoice, voiceRequested, voice.isLiveAudio, voice.status, voice.error, voice.isConnected])
  useEffect(() => {
    if (!props.realtime) {
      voiceRef.current.disconnect()
      voiceReceipts.current.clear()
    }
  }, [props.realtime, voiceRef])

  const activity = useQuery({
    ...assistantQueries.conversationActivity(ownerId ?? '', props.id),
    queryFn: () => api.conversationActivity(props.id),
    enabled: Boolean(ownerId && agentId),
  })
  const refresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: assistantQueryKeys.activityPrefix })
    await queryClient.invalidateQueries({ queryKey: queryKeys.actions.pending() })
    controller.current?.refresh()
  }, [queryClient])
  const data = activity.data
  const updates = data?.updates ?? []
  // Viewing the conversation reads its updates: they're shown inline under the replies that cover them.
  const viewing = props.visible && !props.compact
  const unread = data?.conversation.unreadUpdates ?? 0
  const latestSequence = data?.conversation.latestUpdateSequence ?? 0
  useEffect(() => {
    if (!viewing || !unread || !latestSequence) return
    void api
      .seenThrough(props.id, latestSequence)
      .then(refresh)
      .catch(() => {})
  }, [viewing, unread, latestSequence, props.id, refresh])
  const questions = data && (
    <div
      className="min-w-0 space-y-2 px-3 py-2 [overflow-wrap:anywhere]"
      data-assistant-questions
      aria-label="Assistant questions"
    >
      <AssistantAgentQuestions
        agentIds={[...new Set(data.tasks.flatMap((task) => (task.agentId && !task.unavailable ? [task.agentId] : [])))]}
      />
      <AssistantTaskQuestions
        tasks={data.tasks}
        updates={data.pendingInputs ?? updates}
        focusTaskId={props.focusTaskId}
        onReply={async (task, update, answer) => {
          const key = JSON.stringify([task.id, update.messageId, answer])
          const clientId = answerIds.current.get(key) ?? crypto.randomUUID()
          answerIds.current.set(key, clientId)
          await api.message(props.id, answer, clientId, {
            inReplyTo: update.messageId,
            ...(task.kind === 'agent' && task.agentId ? { agentId: task.agentId } : {}),
          })
          answerIds.current.delete(key)
          await refresh()
        }}
      />
    </div>
  )
  return (
    <div
      className="flex flex-1 min-h-0 min-w-0 max-w-full flex-col overflow-hidden [overflow-wrap:anywhere]"
      style={{ display: props.visible ? undefined : 'none' }}
    >
      {voice.isLiveAudio && (
        <VoiceCompanionButton
          embedded
          controlsOnly
          compactOverride={props.compact}
          onExpand={props.onExpand}
          positionControl={props.positionControl}
          dependencies={{
            useVoiceAssistant: () => ({
              ...voice,
              toggle: () => {
                void voice.setLiveAudio(false)
                voiceReceipts.current.clear()
              },
            }),
          }}
        />
      )}
      {voice.error && (
        <div role="alert" className="px-3 py-2 text-sm text-status-danger-600 dark:text-status-danger-400">
          {voice.error}{' '}
          <button
            className="ficus-button ficus-button-link"
            onClick={() => {
              void voice.retryConnection()
            }}
          >
            Reconnect
          </button>
        </div>
      )}
      {props.realtime && !voice.isLiveAudio && agentId && (
        <button
          className="ficus-button ficus-button-link py-1 text-xs text-muted"
          onClick={() => {
            void startVoice()
          }}
        >
          enable your microphone
        </button>
      )}
      {error && (
        <div role="alert" className="px-3 py-2 text-sm text-status-danger-600 dark:text-status-danger-400">
          {error}{' '}
          {!agentId && (
            <button className="ficus-button ficus-button-link" onClick={() => setAttempt((value) => value + 1)}>
              Retry
            </button>
          )}
        </div>
      )}
      <div className="flex flex-1 min-h-0 min-w-0 flex-col" style={{ display: props.compact ? 'none' : undefined }}>
        {(archive.length > 0 || archiveHasMore) && (
          <details className="shrink-0 max-h-[30dvh] overflow-y-auto px-3 py-2 text-sm">
            <summary className="cursor-pointer text-muted">Earlier conversation</summary>
            {archiveHasMore && (
              <button
                className="ficus-button ficus-button-link"
                onClick={async () => {
                  const page = await api.history(props.id, archiveBefore)
                  setArchive((current) => [
                    ...page.entries.filter((entry) => !current.some((row) => row.id === entry.id)),
                    ...current,
                  ])
                  setArchiveBefore(page.before)
                  setArchiveHasMore(page.hasMore)
                }}
              >
                Load earlier messages
              </button>
            )}
            {archive.map((entry) => (
              <div key={entry.id} className="min-w-0 py-2">
                <span className="text-xs text-muted">{entry.role}</span>
                <MarkdownContent>{entry.text}</MarkdownContent>
              </div>
            ))}
          </details>
        )}
        {agentId ? (
          <Chat
            agentId={agentId}
            hideInboxMessages
            embedded
            className="min-w-0 flex-1 min-h-0"
            pagePath={pagePath}
            initialMessage={props.initialMessage ? { content: props.initialMessage.text } : undefined}
            renderMessageFooter={(item) =>
              item.message.role === 'assistant' && ownerId ? (
                <>
                  {props.onOpenConversation &&
                    durableAssistantConversationLinks(item).map((link) => (
                      <AssistantConversationLinkRow
                        key={link.agentId}
                        conversation={link}
                        onOpen={props.onOpenConversation!}
                      />
                    ))}
                  {durableAssistantPageLinks(item).map((path) => (
                    <AssistantPageLinkRow key={path} path={path} onOpen={navigate} />
                  ))}
                  <AssistantSummarySources ownerId={ownerId} conversationId={props.id} item={item} />
                </>
              ) : null
            }
            onConversation={onConversation}
            beforeSend={() => propsRef.current.pageEditor?.prepare() ?? Promise.resolve()}
            keyboardShortcutsEnabled={props.visible && !props.compact}
            onDone={onDone}
            onNavigate={navigate}
            afterConversation={questions}
            inputStorageKey={`assistant:${props.id}`}
            placeholder="Ask anything…"
          />
        ) : (
          !error && (
            <div className="p-3 text-sm min-w-0">
              {props.initialMessage && <MarkdownContent>{props.initialMessage.text}</MarkdownContent>}
              <p role="status" className="text-muted">
                Loading conversation…
              </p>
            </div>
          )
        )}
      </div>
    </div>
  )
}
