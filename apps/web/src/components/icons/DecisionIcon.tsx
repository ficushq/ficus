import type { IconProps } from './types'

/** A diamond with a split route: a step that decides where the work goes. */
export function DecisionIcon({ className = 'w-5 h-5' }: IconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3l7 7-7 7-7-7z" />
      <path d="M12 17v4M9 10h6" />
    </svg>
  )
}
