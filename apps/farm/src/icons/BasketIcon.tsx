import type { IconProps } from './types'

export function BasketIcon({ className = 'g-icon' }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 20 18" aria-hidden="true">
      <path d="M2 8 H18 L16 17 H4Z" fill="var(--g-icon-paper)" stroke="currentColor" strokeWidth="2" />
      <path d="M5 8 Q10 -1 15 8" fill="none" stroke="currentColor" strokeWidth="2" />
    </svg>
  )
}
