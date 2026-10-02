import type { IconProps } from './types'

export function HourglassIcon({ className = 'w-5 h-5' }: IconProps) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M5 3h14M5 21h14M6 3v3a6 6 0 0 0 12 0V3M6 21v-3a6 6 0 0 1 12 0v3"
      />
    </svg>
  )
}
