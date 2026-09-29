interface IconProps {
  className?: string
}

/** A sprout: the farm. */
export function SproutIcon({ className = 'w-5 h-5' }: IconProps) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M12 21v-9m0 0C12 8 9 5 4.5 5c0 4.5 3 7 7.5 7zm0 0c0-3 2.5-5.5 7.5-5.5 0 4-3 5.5-7.5 5.5zM7 21h10"
      />
    </svg>
  )
}
