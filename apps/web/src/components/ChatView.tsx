import { useToolRenderers } from '../lib/ToolRenderersContext'
import { ConversationSkeleton } from './loading/Skeleton'
import clsx from 'clsx'
import { useState, useRef, useEffect, useCallback, useMemo, useContext } from 'react'
import { Link } from 'react-router-dom'
import { flushSync } from 'react-dom'
import type { MessageMetadata, MessageToolCall, ContentBlock, DeliveryMode, ExecutionStatus } from '@ficus/shared'
import { AssistantMessageContent, HumanMessageContent, ThinkingSection, ParsedTextContent } from './MessageContent'
import { TypingIndicator } from './TypingIndicator'
import { ToolSummary, ToolArgsView, ToolResultView } from '../lib/tool-renderers'
import { getImageAttachState } from '../lib/imageAttach'
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CloseIcon,
  CodeIcon,
  ExpandIcon,
  FileIcon,
  AutoScrollIcon,
  ImageIcon,
  MarkdownIcon,
  MicIcon,
  MinimizeIcon,
  PlusIcon,
  SpeakerOffIcon,
  SpeakerOnIcon,
  StopIcon,
  SendIcon,
  TrashIcon,
} from './icons'
import { useFullscreen } from '../hooks/useFullscreen'
import { Modal } from './Modal'
import { ChatFullscreenContext } from './ChatFullscreenContext'
import { MobileChatOptionsSheet } from './MobileChatOptionsSheet'
import { ToolInlineActions } from './ToolInlineActions'
import { ToolInlineActionModal, type ToolInlineActionModalProps } from './ToolInlineActionModal'
import type { ToolInlineAction } from '../lib/tool-inline-actions'
import type { RenderItem, StreamingContentBlock } from '@ficus/client-react'
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
  onCancelQueue?: () => void | Promise<void>
  deliveryMode?: DeliveryMode
  onDeliveryModeChange?: (m: DeliveryMode) => void
  // pagination
  onLoadOlder?: () => void
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
  inputPrefix?: React.ReactNode
  /** localStorage key for persisting draft input across navigations/refreshes */
  inputStorageKey?: string
  /** Squad ID for permissions, file mentions, and staging images before an agent exists. */
  squadId?: string
  renderMessageFooter?: (item: Extract<RenderItem, { kind: 'persisted' }>) => React.ReactNode
  afterMessages?: React.ReactNode
  /** Persistent content in normal flow directly above the composer. */
  beforeComposer?: React.ReactNode
  className?: string
  autoFocus?: boolean
  sendLabel?: string
  sendButtonClassName?: string
  thinkingLabel?: string
  focusTrigger?: number
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
}

// ---------------------------------------------------------------------------
// Row components
// ---------------------------------------------------------------------------

function HumanMessageRow({
  message,
  viewingUserId,
  showSenderLabel,
  showRaw,
  agentId,
}: {
  agentId?: string
  message: { id: string; role: string; content: string; metadata?: MessageMetadata | null }
  viewingUserId?: string
  showSenderLabel?: boolean
  showRaw?: boolean
}) {
  void viewingUserId // used by caller to compute showSenderLabel
  const auto = automatedSource(message)
  const sender = message.metadata?.sender
  return (
    <div className="flex flex-col">
      {showSenderLabel && sender && <span className="text-[11px] text-muted self-end mr-1 mb-0.5">{sender.name}</span>}
      <div className={clsx('flex', 'justify-end')}>
        <div
          className={clsx(
            'max-w-[90%] md:max-w-[80%] rounded-lg',
            auto ? 'break-words' : 'px-3 md:px-4 py-2 md:py-3 bg-accent text-on-accent break-words'
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
}: {
  agentId?: string
  onToolInlineAction?: (action: ToolInlineAction) => void
  message: { id: string; role: string; content: string; metadata?: MessageMetadata | null }
  blocks: ContentBlock[]
  showRaw?: boolean
  tts?: ChatViewProps['tts']
}) {
  // If we have pre-merged blocks, inject them as metadata.content so AssistantMessageContent uses them
  const effectiveMetadata: MessageMetadata | null =
    blocks.length > 0 ? { ...(message.metadata ?? {}), content: blocks } : (message.metadata ?? null)

  return (
    // No bubble — agent text flows on the page (mobile vibe). Only human messages are bubbled.
    <div className="text-primary overflow-hidden pr-2 md:pr-10">
      <div>
        <AssistantMessageContent
          content={message.content}
          metadata={effectiveMetadata}
          showRaw={showRaw}
          agentId={agentId}
          onToolInlineAction={onToolInlineAction}
        />
        <NavigateButtons navigations={extractNavigationToolCalls(effectiveMetadata?.content)} />
        {tts && tts.playingMessageId === message.id && (
          <div className="flex items-center mt-2 pt-1.5 border-t border-th-border">
            <button
              type="button"
              onClick={() => tts.stop()}
              className="ficus-button flex items-center gap-1 px-1.5 py-0.5 rounded text-xs transition-colors text-status-progress-600 dark:text-status-progress-400 bg-status-progress-50 dark:bg-status-progress-900/30 hover:bg-status-progress-100 dark:hover:bg-status-progress-900/50"
              title={tts.isSynthesizing ? 'Loading...' : 'Stop'}
            >
              {tts.isSynthesizing ? (
                <span className="inline-block w-3.5 h-3.5 border-2 border-status-progress-300 border-t-status-progress-600 rounded-full animate-spin" />
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
  onRetry?: () => void
  metadata?: MessageMetadata | null
}) {
  const effectiveMetadata: MessageMetadata | undefined =
    metadata || imageIds?.length || deliveryMode
      ? { ...(metadata ?? {}), ...(imageIds?.length ? { imageIds } : {}), ...(deliveryMode ? { deliveryMode } : {}) }
      : undefined
  const auto = automatedSource({ role: 'human', metadata: effectiveMetadata ?? null })

  return (
    <div className="flex justify-end">
      <div
        className={clsx(
          'max-w-[90%] md:max-w-[80%] rounded-lg break-words',
          auto ? '' : 'px-3 md:px-4 py-2 md:py-3 bg-accent text-on-accent'
        )}
      >
        {deliveryMode && !auto && queued && (
          <div className="flex items-center gap-1.5 mb-1 text-on-accent/80 text-xs">
            {deliveryMode === 'steer' ? '⚡ Interrupt' : '📋 Follow up'}
          </div>
        )}
        <HumanMessageContent content={content} metadata={effectiveMetadata} showRaw={false} agentId={agentId} />
        {status === 'failed' && onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="ficus-button mt-1 text-xs text-on-accent underline hover:text-on-accent/80"
          >
            Retry
          </button>
        )}
        {status === 'sending' && !auto && <div className="mt-1 text-xs text-on-accent/80">Sending…</div>}
      </div>
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

export function ChatView({
  items,
  onSend,
  agentId,
  onRetry,
  onStop,
  onAbortTool,
  onCancelQueue,
  deliveryMode,
  onDeliveryModeChange,
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
  inputPrefix,
  inputStorageKey,
  squadId,
  afterMessages,
  renderMessageFooter,
  beforeComposer,
  className,
  autoFocus = true,
  sendLabel = 'Send',
  sendButtonClassName,
  thinkingLabel = 'Thinking...',
  focusTrigger,
  keyboardShortcutsEnabled = true,
  tts,
  showRawText,
  onToggleRawText,
  selectedModelSupportsImages,
  focusMessageId,
  focusInboxMessageId,
  dependencies,
}: ChatViewProps) {
  const useImageSrcsHook = dependencies?.useImageSrcsHook ?? useImageSrcs
  const usePermissionsHook = dependencies?.usePermissionsHook ?? usePermissions
  const useVoiceEnabledHook = dependencies?.useVoiceEnabledHook ?? useVoiceEnabled
  const useVoiceRecorderHook = dependencies?.useVoiceRecorderHook ?? useVoiceRecorder
  const uploadImagesDependency = dependencies?.uploadImages ?? uploadImages
  const ActionModal = dependencies?.ToolInlineActionModalComponent ?? ToolInlineActionModal
  const [selectedToolAction, setSelectedToolAction] = useState<ToolInlineAction | null>(null)
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
  const pendingItems = useMemo(
    () => items.filter((i) => i.kind === 'pending' && (i.queued || i.status === 'queued' || i.status === 'failed')),
    [items]
  )

  // Uncontrolled textarea — value lives in a ref to avoid re-rendering
  // the entire component on every keystroke. Only `hasInput` (boolean)
  // is state so the send button / voice shortcuts update on empty↔non-empty.
  const inputRef = useRef(
    (() => {
      if (!inputStorageKey) return ''
      try {
        return localStorage.getItem(`chat-draft:${inputStorageKey}`) ?? ''
      } catch {
        return ''
      }
    })()
  )
  const [hasInput, setHasInput] = useState(() => !!inputRef.current.trim())
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const inputContainerRef = useRef<HTMLDivElement>(null)
  // When a focus target is requested, start with auto-scroll disabled so the initial
  // scroll-to-bottom effect doesn't fire before we've had a chance to jump to the target.
  const focusRequested = !!(focusMessageId || focusInboxMessageId)
  const [autoScroll, _setAutoScroll] = useState(() => !focusRequested)
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
  const { can, isLoading: permissionsLoading } = usePermissionsHook(squadId)
  const canUploadImages = !permissionsLoading && can('agents:write')
  const imageAttachState = getImageAttachState({ canUploadImages, selectedModelSupportsImages })

  /** Set the textarea value imperatively (ref + DOM + hasInput state) */
  const setInputValue = useCallback(
    (value: string) => {
      inputRef.current = value
      if (textareaRef.current) {
        textareaRef.current.value = value
        resizeTextarea(textareaRef.current)
      }
      setHasInput(!!value.trim())
    },
    [resizeTextarea]
  )

  // Reload draft when the storage key changes (e.g. navigating between agents)
  useEffect(() => {
    if (!inputStorageKey) return
    try {
      const draft = localStorage.getItem(`chat-draft:${inputStorageKey}`) ?? ''
      setInputValue(draft)
    } catch {
      setInputValue('')
    }
  }, [inputStorageKey, setInputValue])

  // Debounced localStorage save — driven from onChange, not useEffect
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const saveDraft = useCallback(
    (value: string) => {
      if (!inputStorageKey) return
      if (draftTimerRef.current) clearTimeout(draftTimerRef.current)
      draftTimerRef.current = setTimeout(() => {
        try {
          if (value) {
            localStorage.setItem(`chat-draft:${inputStorageKey}`, value)
          } else {
            localStorage.removeItem(`chat-draft:${inputStorageKey}`)
          }
        } catch {
          // localStorage may be full or unavailable
        }
      }, 1000)
    },
    [inputStorageKey]
  )

  // Clear timer on unmount
  useEffect(
    () => () => {
      if (draftTimerRef.current) clearTimeout(draftTimerRef.current)
    },
    []
  )

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

  useEffect(() => {
    if (!focusMessageId && !focusInboxMessageId) return
    let cancelled = false
    focusSearchActiveRef.current = true
    focusModeRef.current = true
    updateAutoScroll(false)
    const target = {
      ...(focusMessageId ? { messageId: focusMessageId } : {}),
      ...(focusInboxMessageId ? { inboxMessageId: focusInboxMessageId } : {}),
    }
    const MAX_OLDER_PAGES = 10
    const scrollToItem = (itemId: string) => {
      scrollContainerRef.current
        ?.querySelector<HTMLElement>(`[data-message-id~="${itemId}"]`)
        ?.scrollIntoView?.({ block: 'center' })
    }

    const run = async () => {
      let attempts = 0
      let foundId: string | null = null
      while (!cancelled) {
        foundId = findFocusTarget(target)
        if (foundId) break
        const loadOlder = onLoadOlderStableRef.current
        if (!hasOlderMessagesStableRef.current || attempts >= MAX_OLDER_PAGES || !loadOlder) break
        attempts += 1
        const previousItems = itemsStableRef.current
        const result: unknown = loadOlder()
        if (result && typeof (result as Promise<unknown>).then === 'function') {
          await result
        } else {
          await Promise.resolve()
        }
        // Bounded wait for the fetched page to actually land in `items` before rechecking.
        const start = Date.now()
        while (!cancelled && itemsStableRef.current === previousItems && Date.now() - start < 5000) {
          await new Promise((resolve) => setTimeout(resolve, 30))
        }
      }
      if (cancelled) return
      if (!foundId) {
        // Never found the target — fall back to normal bottom-anchored behavior.
        focusModeRef.current = false
        updateAutoScroll(true)
        requestAnimationFrame(pinTranscriptToBottom)
        focusSearchActiveRef.current = false
        return
      }
      setHighlightedMessageId(foundId)
      if (highlightTimeoutRef.current) clearTimeout(highlightTimeoutRef.current)
      highlightTimeoutRef.current = setTimeout(() => setHighlightedMessageId(null), 2000)
      // PIN PHASE: a single scrollIntoView was not enough — prepended pages,
      // images, and streaming appends keep shifting layout for a while, which
      // read as "scrolls up then stops partway". Re-assert the target position
      // after paint and again whenever items change, briefly.
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      if (cancelled) return
      scrollToItem(foundId)
      const settleStart = Date.now()
      let lastItems = itemsStableRef.current
      while (!cancelled && Date.now() - settleStart < 2000) {
        await new Promise((resolve) => setTimeout(resolve, 150))
        if (itemsStableRef.current !== lastItems) {
          lastItems = itemsStableRef.current
          scrollToItem(foundId)
        }
      }
      focusSearchActiveRef.current = false
      // focusModeRef stays set: the user is reading a past message, and
      // bottom-follow only returns on their own scroll-to-bottom or send.
    }

    void run()

    return () => {
      cancelled = true
      focusSearchActiveRef.current = false
    }
    // The loop reads live state via stable refs — only the target ids should restart it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusMessageId, focusInboxMessageId, findFocusTarget, pinTranscriptToBottom, updateAutoScroll])

  useEffect(() => {
    return () => {
      if (highlightTimeoutRef.current) clearTimeout(highlightTimeoutRef.current)
    }
  }, [])

  // Image state
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([])
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
  const [attachSheetOpen, setAttachSheetOpen] = useState(false)
  const attachSheetTriggerRef = useRef<HTMLButtonElement>(null)

  // Track whether we've ever seen an empty pending queue (for "loaded with pending already" detection)
  const sawPendingEmptyRef = useRef(pendingItems.length === 0)

  // Show clear queue button when there are pending (queued/failed) items
  useEffect(() => {
    if (pendingItems.length === 0) {
      setShowClearQueue(false)
      setConfirmingClearQueue(false)
      sawPendingEmptyRef.current = true
      if (clearQueueConfirmTimeoutRef.current) {
        clearTimeout(clearQueueConfirmTimeoutRef.current)
        clearQueueConfirmTimeoutRef.current = null
      }
      return
    }

    // Show immediately if streaming (interrupt/follow-up)
    if (isStreaming) {
      setShowClearQueue(true)
      return
    }

    // Show immediately if we loaded with pending items already (hydration / refresh scenario):
    // we never saw the queue empty since mount, so the data arrived with pending already present
    if (!sawPendingEmptyRef.current) {
      setShowClearQueue(true)
      return
    }

    // Otherwise, delay showing the button to avoid flicker when agent picks up quickly
    const timer = setTimeout(() => {
      setShowClearQueue(true)
    }, 5000)

    return () => clearTimeout(timer)
  }, [pendingItems.length, isStreaming])

  // File mention autocomplete
  const { mentionState, checkForMention, closeMention, selectFile } = useFileMention(
    squadId,
    textareaRef,
    inputRef,
    setInputValue
  )

  const handleCancelQueue = useCallback(async () => {
    if (!onCancelQueue || pendingItems.length === 0) return
    if (clearQueueConfirmTimeoutRef.current) {
      clearTimeout(clearQueueConfirmTimeoutRef.current)
      clearQueueConfirmTimeoutRef.current = null
    }
    setConfirmingClearQueue(false)
    setIsClearingQueue(true)
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

      // Restore content to input field
      const prev = inputRef.current
      const next = prev ? prev + '\n\n' + restoredText : restoredText
      setInputValue(next)
      saveDraft(next)
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
    } finally {
      setIsClearingQueue(false)
    }
  }, [onCancelQueue, pendingImageSrcs, pendingItems, saveDraft, setInputValue])

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

  // Preserve scroll position when older messages are prepended.
  // Track item count and scroll height to detect when new messages were added at the top.
  const prevItemCountRef = useRef(0)
  const prevScrollHeightRef = useRef(0)

  useEffect(() => {
    const el = scrollContainerRef.current
    if (!el) return

    const currentCount = items.length
    const prevCount = prevItemCountRef.current

    // If items were added and we're NOT at auto-scroll (user viewing history)
    // and the scroll height increased, preserve position
    if (currentCount > prevCount && !autoScrollRef.current && prevScrollHeightRef.current > 0) {
      const heightDiff = el.scrollHeight - prevScrollHeightRef.current
      if (heightDiff > 0) {
        el.scrollTop += heightDiff
      }
    }

    prevItemCountRef.current = currentCount
    prevScrollHeightRef.current = el.scrollHeight
  }, [items])

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

  // Drag and drop handlers
  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setIsDragging(false)

      if (inputDisabled || isSubmittingRef.current) return
      const files = Array.from(e.dataTransfer.files)
      const images = files.filter((file) => ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.type))
      if (imageAttachState.allowed) addImages(images)
      agentFiles.addFiles(files.filter((file) => !images.includes(file)))
    },
    [addImages, agentFiles, imageAttachState.allowed, inputDisabled]
  )

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }, [])

  const handleDragEnter = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (inputDisabled || isSubmittingRef.current) return
      setIsDragging(true)
    },
    [inputDisabled]
  )

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    // Only set dragging to false if we're leaving the drop zone entirely
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX
    const y = e.clientY
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
      setIsDragging(false)
    }
  }, [])

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

    try {
      // Send message with image IDs - await if it returns a Promise
      await onSend(messageToSend, allImageIds.length > 0 ? allImageIds : undefined)

      // Only clean up on success
      imagesToCleanup.forEach((img) => URL.revokeObjectURL(img.preview))
      setInputValue('')
      saveDraft('')
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

  const handleTranscription = useCallback(
    (text: string) => {
      const prev = inputRef.current
      const next = prev ? prev + ' ' + text : text
      setInputValue(next)
      saveDraft(next)
      // Focus after inserting text; setInputValue already resized the textarea.
      setTimeout(() => textareaRef.current?.focus(), 0)
    },
    [saveDraft, setInputValue]
  )

  const [voiceError, setVoiceError] = useState<string | null>(null)
  const handleVoiceError = useCallback((error: string) => {
    setVoiceError(error)
    setTimeout(() => setVoiceError(null), 3000)
  }, [])

  const [imagePreparationError, setImagePreparationError] = useState<string | null>(null)
  const [imageError, setImageError] = useState<string | null>(null)
  const [sendError, setSendError] = useState<string | null>(null)

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

  const rawTextToggleButton = onToggleRawText && (
    <button
      onClick={onToggleRawText}
      className={clsx(
        'ficus-button',
        'p-1.5 rounded-md transition-colors shrink-0',
        showRawText
          ? 'text-status-progress-600 dark:text-status-progress-400 bg-status-progress-50 dark:bg-status-progress-900/30 hover:bg-status-progress-100 dark:hover:bg-status-progress-900/50'
          : 'text-placeholder hover:text-secondary hover:bg-surface-hover'
      )}
      aria-label={showRawText ? 'Show rendered markdown' : 'Show raw text'}
      title={showRawText ? 'Show rendered markdown' : 'Show raw text'}
    >
      {showRawText ? <MarkdownIcon className="w-4 h-4" /> : <CodeIcon className="w-4 h-4" />}
    </button>
  )

  const fullscreenButton = (enableFullscreen || isFullscreen) && (
    <button
      onClick={toggleFullscreen}
      className="ficus-button p-1.5 rounded-md text-placeholder hover:text-secondary hover:bg-surface-hover transition-colors shrink-0"
      aria-label={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
      title={isFullscreen ? 'Exit fullscreen (Escape)' : 'Fullscreen'}
    >
      {isFullscreen ? <MinimizeIcon className="w-4 h-4" /> : <ExpandIcon className="w-4 h-4" />}
    </button>
  )

  const chatContent = (
    <div
      className={clsx(
        'flex flex-col bg-surface min-h-0 grow',
        isFullscreen ? 'h-full rounded-lg shadow-xl overflow-hidden' : 'rounded-lg',
        className
      )}
    >
      {(header || rawTextToggleButton || fullscreenButton) && (
        <div
          className={clsx(
            'px-3 md:px-4 py-0.5 md:py-2 border-b border-th-border shrink-0',
            isFullscreen && 'bg-surface-secondary'
          )}
        >
          <div className="flex items-center gap-2">
            <div className="flex-1 min-w-0">{header}</div>
            {rawTextToggleButton}
            {fullscreenButton}
          </div>
        </div>
      )}

      {/* Messages */}
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        onWheel={markUserScrolling}
        onTouchMove={markUserScrolling}
        className="flex-1 overflow-y-auto overflow-x-hidden p-3 md:p-4 space-y-3 min-h-0"
      >
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
          let prevSenderUserId: string | undefined
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
              const wrap = (node: React.ReactNode) => (
                <div
                  key={item.id}
                  data-message-id={messageIds.join(' ')}
                  className={clsx(
                    'rounded-lg transition-shadow duration-1000',
                    isFocusHighlighted && 'ring-2 ring-accent ring-offset-2 ring-offset-surface'
                  )}
                >
                  {node}
                  {renderMessageFooter?.(item)}
                </div>
              )
              if (m.content.startsWith('[System]')) {
                prevSenderUserId = undefined
                return wrap(<SystemMessageRow content={m.content} />)
              }
              if (m.role === 'human') {
                const sender = m.metadata?.sender
                const showSenderLabel =
                  !!sender && sender.userId !== viewingUserId && sender.userId !== prevSenderUserId
                prevSenderUserId = sender?.userId
                return wrap(
                  <HumanMessageRow
                    message={m}
                    viewingUserId={viewingUserId}
                    showSenderLabel={showSenderLabel}
                    showRaw={showRawText}
                    agentId={agentId}
                  />
                )
              }
              prevSenderUserId = undefined
              return wrap(
                <AssistantMessageRow
                  message={m}
                  blocks={item.blocks}
                  showRaw={showRawText}
                  tts={tts}
                  agentId={agentId}
                  onToolInlineAction={setSelectedToolAction}
                />
              )
            }

            if (item.kind === 'system') {
              prevSenderUserId = undefined
              return <SystemMessageRow key={item.id} content={item.text} />
            }

            if (item.kind === 'working') {
              // Activity indicator: position is decided by combine(); we just render it. A
              // waitingFor: 'sandbox' tag means the busy window is specifically the sandbox-ensure
              // debounce (server-pushed execution_phase) — show a distinct label instead of the
              // default thinking copy.
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
              return (
                <div key={item.id} className="text-primary overflow-hidden space-y-2 pr-2 md:pr-10">
                  <StreamingBlocksRenderer
                    blocks={item.blocks}
                    isStreaming={item.status === 'streaming'}
                    onAbortTool={onAbortTool}
                    showRaw={showRawText}
                    agentId={agentId}
                    onToolInlineAction={setSelectedToolAction}
                  />
                  <NavigateButtons navigations={extractNavigationToolCalls(item.blocks)} />
                </div>
              )
            }

            // pending
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
      </div>

      {beforeComposer && <div className="shrink-0 px-3 pb-2 md:px-4">{beforeComposer}</div>}

      {/* Input */}
      {!shouldHideComposer && (
        <div
          ref={inputContainerRef}
          className={clsx(
            'px-3 py-2 md:px-4 md:py-2.5 border-t border-th-border shrink-0 relative',
            isDragging &&
              'ring-2 ring-status-progress-400 ring-inset bg-status-progress-50 dark:bg-status-progress-900/30'
          )}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
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
            {(imagePreparationError || imageError || sendError) && (
              <div
                role="alert"
                aria-live="assertive"
                className="rounded-lg px-3 py-2 bg-status-danger-50 dark:bg-status-danger-900/30 text-status-danger-600 dark:text-status-danger-400 text-sm"
              >
                {imagePreparationError
                  ? `Image attachment failed: ${imagePreparationError}`
                  : imageError
                    ? `Image upload failed: ${imageError}`
                    : `Message was not sent: ${sendError}`}
              </div>
            )}

            {/* Drop overlay */}
            {isDragging && (
              <div className="absolute inset-0 bg-status-progress-100/80 dark:bg-status-progress-900/80 flex items-center justify-center z-10 pointer-events-none rounded-b-lg">
                <div className="text-status-progress-600 dark:text-status-progress-300 font-medium flex items-center gap-2">
                  <FileIcon className="h-6 w-6" />
                  Drop files here
                </div>
              </div>
            )}

            {inputPrefix}

            {/* Clear queue button */}
            {onCancelQueue && showClearQueue && pendingItems.length > 0 && (
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={handleCancelQueueClick}
                  disabled={isClearingQueue}
                  className={clsx(
                    'ficus-button',
                    'flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors disabled:opacity-50',
                    confirmingClearQueue
                      ? 'bg-status-danger-50 dark:bg-status-danger-900/30 text-status-danger-700 dark:text-status-danger-300 hover:bg-status-danger-100 dark:hover:bg-status-danger-900/50'
                      : 'bg-status-attention-50 dark:bg-status-attention-900/30 text-status-attention-700 dark:text-status-attention-300 hover:bg-status-attention-100 dark:hover:bg-status-attention-900/50'
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
                        <button className="ficus-button" type="button" onClick={() => agentFiles.retryFile(file.id)}>
                          Retry
                        </button>
                      </>
                    )}
                    <button
                      className="ficus-button"
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
                                stroke="rgb(var(--status-neutral-200))"
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
                        className="ficus-button mt-1 block w-16 text-xs text-status-progress-600 dark:text-status-progress-400 hover:underline"
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
                        className="ficus-button absolute -top-1 -right-1 bg-status-danger-500 hover:bg-status-danger-600 text-on-strong rounded-full w-5 h-5 flex items-center justify-center text-xs shadow-sm opacity-0 group-hover:opacity-100 transition-opacity"
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
                    className="ficus-button flex items-center gap-1 px-2 py-1 text-xs text-muted hover:text-status-danger-600 dark:hover:text-status-danger-400 hover:bg-status-danger-50 dark:hover:bg-status-danger-900/30 rounded transition-colors self-center"
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
                ref={textareaRef}
                onClick={expandMobileComposer}
                defaultValue={inputRef.current}
                onChange={(e) => {
                  if (isSubmittingRef.current) {
                    e.target.value = inputRef.current
                    return
                  }
                  const val = e.target.value
                  inputRef.current = val
                  setHasInput(!!val.trim())
                  saveDraft(val)
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
                className="ficus-field w-full min-h-[46px] md:min-h-[38px] shrink-0 rounded-md border-input-border bg-input-bg text-primary focus:border-status-progress-500 focus:ring-status-progress-500 px-3 py-2.5 md:py-2 border disabled:bg-surface-secondary resize-none max-h-40 overflow-y-auto text-base md:text-sm"
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
              <p className="text-xs text-placeholder !mt-1 hidden md:block">
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
                <button
                  type="button"
                  ref={attachSheetTriggerRef}
                  onClick={() => setAttachSheetOpen(true)}
                  aria-haspopup="dialog"
                  aria-expanded={attachSheetOpen}
                  className="ficus-button chat-composer-attach md:hidden p-2.5 rounded-md text-muted hover:text-secondary hover:bg-surface-hover transition-colors shrink-0"
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
                    className="ficus-button p-2.5 md:p-2 rounded-md text-muted hover:text-secondary hover:bg-surface-hover disabled:opacity-50 transition-colors shrink-0"
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
                    className="ficus-button p-2.5 md:p-2 rounded-md text-muted hover:text-secondary hover:bg-surface-hover disabled:opacity-50 transition-colors shrink-0"
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
                          'ficus-button',
                          'relative z-10 p-2.5 md:p-2 rounded-md min-h-[44px] md:min-h-0 flex items-center justify-center transition-colors disabled:opacity-50',
                          voiceState === 'recording'
                            ? 'bg-status-danger-100 dark:bg-status-danger-900/30 text-status-danger-600 dark:text-status-danger-400 hover:bg-status-danger-200 dark:hover:bg-status-danger-900/50'
                            : voiceState === 'transcribing'
                              ? 'bg-surface-secondary text-placeholder'
                              : 'text-muted hover:text-secondary hover:bg-surface-hover'
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
                          <span className="inline-block w-5 h-5 border-2 border-status-neutral-300 dark:border-status-neutral-600 border-t-status-neutral-600 dark:border-t-status-neutral-300 rounded-full animate-spin" />
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
                          'ficus-button',
                          'p-2.5 md:p-2 rounded-md min-h-[44px] md:min-h-0 flex items-center justify-center transition-colors',
                          tts.isPlaying || tts.isSynthesizing
                            ? 'bg-status-progress-100 dark:bg-status-progress-900/30 text-status-progress-600 dark:text-status-progress-400'
                            : tts.enabled
                              ? 'text-status-progress-600 dark:text-status-progress-400 hover:bg-status-progress-50 dark:hover:bg-status-progress-900/30'
                              : 'text-placeholder hover:text-secondary hover:bg-surface-hover'
                        )}
                        title={tts.enabled ? 'Disable auto-speak' : 'Enable auto-speak'}
                      >
                        {tts.isSynthesizing ? (
                          <span className="inline-block w-5 h-5 border-2 border-status-progress-300 border-t-status-progress-600 rounded-full animate-spin" />
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
                      'ficus-button',
                      'p-2.5 md:p-2 rounded-md min-h-[44px] md:min-h-0 flex items-center justify-center transition-colors',
                      autoScroll
                        ? 'text-accent hover:bg-selection'
                        : 'text-placeholder hover:text-secondary hover:bg-surface-hover'
                    )}
                    title={autoScroll ? 'Auto-scroll enabled' : 'Auto-scroll disabled'}
                  >
                    <AutoScrollIcon className="w-5 h-5" />
                  </button>
                </div>
                <div className="chat-composer-send flex items-center gap-2 md:gap-1">
                  {onStop && isStreaming && (
                    <button
                      type="button"
                      onClick={onStop}
                      className="ficus-button chat-composer-stop px-2.5 py-2 md:py-1.5 rounded-md text-on-strong text-sm font-medium min-h-[44px] md:min-h-0 bg-status-danger-600 hover:bg-status-danger-700 active:bg-status-danger-800 transition-colors"
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
                        deliveryMode === 'steer' ? 'bg-accent text-on-accent' : 'bg-status-attention-600 text-on-strong'
                      )}
                    >
                      <button
                        type="submit"
                        aria-label={
                          isPreparingImages
                            ? 'Preparing...'
                            : isUploading
                              ? 'Uploading...'
                              : isSubmitting
                                ? 'Sending...'
                                : deliveryMode === 'steer'
                                  ? 'Interrupt'
                                  : 'Follow up'
                        }
                        title={
                          deliveryMode === 'steer'
                            ? 'Send now: the agent reads it at its next step'
                            : 'Send after the agent finishes this turn'
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
                          'chat-composer-submit px-3 py-2 text-sm font-medium transition-colors disabled:opacity-50 md:py-1.5',
                          deliveryMode === 'steer'
                            ? 'hover:bg-accent-hover active:bg-accent-active'
                            : 'hover:bg-status-attention-700 active:bg-status-attention-800'
                        )}
                      >
                        {isPreparingImages
                          ? 'Preparing...'
                          : isUploading
                            ? 'Uploading...'
                            : isSubmitting
                              ? 'Sending...'
                              : deliveryMode === 'steer'
                                ? 'Interrupt'
                                : 'Follow up'}
                      </button>
                      <label
                        title="Choose when this message is delivered"
                        className={clsx(
                          'chat-composer-mode relative flex cursor-pointer items-center border-l px-1.5 transition-colors',
                          deliveryMode === 'steer'
                            ? 'border-accent-active hover:bg-accent-hover'
                            : 'border-status-attention-700 hover:bg-status-attention-700'
                        )}
                      >
                        <ChevronDownIcon className="h-4 w-4" />
                        <select
                          aria-label="Message delivery"
                          value={deliveryMode}
                          onChange={(event) => onDeliveryModeChange(event.target.value as DeliveryMode)}
                          className="absolute inset-0 cursor-pointer opacity-0"
                        >
                          <option value="steer">Interrupt: send now</option>
                          <option value="follow-up">Follow up: send after this turn</option>
                        </select>
                      </label>
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
                        'ficus-button',
                        'px-3 py-2 md:py-1.5 rounded-md text-sm disabled:opacity-50 font-medium min-h-[44px] md:min-h-0',
                        sendButtonClassName ? 'text-on-strong' : 'text-on-accent',
                        sendButtonClassName ?? 'bg-accent hover:bg-accent-hover active:bg-accent-active'
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
                  className="ficus-button w-full flex items-center gap-3 px-3 py-3 rounded-md text-sm text-primary hover:bg-surface-hover disabled:opacity-50 disabled:hover:bg-transparent"
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
                  className="ficus-button w-full flex items-center gap-3 px-3 py-3 rounded-md text-sm text-primary hover:bg-surface-hover disabled:opacity-50"
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
                    className="ficus-button w-full flex items-center gap-3 px-3 py-3 rounded-md text-sm text-primary hover:bg-surface-hover disabled:opacity-50"
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
                    className="ficus-button w-full flex items-center gap-3 px-3 py-3 rounded-md text-sm text-primary hover:bg-surface-hover"
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
                  className="ficus-button w-full flex items-center gap-3 px-3 py-3 rounded-md text-sm text-primary hover:bg-surface-hover"
                >
                  <AutoScrollIcon className="w-5 h-5 text-muted" />
                  {autoScroll ? 'Auto-scroll on' : 'Auto-scroll off'}
                </button>
              </MobileChatOptionsSheet>
            </form>
          </div>
        </div>
      )}
    </div>
  )

  // Wrap in fullscreen overlay when active
  const actionModal = selectedToolAction ? (
    <ActionModal action={selectedToolAction} onClose={() => setSelectedToolAction(null)} />
  ) : null

  if (isFullscreen) {
    return (
      <>
        <Modal isOpen={isFullscreen} onClose={toggleFullscreen} mobileFullscreen maxWidth="chat" noChildPadding>
          <div className="flex flex-col grow min-h-0 overflow-hidden">{chatContent}</div>
        </Modal>
        {actionModal}
      </>
    )
  }

  return (
    <>
      {chatContent}
      {actionModal}
    </>
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
          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium bg-status-progress-50 dark:bg-status-progress-900/30 text-status-progress-700 dark:text-status-progress-300 hover:bg-status-progress-100 dark:hover:bg-status-progress-900/50 transition-colors"
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
  blocks,
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
  const wasExpanded = useRef(defaultExpanded)

  // Auto-expand when group becomes active, auto-collapse when no longer active
  useEffect(() => {
    if (defaultExpanded) {
      setExpanded(true)
    } else if (wasExpanded.current) {
      // Group is no longer the active/last group — auto-collapse
      setExpanded(false)
    }
    wasExpanded.current = !!defaultExpanded
  }, [defaultExpanded, blocks.length])

  const summary = getStreamingGroupSummary(blocks)
  // Check if any tool in this group is still running
  const hasRunningTool = blocks.some((b) => b.type === 'tool_use' && !('_done' in b && b._done))

  return (
    <div className="text-xs">
      <button
        onClick={() => setExpanded(!expanded)}
        className="ficus-button w-full flex items-center gap-1.5 py-0.5 text-secondary hover:text-primary transition-colors"
      >
        <ChevronRightIcon
          className={clsx('w-3 h-3 shrink-0 text-muted transition-transform', expanded && 'rotate-90')}
        />
        {hasRunningTool && (
          <span className="inline-block w-3 h-3 border-2 border-status-neutral-300 dark:border-status-neutral-600 border-t-status-neutral-600 dark:border-t-status-neutral-300 rounded-full animate-spin shrink-0" />
        )}
        <span className="font-medium">{summary}</span>
      </button>
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

  // When defaultExpanded changes (e.g. a new tool call pushes this one up), sync
  useEffect(() => {
    setExpanded(defaultExpanded)
  }, [defaultExpanded])

  return (
    <div className="text-xs">
      <div data-tool-call-row={toolCall.toolCallId} className="flex items-center">
        <button
          onClick={() => setExpanded(!expanded)}
          className="ficus-button flex-1 flex items-center gap-1.5 py-0.5 text-secondary hover:text-primary transition-colors text-left min-w-0"
        >
          {inProgress ? (
            <span className="inline-block w-3 h-3 border-2 border-status-neutral-300 dark:border-status-neutral-600 border-t-status-neutral-600 dark:border-t-status-neutral-300 rounded-full animate-spin shrink-0" />
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
          <ToolSummary renderers={toolRenderers} toolName={toolCall.toolName} args={toolCall.args} />
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
            className="ficus-button px-2 py-0.5 ml-1 text-xs font-medium text-status-external-wait-600 dark:text-status-external-wait-400 hover:bg-status-external-wait-50 dark:hover:bg-status-external-wait-900/30 rounded transition-colors shrink-0"
          >
            Abort
          </button>
        )}
      </div>
      <ToolInlineActions toolCall={toolCall} completed={toolCall._done === true} onOpen={onToolInlineAction} />
      {expanded && (
        <div className="mt-1 ml-1.5 border-l-2 border-th-border pl-3 py-0.5 space-y-1">
          {toolCall.args && (
            <ToolArgsView renderers={toolRenderers} toolName={toolCall.toolName} args={toolCall.args} />
          )}
          {result && (
            <ToolResultView
              renderers={toolRenderers}
              toolName={toolCall.toolName}
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
