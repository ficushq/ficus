import type { IconProps } from './types'

export function LeafIcon({ className = 'g-icon' }: IconProps) {
  return (
    <svg className={className} viewBox="-10 -24 20 25" aria-hidden="true">
      <path
        d="M0 0 C7 -4 9.5 -12 5 -17 C3.5 -19 1.7 -20.5 0 -22 C-1.7 -20.5 -3.5 -19 -5 -17 C-9.5 -12 -7 -4 0 0Z"
        fill="var(--g-icon-paper)"
        stroke="currentColor"
        strokeWidth="2"
      />
    </svg>
  )
}
