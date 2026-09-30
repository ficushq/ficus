import type { IconProps } from './types'

/** A seedling: a stem and two leaves, for work streams inline in text. */
export function SproutIcon({ className = 'g-icon' }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 15 V8.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M8 9 C4.5 9.2 2.2 7.2 2 3.6 C5.4 3.5 7.8 5.4 8 9Z" fill="currentColor" />
      <path d="M8 7.6 C8.3 4 10.6 1.8 14.2 1.8 C14.2 5.4 11.8 7.6 8 7.6Z" fill="currentColor" />
    </svg>
  )
}
