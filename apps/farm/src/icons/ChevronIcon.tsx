import type { IconProps } from './types'

/** A right-pointing chevron, centred in its box so it turns in place (open: rotate it down). */
export function ChevronIcon({ className = 'g-chevron' }: IconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M6 3.5 L10.5 8 L6 12.5" />
    </svg>
  )
}
