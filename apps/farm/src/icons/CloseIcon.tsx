import type { IconProps } from './types'

export function CloseIcon({ className = 'g-icon' }: IconProps) {
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
      <path d="M6 6 L18 18 M18 6 L6 18" />
    </svg>
  )
}
