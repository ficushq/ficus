import clsx from 'clsx'
import { useState, useEffect, useRef } from 'react'

interface ConfirmButtonProps {
  onConfirm: () => void
  label?: string
  confirmLabel?: string
  className?: string
  confirmClassName?: string
  disabled?: boolean
  title?: string
  /**
   * Accessible name. Needed where the visible label ("Remove") repeats across a
   * list and only the row identifies which thing is being acted on.
   */
  ariaLabel?: string
  /** How long the armed state survives before reverting on its own. */
  timeoutMs?: number
}

export function ConfirmButton({
  onConfirm,
  label = 'Cancel',
  confirmLabel = 'Confirm?',
  className = 'px-2 py-1 text-xs font-medium text-status-danger-600 hover:bg-status-danger-50 rounded transition-colors',
  confirmClassName = 'px-2 py-1 text-xs font-medium text-status-danger-700 bg-status-danger-50 hover:bg-status-danger-100 rounded transition-colors',
  disabled,
  title,
  ariaLabel,
  timeoutMs = 3000,
}: ConfirmButtonProps) {
  const [confirming, setConfirming] = useState(false)
  const timeout = useRef<ReturnType<typeof setTimeout>>(undefined)

  useEffect(() => {
    return () => {
      if (timeout.current) clearTimeout(timeout.current)
    }
  }, [])

  const handleClick = () => {
    if (confirming) {
      // Disarm the pending revert too — otherwise a second click that re-arms the
      // button within the old window would be cancelled early by the stale timer.
      if (timeout.current) clearTimeout(timeout.current)
      onConfirm()
      setConfirming(false)
    } else {
      setConfirming(true)
      timeout.current = setTimeout(() => setConfirming(false), timeoutMs)
    }
  }

  return (
    <button
      onClick={handleClick}
      disabled={disabled}
      aria-label={ariaLabel}
      className={clsx('ficus-button', confirming ? confirmClassName : className, 'disabled:opacity-50')}
      title={title}
    >
      {confirming ? confirmLabel : label}
    </button>
  )
}
