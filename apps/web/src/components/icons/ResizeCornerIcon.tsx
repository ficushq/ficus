interface IconProps {
  className?: string
}

/** Two diagonal grip strokes in the bottom-right corner; rotate for other corners. */
export function ResizeCornerIcon({ className = 'w-5 h-5' }: IconProps) {
  return (
    <svg
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      viewBox="0 0 24 24"
    >
      <path d="M20 10 10 20M20 16l-4 4" />
    </svg>
  )
}
