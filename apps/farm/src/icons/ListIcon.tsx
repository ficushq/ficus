import type { IconProps } from './types'

export function ListIcon({ className = 'g-icon' }: IconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 26 24"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.6"
      strokeLinecap="round"
    >
      <path d="M9 6 H23 M9 12 H23 M9 18 H23" />
      <circle cx="4" cy="6" r="1.6" fill="currentColor" />
      <circle cx="4" cy="12" r="1.6" fill="currentColor" />
      <circle cx="4" cy="18" r="1.6" fill="currentColor" />
    </svg>
  )
}
