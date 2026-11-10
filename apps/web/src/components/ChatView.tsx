import { SelectionPopup } from './ThemedPopup'
import { QUEUED_DELIVERY_OPTIONS } from '../lib/queuedDelivery'
import { ChatDropOverlay } from './ChatDropOverlay'
import { isFileDrag, isTextEntry } from '../lib/dropScope'
import { useToolRenderers } from '../lib/ToolRenderersContext'
import { ConversationSkeleton } from './loading/Skeleton'
import clsx from 'clsx'
import { Fragment, useState, useRef, useEffect, useCallback, useMemo, useContext } from 'react'
import { Link } from 'react-router'
import { flushSync } from 'react-dom'
import type {
  MessageMetadata,
  MessageToolCall,
  ContentBlock,
  DeliveryMode,
  ExecutionStatus,
  MessageSearchResult,
} from '@ficus/shared'
import { AssistantMessageContent, HumanMessageContent, ThinkingSection, ParsedTextContent } from './MessageContent'
import { TypingIndicator } from './TypingIndicator'
import { ToolSummary, ToolArgsView, ToolResultView, withoutHiddenToolCalls } from '../lib/tool-renderers'
import { blocksImages, toolCallImages } from '../lib/tool-result-images'
import { ToolImageStrip } from './ToolImageStrip'
import { getImageAttachState } from '../lib/imageAttach'
import {
  AutoScrollIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ClockIcon,
  CloseIcon,
  CodeIcon,
  ExpandIcon,
  FileIcon,
  ImageIcon,
  LightningIcon,
  MarkdownIcon,
  MicIcon,
  MinimizeIcon,
  PlusIcon,
  SendIcon,
  SparklesIcon,
  SpeakerOffIcon,
  SpeakerOnIcon,
  StopIcon,
  TrashIcon,
  SearchIcon,
} from './icons'
import { ChatHistorySearch, type ChatHistoryJumpOutcome } from './ChatHistorySearch'
import { isChatHistorySearchShortcut, shortcutModifierLabel } from '../lib/chatHistorySearch'
import { useFullscreen } from '../hooks/useFullscreen'
import { Modal } from './Modal'
import { ChatFullscreenContext } from './ChatFullscreenContext'
import { MobileChatOptionsSheet } from './MobileChatOptionsSheet'
import {
  InlineActionNotice,
  InlineActionRow,
  ToolInlineActionScopeProvider,
  ToolInlineActions,
} from './ToolInlineActions'
import { ToolInlineActionModal, type ToolInlineActionModalProps } from './ToolInlineActionModal'
import {
  getBlocksInlineActions,
  getToolFirewallFlag,
  getToolInlineActionUnavailableMessage,
  type ToolInlineAction,
} from '../lib/tool-inline-actions'
import { openExternalUrl, openLocalApp } from '../lib/openToolInlineTarget'
import { ToolFirewallBadge } from './ToolFirewallBadge'
import { MAX_OLDER_PAGE_SIZE, type RenderItem, type StreamingContentBlock } from '@ficus/client-react'
import { lastBlocksSegmentIndex, segmentAtNotices, type RenderedContentBlock } from '@ficus/client-core'
import { useVoiceRecorder } from '../hooks/useVoiceRecorder'
import { useVoiceEnabled } from '../hooks/useVoiceEnabled'
import { useVoiceKeyboardShortcuts } from '../hooks/useVoiceKeyboardShortcuts'
import { transcribeAudio } from '../api/transcribe'
import { uploadImages } from '../api/images'
import { useAgentFileAttachments } from '../hooks/useAgentFileAttachments'
import { apiUrl } from '../api/client'
import { useFileMention, FileMentionAutocomplete } from './FileMentionAutocomplete'
import { useImageSrcs } from '../hooks/useImageSrcs'
import { usePermissions } from '../hooks/usePermissions'
import { useStableRef } from '../hooks/useStableRef'
import { usePlantPresence } from '../hooks/usePlantPresence'
import { useAgentChatTyping } from '../hooks/useAgentChatTyping'
import { TeammatesTyping } from './TeammatesTyping'
import {
  dayLabel,
  earliestMessageDate,
  fullTimestamp,
  localDayKey,
  messageTimeLabel,
  startsGroup,
  type TimestampGroupEntry,
} from '../lib/chatTimestamps'

type ImageUploadStatus = 'pending' | 'uploading' | 'done' | 'error'

interface PendingImage {
  id: string
  file: File
  preview: string // object URL for display
  data: string // base64 for sending
  mimeType: string
  status: ImageUploadStatus
  progress: number // 0-100
  uploadedId?: string // ID from server after upload
  error?: string
}

/** Older pages a deep-link focus may load when the target's position is unknown. */
const MAX_FOCUS_OLDER_PAGES = 10
/** Messages one older page holds while jumping to a search result. */
const MAX_FOCUS_PAGE_MESSAGES = MAX_OLDER_PAGE_SIZE
/** Extra older pages a search jump may load beyond its estimate (merged turns, new arrivals). */
const MAX_FOCUS_EXTRA_PAGES = 2
/** Ask for a few more messages than the estimate so a jump rarely needs a second page. */
const FOCUS_PAGE_MARGIN = 10
/**
 * The farthest back (in messages newer than the target) a search jump loads. The transcript is
 * not virtualized, so every loaded message stays rendered; beyond this the panel says so instead.
 */
const MAX_FOCUS_JUMP_MESSAGES = 5000
/** Mounted chats offering history search, most recent last: answers the shortcut when nothing is focused. */
const searchableChats: Array<() => void> = []

function automatedSource(message: { role: string; metadata?: MessageMetadata | null }): 'inbox' | 'monitor' | null {
  if (message.role !== 'human') return null
  if (message.metadata?.source === 'inbox') return 'inbox'
  if (message.metadata?.source === 'monitor') return 'monitor'
  return null
}

interface ChatViewDependencies {
  useImageSrcsHook?: typeof useImageSrcs
  usePermissionsHook?: typeof usePermissions
  useVoiceEnabledHook?: typeof useVoiceEnabled
  useVoiceRecorderHook?: typeof useVoiceRecorder
  uploadAgentFile?: typeof import('../api/agentFiles').uploadAgentFile
  deleteAgentFile?: typeof import('../api/agentFiles').deleteAgentFile
  uploadImages?: typeof uploadImages
  ToolInlineActionModalComponent?: React.ComponentType<ToolInlineActionModalProps>
  openExternalUrl?: (url: string) => void
  /** Resolves to whether the app opened. */
  openLocalApp?: (localDeploymentId: string) => Promise<boolean>
}

interface ChatViewProps {
  dependencies?: ChatViewDependencies
  items: RenderItem[]
  // commands (wired to hook by AgentChat)
  onSend: (message: string, imageIds?: string[]) => void | Promise<void>
  agentId?: string
  onRetry?: (clientId: string) => void
  onStop?: () => void
  onAbortTool?: () => void
  onUpdatePendingMessage?: (messageId: string, operation: 'cancel' | DeliveryMode) => Promise<void>
  onCancelQueue?: () => void | Promise<void>
  /** Stop the running turn and deliver every queued interrupt in a new one. */
  onSendQueuedNow?: () => Promise<void>
  deliveryMode?: DeliveryMode
  onDeliveryModeChange?: (m: DeliveryMode) => void
  /** Set when the composer picked `deliveryMode` itself: shows the "Auto" indicator and why. */
  suggestedDelivery?: { now: boolean } | null
  /** Every change to the draft text (typing, voice, attachments, clearing after a send). */
  onDraftChange?: (draft: string) => void
  // pagination
  /** Load older history. `minimumMessages` asks for a larger page when jumping far back. */
  onLoadOlder?: (options?: { minimumMessages?: number }) => void | Promise<unknown>
  isLoadingOlder?: boolean
  hasOlderMessages?: boolean
  /** Initial messages fetch in flight — show a loader instead of a blank/empty flash. */
  isLoading?: boolean
  // presentational / state
  isStreaming?: boolean
  executionStatus?: ExecutionStatus | null
  viewingUserId?: string
  readOnly?: boolean
  hideInboxMessages?: boolean
  hideComposer?: boolean
  /** Show the manual fullscreen control. Phone composer taps can also expand embedded chats locally. */
  enableFullscreen?: boolean
  embedded?: boolean

  // retained presentational props (not part of reconciliation)
  error?: string | null
  placeholder?: string
  inputDisabled?: boolean
  inputDisabledReason?: string
  /** @deprecated use hideComposer */
  hideInput?: boolean
  header?: React.ReactNode
  /** Compact persistent status beneath header chrome, never over messages or composer. */
  headerStatus?: React.ReactNode
  inputPrefix?: React.ReactNode
  /** localStorage key for persisting draft input across navigations/refreshes */
  inputStorageKey?: string
  /** Squad ID for permissions, file mentions, and staging images before an agent exists. */
  squadId?: string
  renderMessageFooter?: (item: Extract<RenderItem, { kind: 'persisted' }>) => React.ReactNode
  /**
   * Content that starts the transcript, before the first message (e.g. an expandable archive of an
   * earlier conversation). It scrolls with the messages and shows once no older pages remain, so it
   * stays in chronological order. Growing it (expanding) keeps the reading position.
   */
  beforeMessages?: React.ReactNode
  afterMessages?: React.ReactNode
  /**
   * Floating controls that end the message flow (after afterMessages): right below the latest
   * response at the bottom, and pinned over the bottom of the messages while scrolled up, with the
   * transcript visible around them. Each control brings its own opaque surface (the slot has none)
   * and opts in to clicks with `pointer-events-auto`: the slot passes them to the messages beneath.
   * Stacked controls get a small gap between them.
   */
  stickyAfterMessages?: React.ReactNode
  className?: string
  autoFocus?: boolean
  sendLabel?: string
  sendButtonClassName?: string
  thinkingLabel?: string
  focusTrigger?: number
  /** Text to put in the composer (after any draft) and focus; a new `id` puts it in again. */
  composerDraft?: { id: number; text: string }
  /** Retained hidden chats must not register keyboard handlers. */
  keyboardShortcutsEnabled?: boolean
  tts?: {
    enabled: boolean
    isPlaying: boolean
    isSynthesizing: boolean
    playingMessageId: string | null
    speak: (messageId: string) => Promise<void>
    stop: () => void
    toggle: () => void
  }
  /** Show raw text instead of rendered markdown */
  showRawText?: boolean
  /**
   * Small live status beside the composer's controls (e.g. context used, "Waiting for sandbox").
   * Shown at every width, next to the mobile options button too.
   */
  composerStatus?: React.ReactNode
  /** Callback to toggle raw text view */
  onToggleRawText?: () => void
  /** Whether the selected/effective model accepts image input. Undefined preserves legacy allow behavior. */
  selectedModelSupportsImages?: boolean
  /**
   * Server message id to scroll to and highlight once on mount. Suppresses the normal
   * scroll-to-bottom behavior until the target is found (loading older pages as needed,
   * bounded) or given up on — bottom-follow then stays off until the user scrolls back
   * to the bottom themselves or sends a message.
   */
  focusMessageId?: string
  /** Inbox message id: focuses the transcript message that DELIVERED it. */
  focusInboxMessageId?: string
  /**
   * Offer a search of this conversation's full server-side history (header button and
   * Cmd/Ctrl+Shift+F). Selecting a result loads history back to it and highlights it.
   * Needs `agentId` and `onLoadOlder`.
   */
  enableHistorySearch?: boolean
  /**
   * Live typing with teammates in this agent's chat: show who else is typing, and tell them when
   * this person is (see useAgentChatTyping). Off for conversations private to one person.
   */
  showTeammateTyping?: boolean
}

// ---------------------------------------------------------------------------
// Row components
// ---------------------------------------------------------------------------

/** Group-head clock time as a semantic `<time>` element. */
function MessageTime({ at }: { at: Date }) {
  return <time dateTime={at.toISOString()}>{messageTimeLabel(at)}</time>
}

/** Centered day divider, shown before the first message of each local calendar day. */
function DayDivider({ label }: { label: string }) {
  return (
    <div data-testid="day-divider" className="flex items-center gap-3 py-1">
      <span aria-hidden="true" className="flex-1 border-t border-th-border" />
      <span className="text-[11px] text-muted">{label}</span>
      <span aria-hidden="true" className="flex-1 border-t border-th-border" />
    </div>
  )
}

function HumanMessageRow({
  message,
  viewingUserId,
  showSenderLabel,
  time,
  showRaw,
  agentId,
}: {
  agentId?: string
  message: { id: string; role: string; content: string; metadata?: MessageMetadata | null }
  viewingUserId?: string
  showSenderLabel?: boolean
  /** Set on a group head only: shown in the meta line above the bubble. */
  time?: Date | null
  showRaw?: boolean
}) {
  void viewingUserId // used by caller to compute showSenderLabel
  const auto = automatedSource(message)
  const sender = message.metadata?.sender
  const senderName = showSenderLabel && sender ? sender.name : null
  return (
    <div className="flex flex-col">
      {(senderName || time) && (
        <span data-testid="message-meta" className="text-[11px] text-muted self-end mr-1 mb-0.5">
          {senderName && <span data-testid="message-sender">{senderName}</span>}
          {senderName && time && ' · '}
          {time && <MessageTime at={time} />}
        </span>
      )}
      <div className={clsx('flex', 'justify-end')}>
        <div
          className={clsx(
            'max-w-[90%] md:max-w-[80%] rounded-lg',
            auto ? 'wrap-break-word' : 'px-3 md:px-4 py-2 md:py-3 bg-accent text-on-accent wrap-break-word'
          )}
        >
          <HumanMessageContent
            content={message.content}
            metadata={message.metadata}
            showRaw={showRaw}
            agentId={agentId}
          />
        </div>
      </div>
    </div>
  )
}

function AssistantMessageRow({
  message,
  blocks,
  showRaw,
  tts,
  agentId,
  onToolInlineAction,
  time,
}: {
  agentId?: string
  onToolInlineAction?: (action: ToolInlineAction) => void
  message: { id: string; role: string; content: string; metadata?: MessageMetadata | null }
  /** Saved blocks, plus any system notices pinned where they arrived in the live response. */
  blocks: RenderedContentBlock[]
  showRaw?: boolean
  tts?: ChatViewProps['tts']
  /** Set on a group head only: shown in the meta line above the reply. */
  time?: Date | null
}) {
  const segments = segmentAtNotices<ContentBlock>(blocks)
  const contentBlocks = segments.flatMap((segment) => (segment.type === 'blocks' ? segment.blocks : []))
  // A leading notice row brings its own py-2, so a margin on top of it would double the gap.
  const startsWithNotice = segments[0]?.type === 'notice'
  // If we have pre-merged blocks, inject them as metadata.content so AssistantMessageContent uses them
  const effectiveMetadata: MessageMetadata | null =
    contentBlocks.length > 0 ? { ...(message.metadata ?? {}), content: contentBlocks } : (message.metadata ?? null)

  return (
    // No bubble — agent text flows on the page (mobile vibe). Only human messages are bubbled.
    <div className="text-primary overflow-hidden pr-2 md:pr-10">
      {time && (
        // Unlike a human bubble, the reply has no padding of its own: space the time from it like the
        // reply's own parts (space-y-2), still less than the gap between rows, so it heads its reply.
        <div
          data-testid="message-meta"
          className={clsx('text-[11px] text-muted', startsWithNotice ? 'mb-0.5' : 'mb-2')}
        >
          <MessageTime at={time} />
        </div>
      )}
      <div>
        {segments.some((segment) => segment.type === 'notice') ? (
          segments.map((segment) =>
            segment.type === 'notice' ? (
              <SystemMessageRow key={segment.notice.id} content={segment.notice.text} />
            ) : (
              <AssistantMessageContent
                key={segment.key}
                content={message.content}
                metadata={{ ...(message.metadata ?? {}), content: segment.blocks }}
                showRaw={showRaw}
                agentId={agentId}
                onToolInlineAction={onToolInlineAction}
              />
            )
          )
        ) : (
          <AssistantMessageContent
            content={message.content}
            metadata={effectiveMetadata}
            showRaw={showRaw}
            agentId={agentId}
            onToolInlineAction={onToolInlineAction}
          />
        )}
        <NavigateButtons navigations={extractNavigationToolCalls(effectiveMetadata?.content)} />
        {tts && tts.playingMessageId === message.id && (
          <div className="flex items-center mt-2 pt-1.5 border-t border-th-border">
            <button
              type="button"
              onClick={() => tts.stop()}
              className="ficus-button ficus-button-secondary flex items-center gap-1 px-1.5 py-0.5 rounded text-xs transition-colors text-accent-light bg-accent/10 hover:bg-accent/20"
              title={tts.isSynthesizing ? 'Loading...' : 'Stop'}
            >
              {tts.isSynthesizing ? (
                <span className="inline-block w-3.5 h-3.5 border-2 border-accent-light/30 border-t-accent-light rounded-full animate-spin" />
              ) : (
                <StopIcon className="w-3.5 h-3.5" />
              )}
              <span>{tts.isSynthesizing ? 'Loading...' : 'Stop'}</span>
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function SystemMessageRow({ content }: { content: string }) {
  return (
    <div className="text-center py-2">
      <span className="text-sm text-placeholder">{content.replace(/^\[System\]\s*/, '')}</span>
    </div>
  )
}

function PendingMessageRow({
  content,
  imageIds,
  deliveryMode,
  status,
  queued,
  onSwitchMode,
  onCancel,
  onRetry,
  metadata,
  agentId,
}: {
  agentId?: string
  content: string
  imageIds?: string[]
  deliveryMode?: DeliveryMode
  status: 'sending' | 'queued' | 'failed'
  queued?: boolean
  onSwitchMode?: (mode: DeliveryMode) => Promise<void>
  onCancel?: () => Promise<void>
  onRetry?: () => void
  metadata?: MessageMetadata | null
}) {
  const [updating, setUpdating] = useState(false)
  const [updateError, setUpdateError] = useState<string | null>(null)
  const run = async (operation: () => Promise<void>) => {
    if (updating) return
    setUpdating(true)
    setUpdateError(null)
    try {
      await operation()
    } catch (error) {
      setUpdateError(error instanceof Error ? error.message : 'Could not update this message.')
    } finally {
      setUpdating(false)
    }
  }
  const effectiveMetadata: MessageMetadata | undefined =
    metadata || imageIds?.length || deliveryMode
      ? { ...(metadata ?? {}), ...(imageIds?.length ? { imageIds } : {}), ...(deliveryMode ? { deliveryMode } : {}) }
      : undefined
  const auto = automatedSource({ role: 'human', metadata: effectiveMetadata ?? null })
  const showHeader = queued && !auto && (deliveryMode || onCancel)
  const modeLabel = (
    <>
      {deliveryMode === 'steer' ? <LightningIcon className="h-3.5 w-3.5" /> : <ClockIcon className="h-3.5 w-3.5" />}
      {deliveryMode === 'steer' ? 'Interrupt' : 'Follow up'}
    </>
  )
  // Compact controls on the accent bubble: a translucent on-accent wash instead of the canvas hover fill.
  const bubbleControl =
    'ficus-button ficus-button-ghost text-inherit hover:text-on-accent hover:bg-on-accent/15 focus-visible:bg-on-accent/15 disabled:opacity-60'

  return (
    <div className="flex flex-col items-end">
      <div
        aria-busy={updating || undefined}
        className={clsx(
          'max-w-[90%] md:max-w-[80%] rounded-lg wrap-break-word transition-opacity',
          !auto && 'px-3 md:px-4 py-2 md:py-3 bg-accent text-on-accent',
          updating && 'opacity-70'
        )}
      >
        {showHeader && (
          <div className="-mx-1.5 -mt-0.5 mb-1 flex items-center justify-between gap-3 text-xs text-on-accent/80">
            {deliveryMode && onSwitchMode ? (
              <SelectionPopup
                label="Queued message delivery"
                title="Change when this queued message is delivered"
                value={deliveryMode}
                onChange={(mode) => {
                  if (mode !== deliveryMode) void run(() => onSwitchMode(mode))
                }}
                width={300}
                openOnHover
                disabled={updating}
                options={QUEUED_DELIVERY_OPTIONS}
                className={clsx(bubbleControl, 'inline-flex items-center gap-1.5 rounded px-1.5 py-0.5')}
              >
                {modeLabel}
                <ChevronDownIcon className="h-3 w-3" />
              </SelectionPopup>
            ) : deliveryMode ? (
              <span className="inline-flex items-center gap-1.5 px-1.5 py-0.5">{modeLabel}</span>
            ) : (
              <span />
            )}
            {onCancel && (
              <button
                type="button"
                aria-label="Cancel queued message"
                title="Cancel and move it back to the composer"
                disabled={updating}
                onClick={() => void run(onCancel)}
                className={clsx(bubbleControl, 'inline-flex items-center justify-center rounded p-1')}
              >
                <CloseIcon className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        )}
        <HumanMessageContent
          content={content}
          metadata={effectiveMetadata}
          showRaw={false}
          agentId={agentId}
          deliveryControl={
            // Inbox deliveries may change mode but are never canceled; question answers are always
            // interrupts, and monitor deliveries stay as sent.
            queued &&
            auto === 'inbox' &&
            deliveryMode &&
            onSwitchMode &&
            !effectiveMetadata?.inboxMessageSummaries?.some((summary) => summary.questionAnswer != null)
              ? { onChange: (mode) => void run(() => onSwitchMode(mode)), disabled: updating }
              : undefined
          }
        />

        {status === 'failed' && onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="ficus-button ficus-button-ghost -ml-1.5 mt-1 px-1.5 py-0.5 text-xs text-on-accent hover:bg-on-accent/15 hover:text-on-accent focus-visible:bg-on-accent/15"
          >
            Retry
          </button>
        )}
        {status === 'sending' && !auto && <div className="mt-1 text-xs text-on-accent/80">Sending…</div>}
      </div>
      {updateError && (
        <p
          role="alert"
          className="mt-1 max-w-[90%] text-right text-xs text-status-danger-600 dark:text-status-danger-400 md:max-w-[80%]"
        >
          {updateError}
        </p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main ChatView
// ---------------------------------------------------------------------------

/**
 * Server error CODES reach the composer verbatim (the upload route answers with
 * `{ error: 'ATTACHMENT_TOO_LARGE' }` and friends). Say what they mean; any
 * other message — including a server sentence — passes through unchanged.
 */
const AGENT_FILE_ERROR_TEXT: Record<string, string> = {
  ATTACHMENT_TOO_LARGE: 'This file is larger than the upload size limit.',
  INBOX_STORAGE_QUOTA_EXCEEDED: 'Attachment storage is full — remove some attachments and try again.',
  ATTACHMENT_ID_CONFLICT: 'This attachment slot is already used by a different file — remove it and attach again.',
}

export function agentFileErrorText(error?: string): string {
  if (!error) return 'Upload failed'
  return AGENT_FILE_ERROR_TEXT[error] ?? error
}

/** The draft saved for a conversation's composer, or '' when there is none or storage is unavailable. */
function readSavedDraft(storageKey: string): string {
  try {
    return localStorage.getItem(`chat-draft:${storageKey}`) ?? ''
  } catch {
    return ''
  }
}

export function ChatView({
  items,
  onSend,
  agentId,
  onRetry,
  onStop,
  onAbortTool,
  onCancelQueue,
  onSendQueuedNow,
  onUpdatePendingMessage,
  deliveryMode,
  onDeliveryModeChange,
  suggestedDelivery,
  onDraftChange,
  onLoadOlder,
  isLoadingOlder,
  hasOlderMessages,
  isLoading,
  isStreaming: isStreamingProp,
  executionStatus,
  viewingUserId,
  readOnly: _readOnly,
  hideComposer,
  hideInboxMessages,
  enableFullscreen = false,
  embedded: _embedded,
  error,
  placeholder = 'Type a message...',
  inputDisabled,
  inputDisabledReason,
  hideInput,
  header,
  headerStatus,
  inputPrefix,
  inputStorageKey,
  squadId,
  beforeMessages,
  afterMessages,
  renderMessageFooter,
  stickyAfterMessages,
  className,
  autoFocus = true,
  sendLabel = 'Send',
  sendButtonClassName,
  thinkingLabel = 'Thinking...',
  focusTrigger,
  composerDraft,
  keyboardShortcutsEnabled = true,
  tts,
  showRawText,
  onToggleRawText,
  composerStatus,
  selectedModelSupportsImages,
  focusMessageId,
  focusInboxMessageId,
  enableHistorySearch = false,
  showTeammateTyping = false,
  dependencies,
}: ChatViewProps) {
  const useImageSrcsHook = dependencies?.useImageSrcsHook ?? useImageSrcs
  const usePermissionsHook = dependencies?.usePermissionsHook ?? usePermissions
  const useVoiceEnabledHook = dependencies?.useVoiceEnabledHook ?? useVoiceEnabled
  const useVoiceRecorderHook = dependencies?.useVoiceRecorderHook ?? useVoiceRecorder
  const uploadImagesDependency = dependencies?.uploadImages ?? uploadImages
  const ActionModal = dependencies?.ToolInlineActionModalComponent ?? ToolInlineActionModal
  const [selectedToolAction, setSelectedToolAction] = useState<ToolInlineAction | null>(null)
  const openExternal = dependencies?.openExternalUrl ?? openExternalUrl
  const openApp = dependencies?.openLocalApp ?? openLocalApp
  // A short notice for an action whose target is gone, so the click doesn't silently do nothing.
  const [toolActionNotice, setToolActionNotice] = useState<{ id: number; message: string } | null>(null)
  const showToolActionUnavailable = useCallback((kind: ToolInlineAction['kind']) => {
    setToolActionNotice((current) => ({
      id: (current?.id ?? 0) + 1,
      message: getToolInlineActionUnavailableMessage(kind),
    }))
  }, [])
  const dismissToolActionNotice = useCallback(() => setToolActionNotice(null), [])
  // Pull requests and local apps open in a new tab during the click (later, the browser would block it);
  // every other target opens in place.
  const openToolInlineAction = useCallback(
    (action: ToolInlineAction) => {
      setToolActionNotice(null)
      if (action.kind === 'pull_request') openExternal(action.url)
      else if (action.kind === 'local_app') {
        void openApp(action.localDeploymentId).then((opened) => {
          if (!opened) showToolActionUnavailable(action.kind)
        })
      } else setSelectedToolAction(action)
    },
    [openApp, openExternal, showToolActionUnavailable]
  )
  const toolActionScope = useMemo(() => ({ agentId, squadId }), [agentId, squadId])
  // Derived streaming state
  const isStreaming = isStreamingProp ?? items.some((i) => i.kind === 'streaming')

  // Whether the agent is actively working — used only for composer affordances (showing the
  // delivery-mode send toggle). The activity *indicator* itself is no longer derived here: combine()
  // emits a `kind: 'working'` RenderItem at the right position, rendered in the items map below.
  const agentBusy =
    executionStatus === 'queued' ||
    executionStatus === 'waiting-sandbox' ||
    executionStatus === 'running' ||
    executionStatus === 'stopping'

  // Clearable pending items (for the clear-queue button): genuinely queued interrupts/follow-ups or
  // failed sends — NOT the lone 'sending' message that started the current turn (clearing it would
  // race the run it triggered). Matches the hook's clearable set.
  // Exactly what Clear removes: queued messages a person sent (never the send that opened the
  // current turn, and never inbox or monitor deliveries) plus failed sends.
  const pendingItems = useMemo(
    () =>
      items.filter(
        (i) =>
          i.kind === 'pending' &&
          (i.queued || i.status === 'failed') &&
          !automatedSource({ role: 'human', metadata: i.metadata })
      ),
    [items]
  )
  const queuedInterruptCount = useMemo(
    () => items.filter((i) => i.kind === 'pending' && i.queued && i.deliveryMode !== 'follow-up').length,
    [items]
  )

  // Uncontrolled textarea — value lives in a ref to avoid re-rendering
  // the entire component on every keystroke. Only `hasInput` (boolean)
  // is state so the send button / voice shortcuts update on empty↔non-empty.
  // The saved draft is read once, when the composer mounts.
  const [initialDraft] = useState(() => (inputStorageKey ? readSavedDraft(inputStorageKey) : ''))
  const inputRef = useRef(initialDraft)
  const [hasInput, setHasInput] = useState(() => !!initialDraft.trim())
  // Another conversation's draft (a new storage key) decides hasInput in the same render;
  // the effect below then puts its text into the textarea.
  const [draftStorageKey, setDraftStorageKey] = useState(inputStorageKey)
  if (draftStorageKey !== inputStorageKey) {
    setDraftStorageKey(inputStorageKey)
    if (inputStorageKey) setHasInput(!!readSavedDraft(inputStorageKey).trim())
  }
  // Image state
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([])
  // Composer errors, declared before the callbacks that clear them.
  const [imagePreparationError, setImagePreparationError] = useState<string | null>(null)
  const [imageError, setImageError] = useState<string | null>(null)
  const [sendError, setSendError] = useState<string | null>(null)
  const [clearQueueError, setClearQueueError] = useState<string | null>(null)
  const onDraftChangeRef = useStableRef(onDraftChange)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  // The textarea is uncontrolled: when it mounts (or remounts after the composer was
  // hidden) it starts from the text kept in inputRef, without reading the ref in render.
  const attachTextarea = useCallback((textarea: HTMLTextAreaElement | null) => {
    textareaRef.current = textarea
    if (textarea) textarea.value = inputRef.current
  }, [])
  const inputContainerRef = useRef<HTMLDivElement>(null)
  // When a focus target is requested, start with auto-scroll disabled so the initial
  // scroll-to-bottom effect doesn't fire before we've had a chance to jump to the target.
  const focusRequested = !!(focusMessageId || focusInboxMessageId)
  const [autoScroll, _setAutoScroll] = useState(() => !focusRequested)
  // A new focus target turns auto-scroll off in the render that receives it; the effect
  // that runs the focus search only touches refs and the DOM.
  const focusTargetKey = focusRequested ? `${focusMessageId ?? ''}\n${focusInboxMessageId ?? ''}` : null
  const [appliedFocusTargetKey, setAppliedFocusTargetKey] = useState(focusTargetKey)
  if (appliedFocusTargetKey !== focusTargetKey) {
    setAppliedFocusTargetKey(focusTargetKey)
    if (focusTargetKey) _setAutoScroll(false)
  }
  const autoScrollRef = useRef(!focusRequested)
  const pendingManualTextareaScrollTopRef = useRef<number | null>(null)
  const updateAutoScroll = useCallback((value: boolean) => {
    autoScrollRef.current = value
    if (value) pendingManualTextareaScrollTopRef.current = null
    _setAutoScroll(value)
  }, [])
  const pinTranscriptToBottom = useCallback(() => {
    const scrollEl = scrollContainerRef.current
    if (!autoScrollRef.current || !scrollEl) return

    const distance = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight
    if (distance > 1) scrollEl.scrollTop = scrollEl.scrollHeight
  }, [])
  const resizeTextarea = useCallback(
    (textarea: HTMLTextAreaElement) => {
      const scrollEl = scrollContainerRef.current
      const inputEl = inputContainerRef.current
      const previousScrollTop = scrollEl?.scrollTop
      const previousInputHeight = inputEl?.offsetHeight

      // Hidden inline conversations have no measurable scrollHeight. Keep the natural height until visible.
      if (!textarea.getClientRects().length) return
      textarea.style.height = 'auto'
      // scrollHeight excludes borders; include them to avoid a scrollbar on one-line drafts.
      textarea.style.height = `${textarea.scrollHeight + textarea.offsetHeight - textarea.clientHeight}px`

      if (!scrollEl || previousScrollTop == null) return
      if (autoScrollRef.current) {
        pendingManualTextareaScrollTopRef.current = null
        pinTranscriptToBottom()
      } else {
        // Native scroll anchoring can run after the input handler when the composer
        // truly changes height. Keep this value through the observer delivery too.
        if (
          pendingManualTextareaScrollTopRef.current == null &&
          inputEl &&
          previousInputHeight != null &&
          inputEl.offsetHeight !== previousInputHeight
        ) {
          pendingManualTextareaScrollTopRef.current = previousScrollTop
        }
        if (scrollEl.scrollTop !== previousScrollTop) scrollEl.scrollTop = previousScrollTop
      }
    },
    [pinTranscriptToBottom]
  )
  const { can, isLoading: permissionsLoading, identity } = usePermissionsHook(squadId)
  const teammateTyping = useAgentChatTyping(showTeammateTyping ? agentId : undefined, {
    selfUserId: identity?.type === 'user' ? identity.userId : null,
  })
  const canUploadImages = !permissionsLoading && can('agents:write')
  const imageAttachState = getImageAttachState({ canUploadImages, selectedModelSupportsImages })

  /** Put text in the uncontrolled textarea (ref + DOM) and report it, without touching state. */
  const writeComposerText = useCallback(
    (value: string) => {
      inputRef.current = value
      if (textareaRef.current) {
        textareaRef.current.value = value
        resizeTextarea(textareaRef.current)
      }
      onDraftChangeRef.current?.(value)
    },
    [resizeTextarea, onDraftChangeRef]
  )
  /** Set the textarea value imperatively (ref + DOM + hasInput state) */
  const setInputValue = useCallback(
    (value: string) => {
      writeComposerText(value)
      setHasInput(!!value.trim())
    },
    [writeComposerText]
  )

  // Debounced localStorage save — driven from onChange, not useEffect. The pending write remembers
  // its key, so leaving a conversation (key change or unmount) still keeps what was just typed there.
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingDraftRef = useRef<{ key: string; value: string } | null>(null)
  const flushDraft = useCallback(() => {
    if (draftTimerRef.current) clearTimeout(draftTimerRef.current)
    draftTimerRef.current = null
    const pending = pendingDraftRef.current
    pendingDraftRef.current = null
    if (!pending) return
    try {
      if (pending.value) {
        localStorage.setItem(`chat-draft:${pending.key}`, pending.value)
      } else {
        localStorage.removeItem(`chat-draft:${pending.key}`)
      }
    } catch {
      // localStorage may be full or unavailable
    }
  }, [])
  const saveDraft = useCallback(
    (value: string) => {
      if (!inputStorageKey) return
      if (draftTimerRef.current) clearTimeout(draftTimerRef.current)
      pendingDraftRef.current = { key: inputStorageKey, value }
      draftTimerRef.current = setTimeout(flushDraft, 1000)
    },
    [inputStorageKey, flushDraft]
  )

  // Write any pending draft on unmount instead of dropping it
  useEffect(() => flushDraft, [flushDraft])

  // Reload draft when the storage key changes (e.g. navigating between agents). hasInput
  // already followed the key during render.
  useEffect(() => {
    flushDraft()
    if (!inputStorageKey) return
    writeComposerText(readSavedDraft(inputStorageKey))
  }, [inputStorageKey, writeComposerText, flushDraft])

  const fileInputRef = useRef<HTMLInputElement>(null)
  const agentFileInputRef = useRef<HTMLInputElement>(null)
  const agentFileSelectionRef = useRef<{ start: number; end: number } | undefined>(undefined)
  const agentFiles = useAgentFileAttachments({
    agentId,
    getText: () => textareaRef.current?.value ?? inputRef.current,
    getCaret: () => textareaRef.current?.selectionStart ?? undefined,
    uploadFile: dependencies?.uploadAgentFile,
    deleteFile: dependencies?.deleteAgentFile,
    setText: (text, caret, options) => {
      setInputValue(text)
      saveDraft(text)
      noteComposerInput(text)
      // Focus follows the CALLER's intent: attaching or removing a chip is the
      // user asking for the composer back, while an upload settling is not a
      // user action and must not yank focus from wherever they are. The caret
      // is restored either way (React resets it to the end of the new value).
      requestAnimationFrame(() => {
        if (options?.focus) textareaRef.current?.focus()
        if (caret != null) textareaRef.current?.setSelectionRange(caret, caret)
      })
    },
  })
  const fullscreen = useFullscreen({ queryParam: enableFullscreen ? 'fullscreen' : undefined })
  // Router transitions may commit after a mobile user gesture has ended. Keep
  // tap-to-expand synchronous and local, including inside parent-owned layouts.
  const {
    isFullscreen: isMobileExpanded,
    enterFullscreen: enterMobileFullscreen,
    exitFullscreen: exitMobileFullscreen,
  } = useFullscreen()
  const expandParentChat = useContext(ChatFullscreenContext)
  const isFullscreen = fullscreen.isFullscreen || isMobileExpanded
  const toggleFullscreen = isMobileExpanded ? exitMobileFullscreen : fullscreen.toggleFullscreen

  useEffect(() => {
    // Retained Assistant tabs stay mounted when hidden. Their portal must not
    // outlive the visible conversation when navigation switches to another tab.
    if (!keyboardShortcutsEnabled && isMobileExpanded) exitMobileFullscreen()
  }, [keyboardShortcutsEnabled, isMobileExpanded, exitMobileFullscreen])

  const expandMobileComposer = (event: React.MouseEvent<HTMLTextAreaElement>) => {
    const textarea = event.currentTarget
    if (
      expandParentChat === false ||
      isFullscreen ||
      !window.matchMedia('(max-width: 767px)').matches ||
      textarea.closest('.mobile-chat-modal')
    )
      return

    const { selectionStart, selectionEnd, selectionDirection } = textarea
    // Commit the portal and focus its input in the same user gesture so mobile
    // Safari can keep the keyboard open. ChatView stays mounted: drafts, files,
    // uploads, and conversation state survive expansion.
    flushSync(expandParentChat ?? enterMobileFullscreen)
    const expandedTextarea = textareaRef.current
    if (expandedTextarea) {
      resizeTextarea(expandedTextarea)
      expandedTextarea.focus({ preventScroll: true })
      expandedTextarea.setSelectionRange(selectionStart, selectionEnd, selectionDirection)
    }
  }

  // ---------------------------------------------------------------------
  // focusMessageId: scroll to and briefly highlight one message on mount,
  // loading older pages (bounded) if the target isn't in the loaded window.
  // ---------------------------------------------------------------------
  const itemsStableRef = useStableRef(items)
  const hasOlderMessagesStableRef = useStableRef(hasOlderMessages)
  const onLoadOlderStableRef = useStableRef(onLoadOlder)
  // True while we're driving our own load-older loop — guards the near-top scroll
  // trigger (handleScroll) from firing a second, uncoordinated fetchOlder underneath us.
  const focusSearchActiveRef = useRef(false)
  // While set, the user is being taken to (or reading) a focused past message:
  // bottom-following must NOT re-engage from layout-induced scroll positions
  // (streaming used to yank the view back to the bottom mid-read). Only a USER
  // scroll to the bottom — or sending a message — clears it.
  const focusModeRef = useRef(false)
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null)
  const highlightTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  /**
   * Find the rendered item carrying the focus target and return its render id
   * (the value the row's data-message-id starts with). A chat target matches
   * the persisted row ids; an inbox target matches the transcript message that
   * DELIVERED it (metadata.inboxMessageIds, batched deliveries included).
   */
  const findFocusTarget = useCallback(
    (target: { messageId?: string; inboxMessageId?: string }) => {
      const deliversInbox = (message: { metadata?: unknown }) => {
        const ids = (message.metadata as { inboxMessageIds?: unknown } | null | undefined)?.inboxMessageIds
        return Array.isArray(ids) && !!target.inboxMessageId && ids.includes(target.inboxMessageId)
      }
      for (const item of itemsStableRef.current) {
        if (item.kind !== 'persisted') continue
        if (
          target.messageId &&
          (item.id === target.messageId || item.mergedFrom?.some((m) => m.id === target.messageId))
        )
          return item.id
        if (target.inboxMessageId && (deliversInbox(item.message) || item.mergedFrom?.some(deliversInbox)))
          return item.id
      }
      return null
    },
    [itemsStableRef]
  )

  /** The running focus jump; starting another one cancels it. */
  const focusRunRef = useRef<{ cancelled: boolean } | null>(null)

  /**
   * Bring one message into view: load older pages until it is rendered (bounded), then scroll
   * to it and briefly highlight it. `newerCount` (how many messages are newer than the target,
   * known from history search) sizes the older pages so a far jump takes a few requests, and
   * raises the page bound to reach it. Without it, at most MAX_FOCUS_OLDER_PAGES default pages load.
   */
  const startFocus = useCallback(
    (
      target: { messageId?: string; inboxMessageId?: string },
      options: { newerCount?: number; onMissing: 'bottom' | 'stay' }
    ) => {
      if (focusRunRef.current) focusRunRef.current.cancelled = true
      const run = { cancelled: false }
      focusRunRef.current = run
      focusSearchActiveRef.current = true
      focusModeRef.current = true
      // Callers turn the autoScroll state off: during render for a focus prop, in the handler for a jump.
      autoScrollRef.current = false
      const scrollToItem = (itemId: string) => {
        scrollContainerRef.current
          ?.querySelector<HTMLElement>(`[data-message-id~="${itemId}"]`)
          ?.scrollIntoView?.({ block: 'center' })
      }
      const settle = () => {
        if (focusRunRef.current === run) focusSearchActiveRef.current = false
      }
      const { newerCount } = options
      const maxOlderPages =
        newerCount === undefined
          ? MAX_FOCUS_OLDER_PAGES
          : Math.ceil((newerCount + 1) / MAX_FOCUS_PAGE_MESSAGES) + MAX_FOCUS_EXTRA_PAGES

      const outcome = (async (): Promise<ChatHistoryJumpOutcome> => {
        let attempts = 0
        let foundId: string | null = null
        while (!run.cancelled) {
          foundId = findFocusTarget(target)
          if (foundId) break
          if (newerCount !== undefined && newerCount >= MAX_FOCUS_JUMP_MESSAGES) break
          const loadOlder = onLoadOlderStableRef.current
          if (!hasOlderMessagesStableRef.current || attempts >= maxOlderPages || !loadOlder) break
          attempts += 1
          const previousItems = itemsStableRef.current
          const loaded = previousItems.reduce(
            (count, item) => count + (item.kind === 'persisted' ? (item.mergedFrom?.length ?? 1) : 0),
            0
          )
          const result: unknown = loadOlder(
            newerCount === undefined ? undefined : { minimumMessages: newerCount + 1 - loaded + FOCUS_PAGE_MARGIN }
          )
          if (result && typeof (result as Promise<unknown>).then === 'function') {
            await result
          } else {
            await Promise.resolve()
          }
          // Bounded wait for the fetched page to actually land in `items` before rechecking.
          const start = Date.now()
          while (!run.cancelled && itemsStableRef.current === previousItems && Date.now() - start < 5000) {
            await new Promise((resolve) => setTimeout(resolve, 30))
          }
        }
        if (run.cancelled) return 'cancelled'
        if (!foundId) {
          settle()
          if (options.onMissing === 'bottom') {
            // Never found the target — fall back to normal bottom-anchored behavior.
            focusModeRef.current = false
            updateAutoScroll(true)
            requestAnimationFrame(pinTranscriptToBottom)
          }
          return newerCount !== undefined && newerCount >= MAX_FOCUS_JUMP_MESSAGES ? 'too-far' : 'not-found'
        }
        setHighlightedMessageId(foundId)
        if (highlightTimeoutRef.current) clearTimeout(highlightTimeoutRef.current)
        highlightTimeoutRef.current = setTimeout(() => setHighlightedMessageId(null), 2000)
        // PIN PHASE: a single scrollIntoView was not enough — prepended pages,
        // images, and streaming appends keep shifting layout for a while, which
        // read as "scrolls up then stops partway". Re-assert the target position
        // after paint and again whenever items change, briefly.
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
        if (run.cancelled) return 'cancelled'
        scrollToItem(foundId)
        const settleStart = Date.now()
        let lastItems = itemsStableRef.current
        while (!run.cancelled && Date.now() - settleStart < 2000) {
          await new Promise((resolve) => setTimeout(resolve, 150))
          if (itemsStableRef.current !== lastItems) {
            lastItems = itemsStableRef.current
            scrollToItem(foundId)
          }
        }
        settle()
        // focusModeRef stays set: the user is reading a past message, and
        // bottom-follow only returns on their own scroll-to-bottom or send.
        return 'found'
      })()

      const cancel = () => {
        run.cancelled = true
        if (focusRunRef.current === run) {
          focusRunRef.current = null
          focusSearchActiveRef.current = false
        }
      }
      return { outcome, cancel }
    },
    // The loop reads live state via stable refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [findFocusTarget, pinTranscriptToBottom, updateAutoScroll]
  )

  useEffect(() => {
    if (!focusMessageId && !focusInboxMessageId) return
    const { cancel } = startFocus(
      {
        ...(focusMessageId ? { messageId: focusMessageId } : {}),
        ...(focusInboxMessageId ? { inboxMessageId: focusInboxMessageId } : {}),
      },
      { onMissing: 'bottom' }
    )
    return cancel
  }, [focusMessageId, focusInboxMessageId, startFocus])

  // The phone composer's options sheet (attach, voice, auto-scroll, raw text, history search).
  const [attachSheetOpen, setAttachSheetOpen] = useState(false)
  const attachSheetTriggerRef = useRef<HTMLButtonElement>(null)

  // History search: a panel under the header that searches the whole conversation on the
  // server and jumps to a result through startFocus.
  const historySearchAvailable = enableHistorySearch && !!agentId && !!onLoadOlder
  const [historySearchOpen, setHistorySearchOpen] = useState(false)
  const historySearchButtonRef = useRef<HTMLButtonElement>(null)
  const historyJumpRef = useRef<{ cancel: () => void } | null>(null)
  const openHistorySearch = useCallback(() => setHistorySearchOpen(true), [])
  const closeHistorySearch = useCallback(() => {
    setHistorySearchOpen(false)
    requestAnimationFrame(() => {
      const button = historySearchButtonRef.current
      button?.focus({ preventScroll: true })
      // On phones the composer's search button is hidden and lives in the options sheet; its trigger takes focus.
      if (button && button.ownerDocument.activeElement !== button) {
        attachSheetTriggerRef.current?.focus({ preventScroll: true })
      }
    })
  }, [])
  const jumpToSearchResult = useCallback(
    (result: MessageSearchResult) => {
      historyJumpRef.current?.cancel()
      _setAutoScroll(false)
      const jump = startFocus({ messageId: result.id }, { newerCount: result.newerCount, onMissing: 'stay' })
      historyJumpRef.current = jump
      return jump.outcome
    },
    [startFocus]
  )
  useEffect(() => () => historyJumpRef.current?.cancel(), [])
  // A different conversation: close the panel rather than search the old one.
  const [historySearchAgentId, setHistorySearchAgentId] = useState(agentId)
  if (historySearchAgentId !== agentId) {
    setHistorySearchAgentId(agentId)
    setHistorySearchOpen(false)
  }
  const openHistorySearchRef = useStableRef(openHistorySearch)
  useEffect(() => {
    if (!historySearchAvailable) return
    // The chat holding focus answers the shortcut; with nothing focused, the most recently mounted one does.
    const entry = () => openHistorySearchRef.current()
    searchableChats.push(entry)
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !isChatHistorySearchShortcut(e)) return
      const active = document.activeElement
      const focusedHere =
        !!active && !!scrollContainerRef.current?.closest('[data-drop-scope="chat"]')?.contains(active)
      const nothingFocused = !active || active === document.body
      if (!focusedHere && !(nothingFocused && searchableChats.at(-1) === entry)) return
      e.preventDefault()
      entry()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      searchableChats.splice(searchableChats.indexOf(entry), 1)
    }
  }, [historySearchAvailable, openHistorySearchRef])

  useEffect(() => {
    return () => {
      if (highlightTimeoutRef.current) clearTimeout(highlightTimeoutRef.current)
    }
  }, [])

  // Every change a person makes to the composer tells teammates they're typing, until it's empty.
  const pendingImageCountRef = useRef(pendingImages.length)
  const { composerChanged } = teammateTyping
  const noteComposerInput = useCallback(
    (text: string) => composerChanged(!!text.trim() || pendingImageCountRef.current > 0),
    [composerChanged]
  )
  // Images come and go only by a person's hand (attach, paste, remove, restore, send).
  useEffect(() => {
    if (pendingImageCountRef.current === pendingImages.length) return
    pendingImageCountRef.current = pendingImages.length
    noteComposerInput(inputRef.current)
  }, [pendingImages.length, noteComposerInput])
  const [isUploading, setIsUploading] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const isSubmittingRef = useRef(false)
  const [isPreparingImages, setIsPreparingImages] = useState(false)
  const imagePreparationCountRef = useRef(0)
  const hasImageErrors = pendingImages.some((image) => image.status === 'error')
  const uploadedPendingImageIds = useMemo(
    () => pendingImages.map((img) => img.uploadedId).filter((id): id is string => Boolean(id)),
    [pendingImages]
  )
  const pendingImageSrcs = useImageSrcsHook(uploadedPendingImageIds)
  const [isDragging, setIsDragging] = useState(false)
  const [isClearingQueue, setIsClearingQueue] = useState(false)
  const [showClearQueue, setShowClearQueue] = useState(false)
  const [confirmingClearQueue, setConfirmingClearQueue] = useState(false)
  const clearQueueConfirmTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Track whether we've ever seen an empty pending queue (for "loaded with pending already" detection)
  const queueEmpty = pendingItems.length === 0
  const [sawPendingEmpty, setSawPendingEmpty] = useState(queueEmpty)

  // Show clear queue button when there are pending (queued/failed) items. The immediate cases are
  // decided while rendering; only the delayed one needs a timer.
  if (queueEmpty) {
    if (showClearQueue) setShowClearQueue(false)
    if (confirmingClearQueue) setConfirmingClearQueue(false)
    if (!sawPendingEmpty) setSawPendingEmpty(true)
  } else if (!showClearQueue && (isStreaming || !sawPendingEmpty)) {
    // Show immediately if streaming (interrupt/follow-up), or if we loaded with pending items
    // already (hydration / refresh scenario): we never saw the queue empty since mount, so the
    // data arrived with pending already present.
    setShowClearQueue(true)
  }
  useEffect(() => {
    if (!queueEmpty || !clearQueueConfirmTimeoutRef.current) return
    clearTimeout(clearQueueConfirmTimeoutRef.current)
    clearQueueConfirmTimeoutRef.current = null
  }, [queueEmpty])
  useEffect(() => {
    if (queueEmpty || isStreaming || !sawPendingEmpty) return
    // Otherwise, delay showing the button to avoid flicker when agent picks up quickly
    const timer = setTimeout(() => {
      setShowClearQueue(true)
    }, 5000)

    return () => clearTimeout(timer)
  }, [pendingItems.length, queueEmpty, isStreaming, sawPendingEmpty])

  // File mention autocomplete
  const { mentionState, checkForMention, closeMention, selectFile } = useFileMention(
    squadId,
    textareaRef,
    inputRef,
    setInputValue
  )

  // Canceled queued messages return to the composer so nothing typed is lost.
  const restoreToComposer = useCallback(
    (restoredText: string, restoredImageIds: string[]) => {
      const prev = inputRef.current
      const next = prev ? prev + '\n\n' + restoredText : restoredText
      setInputValue(next)
      saveDraft(next)
      noteComposerInput(next)
      // Focus after restoring text; setInputValue already resized the textarea.
      setTimeout(() => textareaRef.current?.focus(), 0)
      if (restoredImageIds.length > 0) {
        setPendingImages((prev) => [
          ...prev,
          ...restoredImageIds.map((id) => ({
            id: `restored-${id}`,
            file: new File([], 'restored'),
            preview: pendingImageSrcs[id] ?? apiUrl(`/images/${id}`),
            data: '',
            mimeType: 'image/png',
            status: 'done' as ImageUploadStatus,
            progress: 100,
            uploadedId: id,
          })),
        ])
      }
    },
    [pendingImageSrcs, saveDraft, setInputValue, noteComposerInput]
  )

  const handleCancelQueue = useCallback(async () => {
    if (!onCancelQueue || pendingItems.length === 0) return
    if (clearQueueConfirmTimeoutRef.current) {
      clearTimeout(clearQueueConfirmTimeoutRef.current)
      clearQueueConfirmTimeoutRef.current = null
    }
    setConfirmingClearQueue(false)
    setIsClearingQueue(true)
    setClearQueueError(null)
    try {
      // Collect content from pending items to restore to input
      const restoredText = pendingItems
        .filter((i) => i.kind === 'pending')
        .map((i) => (i.kind === 'pending' ? i.content : ''))
        .join('\n\n')
      const restoredImageIds = pendingItems
        .filter((i) => i.kind === 'pending')
        .flatMap((i) => (i.kind === 'pending' ? (i.imageIds ?? []) : []))

      await onCancelQueue()
      restoreToComposer(restoredText, restoredImageIds)
    } catch (error) {
      setClearQueueError(error instanceof Error ? error.message : 'Please try again.')
    } finally {
      setIsClearingQueue(false)
    }
  }, [onCancelQueue, pendingItems, restoreToComposer])

  const handleCancelQueueClick = useCallback(async () => {
    if (isClearingQueue) return
    if (!confirmingClearQueue) {
      setConfirmingClearQueue(true)
      if (clearQueueConfirmTimeoutRef.current) clearTimeout(clearQueueConfirmTimeoutRef.current)
      clearQueueConfirmTimeoutRef.current = setTimeout(() => {
        clearQueueConfirmTimeoutRef.current = null
        setConfirmingClearQueue(false)
      }, 3000)
      return
    }

    await handleCancelQueue()
  }, [confirmingClearQueue, handleCancelQueue, isClearingQueue])

  useEffect(() => {
    return () => {
      if (clearQueueConfirmTimeoutRef.current) clearTimeout(clearQueueConfirmTimeoutRef.current)
    }
  }, [])

  // Track user-initiated scrolling to distinguish from DOM-induced scroll events.
  // Only disable auto-scroll when the user is actually scrolling (wheel, touch).
  const userScrollingRef = useRef(false)
  const userScrollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const markUserScrolling = useCallback(() => {
    pendingManualTextareaScrollTopRef.current = null
    userScrollingRef.current = true
    if (userScrollTimeoutRef.current) clearTimeout(userScrollTimeoutRef.current)
    // Reset after a short delay - if no more user input, assume scroll events are programmatic
    userScrollTimeoutRef.current = setTimeout(() => {
      userScrollingRef.current = false
    }, 150)
  }, [])

  // Threshold for loading older messages when scrolling near top
  const LOAD_MORE_THRESHOLD = 150

  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current
    if (!el) return
    const { scrollTop } = el
    const distFromBottom = el.scrollHeight - scrollTop - el.clientHeight

    // Only disable auto-scroll if user is actively scrolling and moves away from bottom
    if (userScrollingRef.current && autoScrollRef.current && distFromBottom > 30) {
      updateAutoScroll(false)
    } else if (
      !autoScrollRef.current &&
      pendingManualTextareaScrollTopRef.current == null &&
      distFromBottom < 30 &&
      (userScrollingRef.current || !focusModeRef.current)
    ) {
      // While focused on a past message, only a USER scroll to the bottom
      // re-engages follow — layout shifts landing at the bottom must not.
      focusModeRef.current = false
      updateAutoScroll(true)
    }

    // Load older messages when scrolling near the top. Skipped while the focusMessageId
    // search is driving its own load-older loop — letting both fire risks duplicate,
    // uncoordinated fetchOlder calls.
    if (
      scrollTop < LOAD_MORE_THRESHOLD &&
      hasOlderMessages &&
      !isLoadingOlder &&
      onLoadOlder &&
      !focusSearchActiveRef.current
    ) {
      onLoadOlder()
    }
  }, [updateAutoScroll, hasOlderMessages, isLoadingOlder, onLoadOlder])

  useEffect(() => {
    if (focusTrigger) textareaRef.current?.focus()
  }, [focusTrigger])

  const composerDraftId = composerDraft?.id
  const composerDraftRef = useStableRef(composerDraft)
  useEffect(() => {
    const draft = composerDraftRef.current
    if (!composerDraftId || !draft) return
    const current = inputRef.current.trimEnd()
    const next = current ? `${current}\n\n${draft.text}` : draft.text
    setInputValue(next)
    saveDraft(next)
    noteComposerInput(next)
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.focus()
    textarea.setSelectionRange(next.length, next.length)
  }, [composerDraftId, composerDraftRef, setInputValue, saveDraft, noteComposerInput])

  // Coalesce streaming updates, then recheck the live follow state before scrolling.
  useEffect(() => {
    if (!autoScrollRef.current) return
    const frame = requestAnimationFrame(pinTranscriptToBottom)
    return () => cancelAnimationFrame(frame)
  }, [items, pinTranscriptToBottom])

  // Auto-scroll when input area resizes (e.g., interrupt/follow-up buttons appear)
  // This prevents the input area growth from covering the bottom of the chat
  useEffect(() => {
    const inputEl = inputContainerRef.current
    if (!inputEl) return

    const observer = new ResizeObserver(() => {
      const manualScrollTop = pendingManualTextareaScrollTopRef.current
      pendingManualTextareaScrollTopRef.current = null
      const scrollEl = scrollContainerRef.current
      if (!autoScrollRef.current && manualScrollTop != null && scrollEl) {
        if (scrollEl.scrollTop !== manualScrollTop) scrollEl.scrollTop = manualScrollTop
        return
      }
      pinTranscriptToBottom()
    })
    observer.observe(inputEl)
    return () => observer.disconnect()
  }, [hideComposer, hideInput, pinTranscriptToBottom])

  // Teammates' typing bubbles at the end of the transcript stay in view while following the bottom.
  const teammatesTypingRef = useRef<HTMLDivElement>(null)
  const hasTeammatesTyping = teammateTyping.typers.length > 0
  useEffect(() => {
    const typingEl = teammatesTypingRef.current
    if (!typingEl) return
    const observer = new ResizeObserver(() => pinTranscriptToBottom())
    observer.observe(typingEl)
    return () => observer.disconnect()
  }, [hasTeammatesTyping, pinTranscriptToBottom])

  // Floating content appearing or resizing at the end of the transcript must not push the latest
  // message out of view while following the bottom.
  const stickyAfterMessagesRef = useRef<HTMLDivElement>(null)
  const hasStickyAfterMessages = Boolean(stickyAfterMessages)
  useEffect(() => {
    const stickyEl = stickyAfterMessagesRef.current
    if (!stickyEl) return
    const observer = new ResizeObserver(() => pinTranscriptToBottom())
    observer.observe(stickyEl)
    return () => observer.disconnect()
  }, [hasStickyAfterMessages, pinTranscriptToBottom])

  // Preserve scroll position when older messages are prepended.
  // Track the first item and scroll height to detect when new messages were added at the top.
  const prevItemCountRef = useRef(0)
  const prevFirstItemIdRef = useRef<string | undefined>(undefined)
  const prevScrollHeightRef = useRef(0)

  useEffect(() => {
    const el = scrollContainerRef.current
    if (!el) return

    const currentCount = items.length
    const prevCount = prevItemCountRef.current
    const firstItemId = items[0]?.id

    // If items were added at the top and we're NOT at auto-scroll (user viewing history)
    // and the scroll height increased, preserve position. Messages arriving at the end
    // grow the transcript below the reader and need no correction.
    if (
      currentCount > prevCount &&
      firstItemId !== prevFirstItemIdRef.current &&
      !autoScrollRef.current &&
      prevScrollHeightRef.current > 0
    ) {
      const heightDiff = el.scrollHeight - prevScrollHeightRef.current
      if (heightDiff > 0) {
        el.scrollTop += heightDiff
      }
    }

    prevItemCountRef.current = currentCount
    prevFirstItemIdRef.current = firstItemId
    prevScrollHeightRef.current = el.scrollHeight
  }, [items])

  // Content starting the transcript grows under the reader's eyes (they expanded it): keep the
  // prepend baseline current, and stop following the bottom once the growth pushed the end out of
  // view, so the next message doesn't scroll away from what they opened.
  const beforeMessagesRef = useRef<HTMLDivElement>(null)
  const showBeforeMessages = Boolean(beforeMessages) && !hasOlderMessages && !isLoadingOlder
  useEffect(() => {
    const slotEl = beforeMessagesRef.current
    if (!slotEl) return
    let previousHeight: number | undefined
    const observer = new ResizeObserver(() => {
      const height = slotEl.offsetHeight
      const grew = previousHeight !== undefined && height > previousHeight
      const changed = previousHeight !== undefined && height !== previousHeight
      previousHeight = height
      const scrollEl = scrollContainerRef.current
      if (!changed || !scrollEl) return
      prevScrollHeightRef.current = scrollEl.scrollHeight
      const distance = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight
      if (grew && autoScrollRef.current && distance > 30) updateAutoScroll(false)
    })
    observer.observe(slotEl)
    return () => observer.disconnect()
  }, [showBeforeMessages, updateAutoScroll])

  // Convert file to base64
  const fileToBase64 = useCallback((file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => {
        const result = reader.result as string
        resolve(result.split(',')[1]) // Remove data URL prefix
      }
      reader.onerror = reject
      reader.readAsDataURL(file)
    })
  }, [])

  // Add images from files
  const addImages = useCallback(
    async (files: File[]) => {
      if (!imageAttachState.allowed) return
      const validFiles = files.filter((f) => ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(f.type))
      if (validFiles.length === 0) return

      imagePreparationCountRef.current += 1
      setIsPreparingImages(true)
      setImagePreparationError(null)
      const createdPreviews: string[] = []
      try {
        const newImages: PendingImage[] = await Promise.all(
          validFiles.map(async (file) => {
            const preview = URL.createObjectURL(file)
            createdPreviews.push(preview)
            return {
              id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
              file,
              preview,
              data: await fileToBase64(file),
              mimeType: file.type,
              status: 'pending' as const,
              progress: 0,
            }
          })
        )

        if (isSubmittingRef.current) {
          newImages.forEach((image) => URL.revokeObjectURL(image.preview))
          return
        }
        setPendingImages((prev) => [...prev, ...newImages])
      } catch {
        createdPreviews.forEach((preview) => URL.revokeObjectURL(preview))
        setImagePreparationError('Could not read the selected image. Please reselect it or choose another file.')
      } finally {
        imagePreparationCountRef.current -= 1
        if (imagePreparationCountRef.current === 0) setIsPreparingImages(false)
      }
    },
    [fileToBase64, imageAttachState.allowed]
  )

  // Remove a pending image
  const removeImage = useCallback((imageId: string) => {
    if (isSubmittingRef.current) return
    setPendingImages((prev) => {
      const image = prev.find((img) => img.id === imageId)
      if (image) {
        // Revoke object URL to prevent memory leak
        URL.revokeObjectURL(image.preview)
      }
      return prev.filter((img) => img.id !== imageId)
    })
    setImageError(null)
    setSendError(null)
  }, [])

  const retryImageUpload = useCallback((imageId: string) => {
    if (isSubmittingRef.current) return
    setPendingImages((prev) =>
      prev.map((img) =>
        img.id === imageId
          ? { ...img, status: 'pending' as const, progress: 0, uploadedId: undefined, error: undefined }
          : img
      )
    )
    setImageError(null)
    setSendError(null)
  }, [])

  // Clear all pending images
  const clearAllImages = useCallback(() => {
    if (isSubmittingRef.current) return
    setPendingImages((prev) => {
      prev.forEach((img) => URL.revokeObjectURL(img.preview))
      return []
    })
    setImageError(null)
    setSendError(null)
  }, [])

  // File input handler
  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (isSubmittingRef.current) {
        e.target.value = ''
        return
      }
      const files = Array.from(e.target.files || [])
      if (files.length > 0) {
        const images = files.filter((file) =>
          ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.type)
        )
        const ordinary = files.filter((file) => !images.includes(file))
        addImages(images)
        const selection =
          document.activeElement === textareaRef.current && textareaRef.current
            ? { start: textareaRef.current.selectionStart, end: textareaRef.current.selectionEnd }
            : undefined
        ordinary.forEach((file) => void agentFiles.addFile(file, selection))
      }
      // Reset input so same file can be selected again
      e.target.value = ''
    },
    [addImages, agentFiles]
  )

  // Drag and drop: the whole chat surface (messages and composer) is the drop target. Only file
  // drags count, so selecting text or dragging page elements never shows the overlay. Entering a
  // child fires before leaving the last one, so a depth count settles where rect checks flicker.
  const dragDepthRef = useRef(0)
  const composerHidden = hideComposer || hideInput
  const canDropFiles = !composerHidden && !inputDisabled
  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      if (!isFileDrag(e)) return
      // Never let the browser open a file dropped on a chat, even one that can't take it.
      e.preventDefault()
      e.stopPropagation()
      dragDepthRef.current = 0
      setIsDragging(false)

      if (composerHidden || inputDisabled || isSubmittingRef.current) return
      const files = Array.from(e.dataTransfer.files)
      const images = files.filter((file) => ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.type))
      if (imageAttachState.allowed) addImages(images)
      agentFiles.addFiles(files.filter((file) => !images.includes(file)))
    },
    [addImages, agentFiles, imageAttachState.allowed, inputDisabled, composerHidden]
  )

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      if (!isFileDrag(e)) return
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer.dropEffect = canDropFiles ? 'copy' : 'none'
    },
    [canDropFiles]
  )

  const handleDragEnter = useCallback(
    (e: React.DragEvent) => {
      if (!isFileDrag(e)) return
      e.preventDefault()
      e.stopPropagation()
      dragDepthRef.current += 1
      if (!canDropFiles || isSubmittingRef.current) return
      setIsDragging(true)
    },
    [canDropFiles]
  )

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (!isFileDrag(e)) return
    e.preventDefault()
    e.stopPropagation()
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (dragDepthRef.current === 0) setIsDragging(false)
  }, [])

  // A drag that ends elsewhere (dropped outside, or cancelled with Escape) clears the overlay.
  useEffect(() => {
    if (!isDragging) return
    const reset = () => {
      dragDepthRef.current = 0
      setIsDragging(false)
    }
    window.addEventListener('dragend', reset)
    window.addEventListener('drop', reset)
    return () => {
      window.removeEventListener('dragend', reset)
      window.removeEventListener('drop', reset)
    }
  }, [isDragging])

  // Paste handler
  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      if (inputDisabled || isSubmittingRef.current) return
      // Mirror handleDrop's split: image clipboard items attach as images,
      // any other pasted FILE (e.g. a PDF copied from the OS file manager)
      // routes to agent files. Plain text pastes fall through untouched.
      const fileItems = Array.from(e.clipboardData.items).filter((item) => item.kind === 'file')
      if (fileItems.length === 0) return

      const files = fileItems.map((item) => item.getAsFile()).filter((f): f is File => f !== null)
      if (files.length === 0) return
      e.preventDefault()
      const images = files.filter((file) => ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.type))
      if (imageAttachState.allowed) addImages(images)
      const ordinary = files.filter((file) => !images.includes(file))
      if (ordinary.length > 0) {
        const selection =
          document.activeElement === textareaRef.current && textareaRef.current
            ? { start: textareaRef.current.selectionStart, end: textareaRef.current.selectionEnd }
            : undefined
        ordinary.forEach((file) => void agentFiles.addFile(file, selection))
      }
    },
    [addImages, agentFiles, imageAttachState.allowed, inputDisabled]
  )

  // Pastes with focus on the chat surface but outside its fields (after clicking the messages, say)
  // attach to this chat, like pasting into the composer; text fields keep their own paste.
  const handleSurfacePaste = useCallback(
    (e: React.ClipboardEvent) => {
      if (e.defaultPrevented || composerHidden || isTextEntry(e.target as Element)) return
      handlePaste(e)
    },
    [handlePaste, composerHidden]
  )

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (
      (!inputRef.current.trim() && pendingImages.length === 0) ||
      disabled ||
      isUploading ||
      imagePreparationCountRef.current > 0 ||
      isSubmittingRef.current ||
      hasImageErrors ||
      agentFiles.blocked
    )
      return

    isSubmittingRef.current = true
    setIsSubmitting(true)
    focusModeRef.current = false
    updateAutoScroll(true) // Re-engage auto-scroll on send
    setImageError(null)
    setSendError(null)

    // Get images that need uploading (not already uploaded)
    const imagesToUpload = pendingImages.filter((img) => img.status === 'pending')
    const alreadyUploaded = pendingImages.filter((img) => img.status === 'done')

    let allImageIds = alreadyUploaded.map((img) => img.uploadedId!).filter(Boolean)

    // Upload pending images with progress
    if (imagesToUpload.length > 0) {
      setIsUploading(true)

      // Mark images as uploading
      setPendingImages((prev) =>
        prev.map((img) => (img.status === 'pending' ? { ...img, status: 'uploading' as const, progress: 0 } : img))
      )

      try {
        const newImageIds = await uploadImagesDependency(
          imagesToUpload.map((img) => ({
            type: 'image' as const,
            data: img.data,
            mimeType: img.mimeType,
          })),
          {
            ...(agentId ? { agentId } : squadId ? { squadId } : {}),
            onProgress: ({ imageIndex, percent }) => {
              const uploadingId = imagesToUpload[imageIndex].id
              setPendingImages((prev) =>
                prev.map((img) => (img.id === uploadingId ? { ...img, progress: percent } : img))
              )
            },
          }
        )

        // Mark as done with uploaded IDs
        setPendingImages((prev) =>
          prev.map((img) => {
            const uploadIndex = imagesToUpload.findIndex((u) => u.id === img.id)
            if (uploadIndex !== -1) {
              return { ...img, status: 'done' as const, progress: 100, uploadedId: newImageIds[uploadIndex] }
            }
            return img
          })
        )

        allImageIds = [...allImageIds, ...newImageIds]
      } catch (error) {
        // Mark failed images
        const errorMessage = error instanceof Error ? error.message : 'Upload failed'
        setPendingImages((prev) =>
          prev.map((img) =>
            img.status === 'uploading' ? { ...img, status: 'error' as const, error: errorMessage } : img
          )
        )
        setImageError(errorMessage)
        setIsUploading(false)
        isSubmittingRef.current = false
        setIsSubmitting(false)
        return // Don't send message if upload failed
      }

      setIsUploading(false)
    }

    // Save message content before sending (in case of error)
    const messageToSend = inputRef.current
    const imagesToCleanup = [...pendingImages]

    // Sent: teammates stop seeing this person type straight away, not once the send is accepted.
    teammateTyping.stopTyping()
    try {
      // Send message with image IDs - await if it returns a Promise
      await onSend(messageToSend, allImageIds.length > 0 ? allImageIds : undefined)

      // Only clean up on success
      imagesToCleanup.forEach((img) => URL.revokeObjectURL(img.preview))
      setInputValue('')
      // Remove the sent draft now: a composer that hands off to a newly created chat unmounts right
      // after sending, and the next composer under this key must start empty.
      saveDraft('')
      flushDraft()
      setPendingImages([])
      agentFiles.clearFiles()
    } catch (error) {
      // On error, keep the message and images in the composer.
      const errorMessage = error instanceof Error ? error.message : 'Failed to send message'
      if (errorMessage.toLowerCase().includes('invalid attachment')) {
        const rejectedIds = new Set(allImageIds)
        setPendingImages((prev) =>
          prev.map((img) =>
            img.uploadedId && rejectedIds.has(img.uploadedId)
              ? {
                  ...img,
                  status: 'error' as const,
                  progress: 0,
                  uploadedId: undefined,
                  error: 'This attachment must be securely re-uploaded.',
                }
              : img
          )
        )
        setSendError('The attachment could not be added. Re-upload it before sending again.')
      } else {
        setSendError(errorMessage)
      }
    } finally {
      isSubmittingRef.current = false
      setIsSubmitting(false)
    }
  }

  const disabled = inputDisabled ?? false

  // The delivery split button's labels. When the composer picked the mode itself, it says so and why.
  const sendProgressLabel = isPreparingImages
    ? 'Preparing...'
    : isUploading
      ? 'Uploading...'
      : isSubmitting
        ? 'Sending...'
        : null
  const deliveryLabel = deliveryMode === 'follow-up' ? 'Follow up' : 'Interrupt'
  const deliveryTitle =
    deliveryMode === 'follow-up'
      ? 'Send after the agent finishes this turn'
      : 'Send now: the agent reads it at its next step'
  const suggestionReason = suggestedDelivery
    ? suggestedDelivery.now
      ? 'Suggested because this should reach the agent now'
      : 'Suggested because this looks like separate work that can wait'
    : null

  const handleTranscription = useCallback(
    (text: string) => {
      const prev = inputRef.current
      const next = prev ? prev + ' ' + text : text
      setInputValue(next)
      saveDraft(next)
      noteComposerInput(next)
      // Focus after inserting text; setInputValue already resized the textarea.
      setTimeout(() => textareaRef.current?.focus(), 0)
    },
    [saveDraft, setInputValue, noteComposerInput]
  )

  const [voiceError, setVoiceError] = useState<string | null>(null)
  const handleVoiceError = useCallback((error: string) => {
    setVoiceError(error)
    setTimeout(() => setVoiceError(null), 3000)
  }, [])

  const [isSendingNow, setIsSendingNow] = useState(false)
  const [sendNowError, setSendNowError] = useState<string | null>(null)
  const handleSendQueuedNow = useCallback(async () => {
    if (!onSendQueuedNow || isSendingNow) return
    setIsSendingNow(true)
    setSendNowError(null)
    try {
      await onSendQueuedNow()
    } catch (error) {
      setSendNowError(error instanceof Error ? error.message : 'Please try again.')
    } finally {
      setIsSendingNow(false)
    }
  }, [isSendingNow, onSendQueuedNow])

  const handleAutoSend = useCallback(
    (text: string) => {
      if (text.trim()) {
        updateAutoScroll(true)
        onSend(text.trim())
      }
    },
    [onSend, updateAutoScroll]
  )

  const {
    state: voiceState,
    elapsed: voiceElapsed,
    volume: voiceVolume,
    isSupported: recorderSupported,
    isHoldMode,
    start: startRecording,
    stop: stopRecording,
    stopAndSend: stopAndSendRecording,
    cancel: cancelRecording,
    beginPress,
    endPress,
    cancelPress,
    isPressing,
    // Justified exception: useVoiceRecorderHook is injectable for tests, so the compiler cannot see that it
    // is a hook and treats it as a plain function that might call these ref-reading callbacks during render.
    // The recorder only calls them from recording events, never while rendering.
    // eslint-disable-next-line react-hooks/refs
  } = useVoiceRecorderHook({
    onTranscription: handleTranscription,
    onAutoSend: handleAutoSend,
    onError: handleVoiceError,
    transcribe: transcribeAudio,
    disabled,
  })

  // Recording needs a capable browser *and* a server with an OpenAI key —
  // transcription is a server round-trip, so without the key the mic would
  // record happily and then fail. Gating here covers the composer toolbar
  // button, the mobile attach sheet and the push-to-talk shortcuts at once.
  const voiceEnabled = useVoiceEnabledHook()
  const voiceSupported = recorderSupported && voiceEnabled

  const shouldHideComposer = hideComposer || hideInput
  const peekingWorkItem = shouldHideComposer
    ? undefined
    : (items.find((item) => item.kind === 'working') as Extract<RenderItem, { kind: 'working' }> | undefined)

  // Keyboard shortcuts for voice recording
  useVoiceKeyboardShortcuts({
    enabled: keyboardShortcutsEnabled && voiceSupported && !shouldHideComposer,
    scopeRef: inputContainerRef,
    voiceState,
    isSupported: voiceSupported,
    hasInput,
    disabled,
    start: startRecording,
    stop: stopRecording,
    stopAndSend: stopAndSendRecording,
    cancel: cancelRecording,
    beginPress,
    endPress,
    isPressing,
    // No onEscape - ChatView doesn't need special escape handling
  })

  // Auto-focus input when it re-enables after streaming/disabled
  useEffect(() => {
    if (!disabled && autoFocus) textareaRef.current?.focus()
  }, [disabled, autoFocus])

  // With the composer's controls (bottom left; on phones, in the options sheet), or in the header
  // when there is no composer (read-only transcripts).
  const rawTextToggle = (place: 'composer' | 'header') =>
    onToggleRawText && (
      <button
        type="button"
        onClick={onToggleRawText}
        aria-pressed={!!showRawText}
        className={clsx(
          'ficus-button ficus-button-ghost',
          'rounded-md flex items-center justify-center transition-colors shrink-0',
          place === 'composer' ? 'p-2.5 md:p-2 min-h-[44px] md:min-h-0' : 'p-1.5',
          showRawText && 'text-accent-light hover:text-accent-light bg-accent/10 hover:bg-accent/20'
        )}
        aria-label={showRawText ? 'Show rendered markdown' : 'Show raw text'}
        title={showRawText ? 'Show rendered markdown' : 'Show raw text'}
      >
        {showRawText ? (
          <MarkdownIcon className={place === 'composer' ? 'w-5 h-5' : 'w-4 h-4'} />
        ) : (
          <CodeIcon className={place === 'composer' ? 'w-5 h-5' : 'w-4 h-4'} />
        )}
      </button>
    )
  const headerRawTextToggle = shouldHideComposer && rawTextToggle('header')

  const fullscreenButton = (enableFullscreen || isFullscreen) && (
    <button
      onClick={toggleFullscreen}
      className="ficus-button ficus-button-ghost p-1.5 rounded-md transition-colors shrink-0"
      aria-label={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
      title={isFullscreen ? 'Exit fullscreen (Escape)' : 'Fullscreen'}
    >
      {isFullscreen ? <MinimizeIcon className="w-4 h-4" /> : <ExpandIcon className="w-4 h-4" />}
    </button>
  )

  // Like the raw text toggle: with the composer's controls (on phones, in the options sheet), so it never
  // needs a header row of its own; in the header only when there is no composer.
  const historySearchPlace: 'composer' | 'header' = shouldHideComposer ? 'header' : 'composer'
  const toggleHistorySearch = () => (historySearchOpen ? closeHistorySearch() : openHistorySearch())
  const historySearchButton = (place: 'composer' | 'header') =>
    historySearchAvailable &&
    historySearchPlace === place && (
      <button
        ref={historySearchButtonRef}
        type="button"
        onClick={toggleHistorySearch}
        aria-pressed={historySearchOpen}
        className={clsx(
          'ficus-button ficus-button-ghost',
          'rounded-md flex items-center justify-center transition-colors shrink-0',
          place === 'composer' ? 'p-2.5 md:p-2 min-h-[44px] md:min-h-0' : 'p-1.5',
          historySearchOpen && 'text-accent-light hover:text-accent-light bg-accent/10 hover:bg-accent/20'
        )}
        aria-label="Search this conversation"
        title={`Search this conversation (${shortcutModifierLabel()}+Shift+F)`}
      >
        <SearchIcon className={place === 'composer' ? 'w-5 h-5' : 'w-4 h-4'} />
      </button>
    )
  const headerHistorySearchButton = historySearchButton('header')

  const chatContent = (
    <div
      // The whole chat is one drop and paste scope; clicking its messages focuses it (see handleSurfacePaste).
      data-drop-scope="chat"
      tabIndex={-1}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onPaste={handleSurfacePaste}
      className={clsx(
        'relative flex flex-col bg-surface min-h-0 grow outline-hidden',
        isFullscreen ? 'h-full rounded-lg shadow-xl overflow-hidden' : 'rounded-lg',
        className
      )}
    >
      {isDragging && <ChatDropOverlay />}
      {(header || headerRawTextToggle || headerHistorySearchButton || fullscreenButton) && (
        <div
          data-testid="chat-header"
          className={clsx(
            'px-3 md:px-4 py-0.5 md:py-2 border-b border-th-border shrink-0',
            isFullscreen && 'bg-surface-secondary'
          )}
        >
          <div className="flex items-center gap-2">
            <div className="flex-1 min-w-0">{header}</div>
            {headerRawTextToggle}
            {headerHistorySearchButton}
            {fullscreenButton}
          </div>
        </div>
      )}

      {historySearchAvailable && historySearchOpen && (
        <ChatHistorySearch
          key={agentId}
          agentId={agentId!}
          onSelect={jumpToSearchResult}
          onClose={closeHistorySearch}
        />
      )}

      {headerStatus && <div className="shrink-0 min-w-0">{headerStatus}</div>}

      {/* Messages */}
      <div
        ref={scrollContainerRef}
        data-testid="chat-messages"
        onScroll={handleScroll}
        onWheel={markUserScrolling}
        onTouchMove={markUserScrolling}
        className={clsx(
          'flex-1 overflow-y-auto overflow-x-hidden p-3 md:p-4 space-y-3 min-h-0',
          // Room for the plant peeking up from behind the composer, kept until its jump out of sight
          // (PLANT_HIDE_MS) is over so it never covers the end of the transcript.
          peekingWorkItem
            ? 'pb-8 md:pb-9'
            : 'transition-[padding] delay-600 duration-300 ease-out motion-reduce:transition-none'
        )}
      >
        {showBeforeMessages && (
          <div ref={beforeMessagesRef} className="min-w-0">
            {beforeMessages}
          </div>
        )}

        {/* Loading indicator for older messages */}
        {isLoadingOlder && (
          <div className="flex items-center justify-center py-3 text-muted">
            <svg className="animate-spin h-4 w-4 mr-2" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
              />
            </svg>
            <span className="text-sm">Loading older messages...</span>
          </div>
        )}

        {/* Indicator when there are more older messages */}
        {!isLoadingOlder && hasOlderMessages && items.length > 0 && (
          <div className="text-center py-2">
            <span className="text-xs text-placeholder">↑ Scroll up for older messages</span>
          </div>
        )}

        {isLoading && items.length === 0 ? (
          <ConversationSkeleton />
        ) : (
          items.length === 0 &&
          !isStreaming && <p className="text-placeholder text-sm text-center mt-8">Send a message to start chatting</p>
        )}

        {/* Single items.map — no reconciliation */}
        {(() => {
          // Track the sender of the previous rendered message. Any non-user
          // message (agent reply, system notice) resets it, so a user's name
          // re-appears whenever their message follows a non-user message — not
          // just above the very first user message on the page.
          // The running context lives in one object created during this render: the
          // callbacks below update it while items are mapped, never after render.
          const run: {
            prevSenderUserId: string | undefined
            prevGroupEntry: TimestampGroupEntry | null
            prevDayKey: string | null
          } = { prevSenderUserId: undefined, prevGroupEntry: null, prevDayKey: null }
          // Timestamps: a human or agent message shows its clock time only when it
          // starts a group (see startsGroup); system rows, automated deliveries and
          // optimistic/streaming items reset grouping. A divider precedes the first
          // rendered message of each local calendar day.
          const now = new Date()
          const groupHeadTime = (entry: TimestampGroupEntry): Date | null => {
            const head = startsGroup(run.prevGroupEntry, entry)
            run.prevGroupEntry = entry
            return head ? entry.at : null
          }
          return items.map((item) => {
            if (
              hideInboxMessages &&
              ((item.kind === 'pending' && item.metadata?.source === 'inbox') ||
                (item.kind === 'persisted' &&
                  item.message.role === 'human' &&
                  item.message.metadata?.source === 'inbox'))
            )
              return null
            if (item.kind === 'persisted') {
              const m = item.message
              // Every source row id (the render key plus any merged-in rows) so a
              // focusMessageId matching ANY of them finds this element via the
              // `~=` attribute selector.
              const messageIds = [item.id, ...(item.mergedFrom?.map((merged) => merged.id) ?? [])]
              const isFocusHighlighted = highlightedMessageId != null && messageIds.includes(highlightedMessageId)
              // A reply merged from several rows is timed by its earliest row.
              const at = earliestMessageDate([
                m.createdAt,
                ...(item.mergedFrom?.map((merged) => merged.createdAt) ?? []),
              ])
              const dayKey = at ? localDayKey(at) : null
              const dayDivider = at && dayKey !== run.prevDayKey ? <DayDivider label={dayLabel(at, now)} /> : null
              if (dayKey) run.prevDayKey = dayKey
              const wrap = (node: React.ReactNode) => (
                <Fragment key={item.id}>
                  {dayDivider}
                  <div
                    data-message-id={messageIds.join(' ')}
                    title={at ? fullTimestamp(at) : undefined}
                    className={clsx(
                      'rounded-lg transition-shadow duration-1000',
                      isFocusHighlighted && 'ring-2 ring-accent ring-offset-2 ring-offset-surface'
                    )}
                  >
                    {node}
                    {renderMessageFooter?.(item)}
                  </div>
                </Fragment>
              )
              if (m.content.startsWith('[System]')) {
                run.prevSenderUserId = undefined
                run.prevGroupEntry = null
                return wrap(<SystemMessageRow content={m.content} />)
              }
              if (m.role === 'human') {
                const sender = m.metadata?.sender
                const showSenderLabel =
                  !!sender && sender.userId !== viewingUserId && sender.userId !== run.prevSenderUserId
                run.prevSenderUserId = sender?.userId
                let time: Date | null = null
                if (automatedSource(m)) run.prevGroupEntry = null
                else time = groupHeadTime({ kind: 'human', senderKey: sender?.userId ?? null, at })
                return wrap(
                  <HumanMessageRow
                    message={m}
                    viewingUserId={viewingUserId}
                    showSenderLabel={showSenderLabel}
                    time={time}
                    showRaw={showRawText}
                    agentId={agentId}
                  />
                )
              }
              run.prevSenderUserId = undefined
              return wrap(
                <AssistantMessageRow
                  message={m}
                  blocks={item.blocks}
                  showRaw={showRawText}
                  tts={tts}
                  agentId={agentId}
                  onToolInlineAction={openToolInlineAction}
                  time={groupHeadTime({ kind: 'agent', senderKey: null, at })}
                />
              )
            }

            if (item.kind === 'system') {
              run.prevSenderUserId = undefined
              run.prevGroupEntry = null
              return <SystemMessageRow key={item.id} content={item.text} />
            }

            if (item.kind === 'working') {
              // Activity indicator: position is decided by combine(); we just render it. A
              // waitingFor: 'sandbox' tag means the busy window is specifically the sandbox-ensure
              // debounce (server-pushed execution_phase) — show a distinct label instead of the
              // default thinking copy.
              // With a composer, the plant peeks up from behind it instead (below).
              if (!shouldHideComposer) return null
              return (
                <div key={item.id} className="flex justify-start px-1">
                  <TypingIndicator
                    label={item.waitingFor === 'sandbox' ? 'Waiting for the sandbox to start…' : thinkingLabel}
                  />
                </div>
              )
            }

            if (item.kind === 'queued') {
              return (
                <div
                  key={item.id}
                  role="status"
                  aria-live="polite"
                  className="rounded-lg bg-status-attention-50 px-3 py-2 text-sm text-status-attention-800 dark:bg-status-attention-900/30 dark:text-status-attention-300"
                >
                  {item.label}
                </div>
              )
            }

            if (item.kind === 'streaming') {
              // Not persisted yet: no time, and the persisted reply that follows starts a group.
              run.prevGroupEntry = null
              // Notices that arrived mid-response sit between the runs of content they split.
              const segments = segmentAtNotices<StreamingContentBlock>(item.blocks)
              const liveSegment = lastBlocksSegmentIndex(segments)
              return (
                <div key={item.id} className="text-primary overflow-hidden space-y-2 pr-2 md:pr-10">
                  {segments.map((segment, index) =>
                    segment.type === 'notice' ? (
                      <SystemMessageRow key={segment.notice.id} content={segment.notice.text} />
                    ) : (
                      <StreamingBlocksRenderer
                        key={segment.key}
                        blocks={segment.blocks}
                        isStreaming={item.status === 'streaming' && index === liveSegment}
                        onAbortTool={onAbortTool}
                        showRaw={showRawText}
                        agentId={agentId}
                        onToolInlineAction={openToolInlineAction}
                      />
                    )
                  )}
                  <NavigateButtons navigations={extractNavigationToolCalls(item.blocks)} />
                </div>
              )
            }

            // pending: optimistic, no persisted time
            run.prevGroupEntry = null
            return (
              <PendingMessageRow
                key={item.id}
                agentId={agentId}
                content={item.content}
                imageIds={item.imageIds}
                deliveryMode={item.deliveryMode}
                status={item.status}
                queued={item.queued}
                metadata={item.metadata}
                onSwitchMode={
                  item.messageId && onUpdatePendingMessage
                    ? (mode) => onUpdatePendingMessage(item.messageId!, mode)
                    : undefined
                }
                onCancel={
                  item.messageId && onUpdatePendingMessage
                    ? async () => {
                        await onUpdatePendingMessage(item.messageId!, 'cancel')
                        restoreToComposer(item.content, item.imageIds ?? [])
                      }
                    : undefined
                }
                onRetry={item.status === 'failed' && onRetry ? () => onRetry(item.id) : undefined}
              />
            )
          })
        })()}

        {error && (
          <div className="flex justify-center">
            <div className="rounded-lg px-3 md:px-4 py-2 md:py-3 bg-status-danger-50 dark:bg-status-danger-900/30 text-status-danger-600 dark:text-status-danger-400 text-sm">
              {error}
            </div>
          </div>
        )}

        {voiceError && (
          <div className="flex justify-center">
            <div className="rounded-lg px-3 md:px-4 py-2 md:py-3 bg-status-external-wait-50 dark:bg-status-external-wait-900/30 text-status-external-wait-600 dark:text-status-external-wait-400 text-sm">
              {voiceError}
            </div>
          </div>
        )}

        {afterMessages}

        {teammateTyping.typers.length > 0 && (
          <div ref={teammatesTypingRef}>
            <TeammatesTyping typers={teammateTyping.typers} />
          </div>
        )}

        {stickyAfterMessages && (
          <div
            ref={stickyAfterMessagesRef}
            data-testid="chat-sticky-after-messages"
            // Sticky insets count from inside the container's bottom padding, so bottom-0 pins it exactly
            // where the transcript ends at the bottom, above the plant's room while it peeks. In the flow at
            // the bottom, it never covers the latest message; scrolled up, messages show around it. Clicks
            // pass through to the messages, so each control opts back in with pointer-events-auto. As a
            // flow-root, a control's negative bottom margin overhangs the padding instead of collapsing
            // through, so it sits at the same height at the bottom and while pinned.
            className="pointer-events-none sticky bottom-0 z-10 flow-root space-y-2 empty:hidden"
          >
            {stickyAfterMessages}
          </div>
        )}
      </div>

      {/* Input */}
      {!shouldHideComposer && (
        <div className="relative shrink-0">
          <PeekingPlant
            working={Boolean(peekingWorkItem)}
            label={peekingWorkItem?.waitingFor === 'sandbox' ? 'Waiting for the sandbox to start…' : thinkingLabel}
          />
          <div
            ref={inputContainerRef}
            className="px-3 py-2 md:px-4 md:py-2.5 border-t border-th-border shrink-0 relative z-10 bg-surface"
          >
            {/* Hidden file input - outside flow so space-y-3 doesn't add gap */}
            <input
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              multiple
              onChange={handleFileSelect}
              className="hidden"
              ref={fileInputRef}
            />
            <input
              type="file"
              accept="*/*"
              multiple
              onChange={(event) => {
                if (isSubmittingRef.current) {
                  event.target.value = ''
                  return
                }
                agentFiles.addFiles(Array.from(event.target.files ?? []), agentFileSelectionRef.current)
                agentFileSelectionRef.current = undefined
                event.target.value = ''
              }}
              className="hidden"
              ref={agentFileInputRef}
            />

            <div
              aria-busy={isSubmitting}
              inert={isSubmitting}
              className={clsx('space-y-2', isSubmitting && 'pointer-events-none')}
            >
              {(imagePreparationError || imageError || sendError || clearQueueError || sendNowError) && (
                <div
                  role="alert"
                  aria-live="assertive"
                  className="rounded-lg px-3 py-2 bg-status-danger-50 dark:bg-status-danger-900/30 text-status-danger-600 dark:text-status-danger-400 text-sm"
                >
                  {imagePreparationError
                    ? `Image attachment failed: ${imagePreparationError}`
                    : imageError
                      ? `Image upload failed: ${imageError}`
                      : sendError
                        ? `Message was not sent: ${sendError}`
                        : clearQueueError
                          ? `Could not clear pending messages: ${clearQueueError}`
                          : `Could not send queued interrupts now: ${sendNowError}`}
                </div>
              )}

              {inputPrefix}

              {/* Queue controls: deliver queued interrupts now, and clear the user's own queued messages */}
              {((onSendQueuedNow && executionStatus === 'running' && queuedInterruptCount > 0) ||
                (onCancelQueue && showClearQueue && pendingItems.length > 0)) && (
                <div className="flex flex-wrap justify-end gap-2">
                  {onSendQueuedNow && executionStatus === 'running' && queuedInterruptCount > 0 && (
                    <button
                      type="button"
                      onClick={() => void handleSendQueuedNow()}
                      disabled={isSendingNow}
                      title="Stop the agent's current step and deliver the queued interrupts now"
                      className="ficus-button ficus-button-secondary flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium disabled:opacity-50"
                    >
                      {isSendingNow ? (
                        <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
                      ) : (
                        <LightningIcon className="h-3 w-3" />
                      )}
                      <span>{isSendingNow ? 'Sending now…' : `Send ${queuedInterruptCount} now`}</span>
                    </button>
                  )}
                  {onCancelQueue && showClearQueue && pendingItems.length > 0 && (
                    <button
                      type="button"
                      onClick={handleCancelQueueClick}
                      disabled={isClearingQueue}
                      className={clsx(
                        'ficus-button ficus-button-danger',
                        'flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors disabled:opacity-50',
                        !confirmingClearQueue &&
                          'bg-status-attention-50 dark:bg-status-attention-900/30 text-status-attention-700 dark:text-status-attention-300 hover:bg-status-attention-100 dark:hover:bg-status-attention-900/50'
                      )}
                    >
                      {isClearingQueue ? (
                        <span className="inline-block w-3 h-3 border-2 border-status-attention-300 border-t-status-attention-600 rounded-full animate-spin" />
                      ) : (
                        <CloseIcon className="w-3 h-3" />
                      )}
                      {confirmingClearQueue ? (
                        <span>Tap again to clear</span>
                      ) : (
                        <span>
                          Clear {pendingItems.length} pending message{pendingItems.length > 1 ? 's' : ''}
                        </span>
                      )}
                    </button>
                  )}
                </div>
              )}

              {/* Pending images preview */}
              {agentFiles.files.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {agentFiles.files.map((file) => (
                    <div
                      key={file.id}
                      className="flex items-center gap-2 rounded border border-th-border px-2 py-1 text-xs"
                    >
                      <FileIcon className="h-4 w-4" />
                      <span>{file.file.name}</span>
                      <span className="text-muted">
                        {file.status === 'uploading' ? `${Math.round(file.progress * 100)}%` : file.status}
                      </span>
                      {file.status === 'error' && (
                        <>
                          {/* The server's reason (e.g. "Attachment unavailable")
                            is the only thing that tells the user whether a
                            retry can possibly help. */}
                          <span role="alert" className="text-status-danger-600 dark:text-status-danger-400">
                            {agentFileErrorText(file.error)}
                          </span>
                          <button
                            className="ficus-button ficus-button-ghost px-1.5 py-0.5"
                            type="button"
                            onClick={() => agentFiles.retryFile(file.id)}
                          >
                            Retry
                          </button>
                        </>
                      )}
                      <button
                        className="ficus-button ficus-button-ghost"
                        type="button"
                        onClick={() => void agentFiles.removeFile(file.id)}
                        aria-label={`Remove ${file.file.name}`}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {pendingImages.length > 0 && (
                <div className="flex flex-wrap gap-2 pb-2">
                  {pendingImages.map((img) => (
                    <div key={img.id} className="relative group">
                      {/* Image thumbnail */}
                      <div className="relative h-16 w-16">
                        <img
                          src={img.uploadedId ? (pendingImageSrcs[img.uploadedId] ?? img.preview) : img.preview}
                          alt=""
                          className={clsx(
                            'h-16 w-16 object-cover rounded border',
                            img.status === 'uploading'
                              ? 'opacity-50'
                              : img.status === 'error'
                                ? 'opacity-50 border-status-danger-500'
                                : 'border-th-border'
                          )}
                        />

                        {/* Upload progress overlay */}
                        {img.status === 'uploading' && (
                          <div className="absolute inset-0 flex items-center justify-center bg-surface/50 rounded">
                            <div className="relative h-8 w-8">
                              <svg className="h-8 w-8 -rotate-90" viewBox="0 0 32 32">
                                <circle
                                  cx="16"
                                  cy="16"
                                  r="14"
                                  fill="none"
                                  stroke="rgb(var(--color-border))"
                                  strokeWidth="3"
                                />
                                <circle
                                  cx="16"
                                  cy="16"
                                  r="14"
                                  fill="none"
                                  stroke="rgb(var(--status-progress-500))"
                                  strokeWidth="3"
                                  strokeDasharray={`${img.progress * 0.88} 88`}
                                  strokeLinecap="round"
                                />
                              </svg>
                              <span className="absolute inset-0 flex items-center justify-center text-[10px] font-medium text-secondary">
                                {img.progress}%
                              </span>
                            </div>
                          </div>
                        )}

                        {/* Done checkmark */}
                        {img.status === 'done' && (
                          <div className="absolute bottom-0 right-0 bg-status-success-500 text-on-strong rounded-full p-0.5">
                            <CheckIcon className="h-3 w-3" />
                          </div>
                        )}

                        {/* Error indicator */}
                        {img.status === 'error' && (
                          <div
                            className="absolute bottom-0 right-0 bg-status-danger-500 text-on-strong rounded-full p-0.5"
                            title={img.error}
                          >
                            <CloseIcon className="h-3 w-3" />
                          </div>
                        )}
                      </div>

                      {img.status === 'error' && (
                        <button
                          type="button"
                          onClick={() => retryImageUpload(img.id)}
                          className="ficus-button ficus-button-ghost mt-1 block w-16 px-1 py-0.5 text-xs"
                          aria-label="Retry image upload"
                        >
                          Re-upload
                        </button>
                      )}

                      {/* Remove button (hidden during upload) */}
                      {img.status !== 'uploading' && (
                        <button
                          type="button"
                          onClick={() => removeImage(img.id)}
                          className="ficus-button ficus-button-danger absolute -top-1 -right-1 rounded-full w-5 h-5 flex items-center justify-center text-xs opacity-0 group-hover:opacity-100 transition-opacity"
                          title="Remove image"
                          aria-label="Remove image"
                        >
                          ×
                        </button>
                      )}
                    </div>
                  ))}

                  {/* Clear all button (when multiple images and not uploading) */}
                  {pendingImages.length > 1 && !isUploading && (
                    <button
                      type="button"
                      onClick={clearAllImages}
                      className="ficus-button ficus-button-danger flex items-center gap-1 px-2 py-1 text-xs rounded transition-colors self-center"
                    >
                      <TrashIcon className="h-3 w-3" />
                      Clear all
                    </button>
                  )}
                </div>
              )}

              <form onSubmit={handleSubmit} className="chat-composer md:space-y-1.5">
                {inputDisabledReason ? (
                  <p
                    id="chat-input-disabled-reason"
                    role="status"
                    aria-live="polite"
                    className="px-2 pb-1 text-sm text-muted"
                  >
                    {inputDisabledReason}
                  </p>
                ) : null}

                <textarea
                  ref={attachTextarea}
                  onClick={expandMobileComposer}
                  onChange={(e) => {
                    if (isSubmittingRef.current) {
                      e.target.value = inputRef.current
                      return
                    }
                    const val = e.target.value
                    inputRef.current = val
                    setHasInput(!!val.trim())
                    onDraftChangeRef.current?.(val)
                    saveDraft(val)
                    noteComposerInput(val)
                    resizeTextarea(e.currentTarget)
                    // Check for @ mention trigger
                    checkForMention()
                  }}
                  onKeyDown={(e) => {
                    // If mention dropdown is open, let it handle navigation keys
                    if (mentionState.isOpen) {
                      if (e.key === 'Escape') {
                        e.preventDefault()
                        closeMention()
                        return
                      }
                      if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'Enter' || e.key === 'Tab') {
                        // Let the autocomplete handle these
                        return
                      }
                    }
                    if (e.key === 'Escape') {
                      textareaRef.current?.blur()
                      return
                    }
                    if (e.key === 'Enter') {
                      if (e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return
                      e.preventDefault()
                      if (
                        (inputRef.current.trim() || pendingImages.length > 0) &&
                        !disabled &&
                        !isUploading &&
                        !isPreparingImages &&
                        !isSubmitting &&
                        !hasImageErrors
                      )
                        handleSubmit(e)
                    }
                  }}
                  onPaste={handlePaste}
                  placeholder={placeholder}
                  aria-describedby={inputDisabledReason ? 'chat-input-disabled-reason' : undefined}
                  autoFocus={autoFocus}
                  disabled={disabled || isUploading || isSubmitting}
                  rows={1}
                  onFocus={(event) => resizeTextarea(event.currentTarget)}
                  className="ficus-field w-full min-h-[46px] md:min-h-[38px] shrink-0 rounded-md border-input-border bg-input-bg text-primary focus:border-accent focus:ring-accent px-3 py-2.5 md:py-2 border disabled:bg-surface-secondary resize-none max-h-40 overflow-y-auto text-base md:text-sm"
                />
                {/* File mention autocomplete dropdown */}
                {mentionState.isOpen && squadId && (
                  <FileMentionAutocomplete
                    squadId={squadId}
                    query={mentionState.query}
                    onSelect={selectFile}
                    onClose={closeMention}
                    textareaRef={textareaRef}
                  />
                )}
                <p className="text-xs text-placeholder mt-1! hidden md:block">
                  {voiceState === 'recording' ? (
                    <span className="text-status-danger-500 dark:text-status-danger-400 flex items-center gap-1">
                      <span className="inline-block w-2 h-2 bg-status-danger-500 rounded-full animate-pulse" />
                      {isHoldMode
                        ? 'Hold-to-talk... release to send, Escape to cancel'
                        : 'Recording... ↑ to send, ↓ to stop and preview, Escape to cancel'}
                    </span>
                  ) : hasInput ? (
                    'Enter to send, Ctrl+Shift+V for voice'
                  ) : (
                    'Enter to send, ↑ for voice'
                  )}
                </p>
                <div className="chat-composer-controls flex gap-2 items-center justify-between">
                  <div className="flex items-center gap-1 min-w-0">
                    <button
                      type="button"
                      ref={attachSheetTriggerRef}
                      onClick={() => setAttachSheetOpen(true)}
                      aria-haspopup="dialog"
                      aria-expanded={attachSheetOpen}
                      className="ficus-button ficus-button-ghost chat-composer-attach md:hidden p-2.5 rounded-md transition-colors shrink-0"
                      aria-label="Attach or change controls"
                    >
                      <PlusIcon className="w-5 h-5" />
                    </button>
                    <div className="hidden md:flex gap-1 items-center">
                      {/* Image button */}
                      <button
                        type="button"
                        onClick={() => imageAttachState.allowed && fileInputRef.current?.click()}
                        disabled={!imageAttachState.allowed || disabled || isUploading}
                        className="ficus-button ficus-button-ghost p-2.5 md:p-2 rounded-md disabled:opacity-50 transition-colors shrink-0"
                        title={imageAttachState.title}
                      >
                        <ImageIcon className="h-5 w-5" />
                      </button>
                      <button
                        type="button"
                        onMouseDown={() => {
                          if (document.activeElement === textareaRef.current && textareaRef.current) {
                            agentFileSelectionRef.current = {
                              start: textareaRef.current.selectionStart,
                              end: textareaRef.current.selectionEnd,
                            }
                          }
                        }}
                        onClick={() => agentId && agentFileInputRef.current?.click()}
                        disabled={!agentId || disabled}
                        className="ficus-button ficus-button-ghost p-2.5 md:p-2 rounded-md disabled:opacity-50 transition-colors shrink-0"
                        title="Attach a file"
                        aria-label="Attach a file"
                      >
                        <FileIcon className="h-5 w-5" />
                      </button>
                      {/* Mic button */}
                      {voiceSupported && (
                        <div className="relative flex items-center justify-center">
                          {voiceState === 'recording' && (
                            <span
                              className="absolute inset-0 rounded-md bg-status-danger-400 pointer-events-none"
                              style={{
                                opacity: 0.15 + voiceVolume * 0.35,
                                transform: `scale(${1 + voiceVolume * 0.4})`,
                                transition: 'transform 75ms, opacity 75ms',
                              }}
                            />
                          )}
                          <button
                            type="button"
                            onMouseDown={(e) => {
                              e.preventDefault()
                              beginPress()
                            }}
                            onMouseUp={() => endPress()}
                            onMouseLeave={() => {
                              if (isHoldMode) cancelPress()
                            }}
                            onTouchStart={(e) => {
                              e.preventDefault()
                              beginPress()
                            }}
                            onTouchEnd={() => endPress()}
                            disabled={disabled || voiceState === 'transcribing'}
                            className={clsx(
                              'ficus-button ficus-button-ghost',
                              'relative z-10 p-2.5 md:p-2 rounded-md min-h-[44px] md:min-h-0 flex items-center justify-center transition-colors disabled:opacity-50',
                              voiceState === 'recording'
                                ? 'bg-status-danger-100 dark:bg-status-danger-900/30 text-status-danger-600 dark:text-status-danger-400 hover:bg-status-danger-200 dark:hover:bg-status-danger-900/50'
                                : voiceState === 'transcribing'
                                  ? 'bg-surface-secondary'
                                  : ''
                            )}
                            title={
                              voiceState === 'recording'
                                ? isHoldMode
                                  ? 'Release to send'
                                  : 'Stop recording'
                                : voiceState === 'transcribing'
                                  ? 'Transcribing...'
                                  : hasInput
                                    ? 'Record voice message (Ctrl+Shift+V)'
                                    : 'Record voice message (↑)'
                            }
                          >
                            {voiceState === 'transcribing' ? (
                              <span className="inline-block w-5 h-5 border-2 border-th-border border-t-secondary rounded-full animate-spin" />
                            ) : (
                              <MicIcon className="w-5 h-5" />
                            )}
                            {voiceState === 'recording' && (
                              <span className="ml-1 text-xs font-mono tabular-nums">
                                {Math.floor(voiceElapsed / 60)}:{String(voiceElapsed % 60).padStart(2, '0')}
                              </span>
                            )}
                          </button>
                        </div>
                      )}
                      {/* TTS toggle button */}
                      {tts && (
                        <div className="relative">
                          <button
                            type="button"
                            onClick={tts.toggle}
                            className={clsx(
                              'ficus-button ficus-button-ghost',
                              'p-2.5 md:p-2 rounded-md min-h-[44px] md:min-h-0 flex items-center justify-center transition-colors',
                              tts.isPlaying || tts.isSynthesizing
                                ? 'bg-accent/15 hover:bg-accent/15 text-accent-light hover:text-accent-light'
                                : tts.enabled
                                  ? 'text-accent-light hover:text-accent-light hover:bg-accent/10'
                                  : ''
                            )}
                            title={tts.enabled ? 'Disable auto-speak' : 'Enable auto-speak'}
                          >
                            {tts.isSynthesizing ? (
                              <span className="inline-block w-5 h-5 border-2 border-accent-light/30 border-t-accent-light rounded-full animate-spin" />
                            ) : tts.enabled ? (
                              <SpeakerOnIcon className={clsx('w-5 h-5', tts.isPlaying && 'animate-pulse')} />
                            ) : (
                              <SpeakerOffIcon className="w-5 h-5" />
                            )}
                          </button>
                        </div>
                      )}
                      {/* Auto-scroll toggle */}
                      <button
                        type="button"
                        onClick={() => {
                          const next = !autoScroll
                          updateAutoScroll(next)
                          if (next) pinTranscriptToBottom()
                        }}
                        className={clsx(
                          'ficus-button ficus-button-ghost',
                          'p-2.5 md:p-2 rounded-md min-h-[44px] md:min-h-0 flex items-center justify-center transition-colors',
                          autoScroll && 'text-accent hover:text-accent hover:bg-selection'
                        )}
                        title={autoScroll ? 'Auto-scroll enabled' : 'Auto-scroll disabled'}
                      >
                        <AutoScrollIcon className="w-5 h-5" />
                      </button>
                      {rawTextToggle('composer')}
                      {historySearchButton('composer')}
                    </div>
                    {composerStatus}
                  </div>
                  <div className="chat-composer-send flex items-center gap-2 md:gap-1">
                    {/* Any active turn, not only a streaming one: a queued or sandbox-waiting run stops too. */}
                    {onStop && (isStreaming || agentBusy) && (
                      <button
                        type="button"
                        onClick={onStop}
                        className="ficus-button ficus-button-danger chat-composer-stop px-2.5 py-2 md:py-1.5 rounded-md text-sm font-medium min-h-[44px] md:min-h-0 transition-colors"
                        title="Stop"
                      >
                        Stop
                      </button>
                    )}
                    {deliveryMode && onDeliveryModeChange && (agentBusy || isStreaming) ? (
                      <div
                        className={clsx(
                          // One split button: the main part sends in the chosen mode, the chevron picks the mode.
                          // Shown only while a turn is active to interrupt or queue into; when idle a plain Send
                          // is shown and deliveryMode stays 'steer' (safe default).
                          'chat-composer-delivery flex min-h-[44px] items-stretch overflow-hidden rounded-md md:min-h-0',
                          deliveryMode === 'steer'
                            ? 'bg-accent text-on-accent'
                            : 'bg-status-attention-600 text-on-strong'
                        )}
                      >
                        <button
                          type="submit"
                          aria-label={
                            sendProgressLabel ?? (suggestionReason ? `${deliveryLabel} (suggested)` : deliveryLabel)
                          }
                          title={suggestionReason ? `${suggestionReason}. ${deliveryTitle}` : deliveryTitle}
                          disabled={
                            disabled ||
                            isUploading ||
                            isPreparingImages ||
                            isSubmitting ||
                            hasImageErrors ||
                            agentFiles.blocked ||
                            (!hasInput && pendingImages.length === 0)
                          }
                          className={clsx(
                            'chat-composer-submit inline-flex items-center gap-1.5 whitespace-nowrap px-3 py-2 text-sm font-medium transition-colors disabled:opacity-50 md:py-1.5',
                            deliveryMode === 'steer'
                              ? 'hover:bg-accent-hover active:bg-accent-active'
                              : 'hover:bg-status-attention-700 active:bg-status-attention-800'
                          )}
                        >
                          {sendProgressLabel ?? deliveryLabel}
                          {suggestionReason && !sendProgressLabel && (
                            <span
                              className="chat-composer-auto inline-flex items-center gap-0.5 text-[11px] font-medium leading-none opacity-80"
                              title={suggestionReason}
                              aria-hidden="true"
                            >
                              <SparklesIcon className="h-3 w-3" />
                              Auto
                            </span>
                          )}
                        </button>
                        <SelectionPopup
                          label="Message delivery"
                          title="Choose when this message is delivered"
                          value={deliveryMode}
                          onChange={onDeliveryModeChange}
                          width={320}
                          openOnHover
                          disabled={disabled || isUploading || isPreparingImages || isSubmitting}
                          options={[
                            {
                              value: 'steer',
                              label: 'Interrupt',
                              description: 'When sent, interrupt the current turn at the next delivery point.',
                            },
                            {
                              value: 'follow-up',
                              label: 'Follow up',
                              description: 'When sent, queue this message for after the current turn.',
                            },
                          ]}
                          className={clsx(
                            'ficus-button ficus-button-ghost text-inherit hover:text-inherit chat-composer-mode flex min-h-[44px] md:min-h-0 items-center border-l px-2.5 transition-colors disabled:opacity-50',
                            deliveryMode === 'steer'
                              ? 'border-accent-active hover:bg-accent-hover'
                              : 'border-status-attention-700 hover:bg-status-attention-700'
                          )}
                        >
                          <ChevronDownIcon className="h-4 w-4" />
                        </SelectionPopup>
                      </div>
                    ) : (
                      <button
                        type="submit"
                        aria-label={
                          isPreparingImages
                            ? 'Preparing...'
                            : isUploading
                              ? 'Uploading...'
                              : isSubmitting
                                ? 'Sending...'
                                : sendLabel
                        }
                        disabled={
                          disabled ||
                          isUploading ||
                          isPreparingImages ||
                          isSubmitting ||
                          hasImageErrors ||
                          agentFiles.blocked ||
                          (!hasInput && pendingImages.length === 0)
                        }
                        className={clsx(
                          'ficus-button ficus-button-primary',
                          'px-3 py-2 md:py-1.5 rounded-md text-sm disabled:opacity-50 font-medium min-h-[44px] md:min-h-0',
                          sendButtonClassName && 'text-on-strong',
                          sendButtonClassName
                        )}
                      >
                        <SendIcon className="h-5 w-5 md:hidden" />
                        <span className="hidden md:inline">
                          {isPreparingImages
                            ? 'Preparing...'
                            : isUploading
                              ? 'Uploading...'
                              : isSubmitting
                                ? 'Sending...'
                                : sendLabel}
                        </span>
                      </button>
                    )}
                  </div>
                </div>
                <MobileChatOptionsSheet
                  open={attachSheetOpen}
                  onClose={() => setAttachSheetOpen(false)}
                  triggerRef={attachSheetTriggerRef}
                >
                  <button
                    type="button"
                    onClick={() => {
                      if (!imageAttachState.allowed) return
                      fileInputRef.current?.click()
                      setAttachSheetOpen(false)
                    }}
                    disabled={!imageAttachState.allowed || disabled || isUploading}
                    title={imageAttachState.title}
                    className="ficus-button ficus-button-ghost w-full flex items-center gap-3 px-3 py-3 rounded-md text-sm text-primary disabled:opacity-50 disabled:hover:bg-transparent"
                  >
                    <ImageIcon className="w-5 h-5 text-muted" />
                    Attach image
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (textareaRef.current) {
                        agentFileSelectionRef.current = {
                          start: textareaRef.current.selectionStart,
                          end: textareaRef.current.selectionEnd,
                        }
                      }
                      agentFileInputRef.current?.click()
                      setAttachSheetOpen(false)
                    }}
                    disabled={!agentId || disabled}
                    className="ficus-button ficus-button-ghost w-full flex items-center gap-3 px-3 py-3 rounded-md text-sm text-primary disabled:opacity-50"
                  >
                    <FileIcon className="w-5 h-5 text-muted" />
                    Attach file
                  </button>
                  {voiceSupported && (
                    <button
                      type="button"
                      onClick={() => {
                        if (voiceState === 'recording') {
                          endPress()
                        } else {
                          beginPress()
                        }
                        setAttachSheetOpen(false)
                      }}
                      disabled={disabled || voiceState === 'transcribing'}
                      className="ficus-button ficus-button-ghost w-full flex items-center gap-3 px-3 py-3 rounded-md text-sm text-primary disabled:opacity-50"
                    >
                      <MicIcon className="w-5 h-5 text-muted" />
                      {voiceState === 'recording' ? 'Stop voice recording' : 'Voice message'}
                    </button>
                  )}
                  {tts && (
                    <button
                      type="button"
                      onClick={() => {
                        tts.toggle()
                        setAttachSheetOpen(false)
                      }}
                      className="ficus-button ficus-button-ghost w-full flex items-center gap-3 px-3 py-3 rounded-md text-sm text-primary"
                    >
                      {tts.enabled ? (
                        <SpeakerOnIcon className="w-5 h-5 text-muted" />
                      ) : (
                        <SpeakerOffIcon className="w-5 h-5 text-muted" />
                      )}
                      {tts.enabled ? 'Auto-speak on' : 'Auto-speak off'}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      const next = !autoScroll
                      updateAutoScroll(next)
                      if (next) pinTranscriptToBottom()
                      setAttachSheetOpen(false)
                    }}
                    className="ficus-button ficus-button-ghost w-full flex items-center gap-3 px-3 py-3 rounded-md text-sm text-primary"
                  >
                    <AutoScrollIcon className="w-5 h-5 text-muted" />
                    {autoScroll ? 'Auto-scroll on' : 'Auto-scroll off'}
                  </button>
                  {onToggleRawText && (
                    <button
                      type="button"
                      onClick={() => {
                        onToggleRawText()
                        setAttachSheetOpen(false)
                      }}
                      className="ficus-button ficus-button-ghost w-full flex items-center gap-3 px-3 py-3 rounded-md text-sm text-primary"
                    >
                      {showRawText ? (
                        <MarkdownIcon className="w-5 h-5 text-muted" />
                      ) : (
                        <CodeIcon className="w-5 h-5 text-muted" />
                      )}
                      {showRawText ? 'Show rendered markdown' : 'Show raw text'}
                    </button>
                  )}
                  {historySearchAvailable && (
                    <button
                      type="button"
                      onClick={() => {
                        setAttachSheetOpen(false)
                        toggleHistorySearch()
                      }}
                      className={clsx(
                        'ficus-button ficus-button-ghost w-full flex items-center gap-3 px-3 py-3 rounded-md text-sm text-primary',
                        historySearchOpen && 'bg-accent/10 hover:bg-accent/20'
                      )}
                    >
                      <SearchIcon className={clsx('w-5 h-5', historySearchOpen ? 'text-accent-light' : 'text-muted')} />
                      {historySearchOpen ? 'Close search' : 'Search this conversation'}
                    </button>
                  )}
                </MobileChatOptionsSheet>
              </form>
            </div>
          </div>
        </div>
      )}
    </div>
  )

  // Wrap in fullscreen overlay when active
  const actionModal = (
    <>
      {selectedToolAction ? (
        <ActionModal
          action={selectedToolAction}
          scope={toolActionScope}
          onClose={() => setSelectedToolAction(null)}
          onUnavailable={() => showToolActionUnavailable(selectedToolAction.kind)}
        />
      ) : null}
      {toolActionNotice ? (
        <InlineActionNotice
          id={toolActionNotice.id}
          message={toolActionNotice.message}
          onDismiss={dismissToolActionNotice}
        />
      ) : null}
    </>
  )

  // Inline actions show only when the viewer can open them in this chat (see ToolInlineActionScopeProvider).
  if (isFullscreen) {
    return (
      <ToolInlineActionScopeProvider value={toolActionScope}>
        <Modal isOpen={isFullscreen} onClose={toggleFullscreen} mobileFullscreen maxWidth="chat" noChildPadding>
          <div className="flex flex-col grow min-h-0 overflow-hidden">{chatContent}</div>
        </Modal>
        {actionModal}
      </ToolInlineActionScopeProvider>
    )
  }

  return (
    <ToolInlineActionScopeProvider value={toolActionScope}>
      {chatContent}
      {actionModal}
    </ToolInlineActionScopeProvider>
  )
}

/**
 * Extract navigate tool calls from content blocks or streaming blocks.
 */
function extractNavigationToolCalls(blocks?: ContentBlock[] | StreamingContentBlock[]): { path: string; id: string }[] {
  if (!blocks) return []
  const results: { path: string; id: string; prompt: boolean }[] = []
  for (const block of blocks) {
    if (block.type !== 'tool_use') continue
    // For streaming blocks, only include completed ones
    if ('_done' in block && !block._done) continue
    if (block.toolCall.toolName !== 'navigate') continue
    try {
      const args = JSON.parse(block.toolCall.args)
      if (args.path) {
        results.push({ path: args.path, id: block.id, prompt: args.prompt })
      }
    } catch {
      // skip malformed args
    }
  }
  return results
}

function NavigateButtons({ navigations }: { navigations: { path: string; id: string }[] }) {
  if (navigations.length === 0) return null
  return (
    <div className="flex flex-wrap gap-1.5 mt-2 pt-2">
      {navigations.map((nav) => (
        <Link
          key={nav.id}
          to={nav.path}
          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium bg-accent/10 text-accent-light hover:bg-accent/20 transition-colors"
        >
          {nav.path}
          <span aria-hidden="true">&rarr;</span>
        </Link>
      ))}
    </div>
  )
}

// Type for grouped streaming blocks
type StreamingBlockGroup =
  | { type: 'single'; block: StreamingContentBlock; index: number }
  | { type: 'group'; blocks: StreamingContentBlock[]; startIndex: number }

/**
 * Groups consecutive non-text streaming blocks (thinking and tool_use) into collapsible groups.
 * Text blocks break groups and are rendered directly.
 */
function groupStreamingBlocks(blocks: StreamingContentBlock[]): StreamingBlockGroup[] {
  const result: StreamingBlockGroup[] = []
  let currentGroup: { blocks: StreamingContentBlock[]; startIndex: number } | null = null

  const flushGroup = () => {
    if (!currentGroup) return
    if (currentGroup.blocks.length === 1) {
      result.push({ type: 'single', block: currentGroup.blocks[0], index: currentGroup.startIndex })
    } else {
      result.push({ type: 'group', blocks: [...currentGroup.blocks], startIndex: currentGroup.startIndex })
    }
    currentGroup = null
  }

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]
    if (block.type === 'text') {
      // Text blocks break groups
      flushGroup()
      result.push({ type: 'single', block, index: i })
    } else {
      // thinking or tool_use - accumulate into current group
      if (!currentGroup) {
        currentGroup = { blocks: [block], startIndex: i }
      } else {
        currentGroup.blocks.push(block)
      }
    }
  }

  // Flush any remaining group
  flushGroup()

  return result
}

/**
 * Generates a human-readable summary for a group of streaming blocks
 */
function getStreamingGroupSummary(blocks: StreamingContentBlock[]): string {
  const toolCount = blocks.filter((b) => b.type === 'tool_use').length
  const thinkingCount = blocks.filter((b) => b.type === 'thinking').length

  const parts: string[] = []
  if (toolCount > 0) {
    parts.push(`${toolCount} tool${toolCount !== 1 ? 's' : ''}`)
  }
  if (thinkingCount > 0) {
    parts.push(`${thinkingCount} thinking`)
  }

  return parts.join(' • ')
}

function StreamingBlocksRenderer({
  blocks: allBlocks,
  isStreaming = true,
  onAbortTool,
  showRaw,
  agentId,
  onToolInlineAction,
}: {
  blocks: StreamingContentBlock[]
  isStreaming?: boolean
  onAbortTool?: () => void
  showRaw?: boolean
  agentId?: string
  onToolInlineAction?: (action: ToolInlineAction) => void
}) {
  const toolRenderers = useToolRenderers()
  // Hidden (bookkeeping) tool calls never render, so the streaming indices below skip them too.
  const blocks = useMemo(() => withoutHiddenToolCalls(allBlocks, toolRenderers), [allBlocks, toolRenderers])
  const groups = useMemo(() => groupStreamingBlocks(blocks), [blocks])

  // Determine streaming state indices
  const lastTextIndex = blocks.map((b, i) => (b.type === 'text' ? i : -1)).reduce((a, b) => Math.max(a, b), -1)
  const lastThinkingIndex = blocks.map((b, i) => (b.type === 'thinking' ? i : -1)).reduce((a, b) => Math.max(a, b), -1)
  const lastToolIndex = blocks.map((b, i) => (b.type === 'tool_use' ? i : -1)).reduce((a, b) => Math.max(a, b), -1)
  const lastBlockIndex = blocks.length - 1
  const lastGroupIndex = groups.length - 1

  return (
    <>
      {groups.map((group, groupIdx) => {
        const isLastGroup = groupIdx === lastGroupIndex

        if (group.type === 'single') {
          const block = group.block
          const blockIndex = group.index

          if (block.type === 'thinking') {
            // Thinking is actively streaming if it's the last thinking block, also the last block overall, and we're still streaming
            const isThinkingStreaming = isStreaming && blockIndex === lastThinkingIndex && blockIndex === lastBlockIndex
            return (
              <ThinkingSection
                key={block.id}
                thinking={block.content}
                isStreaming={isThinkingStreaming}
                durationMs={block.durationMs}
              />
            )
          }
          if (block.type === 'text') {
            // Text is actively streaming if it's the last text block, also the last block overall, and we're still streaming
            const isLastTextStreaming = isStreaming && blockIndex === lastTextIndex && blockIndex === lastBlockIndex
            return (
              <div
                key={block.id}
                className={
                  isLastTextStreaming
                    ? '[&>*:last-child]:inline [&>*:last-child]:mb-0 [&>*:last-child>*:last-child]:mb-0'
                    : ''
                }
              >
                <ParsedTextContent content={block.content} showRaw={showRaw} agentId={agentId} />
                {isLastTextStreaming && (
                  <span className="inline-block w-1.5 h-4 bg-placeholder animate-pulse ml-0.5 align-text-bottom" />
                )}
              </div>
            )
          }
          if (block.type === 'tool_use') {
            const isDone = '_done' in block && block._done
            const isLastTool = blockIndex === lastToolIndex
            return (
              <StreamingToolCallItem
                key={block.id}
                toolCall={{ ...block.toolCall, _done: isDone }}
                defaultExpanded={isLastTool && blockIndex === lastBlockIndex}
                onAbortTool={!isDone ? onAbortTool : undefined}
                onToolInlineAction={onToolInlineAction}
              />
            )
          }
          return null
        } else {
          // Multi-block group - render as collapsible section
          // Last group should be expanded by default
          return (
            <StreamingBlockGroupSection
              key={`group-${groupIdx}`}
              blocks={group.blocks}
              startIndex={group.startIndex}
              defaultExpanded={isLastGroup}
              lastBlockIndex={lastBlockIndex}
              lastThinkingIndex={lastThinkingIndex}
              lastToolIndex={lastToolIndex}
              onAbortTool={onAbortTool}
              onToolInlineAction={onToolInlineAction}
            />
          )
        }
      })}
    </>
  )
}

/**
 * Renders a group of consecutive streaming tool/thinking blocks as a single collapsible section.
 */
function StreamingBlockGroupSection({
  blocks,
  startIndex,
  defaultExpanded,
  lastBlockIndex,
  lastThinkingIndex,
  lastToolIndex,
  onAbortTool,
  onToolInlineAction,
}: {
  blocks: StreamingContentBlock[]
  startIndex: number
  defaultExpanded?: boolean
  lastBlockIndex: number
  lastThinkingIndex: number
  lastToolIndex: number
  onAbortTool?: () => void
  onToolInlineAction?: (action: ToolInlineAction) => void
}) {
  const [expanded, setExpanded] = useState(defaultExpanded ?? false)
  const [seen, setSeen] = useState({ defaultExpanded: !!defaultExpanded, blockCount: blocks.length })

  // Auto-expand when group becomes active (and again as it grows), auto-collapse when no longer active
  if (seen.defaultExpanded !== !!defaultExpanded || seen.blockCount !== blocks.length) {
    setSeen({ defaultExpanded: !!defaultExpanded, blockCount: blocks.length })
    if (defaultExpanded) {
      setExpanded(true)
    } else if (seen.defaultExpanded) {
      // Group is no longer the active/last group — auto-collapse
      setExpanded(false)
    }
  }

  const summary = getStreamingGroupSummary(blocks)
  // A collapsed group still shows the actions its finished tool calls offer, then the images they read,
  // as soon as each result arrives.
  const actions = useMemo(() => getBlocksInlineActions(blocks, { live: true }), [blocks])
  const images = useMemo(() => blocksImages(blocks), [blocks])
  // Check if any tool in this group is still running
  const hasRunningTool = blocks.some((b) => b.type === 'tool_use' && !('_done' in b && b._done))

  return (
    <div className="text-xs">
      <button
        onClick={() => setExpanded(!expanded)}
        className="font-medium w-full flex items-center gap-1.5 py-0.5 max-md:min-h-6 text-secondary hover:text-primary transition-colors"
      >
        <ChevronRightIcon
          className={clsx('w-3 h-3 shrink-0 text-muted transition-transform', expanded && 'rotate-90')}
        />
        {hasRunningTool && (
          <span className="inline-block w-3 h-3 border-2 border-th-border border-t-secondary rounded-full animate-spin shrink-0" />
        )}
        <span className="font-medium">{summary}</span>
      </button>
      {!expanded && <InlineActionRow actions={actions} onOpen={onToolInlineAction} />}
      {!expanded && images.length > 0 && <ToolImageStrip images={images} underRow />}
      {expanded && (
        <div className="mt-1 ml-1.5 border-l-2 border-th-border pl-3 py-0.5 space-y-2">
          {blocks.map((block, i) => {
            const blockIndex = startIndex + i

            if (block.type === 'thinking') {
              const isStreaming = blockIndex === lastThinkingIndex && blockIndex === lastBlockIndex
              return (
                <ThinkingSection
                  key={block.id}
                  thinking={block.content}
                  isStreaming={isStreaming}
                  durationMs={block.durationMs}
                />
              )
            }
            if (block.type === 'tool_use') {
              const isDone = '_done' in block && block._done
              const isLastTool = blockIndex === lastToolIndex
              return (
                <StreamingToolCallItem
                  key={block.id}
                  toolCall={{ ...block.toolCall, _done: isDone }}
                  defaultExpanded={isLastTool && !isDone}
                  onAbortTool={!isDone ? onAbortTool : undefined}
                  onToolInlineAction={onToolInlineAction}
                />
              )
            }
            return null
          })}
        </div>
      )}
    </div>
  )
}

function StreamingToolCallItem({
  toolCall,
  defaultExpanded,
  onAbortTool,
  onToolInlineAction,
}: {
  toolCall: MessageToolCall & { _done?: boolean }
  defaultExpanded: boolean
  onAbortTool?: () => void
  onToolInlineAction?: (action: ToolInlineAction) => void
}) {
  const toolRenderers = useToolRenderers()
  const inProgress = !toolCall._done
  const isIncomplete = !inProgress && !toolCall.result && !toolCall.isError
  const isError = toolCall.isError || isIncomplete
  const result = toolCall.result || (isIncomplete ? 'Command aborted' : '')
  const [expanded, setExpanded] = useState(defaultExpanded)
  const firewall = useMemo(
    () => (toolCall._done ? getToolFirewallFlag({ result: toolCall.result }) : null),
    [toolCall._done, toolCall.result]
  )
  const images = useMemo(
    () =>
      toolCallImages({
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        args: toolCall.args,
        result: toolCall.result,
      }),
    [toolCall.toolCallId, toolCall.toolName, toolCall.args, toolCall.result]
  )

  // When defaultExpanded changes (e.g. a new tool call pushes this one up), sync
  const [syncedDefaultExpanded, setSyncedDefaultExpanded] = useState(defaultExpanded)
  if (syncedDefaultExpanded !== defaultExpanded) {
    setSyncedDefaultExpanded(defaultExpanded)
    setExpanded(defaultExpanded)
  }

  return (
    <div className="text-xs">
      <div data-tool-call-row={toolCall.toolCallId} className="flex items-center">
        <button
          onClick={() => setExpanded(!expanded)}
          className="font-medium flex-1 flex items-center gap-1.5 py-0.5 max-md:min-h-6 text-secondary hover:text-primary transition-colors text-left min-w-0"
        >
          {inProgress ? (
            <span className="inline-block w-3 h-3 border-2 border-th-border border-t-secondary rounded-full animate-spin shrink-0" />
          ) : isError ? (
            <span className="text-status-danger-500 dark:text-status-danger-400 shrink-0 inline-block w-3 text-center">
              &#10007;
            </span>
          ) : (
            <span className="text-status-success-600 dark:text-status-success-400 shrink-0 inline-block w-3 text-center">
              &#10003;
            </span>
          )}
          <span className="font-medium shrink-0">{toolCall.toolName}</span>
          <ToolSummary
            renderers={toolRenderers}
            toolName={toolCall.toolName}
            args={toolCall.args}
            inProgress={inProgress}
          />
          {firewall && <ToolFirewallBadge flag={firewall} />}
          {isError && (
            <span className="text-status-danger-500 dark:text-status-danger-400 text-[10px] font-medium shrink-0">
              ERROR
            </span>
          )}
          <ChevronRightIcon
            className={clsx('w-3 h-3 shrink-0 text-muted transition-transform', expanded && 'rotate-90')}
          />
        </button>
        {inProgress && onAbortTool && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              onAbortTool()
            }}
            className="ficus-button ficus-button-danger px-2 py-0.5 ml-1 text-xs font-medium text-status-external-wait-600 dark:text-status-external-wait-400 hover:bg-status-external-wait-50 dark:hover:bg-status-external-wait-900/30 rounded transition-colors shrink-0"
          >
            Abort
          </button>
        )}
      </div>
      <ToolInlineActions toolCall={toolCall} completed={toolCall._done === true} onOpen={onToolInlineAction} />
      {!expanded && images.length > 0 && <ToolImageStrip images={images} underRow />}
      {expanded && (
        <div className="mt-1 ml-1.5 border-l-2 border-th-border pl-3 py-0.5 space-y-1">
          {toolCall.args && (
            <ToolArgsView
              renderers={toolRenderers}
              toolName={toolCall.toolName}
              args={toolCall.args}
              follow={inProgress}
            />
          )}
          {result && (
            <ToolResultView
              renderers={toolRenderers}
              toolName={toolCall.toolName}
              args={toolCall.args}
              result={result}
              isError={isError}
              autoScroll={inProgress}
            />
          )}
          {inProgress && !result && <div className="text-placeholder text-[10px] italic">Running...</div>}
        </div>
      )}
    </div>
  )
}

/**
 * While the agent works, the Ficus plant peeks up from behind the composer,
 * pot half hidden: it jumps up into place when work starts, and jumps then
 * falls back out of sight when it ends (kept mounted just for that), the same
 * jump it does when clicked. Reduced motion shows and hides it without them.
 */
function PeekingPlant({ working, label }: { working: boolean; label?: string }) {
  const plant = usePlantPresence(working)
  const [shownLabel, setShownLabel] = useState(label)
  if (working && label !== shownLabel) setShownLabel(label)

  if (!plant.shown) return null
  return (
    <div className="pointer-events-none absolute bottom-full left-3 z-0 translate-y-[26%] md:left-4">
      <div
        className="ficus-plant-peek"
        data-state={plant.state}
        aria-hidden={working ? undefined : true}
        onAnimationEnd={plant.onAnimationEnd}
      >
        <TypingIndicator label={shownLabel} />
      </div>
    </div>
  )
}
