import { useCallback, useSyncExternalStore } from 'react'

type LegacyMediaQueryList = MediaQueryList & {
  addListener: (listener: () => void) => void
  removeListener: (listener: () => void) => void
}

// One MediaQueryList per query, so rendering reads `.matches` instead of allocating a new list each
// time. Keyed by the matchMedia function as well, so a replaced window (tests) never reuses old lists.
const mediaLists = new WeakMap<typeof window.matchMedia, Map<string, MediaQueryList>>()

function mediaList(query: string): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null
  let lists = mediaLists.get(window.matchMedia)
  if (!lists) {
    lists = new Map()
    mediaLists.set(window.matchMedia, lists)
  }
  let media = lists.get(query)
  if (!media) {
    media = window.matchMedia(query)
    lists.set(query, media)
  }
  return media
}

/**
 * Whether a media query matches now, following changes (window resizes, rotation). It reads the
 * query as an external store, so a change re-renders without an effect copying it into state.
 * Without matchMedia (or on the server) it reports `fallback`.
 */
export function useMediaQuery(query: string, fallback = true): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const media = mediaList(query)
      if (!media) return () => {}
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
  const snapshot = () => mediaList(query)?.matches ?? fallback
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}
