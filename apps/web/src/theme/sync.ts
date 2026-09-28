import { validateThemePreference, type MyThemePreferences, type ThemePreference, type ThemePreset } from '@ficus/shared'
import { isHttpResponseError } from '@ficus/client-core'
import { DEFAULT_THEME_ID } from '@ficus/shared/theme-schema'
import {
  clearCustomTheme,
  hashCustomThemeDocument,
  loadCustomTheme,
  persistCustomTheme,
  persistPresetId,
  persistPresetOwnerId,
} from './custom'
import { persistThemeSelection, type ThemeStorage } from './storage'
import { LEGACY_THEME_LOCAL_OVERRIDE_STORAGE_KEY } from '@ficus/shared/browser-keys'

/** Written by versions that let a device keep its own theme instead of following the account. Every device now
 * follows the account, so the flag is only removed. */
export const LEGACY_LOCAL_OVERRIDE_KEY = LEGACY_THEME_LOCAL_OVERRIDE_STORAGE_KEY
const DEFAULT: ThemePreference = {
  themeId: DEFAULT_THEME_ID,
  appearance: 'light',
  customTheme: null,
  presetId: null,
  presetOwnerId: null,
}
export interface ThemeSyncApi {
  getMine(signal?: AbortSignal): Promise<MyThemePreferences>
  updateMine(
    input: { expectedUserId: string; theme: ThemePreference },
    signal?: AbortSignal
  ): Promise<MyThemePreferences>
}
/** Phase 2 live link: just enough of `client.themePresets` to refetch the
 * currently-applied preset's document. A separate, minimal interface (like
 * `ThemeSyncApi` above) rather than importing the whole client-core resource
 * type, so this module stays testable with a one-method fake. */
export interface ThemePresetLiveLinkApi {
  get(id: string, signal?: AbortSignal): Promise<ThemePreset>
}
interface Session {
  abort: AbortController
  userId: string | null
  pending: ThemePreference | null
  writing: Promise<void> | null
  reading: Promise<void> | null
}

/** No network at construction or local paint time. Only connect() starts I/O.
 * No query cache: remote documents and queued writes belong to exactly one session. */
export class ThemeSyncStore {
  private listeners = new Set<() => void>()
  private session: Session | null = null
  private api: ThemeSyncApi | null = null
  private revision = 0
  private inheritedInSession = false
  private state: ReturnType<typeof loadCustomTheme> & { syncAvailable: boolean }

  constructor(private storage: ThemeStorage | null) {
    this.state = { ...loadCustomTheme(storage), syncAvailable: false }
    try {
      storage?.removeItem(LEGACY_LOCAL_OVERRIDE_KEY)
    } catch {
      /* storage unavailable: nothing to clean up */
    }
    // Initial migration/defaults are persisted once. Later writes belong only
    // to deliberate changes or account adoption in apply(), never to a React
    // rerender caused by a storage event from another document.
    persistThemeSelection(storage, this.state.selection)
  }
  getSnapshot = () => this.state
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private emit() {
    for (const listener of this.listeners) listener()
  }
  private current(): ThemePreference {
    return {
      ...this.state.selection,
      customTheme: this.state.custom,
      presetId: this.state.presetId,
      presetOwnerId: this.state.presetOwnerId,
    }
  }
  private apply(theme: ThemePreference) {
    clearCustomTheme(this.storage)
    const saved = !theme.customTheme || persistCustomTheme(this.storage, theme.customTheme)
    if (theme.customTheme) {
      persistPresetId(this.storage, theme.presetId)
      persistPresetOwnerId(this.storage, theme.presetOwnerId)
    }
    persistThemeSelection(this.storage, theme)
    this.state = {
      ...this.state,
      selection: { themeId: theme.themeId, appearance: theme.appearance },
      custom: theme.customTheme,
      presetId: theme.customTheme ? theme.presetId : null,
      presetOwnerId: theme.customTheme ? theme.presetOwnerId : null,
      error: saved ? null : 'Theme applied for this session only: device storage is unavailable.',
    }
    this.emit()
  }
  /** Called only by explicit user actions, never by OS changes or remote adoption. */
  change = (theme: ThemePreference) => {
    const result = validateThemePreference(theme)
    if (!result.ok) throw new Error(result.error)
    this.revision++
    this.apply(result.theme)
    // The choice is now the account's, so signing out drops it like an adopted one.
    if (this.session?.userId) this.inheritedInSession = true
    if (this.session) {
      this.session.pending = this.current()
      void this.flush(this.session)
    }
  }
  /** Another tab's device choice must invalidate a pending server read too.
   * Read only: never echo a storage event back into network/persistence. */
  reloadFromStorage = () => {
    const loaded = loadCustomTheme(this.storage)
    if (
      JSON.stringify([loaded.selection, loaded.custom, loaded.presetId, loaded.presetOwnerId]) ===
      JSON.stringify([this.state.selection, this.state.custom, this.state.presetId, this.state.presetOwnerId])
    )
      return
    this.revision++
    if (this.session) this.session.pending = null
    this.state = { ...this.state, ...loaded }
    this.emit()
  }
  recoverCustom = () => {
    clearCustomTheme(this.storage)
    this.state = {
      ...this.state,
      custom: null,
      presetId: null,
      presetOwnerId: null,
      error: 'Custom theme could not be applied. Restored its base theme.',
    }
    this.emit()
  }
  connect = (api: ThemeSyncApi) => {
    this.disconnect()
    this.api = api
    this.session = { abort: new AbortController(), userId: null, pending: null, writing: null, reading: null }
    void this.refresh()
  }
  disconnect = (clearInherited = false) => {
    this.session?.abort.abort()
    this.session = null
    this.api = null
    this.state = { ...this.state, syncAvailable: false }
    if (clearInherited && this.inheritedInSession) this.apply(DEFAULT)
    if (clearInherited) this.inheritedInSession = false
    this.emit()
  }
  private alive(session: Session) {
    return this.session === session && !session.abort.signal.aborted
  }
  private async flush(session: Session): Promise<void> {
    if (!this.alive(session) || !session.userId || !session.pending || session.writing)
      return session.writing ?? undefined
    const api = this.api!
    session.writing = (async () => {
      while (this.alive(session) && session.pending) {
        const theme = session.pending
        const revision = this.revision
        session.pending = null
        try {
          await api.updateMine({ expectedUserId: session.userId!, theme }, session.abort.signal)
        } catch {
          // Keep only the latest unsent choice, within this session. Reconnect/focus
          // retries it; neither login nor reload uploads an old device/account cache.
          // A newer choice from another tab cancels the original intent. Never resurrect that old PUT;
          // a newer same-tab choice is already in pending and stays there.
          if (this.alive(session) && revision === this.revision) session.pending ??= theme
          break
        }
      }
    })()
    await session.writing
    session.writing = null
  }
  refresh = async (): Promise<void> => {
    const session = this.session
    if (!session || session.reading) return session?.reading ?? undefined
    const api = this.api!
    session.reading = (async () => {
      try {
        await this.flush(session)
        if (!this.alive(session)) return
        const revision = this.revision
        const result = await api.getMine(session.abort.signal)
        if (!this.alive(session)) return
        if (!result || typeof result.userId !== 'string' || !result.userId) return
        if (session.userId && session.userId !== result.userId) {
          // Cookie changed outside the UI. Never carry a pending write or document
          // into that identity. A new authenticated session must reconnect.
          this.disconnect(true)
          return
        }
        // No row is no account choice yet: keep this device's theme rather than resetting it to the default.
        const parsed = result.theme === null ? null : validateThemePreference(result.theme)
        if (parsed && !parsed.ok) return
        session.userId = result.userId
        this.state = { ...this.state, syncAvailable: true }
        // Every device follows the account, except over a newer choice made here that the read predates or that
        // has not reached the server yet (offline); that choice is uploaded next and becomes the account's.
        if (parsed && revision === this.revision && !session.pending) {
          this.inheritedInSession = true
          this.apply(parsed.theme)
        } else this.emit()
        await this.flush(session)
      } catch {
        /* offline/old server: silently remain device-local */
      }
    })()
    await session.reading
    session.reading = null
  }
  /**
   * Phase 2 "live link": refetches the currently-applied preset's document
   * and applies it if it changed — the author's edits show up on this
   * device's next load or focus/refresh, exactly like account preference
   * sync's own `refresh()`. Independent of `connect()`/`session` (the preset itself, not the
   * account preference row, is what's being refetched) — callers still only
   * invoke it during an authenticated session, matching `ThemeAccountSync`'s
   * own trigger lifecycle.
   *
   * A no-op unless a preset with a known owner is actually active (`custom`,
   * `presetId` AND `presetOwnerId` all present) — never fetches for a
   * built-in selection, a one-off import, or an already-detached preset.
   * `presetOwnerId` stays populated for EVERY applied preset, including the
   * caller's own (see ThemePreference.presetOwnerId's doc comment), so this
   * also picks up the caller's own edits made from another device — a
   * harmless, usually-no-op bonus, not a behavior regression: the editor and
   * rename flow already apply an own edit locally and instantly.
   *
   * On 404 (unshared or deleted), marks detached — clears `presetId` but
   * RETAINS `presetOwnerId` and the document snapshot, via the normal
   * `apply()` path (persists + repaints identically to any other selection
   * change). Never overrides an open editor draft or quick-picker hover
   * preview: those live in ThemeProvider's separate preview slot, which
   * always reapplies over any real repaint this triggers (see
   * `useThemePreview`'s doc comment) — this method only ever touches the
   * STORED selection, never paints directly.
   */
  refreshLinkedPreset = async (api: ThemePresetLiveLinkApi, signal?: AbortSignal): Promise<void> => {
    const { presetId, presetOwnerId, custom, selection } = this.state
    if (!presetId || !presetOwnerId || !custom) return
    const revision = this.revision
    try {
      const preset = await api.get(presetId, signal)
      if (revision !== this.revision) return // superseded by a newer local change meanwhile
      if (hashCustomThemeDocument(preset.document) === hashCustomThemeDocument(custom)) return // unchanged
      this.apply({ ...selection, customTheme: preset.document, presetId: preset.id, presetOwnerId: preset.owner.id })
    } catch (error) {
      if (revision !== this.revision) return
      if (isHttpResponseError(error, 404))
        this.apply({ ...selection, customTheme: custom, presetId: null, presetOwnerId })
      // Any other error (offline, old server, aborted): silently remain as-is, retried on the next trigger.
    }
  }
}
