import clsx from 'clsx'
import type { ComponentType, ReactNode } from 'react'

export interface SegmentedControlOption<T extends string> {
  value: T
  label: string
  Icon?: ComponentType<{ className?: string }>
  /** A tooltip, when the label alone doesn't say enough (or why the option is disabled). */
  title?: string
  /** Just this option unavailable. */
  disabled?: boolean
  /** An accessible name that says more than the label (e.g. "Subagents, 2 active subagents"). */
  ariaLabel?: string
  /** Shown after the label, e.g. a count; told whether the option is the chosen one so it can match. */
  badge?: (selected: boolean) => ReactNode
}

/**
 * The app's segmented control: a small set of mutually exclusive text (or
 * icon+text) options in one tray, the chosen one filled with the accent and
 * the rest plain, with no borders between them. Use it for every single-choice
 * toggle row (view switchers, modes, scopes, ranges), not hand-rolled button
 * groups, so they all read as one control.
 *
 * `size="default"` fills its row (forms, settings); `size="compact"` sizes to
 * its options for toolbars and headers.
 */
export function SegmentedControl<T extends string>({
  ariaLabel,
  options,
  value,
  onChange,
  disabled = false,
  hintId,
  className,
  size = 'default',
  blurOnChange = false,
}: {
  ariaLabel: string
  options: readonly SegmentedControlOption<T>[]
  value: T
  onChange: (next: T) => void
  disabled?: boolean
  hintId?: string
  className?: string
  size?: 'default' | 'compact'
  /** Let go of focus after a choice, for pages where a key held on a focused button would do something else. */
  blurOnChange?: boolean
}) {
  const compact = size === 'compact'
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={clsx(
        'rounded-lg bg-surface-secondary',
        compact ? 'inline-flex shrink-0 gap-0.5 p-0.5' : 'flex gap-1 p-1',
        className
      )}
    >
      {options.map((option) => {
        const selected = value === option.value
        const off = disabled || option.disabled
        const { Icon } = option
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={option.ariaLabel}
            disabled={off}
            aria-describedby={disabled ? hintId : undefined}
            title={option.title}
            className={clsx(
              'flex items-center justify-center gap-1 whitespace-nowrap rounded-md text-xs font-medium transition-colors',
              compact ? 'px-2.5 py-1' : 'min-h-[36px] flex-1 px-2 py-1.5',
              off
                ? 'cursor-default text-muted opacity-60'
                : selected
                  ? 'bg-accent text-on-accent'
                  : 'text-secondary hover:bg-surface-hover hover:text-primary'
            )}
            onClick={(event) => {
              if (blurOnChange) event.currentTarget.blur()
              onChange(option.value)
            }}
          >
            {Icon && <Icon className="h-3.5 w-3.5" />}
            {option.label}
            {option.badge?.(selected)}
          </button>
        )
      })}
    </div>
  )
}
