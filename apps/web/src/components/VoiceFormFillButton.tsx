import clsx from 'clsx'
import type { FormFillState } from '../hooks/useVoiceFormFill'
import { MicIcon } from './icons'

interface VoiceFormFillButtonProps {
  state: FormFillState
  elapsed: number
  isSupported: boolean
  isHoldMode: boolean
  beginPress: () => void
  endPress: () => void
  cancelPress: () => void
  disabled?: boolean
  label?: string
  shortcutHint?: string
  recordingHint?: string
}

export function VoiceFormFillButton({
  state,
  elapsed,
  isSupported,
  isHoldMode,
  beginPress,
  endPress,
  cancelPress,
  disabled,
  label = 'Describe your task by voice',
  shortcutHint = 'Alt+↑',
  recordingHint = 'Click or Alt+↑ to fill, Esc to cancel',
}: VoiceFormFillButtonProps) {
  if (!isSupported) return null

  return (
    <div className="relative">
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
        disabled={disabled || state === 'extracting' || state === 'transcribing'}
        className={clsx(
          'ficus-button',
          'w-full flex items-center justify-center gap-2 px-4 py-3 rounded-lg border-2 border-dashed transition-colors disabled:opacity-50',
          state === 'recording'
            ? 'border-status-danger-400 dark:border-status-danger-600 bg-status-danger-50 dark:bg-status-danger-900/30 text-status-danger-700 dark:text-status-danger-300'
            : state === 'transcribing' || state === 'extracting'
              ? 'border-th-border bg-surface-secondary text-placeholder'
              : 'border-th-border hover:border-status-danger-400 dark:hover:border-status-danger-600 hover:bg-status-danger-50 dark:hover:bg-status-danger-900/30 text-secondary hover:text-status-danger-700 dark:hover:text-status-danger-300'
        )}
      >
        {state === 'extracting' ? (
          <>
            <span className="inline-block w-4 h-4 border-2 border-status-danger-300 border-t-status-danger-600 rounded-full animate-spin" />
            <span className="text-sm font-medium">Filling form...</span>
          </>
        ) : state === 'transcribing' ? (
          <>
            <span className="inline-block w-4 h-4 border-2 border-status-neutral-300 dark:border-status-neutral-600 border-t-status-neutral-600 dark:border-t-status-neutral-300 rounded-full animate-spin" />
            <span className="text-sm font-medium">Transcribing...</span>
          </>
        ) : state === 'recording' ? (
          <>
            <span className="inline-block w-2.5 h-2.5 bg-status-danger-500 rounded-full animate-pulse" />
            <span className="text-sm font-medium">
              Listening... {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}
            </span>
          </>
        ) : (
          <>
            <MicIcon className="w-4 h-4" />
            <span className="text-sm font-medium">
              {label} ({shortcutHint})
            </span>
          </>
        )}
      </button>
      {state === 'recording' && <p className="text-xs text-placeholder mt-1 text-center">{recordingHint}</p>}
    </div>
  )
}
