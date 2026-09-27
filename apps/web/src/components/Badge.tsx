import type { StatusRole } from '@ficus/shared'
import clsx from 'clsx'
import { Link } from 'react-router-dom'

// Decorative accents are deliberately separate from status meaning.
export type BadgeColor =
  | StatusRole
  | 'accent-1'
  | 'accent-2'
  | 'accent-3'
  | 'accent-4'
  | 'accent-5'
  | 'accent-6'
  | 'accent-7'

const COLOR_CLASSES: Record<BadgeColor, string> = {
  progress: 'bg-status-progress-badge-surface text-status-progress-badge-fg',
  queue: 'bg-status-queue-badge-surface text-status-queue-badge-fg',
  review: 'bg-status-review-badge-surface text-status-review-badge-fg',
  humanWait: 'bg-status-human-wait-badge-surface text-status-human-wait-badge-fg',
  externalWait: 'bg-status-external-wait-badge-surface text-status-external-wait-badge-fg',
  attention: 'bg-status-attention-badge-surface text-status-attention-badge-fg',
  danger: 'bg-status-danger-badge-surface text-status-danger-badge-fg',
  success: 'bg-status-success-badge-surface text-status-success-badge-fg',
  neutral: 'bg-status-neutral-badge-surface text-status-neutral-badge-fg',
  'accent-1': 'bg-badge-accent-1-surface text-badge-accent-1-fg',
  'accent-2': 'bg-badge-accent-2-surface text-badge-accent-2-fg',
  'accent-3': 'bg-badge-accent-3-surface text-badge-accent-3-fg',
  'accent-4': 'bg-badge-accent-4-surface text-badge-accent-4-fg',
  'accent-5': 'bg-badge-accent-5-surface text-badge-accent-5-fg',
  'accent-6': 'bg-badge-accent-6-surface text-badge-accent-6-fg',
  'accent-7': 'bg-badge-accent-7-surface text-badge-accent-7-fg',
}

const HOVER_CLASSES: Record<BadgeColor, string> = {
  progress: 'hover:bg-status-progress-badge-hover',
  queue: 'hover:bg-status-queue-badge-hover',
  review: 'hover:bg-status-review-badge-hover',
  humanWait: 'hover:bg-status-human-wait-badge-hover',
  externalWait: 'hover:bg-status-external-wait-badge-hover',
  attention: 'hover:bg-status-attention-badge-hover',
  danger: 'hover:bg-status-danger-badge-hover',
  success: 'hover:bg-status-success-badge-hover',
  neutral: 'hover:bg-status-neutral-badge-hover',
  'accent-1': 'hover:bg-badge-accent-1-hover',
  'accent-2': 'hover:bg-badge-accent-2-hover',
  'accent-3': 'hover:bg-badge-accent-3-hover',
  'accent-4': 'hover:bg-badge-accent-4-hover',
  'accent-5': 'hover:bg-badge-accent-5-hover',
  'accent-6': 'hover:bg-badge-accent-6-hover',
  'accent-7': 'hover:bg-badge-accent-7-hover',
}

interface BadgeProps {
  children: React.ReactNode
  color?: BadgeColor
  /** If provided, renders as a Link */
  to?: string
  /** Click handler (for non-link badges) */
  onClick?: (e: React.MouseEvent) => void
  className?: string
  title?: string
}

const BASE_CLASSES = 'inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-medium leading-4'

export function Badge({ children, color = 'neutral', to, onClick, className, title }: BadgeProps) {
  const colorClasses = COLOR_CLASSES[color]

  if (to) {
    return (
      <Link
        to={to}
        onClick={onClick}
        className={clsx(BASE_CLASSES, colorClasses, HOVER_CLASSES[color], 'transition-colors', className)}
        title={title}
      >
        {children}
      </Link>
    )
  }

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={clsx(
          'ficus-button',
          BASE_CLASSES,
          colorClasses,
          HOVER_CLASSES[color],
          'transition-colors',
          className
        )}
        title={title}
      >
        {children}
      </button>
    )
  }

  return (
    <span className={clsx(BASE_CLASSES, colorClasses, className)} title={title}>
      {children}
    </span>
  )
}

// Re-export color for convenience
export { COLOR_CLASSES as BADGE_COLORS }
