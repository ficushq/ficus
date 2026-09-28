import type { IconProps } from './types'

export function MinusIcon({ className = 'g-icon' }: IconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="3.4"
      strokeLinecap="round"
    >
      <path d="M5 12 H19" />
    </svg>
  )
}
