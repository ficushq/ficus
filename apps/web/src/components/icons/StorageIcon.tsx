import type { IconProps } from './types'

/** A hard drive: disk space used, as on the Storage settings pages. */
export function StorageIcon({ className = 'w-5 h-5' }: IconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3.5 14 6.1 6.2a1.5 1.5 0 0 1 1.4-1.2h9a1.5 1.5 0 0 1 1.4 1.2l2.6 7.8" />
      <rect x="3.5" y="14" width="17" height="6" rx="1.5" />
      <path d="M16.5 17h.01M7 17h5" />
    </svg>
  )
}
