import type { IconProps } from './types'

/** Two overlapping squares, one plain, one gridded: switch the farm's style. */
export function StyleIcon({ className = 'g-icon' }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 26 26" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="3" width="13" height="13" rx="2.5" />
      <rect x="10" y="10" width="13" height="13" rx="2.5" />
      <path d="M14.3 10 V23 M18.6 10 V23 M10 14.3 H23 M10 18.6 H23" strokeWidth="1.2" />
    </svg>
  )
}
