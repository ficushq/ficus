import type { IconProps } from './types'

/** Two people, or one when you're playing on your own. */
export function PeopleIcon({ className = 'g-icon', solo = false }: IconProps & { solo?: boolean }) {
  return (
    <svg className={className} viewBox="0 0 30 26" aria-hidden="true">
      {!solo && (
        <g opacity="0.75">
          <circle cx="21" cy="8" r="4" fill="var(--g-icon-paper)" stroke="currentColor" strokeWidth="2" />
          <path d="M15 23 a6 6 0 0 1 12 0" fill="var(--g-icon-paper)" stroke="currentColor" strokeWidth="2" />
        </g>
      )}
      <circle
        cx={solo ? 15 : 11}
        cy="9"
        r="4.5"
        fill="var(--g-icon-accent-soft)"
        stroke="currentColor"
        strokeWidth="2.2"
      />
      <path
        d={solo ? 'M8 24 a7 7 0 0 1 14 0z' : 'M4 24 a7 7 0 0 1 14 0z'}
        fill="var(--g-icon-accent)"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinejoin="round"
      />
    </svg>
  )
}
