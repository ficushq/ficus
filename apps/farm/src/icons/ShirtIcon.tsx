import type { IconProps } from './types'

/** A T-shirt: how you look on the farm (the character builder). */
export function ShirtIcon({ className = 'g-icon' }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 28 26" aria-hidden="true">
      <path
        d="M9.5 3 L3 7 L5.5 12 L8 11 V23 H20 V11 L22.5 12 L25 7 L18.5 3 Q14 7 9.5 3 Z"
        fill="var(--g-icon-accent)"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinejoin="round"
      />
      <path d="M11 3.8 Q14 6.4 17 3.8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}
