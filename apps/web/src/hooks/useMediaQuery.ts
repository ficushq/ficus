import { useCallback, useSyncExternalStore } from 'react'

type LegacyMediaQueryList = MediaQueryList & {
  addListener: (listener: () => void) => void
  removeListener: (listener: () => void) => void
}

function hasMatchMedia(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
}

function matches(query: string, fallback: boolean): boolean {
  if (!hasMatchMedia()) return fallback
  return window.matchMedia(query).matches
}

/**
 * Whether a media query matches now, following changes (window resizes, rotation). It reads the
 * query as an external store, so a change re-renders without an effect copying it into state.
 * Without matchMedia (or on the server) it reports `fallback`.
 */
export function useMediaQuery(query: string, fallback = true): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!hasMatchMedia()) return () => {}
      const media = window.matchMedia(query)
      if ('addEventListener' in media && typeof media.addEventListener === 'function') {
        media.addEventListener('change', onChange)
        return () => media.removeEventListener('change', onChange)
      }
      // Older Safari only has the deprecated listener methods.
      const legacy = media as LegacyMediaQueryList
      legacy.addListener?.(onChange)
      return () => legacy.removeListener?.(onChange)
    },
    [query]
  )
  const snapshot = () => matches(query, fallback)
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}
