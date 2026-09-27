import type { IconProps } from './types'

/** A friendly robot head with a bulb antenna: the Assistant. */
export function AssistantIcon({ className = 'g-icon' }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 28 28" aria-hidden="true">
      <path d="M14 7 V3" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      <circle cx="14" cy="3" r="2.4" fill="#f2c14e" stroke="currentColor" strokeWidth="1.6" />
      <rect x="3.5" y="11" width="3" height="7" rx="1.4" fill="#8a9a5b" stroke="currentColor" strokeWidth="1.4" />
      <rect x="21.5" y="11" width="3" height="7" rx="1.4" fill="#8a9a5b" stroke="currentColor" strokeWidth="1.4" />
      <rect x="6" y="7" width="16" height="15" rx="6" fill="#fbf4e4" stroke="currentColor" strokeWidth="2" />
      <rect x="8.5" y="10.5" width="11" height="8" rx="3.5" fill="#23282c" />
      <circle cx="11.5" cy="14.5" r="1.3" fill="#ffd76a" />
      <circle cx="16.5" cy="14.5" r="1.3" fill="#ffd76a" />
      <path d="M9 26 Q14 22 19 26" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}
