interface IconProps {
  className?: string
}

/** A handheld device outline for Mobile, distinct from Paired Devices’ desktop screen. */
export function DeviceIcon({ className = 'w-5 h-5' }: IconProps) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <rect x="7" y="2" width="10" height="20" rx="2" strokeWidth={2} />
      <line x1="11" y1="18" x2="13" y2="18" strokeWidth={2} strokeLinecap="round" />
    </svg>
  )
}
