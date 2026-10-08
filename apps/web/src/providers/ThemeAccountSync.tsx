import { useEffect, useLayoutEffect } from 'react'
import { selfServiceQueryEnabled, useAuth } from './AuthProvider'
import { useThemeSyncStore } from './ThemeProvider'
import { client } from '../api/clientInstance'
import type { ThemePresetLiveLinkApi, ThemeSyncApi } from '../theme/sync'

/** Deliberately inside AuthProvider, outside the synchronous paint provider.
 * Two animation frames give the browser a paint opportunity before any theme I/O. */
export function ThemeAccountSync() {
  const auth = useAuth()
  const { authRequired, sessionVersion } = auth
  return (
    <ThemeAccountSyncSession
      sessionKey={
        authRequired === null ? undefined : authRequired && selfServiceQueryEnabled(auth) ? sessionVersion : null
      }
    />
  )
}

/** Explicit identity epoch seam for session-boundary regression tests. */
export function ThemeAccountSyncSession({
  sessionKey,
  api = client.userPreferences,
  themePresetsApi = client.themePresets,
}: {
  sessionKey: number | null | undefined
  api?: ThemeSyncApi
  /** Phase 2 live link: refetches the currently-applied preset (if any) on
   * the same triggers as the account preference sync below. Deliberately a
   * separate, minimal interface, not gated by `sessionKey`/`connect()` the
   * way the account preference row is — the preset itself has nothing to do
   * with account adoption, only with "is there still a live-linked preset
   * applied". See ThemeSyncStore.refreshLinkedPreset's doc comment. */
  themePresetsApi?: ThemePresetLiveLinkApi
}) {
  const store = useThemeSyncStore()
  useLayoutEffect(() => {
    // Invalidate requests before passive effects or the next account can render.
    // Auth bootstrap (unknown status) leaves the pre-paint cache untouched.
    if (sessionKey !== undefined) store.disconnect(true)
    return () => store.disconnect()
  }, [store, sessionKey, api])
  useEffect(() => {
    if (sessionKey == null) return
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        store.connect(api)
        // Sequenced, not parallel: the live-linked preset's OWN id/owner
        // typically comes FROM the account read on a fresh device (a device
        // that has never applied this preset locally yet), so the account
        // read must land first. store.refresh() here joins the in-flight
        // read connect() just started (ThemeSyncStore.refresh is reentrant —
        // a second call while one is already running awaits the same read),
        // it does not start a redundant second request.
        void (async () => {
          await store.refresh()
          await store.refreshLinkedPreset(themePresetsApi)
        })()
      })
    })
    const refresh = () => {
      void (async () => {
        await store.refresh()
        await store.refreshLinkedPreset(themePresetsApi)
      })()
    }
    const visible = () => {
      if (document.visibilityState === 'visible') refresh()
    }
    window.addEventListener('online', refresh)
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', visible)
    return () => {
      cancelAnimationFrame(frame)
      store.disconnect()
      window.removeEventListener('online', refresh)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [store, sessionKey, api, themePresetsApi])
  return null
}
