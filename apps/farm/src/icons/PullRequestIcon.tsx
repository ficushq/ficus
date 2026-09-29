import type { IconProps } from './types'

export function PullRequestIcon({ className = 'g-icon' }: IconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
    >
      <circle cx="4" cy="3.5" r="1.6" />
      <circle cx="4" cy="12.5" r="1.6" />
      <circle cx="12" cy="12.5" r="1.6" />
      <path d="M4 5.1 V10.9 M12 10.9 V6.5 Q12 4 9.5 4 H7.5 M9 2.5 L7.5 4 L9 5.5" />
    </svg>
  )
}
