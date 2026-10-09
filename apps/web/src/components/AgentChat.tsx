import { AgentSlotWaitStatus } from './AgentSlotWaitStatus'
import { useStableRef } from '../hooks/useStableRef'
import { useDeliverySuggestion } from '../hooks/useDeliverySuggestion'
import clsx from 'clsx'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useAgentConversation } from '@ficus/client-react'
import type { AssistantRoutingSend, ChatScope, MessageMetadata } from '@ficus/shared'
import { queries } from '../queryOptions'
import { ChatView } from './ChatView'
import { QuestionInput } from './QuestionInput'
import { PendingQuestionsBanner } from './PendingQuestionsBanner'
import { SpinnerIcon } from './icons'
import { useChatApi } from '../api/ChatApiProvider'
import { getAgentName } from '../lib/agentDisplay'
import { webStatus } from '../lib/statusPresentation'

const attentionStatus = webStatus('attention')

interface AgentChatDependencies {
  ChatViewComponent?: typeof ChatView
  /** Test override for the squad-less liveness fallback. */
  pendingQuestionsFallbackIntervalMs?: number
}

export type AgentChatController = ReturnType<typeof useAgentConversation>
interface AgentChatProps {
  beforeSend?: () => Promise<void>
  /** Called with the composer's draft as it changes. */
  onDraftChange?: (draft: string) => void
  /** Extra options for a typed message, read as it is sent (e.g. the Assistant's routing). */
  sendOptions?: (message: string) => { assistantRouting?: AssistantRoutingSend } | undefined
  onConversation?: (conversation: AgentChatController) => void
  renderMessageFooter?: React.ComponentProps<typeof ChatView>['renderMessageFooter']
  afterConversation?: React.ReactNode
  dependencies?: AgentChatDependencies
  agentId?: string
  scope?: ChatScope
  viewingUserId?: string
  embedded?: boolean
  enableFullscreen?: boolean
  readOnly?: boolean
  hideInboxMessages?: boolean
  hideComposer?: boolean
  inputDisabled?: boolean
  pagePath?: string
  initialMessage?: { content: string }
  initialPending?: { content: string; imageIds?: string[] }
  onAgentCreated?: (agentId: string) => void
  onDone?: (response: string, metadata: MessageMetadata | null, messageId?: string) => void
  onNavigate?: (path: string) => void
  thinkingLabel?: string
  // W5 props
  /** Header chrome rendered above the transcript. May be a render function so
   *  the wrapper (AgentConversationBody's execution badge) can consume the
   *  conversation's LIVE stream-derived state — notably `waitingForSandbox`,
   *  which the DB execution status alone cannot express during a normal
   *  in-turn sandbox ensure (the row stays 'running'). */
  header?: React.ReactNode | ((state: AgentChatHeaderState) => React.ReactNode)
  isReview?: boolean
  onReviewFeedback?: (message: string) => Promise<void>
  inputStorageKey?: string
  composerDraft?: React.ComponentProps<typeof ChatView>['composerDraft']
  squadId?: string
  tts?: {
    enabled: boolean
    isPlaying: boolean
    isSynthesizing: boolean
    playingMessageId: string | null
    speak: (messageId: string) => Promise<void>
    stop: () => void
    toggle: () => void
  }
  showRawText?: boolean
  onToggleRawText?: () => void
  /** Small live status beside the composer's controls (context used and sandbox waits…). */
  composerStatus?: React.ReactNode | ((state: AgentChatHeaderState) => React.ReactNode)
  inputPrefix?: React.ReactNode
  focusTrigger?: number
  keyboardShortcutsEnabled?: boolean
  className?: string
  placeholder?: string
  /** Server message id to scroll to and highlight on mount (e.g. deep-linking from Activity). */
  focusMessageId?: string
  /** Inbox message id: focuses the transcript message that delivered it. */
  focusInboxMessageId?: string
}

/** Live conversation state exposed to a `header` render function. */
export interface AgentChatHeaderState {
  /** True while the server has signaled the active turn is blocked on its sandbox ensure. */
  waitingForSandbox: boolean
}

export function AgentChat({
  agentId,
  scope,
  viewingUserId,
  embedded,
  enableFullscreen,
  readOnly,
  hideComposer,
  hideInboxMessages,
  inputDisabled,
  initialPending,
  initialMessage,
  pagePath,
  onAgentCreated,
  onDone,
  onNavigate,
  thinkingLabel,
  header,
  isReview,
  onReviewFeedback,
  inputStorageKey,
  composerDraft,
  squadId,
  tts,
  showRawText,
  onToggleRawText,
  composerStatus,
  inputPrefix,
  focusTrigger,
  keyboardShortcutsEnabled,
  className,
  placeholder: placeholderProp,
  focusMessageId,
  focusInboxMessageId,
  dependencies,
  onConversation,
  beforeSend,
  onDraftChange,
  sendOptions,
  afterConversation,
  renderMessageFooter,
}: AgentChatProps) {
  const ChatViewComponent = dependencies?.ChatViewComponent ?? ChatView
  const api = useChatApi()
  const conv = useAgentConversation({ agentId, scope, initialPending, onDone, pagePath })
  const onConversationRef = useStableRef(onConversation)
  useEffect(() => {
    onConversationRef.current?.(conv)
  }, [conv, onConversationRef])

  const beforeSendRef = useStableRef(beforeSend)
  const sendOptionsRef = useStableRef(sendOptions)
  const onDraftChangeRef = useStableRef(onDraftChange)
  const [preparationError, setPreparationError] = useState<string>()
  const [initialPreparationAttempt, setInitialPreparationAttempt] = useState(0)

  // Launcher requests are sends, not pre-existing optimistic rows. Keep failed sends
  // in the conversation's retry UI and never resend on rerenders or mode switches.
  const initialMessageSent = useRef(false)
  const sendInitial = conv.send
  useEffect(() => {
    if (!initialMessage?.content || initialMessageSent.current || inputDisabled) return
    initialMessageSent.current = true
    void (async () => {
      await beforeSendRef.current?.()
      setPreparationError(undefined)
      sendInitial(initialMessage.content)
    })().catch((error) => {
      initialMessageSent.current = false
      setPreparationError(error instanceof Error ? error.message : 'Could not prepare conversation')
    })
  }, [initialMessage, inputDisabled, sendInitial, beforeSendRef, initialPreparationAttempt])

  // Surface a newly-created agent to the wrapper (routing/URL). Notify at most once per created id:
  // callers (e.g. the consultant composer) keep agentId undefined and pass an inline onAgentCreated,
  // so its identity churns every render — re-firing would loop setSearchParams ("Too many calls to
  // Location or History APIs").
  const notifiedAgentIdRef = useRef<string | null>(null)
  useEffect(() => {
    if (conv.agentId && conv.agentId !== agentId && notifiedAgentIdRef.current !== conv.agentId) {
      notifiedAgentIdRef.current = conv.agentId
      onAgentCreated?.(conv.agentId)
    }
  }, [conv.agentId, agentId, onAgentCreated])

  const { data: agent } = useQuery({
    ...queries.agents.detail(conv.agentId ?? ''),
    queryFn: () => api.getAgent(conv.agentId ?? ''),
    enabled: !!conv.agentId,
  })
  const isTerminated = agent?.status === 'terminated'
  const isDormant = agent?.status === 'dormant'
  const isWaitingInput = agent?.status === 'waiting-input'
  const isActive = agent?.status === 'active' || isWaitingInput

  // Open async questions this agent asked (rendered near the input; the agent isn't blocked on them).
  // The conversation hook resolves prop navigation in an effect; prefer the requested chat immediately.
  const questionAgentId = agentId ?? conv.agentId
  const { data: openQuestions, isPlaceholderData: questionsArePlaceholder } = useQuery({
    ...queries.agentQuestions.byAgent(questionAgentId ?? '', 'open'),
    queryFn: () => api.getAgentQuestions(questionAgentId ?? '', 'open'),
    enabled: !!questionAgentId,
    // Personal-agent questions normally invalidate through owner-authorized `agents` events.
    // Retain a narrow polling safety net for a dropped frame or suspended socket.
    refetchInterval: agent?.squadId === null ? (dependencies?.pendingQuestionsFallbackIntervalMs ?? 60_000) : false,
  })

  const [questionSubmitted, setQuestionSubmitted] = useState(false)

  // Reset submitted state when agent status changes
  useEffect(() => {
    setQuestionSubmitted(false)
  }, [agent?.status])

  // Auto-navigate on completed navigate tool calls with prompt: false (Fix 2)
  const executedNavigations = useRef<Set<string>>(new Set())
  useEffect(() => {
    for (const item of conv.items) {
      if (item.kind !== 'streaming') continue
      for (const block of item.blocks) {
        if (block.type === 'tool_use' && block._done && block.toolCall.toolName === 'navigate') {
          const blockId = block.id
          if (executedNavigations.current.has(blockId)) continue
          try {
            const args = JSON.parse(block.toolCall.args)
            if (args.prompt === false && args.path) {
              executedNavigations.current.add(blockId)
              onNavigate?.(args.path)
            }
          } catch {
            // Ignore malformed args
          }
        }
      }
    }
  }, [conv.items, onNavigate])

  // Interrupt or Follow up: while the agent works, a paused draft is judged for whether it is about
  // the current work, and a confident answer pre-selects the mode. A manual choice wins.
  const isStreaming = conv.streamStatus === 'live' && conv.items.some((i) => i.kind === 'streaming')
  const executionBusy =
    conv.executionStatus === 'queued' ||
    conv.executionStatus === 'waiting-sandbox' ||
    conv.executionStatus === 'running' ||
    conv.executionStatus === 'stopping'
  const delivery = useDeliverySuggestion({
    agentId: conv.agentId,
    busy: !inputDisabled && !isReview && !isWaitingInput && (executionBusy || isStreaming),
    fetchSuggestion: api.getDeliverySuggestion,
  })
  const deliveryMode = delivery.deliveryMode
  const deliveryDraftChange = delivery.onDraftChange
  const handleDraftChange = useCallback(
    (draft: string) => {
      deliveryDraftChange(draft)
      onDraftChangeRef.current?.(draft)
    },
    [deliveryDraftChange, onDraftChangeRef]
  )

  // Send routing: review feedback takes priority over normal send
  const handleSend = async (message: string, imageIds?: string[]) => {
    if (inputDisabled) return
    if (isReview && onReviewFeedback) {
      await onReviewFeedback(message)
      return
    }
    await beforeSendRef.current?.()
    await conv.sendAccepted(message, { imageIds, deliveryMode, ...sendOptionsRef.current?.(message) }).accepted
    // The next draft starts from the default and takes a fresh suggestion.
    delivery.reset()
  }

  // Composer visibility
  const shouldHideComposer = hideComposer || isTerminated || readOnly || (isWaitingInput && agent?.questionData != null)

  // Contextual placeholder (explicit prop overrides contextual default)
  const maintenanceQueued = conv.executionStatus === 'waiting-maintenance'
  const isRunning = conv.executionStatus === 'running' || conv.executionStatus === 'waiting-sandbox'
  const canSendInline = isRunning || isStreaming
  const placeholder =
    placeholderProp ??
    (maintenanceQueued
      ? 'Queued until maintenance completes…'
      : canSendInline
        ? 'Message the agent...'
        : isReview
          ? 'Request changes or ask the agent to revise...'
          : isWaitingInput
            ? 'Type your answer...'
            : isActive
              ? 'Type a message to intervene...'
              : 'Type a message...')

  // Build afterMessages
  const blockingQuestion =
    isWaitingInput && agent?.questionData ? (
      questionSubmitted ? (
        <div className="mx-auto w-full max-w-[95%] md:max-w-[90%] rounded-lg border border-th-border bg-surface-secondary p-3 md:p-4">
          <div className="flex items-center justify-center gap-2 text-muted text-sm py-1">
            <SpinnerIcon className="animate-spin h-4 w-4" />
            Sending answer...
          </div>
        </div>
      ) : (
        <div className="mx-auto w-full max-w-[95%] md:max-w-[90%] rounded-lg border-2 border-status-human-wait-200 dark:border-status-human-wait-800 bg-status-human-wait-50 dark:bg-status-human-wait-900/20 p-3 md:p-4">
          <div className="flex items-center gap-2 mb-3">
            <span className="text-status-human-wait-500 text-lg">?</span>
            <p className="text-sm font-medium text-status-human-wait-700 dark:text-status-human-wait-400">
              Agent needs your input
            </p>
          </div>
          <QuestionInput
            questionData={agent.questionData}
            disabled={questionSubmitted || !!inputDisabled}
            onSubmit={(answer) => {
              setQuestionSubmitted(true)
              conv.send(answer)
            }}
          />
        </div>
      )
    ) : undefined

  const terminatedNotice = isTerminated ? (
    <div className="mx-auto w-full max-w-[95%] md:max-w-[90%] rounded-lg border border-th-border bg-surface-secondary p-3 text-sm text-secondary text-center">
      This agent was terminated and can no longer receive messages. You can still view the conversation history.
    </div>
  ) : null

  const dormantNotice = isDormant ? (
    <div className="mx-auto w-full max-w-[95%] md:max-w-[90%] rounded-lg border border-th-border bg-surface-secondary p-3 text-sm text-secondary text-center">
      This agent is dormant. Sending a message will wake it.
    </div>
  ) : null

  const compactionBanner = conv.compactionState ? (
    <div
      className={clsx(
        'mx-auto w-full max-w-[95%] md:max-w-[90%] rounded-lg border p-2 text-center text-sm',
        attentionStatus.borderClass,
        attentionStatus.surfaceClass,
        attentionStatus.textClass
      )}
    >
      Compacting context{conv.compactionState.reason === 'manual' ? ' (manual)' : ''}…
    </div>
  ) : null

  const afterMessages =
    compactionBanner || terminatedNotice || dormantNotice || blockingQuestion ? (
      <>
        {compactionBanner}
        {terminatedNotice}
        {dormantNotice}
        {blockingQuestion}
      </>
    ) : undefined

  const pendingQuestionsBanner = questionAgentId ? (
    // Stay mounted through empty/loading results, but reset all local UI/history on navigation.
    <PendingQuestionsBanner
      key={questionAgentId}
      questions={
        !questionsArePlaceholder && openQuestions?.every((question) => question.agentId === questionAgentId)
          ? openQuestions
          : undefined
      }
      agentName={(agent?.id === questionAgentId && getAgentName(agent)) || 'Agent'}
    />
  ) : undefined

  return (
    <ChatViewComponent
      items={conv.items}
      renderMessageFooter={renderMessageFooter}
      agentId={conv.agentId}
      onSend={handleSend}
      onRetry={conv.retrySend}
      onStop={inputDisabled ? undefined : conv.stop}
      // Tool-abort is unreliable end-to-end; stopping the whole execution is the real abort.
      // Keep conv.abortTool fully implemented (resource + hook) but do NOT surface the button
      // for now. Re-enable by passing onAbortTool={conv.abortTool}.
      onAbortTool={undefined}
      onCancelQueue={inputDisabled ? undefined : conv.cancelAllPending}
      onLoadOlder={conv.fetchOlder}
      hasOlderMessages={conv.hasOlder}
      isLoadingOlder={conv.isFetchingOlder}
      isLoading={conv.isLoading}
      isStreaming={isStreaming}
      executionStatus={conv.executionStatus}
      viewingUserId={viewingUserId}
      readOnly={readOnly || isTerminated}
      hideInboxMessages={hideInboxMessages}
      hideComposer={shouldHideComposer}
      inputDisabled={inputDisabled}
      enableFullscreen={enableFullscreen}
      embedded={embedded}
      header={typeof header === 'function' ? header({ waitingForSandbox: conv.waitingForSandbox }) : header}
      headerStatus={
        conv.agentId && agent?.squadId && !isTerminated && !isDormant ? (
          <AgentSlotWaitStatus
            key={conv.agentId}
            agentId={conv.agentId}
            squadId={agent.squadId}
            isIdle={
              agent.status === 'idle' &&
              (!conv.executionStatus || ['completed', 'stopped', 'failed'].includes(conv.executionStatus)) &&
              !conv.items.some((item) => item.kind === 'streaming')
            }
          />
        ) : undefined
      }
      afterMessages={
        <>
          {afterMessages}
          {preparationError && (
            <div role="alert">
              {preparationError}
              {!initialMessageSent.current && initialMessage && (
                <button
                  className="ficus-button ficus-button-link ml-2"
                  onClick={() => setInitialPreparationAttempt((value) => value + 1)}
                >
                  Retry sending
                </button>
              )}
            </div>
          )}
          {afterConversation}
        </>
      }
      beforeComposer={pendingQuestionsBanner}
      placeholder={placeholder}
      thinkingLabel={thinkingLabel}
      inputStorageKey={inputStorageKey}
      composerDraft={composerDraft}
      squadId={squadId}
      tts={tts}
      showRawText={showRawText}
      onToggleRawText={onToggleRawText}
      composerStatus={
        typeof composerStatus === 'function'
          ? composerStatus({ waitingForSandbox: conv.waitingForSandbox })
          : composerStatus
      }
      inputPrefix={inputPrefix}
      deliveryMode={deliveryMode}
      onDeliveryModeChange={delivery.chooseMode}
      suggestedDelivery={delivery.suggested}
      onDraftChange={handleDraftChange}
      sendLabel={isReview ? 'Send Feedback' : undefined}
      focusTrigger={focusTrigger}
      keyboardShortcutsEnabled={keyboardShortcutsEnabled}
      className={className}
      focusMessageId={focusMessageId}
      focusInboxMessageId={focusInboxMessageId}
    />
  )
}
