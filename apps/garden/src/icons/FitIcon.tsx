import type { IconProps } from './types'

export function FitIcon({ className = 'g-icon' }: IconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 26 26"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 9 V3 H9 M17 3 H23 V9 M23 17 V23 H17 M9 23 H3 V17" />
      <path d="M13 8 L18 13 L13 18 L8 13Z" fill="#9fb57f" />
    </svg>
  )
}
