import type { IconProps } from './types'

export function EnvelopeIcon({ className = 'g-icon' }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 20 16" aria-hidden="true">
      <rect x="1" y="1" width="18" height="14" rx="2" fill="#fffaf1" stroke="currentColor" strokeWidth="2" />
      <path d="M2 2 L10 9 L18 2" fill="none" stroke="currentColor" strokeWidth="2" />
    </svg>
  )
}
