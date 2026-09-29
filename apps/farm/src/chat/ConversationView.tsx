import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useConversationClient, type UseAgentConversationResult } from '@ficus/client-react'
import { permissionMatches, type DeliveryMode } from '@ficus/shared'
import { chatQueries } from './queries'
import { Composer } from './Composer'
import { QuestionCard } from './QuestionCard'
import { Transcript, type TranscriptProps } from './Transcript'
import { sendLetter } from '../farm/letters'

const NEAR_BOTTOM_PX = 80

/** `can('chat:send')` for a squad (or globally), as the web's usePermissions answers it. */
export function useCanSendChat(squadId: string | undefined, enabled = true) {
  const client = useConversationClient()
  const permissions = useQuery({ ...chatQueries.permissions(client, squadId), enabled })
  const loading = !enabled || permissions.isLoading
  const can = (permissions.data?.permissions ?? []).some((held) => permissionMatches(held, 'chat:send'))
  return { loading, canSend: !loading && can }
}

export interface ConversationViewProps {
  conv: UseAgentConversationResult
  /** Chat is read-only until permissions confirm `chat:send` (matches the web's inputDisabled). */
  canSend: boolean
  hideInboxMessages?: boolean
  placeholder?: string
  /** Shown instead of the empty transcript (e.g. the seed-packet prompt). */
  intro?: ReactNode
  /** Draft key (stored under the farm's own `ficus-farm:` prefix). */
  draftKey?: string
  composerLabel?: string
  afterConversation?: ReactNode
  /** Messages from before this agent (an Assistant conversation's earlier sessions), drawn as the top of the log. */
  beforeConversation?: ReactNode
  /** Drawn under each of the agent's replies. */
  renderReplyFooter?: TranscriptProps['renderReplyFooter']
  autoFocus?: boolean
}

/**
 * One agent conversation: transcript, blocking question, notices and composer.
 * Mirrors the web's AgentChat + ChatView behaviour over `useAgentConversation`.
 */
export function ConversationView({
  conv,
  canSend,
  hideInboxMessages,
  placeholder: placeholderProp,
  intro,
  draftKey,
  composerLabel = 'Message',
  afterConversation,
  beforeConversation,
  renderReplyFooter,
  autoFocus = true,
}: ConversationViewProps) {
  const client = useConversationClient()
  const { data: agent } = useQuery({ ...chatQueries.agent(client, conv.agentId ?? ''), enabled: !!conv.agentId })
  const { data: me } = useQuery(chatQueries.me(client))
  const [deliveryMode, setDeliveryMode] = useState<DeliveryMode>('steer')
  const [questionSubmitted, setQuestionSubmitted] = useState(false)
  const inputDisabled = !canSend

  useEffect(() => {
    setQuestionSubmitted(false)
  }, [agent?.status])

  const isTerminated = agent?.status === 'terminated'
  const isDormant = agent?.status === 'dormant'
  const isWaitingInput = agent?.status === 'waiting-input'
  const isActive = agent?.status === 'active' || isWaitingInput
  const blocking = isWaitingInput && agent?.questionData ? agent.questionData : null

  const exec = conv.executionStatus
  const isStreaming = conv.streamStatus === 'live' && conv.items.some((i) => i.kind === 'streaming')
  const agentBusy = exec === 'queued' || exec === 'waiting-sandbox' || exec === 'running' || exec === 'stopping'
  const isRunning = exec === 'running' || exec === 'waiting-sandbox'
  const hideComposer = isTerminated || !!blocking

  const placeholder =
    placeholderProp ??
    (inputDisabled
      ? 'You do not have permission to send chat messages'
      : exec === 'waiting-maintenance'
        ? 'Queued until maintenance completes…'
        : isRunning || isStreaming
          ? 'Message the agent...'
          : isWaitingInput
            ? 'Type your answer...'
            : isActive
              ? 'Type a message to intervene...'
              : 'Type a message...')

  const workingLabel =
    exec === 'waiting-sandbox'
      ? 'Sandbox capacity is temporarily unavailable; retrying automatically'
      : 'Agent is working...'

  // Queued interrupts/follow-ups and failed sends: what "Clear queue" removes (and restores to the box).
  const clearable = useMemo(
    () =>
      conv.items.flatMap((i) =>
        i.kind === 'pending' && (i.queued || i.status === 'queued' || i.status === 'failed') ? [i.content] : []
      ),
    [conv.items]
  )

  // Scroll: follow the bottom while the reader is there; keep their place when older rows load above.
  const scrollRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const stick = useRef(true)
  const olderAnchor = useRef<{ height: number; top: number } | null>(null)
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (olderAnchor.current && !conv.isFetchingOlder) {
      el.scrollTop = olderAnchor.current.top + (el.scrollHeight - olderAnchor.current.height)
      olderAnchor.current = null
    } else if (stick.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [conv.items, conv.isFetchingOlder, blocking, questionSubmitted])

  // Focus the composer on open — and again once permissions enable it, unless the reader has moved on.
  useEffect(() => {
    const input = textareaRef.current
    if (!autoFocus || inputDisabled || !input) return
    const chat = input.closest('[role="dialog"]')
    const active = document.activeElement
    const usingChat =
      active instanceof HTMLElement &&
      active !== chat &&
      !!chat?.contains(active) &&
      active.matches('input, textarea, select, button')
    if (!usingChat) input.focus()
  }, [autoFocus, inputDisabled])

  const loadOlder = () => {
    const el = scrollRef.current
    if (el) olderAnchor.current = { height: el.scrollHeight, top: el.scrollTop }
    conv.fetchOlder()
  }

  const handleSend = async (text: string) => {
    if (inputDisabled) return
    stick.current = true
    // Your message flies across the farm to the robot as a letter.
    if (conv.agentId) sendLetter({ from: { kind: 'me' }, toAgentId: conv.agentId })
    await conv.sendAccepted(text, { deliveryMode }).accepted
  }

  const empty = !conv.isLoading && conv.items.length === 0

  return (
    <div className="g-chat-body">
      <div
        ref={scrollRef}
        className="g-chat-scroll"
        onScroll={(e) => {
          const el = e.currentTarget
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX
        }}
      >
        {conv.hasOlder && (
          <button type="button" className="g-chat-older" disabled={conv.isFetchingOlder} onClick={loadOlder}>
            {conv.isFetchingOlder ? 'Loading older messages…' : 'Load older messages'}
          </button>
        )}
        <div className="g-chat-log" role="log" aria-live="polite" aria-relevant="additions" aria-label="Conversation">
          {conv.isLoading && conv.agentId && <p className="g-chat-system">Loading the conversation…</p>}
          {beforeConversation}
          {empty && !beforeConversation && (intro ?? <p className="g-chat-system">Send a message to start chatting</p>)}
          <Transcript
            items={conv.items}
            viewingUserId={me?.id}
            hideInboxMessages={hideInboxMessages}
            workingLabel={workingLabel}
            onRetry={conv.retrySend}
            renderReplyFooter={renderReplyFooter}
          />
        </div>
        {conv.compactionState && (
          <p className="g-chat-notice" role="status">
            Compacting context{conv.compactionState.reason === 'manual' ? ' (manual)' : ''}…
          </p>
        )}
        {isTerminated && (
          <p className="g-chat-notice">
            This robot was retired and can no longer receive messages. You can still read the conversation.
          </p>
        )}
        {isDormant && <p className="g-chat-notice">This robot is asleep. Sending a message will wake it.</p>}
        {blocking &&
          (questionSubmitted ? (
            <p className="g-chat-notice" role="status">
              Sending answer…
            </p>
          ) : (
            <QuestionCard
              key={agent?.id}
              questionData={blocking}
              disabled={inputDisabled}
              onSubmit={(answer) => {
                setQuestionSubmitted(true)
                if (conv.agentId) sendLetter({ from: { kind: 'me' }, toAgentId: conv.agentId })
                conv.send(answer)
              }}
            />
          ))}
        {afterConversation}
      </div>
      {!hideComposer && (
        <Composer
          onSend={handleSend}
          busy={agentBusy || isStreaming}
          streaming={isStreaming}
          deliveryMode={deliveryMode}
          onDeliveryModeChange={setDeliveryMode}
          onStop={inputDisabled ? undefined : conv.stop}
          queued={clearable}
          onCancelQueue={inputDisabled ? undefined : conv.cancelAllPending}
          disabled={inputDisabled}
          placeholder={placeholder}
          label={composerLabel}
          draftKey={draftKey}
          textareaRef={textareaRef}
        />
      )}
    </div>
  )
}
