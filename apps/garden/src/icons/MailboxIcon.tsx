import type { IconProps } from './types'

export function MailboxIcon({ className = 'g-icon' }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 30 26" aria-hidden="true">
      <path
        d="M3 24 V10 a8 8 0 0 1 8 -8 h8 a8 8 0 0 1 8 8 v14z"
        fill="var(--g-icon-warm)"
        stroke="currentColor"
        strokeWidth="2.4"
      />
      <rect x="11" y="18" width="8" height="8" fill="var(--g-icon-wood)" stroke="currentColor" strokeWidth="2" />
    </svg>
  )
}
