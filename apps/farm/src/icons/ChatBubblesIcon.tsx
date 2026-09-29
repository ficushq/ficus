import type { IconProps } from './types'

/** Two speech bubbles: the farm's chat between people. */
export function ChatBubblesIcon({ className = 'g-icon' }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 30 26" aria-hidden="true">
      <path
        d="M11 20 h7 a8 7 0 0 0 0 -14 h-4 a8 7 0 0 0 -8 7 v11z"
        fill="var(--g-icon-paper)"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinejoin="round"
      />
      <path
        d="M19 4 h3 a6 5.5 0 0 1 6 5.5 v8 l-3 -2.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="11" cy="13" r="1.5" fill="currentColor" />
      <circle cx="16" cy="13" r="1.5" fill="currentColor" />
    </svg>
  )
}
