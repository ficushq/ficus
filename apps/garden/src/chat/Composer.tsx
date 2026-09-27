import { useEffect, useId, useRef, useState, type RefObject } from 'react'
import clsx from 'clsx'
import type { DeliveryMode } from '@ficus/shared'
import { useStableRef } from '../hooks/useStableRef'

const CLEAR_CONFIRM_MS = 3000
const CLEAR_REVEAL_DELAY_MS = 5000

function readDraft(key?: string): string {
  if (!key) return ''
  try {
    return localStorage.getItem(`chat-draft:${key}`) ?? ''
  } catch {
    return ''
  }
}

function saveDraft(key: string | undefined, value: string) {
  if (!key) return
  try {
    if (value) localStorage.setItem(`chat-draft:${key}`, value)
    else localStorage.removeItem(`chat-draft:${key}`)
  } catch {
    // storage unavailable (private mode): drafts just don't persist
  }
}

/**
 * Whether to offer "Clear queue", with the web's timing: straight away while a
 * reply streams or when the chat opened with a queue already there, otherwise
 * after a pause so a queue the agent picks up at once doesn't flash the button.
 */
function useShowClearQueue(count: number, streaming: boolean): boolean {
  const [show, setShow] = useState(false)
  const sawEmpty = useRef(count === 0)
  useEffect(() => {
    if (count === 0) {
      setShow(false)
      sawEmpty.current = true
      return
    }
    if (streaming || !sawEmpty.current) {
      setShow(true)
      return
    }
    const timer = setTimeout(() => setShow(true), CLEAR_REVEAL_DELAY_MS)
    return () => clearTimeout(timer)
  }, [count, streaming])
  return show
}

export interface ComposerProps {
  onSend: (text: string) => Promise<void>
  /** A turn is active: offer Interrupt / Follow up instead of Send. */
  busy: boolean
  streaming: boolean
  deliveryMode: DeliveryMode
  onDeliveryModeChange: (mode: DeliveryMode) => void
  onStop?: () => void
  /** Queued/failed sends the Clear control removes; their text is restored to the box. */
  queued: string[]
  onCancelQueue?: () => Promise<void>
  disabled?: boolean
  placeholder: string
  label: string
  draftKey?: string
  textareaRef?: RefObject<HTMLTextAreaElement | null>
}

export function Composer({
  onSend,
  busy,
  streaming,
  deliveryMode,
  onDeliveryModeChange,
  onStop,
  queued,
  onCancelQueue,
  disabled = false,
  placeholder,
  label,
  draftKey,
  textareaRef,
}: ComposerProps) {
  const inputId = useId()
  const errorId = useId()
  const [value, setValue] = useState(() => readDraft(draftKey))
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmingClear, setConfirmingClear] = useState(false)
  const [clearing, setClearing] = useState(false)
  const submittingRef = useRef(false)
  const valueRef = useStableRef(value)
  const showClear = useShowClearQueue(queued.length, streaming)

  useEffect(() => {
    if (!confirmingClear) return
    const timer = setTimeout(() => setConfirmingClear(false), CLEAR_CONFIRM_MS)
    return () => clearTimeout(timer)
  }, [confirmingClear])
  useEffect(() => {
    if (queued.length === 0) setConfirmingClear(false)
  }, [queued.length])

  const update = (next: string) => {
    setValue(next)
    saveDraft(draftKey, next)
  }

  const canSubmit = !disabled && !submitting && value.trim().length > 0

  const submit = async () => {
    const text = valueRef.current
    if (disabled || submittingRef.current || !text.trim()) return
    submittingRef.current = true
    setSubmitting(true)
    setError(null)
    try {
      await onSend(text)
      update('')
    } catch (cause) {
      // Keep the text so nothing typed is lost.
      setError(cause instanceof Error ? cause.message : 'Failed to send message')
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }

  const clearQueue = async () => {
    if (!onCancelQueue || clearing) return
    if (!confirmingClear) {
      setConfirmingClear(true)
      return
    }
    setConfirmingClear(false)
    setClearing(true)
    const restored = queued.join('\n\n')
    try {
      await onCancelQueue()
      const prev = valueRef.current
      update(prev ? `${prev}\n\n${restored}` : restored)
      textareaRef?.current?.focus()
    } finally {
      setClearing(false)
    }
  }

  const sendLabel = submitting ? 'Sending…' : busy ? (deliveryMode === 'steer' ? 'Interrupt' : 'Follow up') : 'Send'

  return (
    <form
      className="g-chat-composer"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      {error && (
        <p id={errorId} className="g-chat-error" role="alert">
          Message was not sent: {error}
        </p>
      )}
      {onCancelQueue && showClear && queued.length > 0 && (
        <button
          type="button"
          className={clsx('g-chat-clear', confirmingClear && 'g-confirm')}
          disabled={clearing}
          onClick={() => void clearQueue()}
        >
          {confirmingClear
            ? 'Tap again to clear'
            : `Clear ${queued.length} pending message${queued.length > 1 ? 's' : ''}`}
        </button>
      )}
      <label htmlFor={inputId} className="g-chat-sr-only">
        {label}
      </label>
      <textarea
        id={inputId}
        ref={textareaRef}
        className="g-chat-input"
        rows={2}
        value={value}
        placeholder={placeholder}
        disabled={disabled || submitting}
        aria-describedby={error ? errorId : undefined}
        onChange={(e) => update(e.target.value)}
        onKeyDown={(e) => {
          // Same as the web composer: Enter sends, any modifier (Shift, ⌘, Ctrl, Alt) makes a newline.
          if (e.key !== 'Enter' || e.nativeEvent.isComposing) return
          if (e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return
          e.preventDefault()
          void submit()
        }}
      />
      <div className="g-chat-composer-bar">
        <span className="g-chat-hint">Enter to send · Shift+Enter for a new line</span>
        <div className="g-chat-send">
          {onStop && streaming && (
            <button type="button" className="g-button g-chat-stop" onClick={onStop}>
              Stop
            </button>
          )}
          {busy ? (
            <div className={clsx('g-chat-delivery', deliveryMode === 'follow-up' && 'g-follow')}>
              <button
                type="submit"
                className="g-chat-delivery-submit"
                disabled={!canSubmit}
                title={
                  deliveryMode === 'steer'
                    ? 'Send now: the agent reads it at its next step'
                    : 'Send after the agent finishes this turn'
                }
              >
                {sendLabel}
              </button>
              <label className="g-chat-delivery-mode" title="Choose when this message is delivered">
                <span aria-hidden="true">▾</span>
                <select
                  aria-label="Message delivery"
                  value={deliveryMode}
                  onChange={(e) => onDeliveryModeChange(e.target.value as DeliveryMode)}
                >
                  <option value="steer">Interrupt: send now</option>
                  <option value="follow-up">Follow up: send after this turn</option>
                </select>
              </label>
            </div>
          ) : (
            <button type="submit" className="g-button g-button-primary g-chat-submit" disabled={!canSubmit}>
              {sendLabel}
            </button>
          )}
        </div>
      </div>
    </form>
  )
}
