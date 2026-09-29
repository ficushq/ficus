interface IconProps {
  className?: string
}

/** A window split into a left half and two right quarters: arrange a window on screen. */
export function WindowLayoutIcon({ className = 'w-5 h-5' }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d="M12 4v16M12 12h9" />
    </svg>
  )
}
