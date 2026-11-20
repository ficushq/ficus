interface IconProps {
  className?: string
}

/** A small window with an arrow leaving its top-right corner: open this in a floating window. */
export function PopOutIcon({ className = 'w-5 h-5' }: IconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M11 4H6.5A2.5 2.5 0 0 0 4 6.5v11A2.5 2.5 0 0 0 6.5 20h11a2.5 2.5 0 0 0 2.5-2.5V13" />
      <path d="M14 4h6v6M20 4l-8 8" />
    </svg>
  )
}
