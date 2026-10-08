import { useEffect, useState } from 'react'

function matches(query: string, fallback: boolean): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return fallback
  return window.matchMedia(query).matches
}

/** Whether a media query matches now, following changes (window resizes, rotation). */
export function useMediaQuery(query: string, fallback = true): boolean {
  const [value, setValue] = useState(() => matches(query, fallback))

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const media = window.matchMedia(query)
    const update = () => setValue(media.matches)
    update()
    media.addEventListener?.('change', update)
    return () => media.removeEventListener?.('change', update)
  }, [query])

  return value
}
