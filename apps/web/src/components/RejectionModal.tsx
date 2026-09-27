import { useVoiceEnabled } from '../hooks/useVoiceEnabled'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Modal } from './Modal'
import { useVoiceRecorder } from '../hooks/useVoiceRecorder'
import { useVoiceKeyboardShortcuts } from '../hooks/useVoiceKeyboardShortcuts'
import { transcribeAudio } from '../api/transcribe'
import { VoiceMicButton } from './VoiceMicButton'

interface RejectionModalProps {
  isOpen: boolean
  onClose: () => void
  onConfirm: (reason: string) => void
  isLoading?: boolean
  title?: string
  confirmLabel?: string
  loadingLabel?: string
  placeholder?: string
}

export function RejectionModal({
  isOpen,
  onClose,
  onConfirm,
  isLoading,
  title = 'Reject Checkpoint',
  confirmLabel = 'Confirm Rejection',
  loadingLabel = 'Rejecting...',
  placeholder = 'Please provide a reason for rejecting this checkpoint...',
}: RejectionModalProps) {
  const [reason, setReason] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [voiceError, setVoiceError] = useState<string | null>(null)

  // Auto-focus textarea when modal opens
  useEffect(() => {
    if (isOpen) {
      const id = requestAnimationFrame(() => {
        textareaRef.current?.focus()
      })
      return () => cancelAnimationFrame(id)
    }
  }, [isOpen])

  const handleConfirm = () => {
    if (!reason.trim()) return
    onConfirm(reason)
  }

  const handleClose = useCallback(() => {
    onClose()
  }, [onClose])

  const handleTranscription = useCallback((text: string) => {
    setReason((prev) => (prev ? prev + ' ' + text : text))
    setTimeout(() => textareaRef.current?.focus(), 0)
  }, [])

  const handleAutoConfirm = useCallback(
    (text: string) => {
      if (text.trim()) {
        setReason(text.trim())
        onConfirm(text.trim())
      }
    },
    [onConfirm, setReason]
  )

  const handleVoiceError = useCallback((error: string) => {
    setVoiceError(error)
    setTimeout(() => setVoiceError(null), 3000)
  }, [])

  const dictationEnabled = useVoiceEnabled()
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
  } = useVoiceRecorder({
    onTranscription: handleTranscription,
    onAutoSend: handleAutoConfirm,
    onError: handleVoiceError,
    transcribe: transcribeAudio,
    disabled: isLoading || !dictationEnabled,
  })
  const voiceSupported = recorderSupported && dictationEnabled

  const hasInput = !!reason.trim()

  // Keyboard shortcuts for voice recording
  useVoiceKeyboardShortcuts({
    enabled: isOpen && voiceSupported,
    voiceState,
    isSupported: voiceSupported,
    hasInput,
    disabled: !!isLoading,
    start: startRecording,
    stop: stopRecording,
    stopAndSend: stopAndSendRecording,
    cancel: cancelRecording,
    beginPress,
    endPress,
    isPressing,
    onEscape: handleClose,
  })

  // Cancel recording when modal closes
  useEffect(() => {
    if (!isOpen && voiceState === 'recording') {
      cancelRecording()
    }
  }, [isOpen, voiceState, cancelRecording])

  const isMac = typeof navigator !== 'undefined' && navigator.platform.includes('Mac')

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title={title}>
      <div className="mb-4">
        <div className="flex items-center justify-between gap-2 mb-2">
          <label className="text-sm font-medium text-secondary">Rejection Reason</label>
          {voiceSupported && (
            <VoiceMicButton
              state={voiceState}
              elapsed={voiceElapsed}
              volume={voiceVolume}
              isSupported={voiceSupported}
              isHoldMode={isHoldMode}
              beginPress={beginPress}
              endPress={endPress}
              cancelPress={cancelPress}
              disabled={isLoading}
              size="lg"
              title={hasInput ? 'Record voice (Ctrl+Shift+V)' : 'Record voice (↑)'}
            />
          )}
        </div>
        <textarea
          ref={textareaRef}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              handleConfirm()
            }
          }}
          className="ficus-field w-full rounded-md border-input-border bg-input-bg text-primary focus:border-accent focus:ring-accent px-3 py-2 border"
          rows={5}
          placeholder={placeholder}
        />
      </div>

      {voiceError && (
        <div className="mb-4 rounded-md px-3 py-2 bg-status-external-wait-50 dark:bg-status-external-wait-900/30 text-status-external-wait-600 dark:text-status-external-wait-400 text-sm">
          {voiceError}
        </div>
      )}

      <div className="flex flex-wrap justify-end gap-3">
        <button
          type="button"
          onClick={handleClose}
          disabled={isLoading}
          className="ficus-button px-4 py-2 text-sm font-medium text-secondary bg-surface-secondary rounded-md hover:bg-surface-hover disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleConfirm}
          disabled={!reason.trim() || isLoading}
          className="ficus-button ficus-button-primary min-h-10 px-4 py-2 text-sm disabled:opacity-50"
        >
          {isLoading ? loadingLabel : confirmLabel}
        </button>
      </div>

      <p className="text-xs text-placeholder mt-1 text-right self-end">
        {voiceState === 'recording' ? (
          <span className="text-status-danger-500 dark:text-status-danger-400 flex items-center justify-end gap-1">
            <span className="inline-block w-2 h-2 bg-status-danger-500 rounded-full animate-pulse" />
            {isHoldMode
              ? 'Hold-to-talk... release to transcribe, Esc to cancel'
              : 'Recording... ↑ to confirm, ↓ to preview, Esc to cancel'}
          </span>
        ) : hasInput ? (
          `${isMac ? '⌘' : 'Ctrl'} + Enter to confirm, Ctrl+Shift+V for voice, Esc to cancel`
        ) : (
          `${isMac ? '⌘' : 'Ctrl'} + Enter to confirm, ↑ for voice, Esc to cancel`
        )}
      </p>
    </Modal>
  )
}
