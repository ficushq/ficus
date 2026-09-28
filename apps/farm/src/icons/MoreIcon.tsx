import type { IconProps } from './types'

export function MoreIcon({ className = 'g-icon' }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 26 26" aria-hidden="true" fill="currentColor">
      <circle cx="6" cy="13" r="2.6" />
      <circle cx="13" cy="13" r="2.6" />
      <circle cx="20" cy="13" r="2.6" />
    </svg>
  )
}
