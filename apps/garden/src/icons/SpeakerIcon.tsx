import type { IconProps } from './types'

export function SpeakerIcon({ className = 'g-icon', muted = false }: IconProps & { muted?: boolean }) {
  return (
    <svg className={className} viewBox="0 0 26 24" aria-hidden="true">
      <path
        d="M3 9 H8 L14 3 V21 L8 15 H3Z"
        fill="#fffaf1"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinejoin="round"
      />
      {muted ? (
        <path d="M18 8 L24 16 M24 8 L18 16" stroke="#b0582f" strokeWidth="2.6" strokeLinecap="round" />
      ) : (
        <path
          d="M18 8 Q21 12 18 16 M21 5 Q26 12 21 19"
          fill="none"
          stroke="#3f6b4f"
          strokeWidth="2.4"
          strokeLinecap="round"
        />
      )}
    </svg>
  )
}
