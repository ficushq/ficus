interface IconProps {
  className?: string
}

/** Mobile's handheld device with a check badge: this server's Mobile & Pro setup. */
export function DeviceProIcon({ className = 'w-5 h-5' }: IconProps) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <g strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}>
        <path d="M13 22H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v6" />
        <path d="M9 18h2" />
        <circle cx="18" cy="17" r="4" />
        <path d="m16.5 17 1 1 2-2" />
      </g>
    </svg>
  )
}
