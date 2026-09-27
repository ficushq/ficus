import type { IconProps } from './types'

export function SeedPacketIcon({ className = 'g-icon' }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 26 30" aria-hidden="true">
      <rect x="3" y="3" width="20" height="25" rx="3" fill="#fffaf1" stroke="currentColor" strokeWidth="2.4" />
      <circle cx="13" cy="15" r="5" fill="#e0a93b" stroke="currentColor" strokeWidth="2" />
      <path d="M3 8 H23" stroke="currentColor" strokeWidth="2" />
    </svg>
  )
}
