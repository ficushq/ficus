import { useEffect, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'

/** Section heading classes shared with Notifications' and App's settings sections. */
export const SETTINGS_HEADING = 'text-base font-medium text-primary mb-4'
/** Row action button sizing, matching the Notifications page (44px touch target on phones). */
export const SETTINGS_BUTTON =
  'ficus-button px-4 py-2.5 md:py-2 rounded-md text-sm font-medium min-h-[44px] md:min-h-0 shrink-0 disabled:opacity-50'
export const QUIET_LINK = 'text-sm text-accent-light hover:underline'

/**
 * One settings row: a label and description on the left, its control (or a
 * read-only value) right-aligned. Stacks on narrow screens, like the
 * Notifications rows.
 */
export function SettingsRow({
  label,
  description,
  value,
  control,
  inlineControl = false,
  children,
}: {
  label: ReactNode
  description?: ReactNode
  /** A read-only value shown where a control would be. */
  value?: ReactNode
  control?: ReactNode
  /** Keep a compact control (such as a ⋯ menu) beside the label on phones too. */
  inlineControl?: boolean
  children?: ReactNode
}) {
  return (
    <div
      className={clsx(
        'flex gap-1 sm:items-center sm:justify-between sm:gap-6',
        inlineControl ? 'items-start justify-between gap-3' : 'flex-col sm:flex-row'
      )}
    >
      <div className="min-w-0">
        <div className="font-medium text-primary">{label}</div>
        {description && <div className="mt-0.5 text-sm text-muted">{description}</div>}
        {children}
      </div>
      {value !== undefined && (
        <div className="min-w-0 break-words text-sm text-secondary sm:max-w-[60%] sm:text-right">{value}</div>
      )}
      {control && (
        <div className={clsx('flex shrink-0 flex-wrap items-center gap-3 sm:mt-0', !inlineControl && 'mt-2')}>
          {control}
        </div>
      )}
    </div>
  )
}

/** A named link that leaves Ficus: opens in a new tab and says so with ↗. */
export function ExternalLink({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={clsx(QUIET_LINK, className)}>
      {children}
      <span aria-hidden="true">{'\u00a0↗'}</span>
    </a>
  )
}

/**
 * Copies a value and flashes "Copied" only once the write resolves, so an
 * insecure context or a denied permission never claims a copy that failed.
 */
export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )
  const copy = () => {
    if (timer.current) clearTimeout(timer.current)
    if (!navigator.clipboard) return setState('failed')
    navigator.clipboard.writeText(value).then(
      () => {
        setState('copied')
        timer.current = setTimeout(() => setState('idle'), 2000)
      },
      () => setState('failed')
    )
  }
  return (
    <button type="button" onClick={copy} className={clsx(SETTINGS_BUTTON, 'ficus-button-secondary')}>
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : label}
    </button>
  )
}
