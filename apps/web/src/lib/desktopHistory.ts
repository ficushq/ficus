import { desktopBridge } from './desktop'

// Chromium's Navigation API exposes the *existing* session history, including
// hash entries and forward entries. Keep a small structural type for TS versions
// whose DOM library does not yet include window.navigation.
export interface HistoryEntry {
  key: string
  id: string
  url: string | null
  index: number
  sameDocument: boolean
}
export interface SessionNavigation extends EventTarget {
  currentEntry: HistoryEntry | null
  entries(): HistoryEntry[]
}
export type HistoryAvailability = { back: boolean; forward: boolean }
export const NO_HISTORY: HistoryAvailability = { back: false, forward: false }

export function createDesktopHistory(host: Window, base = '/') {
  const navigation = (host as Window & { navigation?: SessionNavigation }).navigation
  const listeners = new Set<() => void>()
  const prefix = new URL(base.replace(/\/?$/, '/'), host.location.origin)
  const storageKey = `ficus:desktop-history:${prefix.pathname}`
  // Keys survive reload; IDs distinguish replacements of the same entry by
  // another document. Persist both so a reused key cannot widen our boundary.
  let known = new Map<string, string>()
  let snapshot = NO_HISTORY
  let pending = false
  const inApp = (entry: HistoryEntry | null | undefined) => {
    if (!entry?.url) return false
    const url = new URL(entry.url)
    return (
      url.origin === prefix.origin &&
      (url.pathname === prefix.pathname.slice(0, -1) || url.pathname.startsWith(prefix.pathname))
    )
  }
  try {
    const saved: unknown = JSON.parse(host.sessionStorage.getItem(storageKey) ?? '[]')
    if (
      Array.isArray(saved) &&
      saved.every(
        (pair) => Array.isArray(pair) && pair.length === 2 && pair.every((value) => typeof value === 'string')
      )
    )
      known = new Map(saved)
  } catch {
    /* Storage is optional; this document still gets bounded history. */
  }

  const allowed = (delta: -1 | 1) => {
    const current = navigation?.currentEntry
    if (!current || known.get(current.key) !== current.id || !inApp(current)) return false
    const target = navigation?.entries().find((entry) => entry.index === current.index + delta)
    return !!target && known.get(target.key) === target.id && inApp(target)
  }
  const update = () => {
    // Disposed/replaced/forward-truncated entries must not stay in the persisted set.
    known = new Map(
      navigation
        ?.entries()
        .filter((entry) => known.get(entry.key) === entry.id && inApp(entry))
        .map((entry) => [entry.key, entry.id])
    )
    try {
      host.sessionStorage.setItem(storageKey, JSON.stringify([...known]))
    } catch {
      /* fail closed on reload */
    }
    const back = !pending && allowed(-1)
    const forward = !pending && allowed(1)
    if (snapshot.back !== back || snapshot.forward !== forward) {
      snapshot = { back, forward }
      listeners.forEach((listener) => listener())
    }
  }
  if (inApp(navigation?.currentEntry)) known.set(navigation!.currentEntry!.key, navigation!.currentEntry!.id)
  const onChange = (event: Event) => {
    pending = false
    const entry = navigation?.currentEntry
    const type = (event as Event & { navigationType?: string }).navigationType
    // Never adopt unknown traversed entries. Only entries created by this app,
    // plus its initial entry, become reachable from these controls.
    if ((type === 'push' || type === 'replace') && entry?.sameDocument && inApp(entry)) known.set(entry.key, entry.id)
    update()
  }
  navigation?.addEventListener('currententrychange', onChange)
  const onError = () => {
    pending = false
    update()
  }
  navigation?.addEventListener('navigateerror', onError)
  update()
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    go(delta: -1 | 1) {
      // Recheck the live history, not a stale render. Lock out repeated keys/clicks
      // until the asynchronous traversal commits, preventing boundary overshoot.
      if (pending || !allowed(delta)) return
      pending = true
      update()
      host.history.go(delta)
    },
    dispose() {
      navigation?.removeEventListener('currententrychange', onChange)
      navigation?.removeEventListener('navigateerror', onError)
      listeners.clear()
    },
  }
}

let history: ReturnType<typeof createDesktopHistory> | undefined
/** Start before Router/auth bootstrap so even early redirects are observed. */
export function initializeDesktopHistory() {
  if (desktopBridge() && !history) history = createDesktopHistory(window, import.meta.env.BASE_URL || '/')
}
export function getDesktopHistory() {
  return history
}
