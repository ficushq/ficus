import { siteAssistantToolRenderers } from '../lib/tool-renderers'
import type { ReactNode } from 'react'
import { useRef, useEffect, useState, useId } from 'react'
import clsx from 'clsx'
import { createPortal } from 'react-dom'
import { siteOperatorVoiceAssistant } from './assistants/siteOperator/siteOperatorAssistant'
import { VoiceTranscriptInspector } from './VoiceTranscriptInspector'
import { useRealtimeVoiceAssistant } from './useRealtimeVoiceAssistant'
import { Presence } from '../components/Presence'
import { usePopupDismiss } from '../hooks/usePopupDismiss'
import { MicIcon, CloseIcon, ExpandIcon, ChevronDownIcon, StopIcon, RefreshIcon } from '../components/icons'
import { OPEN_ASSISTANT_EVENT, OPEN_VOICE_EVENT } from '@ficus/shared/browser-keys'

type VoiceControls = Pick<
  ReturnType<typeof useRealtimeVoiceAssistant>,
  | 'status'
  | 'history'
  | 'error'
  | 'toggle'
  | 'restartFresh'
  | 'interrupt'
  | 'isConnected'
  | 'rateLimitRetry'
  | 'isMicMuted'
  | 'toggleMicMuted'
>

function useSiteOperatorVoice() {
  return useRealtimeVoiceAssistant(siteOperatorVoiceAssistant, { autoReconnect: true, maxReconnectAttempts: 3 })
}

export function VoiceCompanionButton({
  dependencies,
  controlsOnly = false,
  hideTrigger = false,
  embedded = false,
  compactOverride = false,
  onActivityChange,
  onConnected,
  onExpand,
  positionControl,
}: {
  controlsOnly?: boolean
  embedded?: boolean
  compactOverride?: boolean
  onActivityChange?: (active: boolean) => void
  onConnected?: () => void
  onExpand?: () => void
  positionControl?: ReactNode
  hideTrigger?: boolean
  dependencies?: { useVoiceAssistant: () => VoiceControls }
} = {}) {
  const useVoice = dependencies?.useVoiceAssistant ?? useSiteOperatorVoice
  const {
    status,
    history,
    error,
    toggle,
    restartFresh,
    interrupt,
    isConnected,
    rateLimitRetry,
    isMicMuted,
    toggleMicMuted,
  } = useVoice()
  const [panelOpen, setPanelOpen] = useState(false)
  useEffect(() => {
    const open = () => {
      setPanelOpen(true)
      setCompact(false)
    }
    const showText = () => {
      setPanelOpen((open) => isConnected && open)
      setCompact(true)
    }
    window.addEventListener(OPEN_VOICE_EVENT, open)
    window.addEventListener(OPEN_ASSISTANT_EVENT, showText)
    return () => {
      window.removeEventListener(OPEN_VOICE_EVENT, open)
      window.removeEventListener(OPEN_ASSISTANT_EVENT, showText)
    }
  }, [isConnected])

  const [resetting, setResetting] = useState(false)
  const sessionConnected = useRef(false)
  const live = isConnected || resetting
  const [localCompact, setCompact] = useState(false)
  const compact = embedded ? compactOverride : localCompact
  useEffect(() => {
    onActivityChange?.(live || status === 'connecting')
  }, [live, status, onActivityChange])
  const unavailableHintId = useId()
  const panelRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (isConnected && !sessionConnected.current) {
      sessionConnected.current = true
      onConnected?.()
    }
  }, [isConnected, onConnected])

  // Keep a live session with the user as they move around the page.
  useEffect(() => {
    if (isConnected) {
      setPanelOpen(true)
      setCompact(true)
    }
  }, [isConnected])
  useEffect(() => {
    if (status === 'error') {
      setPanelOpen(true)
      setCompact(false)
    }
  }, [status])

  // Auto-scroll transcript to bottom
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [history])

  // The expanded header panel is a popup: an outside press or Escape compacts a live session and
  // closes an idle one. Compact-and-live it is a persistent mini player, and embedded it is part of
  // its host, so neither dismisses (nor claims Escape).
  usePopupDismiss({
    open: !embedded && panelOpen && !(isConnected && compact),
    popup: panelRef,
    trigger: buttonRef,
    // A non-modal companion that keeps running while the user works elsewhere: focus moving away
    // never dismissed it, only a press outside or Escape does.
    focusOut: false,
    onDismiss: () => {
      if (isConnected) setCompact(true)
      else setPanelOpen(false)
    },
  })

  const unavailableReason =
    typeof window !== 'undefined' && window.isSecureContext === false
      ? 'Voice needs a secure connection. Open Ficus using HTTPS or localhost.'
      : typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia
        ? 'This browser does not support microphone access.'
        : null

  const hasHistory = history.length > 0

  const handleClick = () => {
    if (unavailableReason) return
    if (isConnected) {
      setPanelOpen(true)
      setCompact(false)
    } else setPanelOpen((prev) => !prev)
  }

  const handleDisconnect = () => {
    sessionConnected.current = false
    toggle()
    setPanelOpen(false)
    setCompact(false)
  }

  const handleRestartFresh = async () => {
    if (resetting) return
    setResetting(true)
    try {
      await restartFresh()
    } finally {
      setResetting(false)
    }
  }

  const canInterrupt = status === 'speaking' || status === 'processing' || Boolean(rateLimitRetry)

  const statusLabels: Record<VoiceControls['status'], string> = {
    idle: 'Voice',
    connecting: 'Connecting',
    listening: 'Listening',
    'user-speaking': 'Listening',
    processing: 'Thinking',
    speaking: 'Speaking',
    error: 'Error',
  }
  const statusLabel = statusLabels[status]

  const panel = (
    <Presence
      open={embedded || panelOpen}
      ref={panelRef}
      data-compact={live && compact}
      style={embedded ? undefined : { top: (buttonRef.current?.getBoundingClientRect().bottom ?? 56) + 8 }}
      className={clsx(
        embedded
          ? 'p-2 overflow-y-auto min-h-0'
          : 'ficus-overlay ficus-voice-panel fixed right-3 sm:right-6 z-50 p-2 overflow-y-auto max-h-[calc(100dvh-10rem)] max-w-[calc(100vw-1.5rem)] transition-[width] duration-200 ease-out motion-reduce:transition-none',
        !embedded && (live && compact ? 'w-72' : 'w-[calc(100vw-1.5rem)] sm:w-96')
      )}
    >
      <div
        className="flex items-center justify-between gap-2 px-2 py-2"
        style={embedded && !live ? { display: 'none' } : undefined}
      >
        <div className="flex items-center gap-2.5">
          {live && (
            <button
              disabled={resetting}
              onClick={toggleMicMuted}
              aria-pressed={isMicMuted}
              aria-label={isMicMuted ? 'Unmute microphone' : 'Mute microphone'}
              title={isMicMuted ? 'Unmute microphone' : 'Mute microphone'}
              className={clsx(
                'ficus-button relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full',
                isMicMuted ? 'bg-surface-secondary text-muted' : 'bg-selection text-accent-light'
              )}
            >
              {!isMicMuted && status === 'user-speaking' && (
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-1 rounded-full bg-accent-light/20 motion-safe:animate-ping"
                />
              )}
              <MicIcon className="relative h-4 w-4" />
            </button>
          )}
          <div>
            {!embedded && <h2 className="text-sm font-semibold text-primary">Assistant · Voice</h2>}
            <p role="status" className="text-xs text-muted">
              {resetting
                ? 'Resetting…'
                : rateLimitRetry
                  ? `Retrying in ${Math.ceil(rateLimitRetry.remainingMs / 1000)}s`
                  : status === 'idle'
                    ? 'Talk to Ficus'
                    : isMicMuted
                      ? 'Mic muted'
                      : statusLabel}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {compact && positionControl}
          {live && !compact && !controlsOnly && (
            <button
              onClick={handleRestartFresh}
              disabled={resetting}
              aria-label="Reset voice conversation"
              title="Reset voice conversation"
              className="ficus-button flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-surface-hover"
            >
              <RefreshIcon className={clsx('h-4 w-4', resetting && 'motion-safe:animate-spin')} />
            </button>
          )}

          {live && (
            <button
              onClick={handleDisconnect}
              aria-label="End chat"
              title="End chat"
              className="ficus-button flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-status-danger-500/10 hover:text-status-danger-500"
            >
              <StopIcon className="h-4 w-4" />
            </button>
          )}
          {embedded && compact && (
            <button
              onClick={onExpand}
              aria-label="Expand assistant"
              title="Expand assistant"
              className="ficus-button flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-surface-hover"
            >
              <ExpandIcon className="h-4 w-4" />
            </button>
          )}
          {!embedded && (
            <button
              onClick={() => {
                if (isConnected) setCompact((value) => !value)
                else {
                  setPanelOpen(false)
                  buttonRef.current?.focus()
                }
              }}
              aria-label={
                isConnected ? (compact ? 'Expand voice assistant' : 'Compact voice assistant') : 'Close voice assistant'
              }
              className="ficus-button rounded-lg p-2 text-muted hover:bg-surface-hover hover:text-primary"
            >
              {isConnected ? (
                compact ? (
                  <ExpandIcon className="h-4 w-4" />
                ) : (
                  <ChevronDownIcon className="h-4 w-4" />
                )
              ) : (
                <CloseIcon className="h-4 w-4" />
              )}
            </button>
          )}
        </div>
      </div>
      {!controlsOnly &&
        !resetting &&
        !(live && compact) &&
        (!hasHistory && !isConnected ? (
          <VoiceGuidance />
        ) : (
          <details className="px-2 py-2 text-xs text-muted">
            <summary className="cursor-pointer hover:text-primary">Things you can ask</summary>
            <VoiceGuidance />
          </details>
        ))}
      {!controlsOnly && !live && (
        <div className="px-2 pb-3">
          <button
            onClick={() => {
              void toggle()
            }}
            disabled={status === 'connecting'}
            aria-busy={status === 'connecting'}
            className="ficus-button ficus-button-primary flex w-full items-center justify-center gap-2 px-3 py-2.5 text-sm disabled:opacity-70"
          >
            <MicIcon className={clsx('h-4 w-4', status === 'connecting' && 'motion-safe:animate-pulse')} />
            {status === 'connecting' ? 'Starting voice chat…' : status === 'error' ? 'Try again' : 'Start voice chat'}
          </button>
          {status === 'connecting' && (
            <button
              onClick={() => {
                void toggle()
              }}
              className="ficus-button mt-2 w-full rounded-lg py-2 text-xs text-muted hover:bg-surface-hover"
            >
              Cancel
            </button>
          )}
        </div>
      )}

      {rateLimitRetry && isConnected && !compact && (
        <div className="px-3 py-2  text-xs text-status-attention-600 dark:text-status-attention-400">
          <div className="flex items-center gap-2">
            <span className="inline-block w-3 h-3 border-2 border-status-attention-300 border-t-status-attention-600 rounded-full animate-spin" />
            <span>Rate limit hit. Retrying in {Math.ceil(rateLimitRetry.remainingMs / 1000)}s…</span>
          </div>
        </div>
      )}

      {/* Error */}
      {status === 'error' && error && (
        <div className="px-3 py-2 text-sm text-status-danger-600 dark:text-status-danger-400 ">{error}</div>
      )}

      {/* Transcript history */}
      {!controlsOnly && (hasHistory || (isConnected && canInterrupt)) && !(live && compact) && (
        <div ref={scrollRef} className="max-h-[50dvh] overflow-y-auto border-t border-panel-border pt-2">
          <VoiceTranscriptInspector
            toolRenderers={siteAssistantToolRenderers}
            history={history}
            onInterrupt={isConnected && canInterrupt ? interrupt : undefined}
          />
        </div>
      )}

      {/* Empty state */}
      {!controlsOnly && !hasHistory && isConnected && !compact && !canInterrupt && (
        <div className="px-3 py-6 text-center text-sm text-muted">Speak naturally. You can interrupt at any time.</div>
      )}
    </Presence>
  )
  if (embedded) return panel
  return (
    <div className="relative group/voice">
      {/* Header button */}
      {!hideTrigger && (
        <button
          ref={buttonRef}
          onClick={handleClick}
          aria-expanded={panelOpen}
          aria-disabled={Boolean(unavailableReason)}
          aria-describedby={unavailableReason ? unavailableHintId : undefined}
          aria-label="Voice assistant"
          className={clsx(
            'ficus-button relative flex items-center justify-center p-2 rounded-md transition-colors',
            unavailableReason
              ? 'text-muted opacity-50 cursor-not-allowed'
              : 'text-muted hover:text-primary hover:bg-surface-hover'
          )}
          title={unavailableReason ?? 'Voice assistant'}
        >
          <MicIcon className="w-5 h-5" />
        </button>
      )}

      {!hideTrigger && unavailableReason && (
        <div
          id={unavailableHintId}
          role="tooltip"
          className="ficus-overlay pointer-events-none absolute right-0 top-full z-50 mt-2 hidden w-64 p-3 text-xs text-secondary group-hover/voice:block group-focus-within/voice:block"
        >
          {unavailableReason}
        </div>
      )}

      {/* Dropdown panel */}
      {typeof document !== 'undefined' && createPortal(panel, document.body)}
    </div>
  )
}

export function VoiceGuidance() {
  return (
    <div className="px-2 py-3 text-sm text-secondary">
      <p>Get a quick update, find your way around, or send a message to an agent—hands free.</p>
      <p className="mt-3 text-xs font-medium text-muted">Try asking</p>
      <ul className="mt-2 space-y-2 text-sm">
        <li>“What are my squads working on?”</li>
        <li>“Open my squad’s activity.”</li>
        <li>“Ask the manager for a progress update.”</li>
      </ul>
      <p className="mt-3 text-xs leading-relaxed text-muted">
        Speak naturally and interrupt whenever you need to. The transcript stays here; expand a tool call to inspect its
        details.
      </p>
    </div>
  )
}
