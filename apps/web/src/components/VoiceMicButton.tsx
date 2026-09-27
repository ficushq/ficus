import clsx from 'clsx'
import type { RecorderState } from '../hooks/useVoiceRecorder'
import { useVoiceEnabled } from '../hooks/useVoiceEnabled'
import { MicIcon } from './icons'

type Size = 'sm' | 'md' | 'lg'

interface VoiceMicButtonProps {
  state: RecorderState
  elapsed: number
  volume?: number // Optional volume for visualization ring
  isSupported: boolean
  isHoldMode: boolean
  beginPress: () => void
  endPress: () => void
  cancelPress: () => void
  disabled?: boolean
  title?: string
  size?: Size // Default: 'sm'
}

const colors = {
  recording:
    'bg-status-danger-100 dark:bg-status-danger-900/30 text-status-danger-600 dark:text-status-danger-400 hover:bg-status-danger-200 dark:hover:bg-status-danger-900/50',
  recordingText: 'text-status-danger-600 dark:text-status-danger-400',
  volumeRing: 'bg-status-danger-400',
  focusRing: 'focus:ring-status-danger-500/50',
}

const sizeConfig: Record<Size, { icon: string; spinner: string; padding: string }> = {
  sm: { icon: 'w-3.5 h-3.5', spinner: 'w-3.5 h-3.5', padding: 'p-0.5' },
  md: { icon: 'w-4 h-4', spinner: 'w-4 h-4', padding: 'p-1' },
  lg: { icon: 'w-5 h-5', spinner: 'w-5 h-5', padding: 'p-2' },
}

export function VoiceMicButton({
  state,
  elapsed,
  volume,
  isSupported,
  isHoldMode,
  beginPress,
  endPress,
  cancelPress,
  disabled,
  title: titleProp,
  size = 'sm',
}: VoiceMicButtonProps) {
  // Gated HERE, not only at each call site: every consumer of this button
  // (composer, question input, rejection modal, and whatever is added next)
  // hits the same transcribe endpoint, so a mic offered anywhere without an
  // OpenAI key is a control that silently fails — the exact problem the
  // voice/status route exists to prevent. Call-site gating alone already
  // missed two surfaces once.
  const voiceEnabled = useVoiceEnabled()
  if (!voiceEnabled) return null
  if (!isSupported) return null

  const sizes = sizeConfig[size]

  const defaultTitle =
    state === 'recording'
      ? isHoldMode
        ? 'Release to transcribe'
        : 'Stop recording'
      : state === 'transcribing'
        ? 'Transcribing...'
        : (titleProp ?? 'Record voice')

  return (
    <div className="relative flex items-center">
      {/* Volume visualization ring */}
      {volume !== undefined && state === 'recording' && (
        <span
          className={clsx('absolute inset-0 rounded pointer-events-none', colors.volumeRing)}
          style={{
            opacity: 0.15 + volume * 0.35,
            transform: `scale(${1 + volume * 0.4})`,
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
        disabled={disabled || state === 'transcribing'}
        className={clsx(
          'ficus-button',
          'relative z-10 flex flex-row items-center gap-1 rounded transition-colors disabled:opacity-50 focus:ring-2',
          sizes.padding,
          colors.focusRing,
          state === 'recording'
            ? colors.recording
            : state === 'transcribing'
              ? 'bg-surface-secondary text-placeholder'
              : 'text-muted hover:text-secondary hover:bg-surface-hover'
        )}
        title={defaultTitle}
      >
        {state === 'transcribing' ? (
          <span
            className={clsx(
              'inline-block border-2 border-status-neutral-300 dark:border-status-neutral-600 border-t-status-neutral-600 dark:border-t-status-neutral-300 rounded-full animate-spin',
              sizes.spinner
            )}
          />
        ) : (
          <MicIcon className={sizes.icon} />
        )}
        {state === 'recording' && (
          <span className={clsx('ml-0.5 text-xs font-mono tabular-nums', colors.recordingText)}>
            {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}
          </span>
        )}
      </button>
    </div>
  )
}
