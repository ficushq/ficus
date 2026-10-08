import clsx from 'clsx'
import { useState, useEffect, useRef } from 'react'

/** Each variant with the `ficus-button` base it must ship with (see buttonVariants.guard.test.ts). */
const VARIANT_CLASS = {
  danger: 'ficus-button ficus-button-danger',
  secondary: 'ficus-button ficus-button-secondary',
  ghost: 'ficus-button ficus-button-ghost',
} as const

interface ConfirmButtonProps {
  onConfirm: () => void
  label?: string
  confirmLabel?: string
  /** The button's look; destructive by default. Menu rows and header clusters pass `ghost`. */
  variant?: keyof typeof VARIANT_CLASS
  /** Sizing, layout and any tint; the variant supplies the look. */
  className?: string
  /** Replaces `className` while armed; defaults to `className` plus a danger tint for the danger variant. */
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
  variant = 'danger',
  className = 'px-2 py-1 text-xs',
  confirmClassName,
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
      className={clsx(
        VARIANT_CLASS[variant],
        confirming
          ? (confirmClassName ?? clsx(className, variant === 'danger' && 'bg-status-danger-surface'))
          : className,
        'disabled:opacity-50'
      )}
      title={title}
    >
      {confirming ? confirmLabel : label}
    </button>
  )
}
