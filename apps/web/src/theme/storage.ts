import {
  normalizeStoredThemeSelection,
  type AppearanceSetting,
  type EffectiveAppearance,
  type StoredThemeSelection,
} from '@ficus/shared/theme-schema'
import { IRIS_THEME, KNOWN_THEME_IDS } from './registry'
import {
  APPEARANCE_STORAGE_KEY,
  LEGACY_SURFACE_COLOR_STORAGE_KEY,
  LEGACY_THEME_STORAGE_KEY,
  THEME_ID_STORAGE_KEY,
  THEME_SURFACE_STORAGE_KEY,
} from '@ficus/shared/browser-keys'

/**
 * Device-local theme persistence (phase 0, PD-2).
 *
 * localStorage stays the *synchronous pre-paint source of truth*: the inline
 * flash script in index.html reads these keys before React boots. The seam is
 * deliberately narrow (read/persist selection, persist/read the resolved
 * surface snapshot) so a later async account-sync layer can wrap it while the
 * device-local explicit choice keeps winning.
 */

export const THEME_ID_KEY = THEME_ID_STORAGE_KEY
export const APPEARANCE_KEY = APPEARANCE_STORAGE_KEY
/** Legacy pre-theme-architecture key holding bare 'light' | 'dark'. */
export const LEGACY_THEME_KEY = LEGACY_THEME_STORAGE_KEY
/** Legacy resolved-surface snapshot (plain color string), kept written for one migration cycle. */
export const LEGACY_SURFACE_COLOR_KEY = LEGACY_SURFACE_COLOR_STORAGE_KEY
/**
 * State-keyed resolved-surface snapshot: `{ theme, appearance, surface }` with
 * the *resolved* appearance, so any stored theme can paint without a flash of
 * the default theme and an OS scheme flip never paints a stale surface.
 */
export const THEME_SURFACE_KEY = THEME_SURFACE_STORAGE_KEY

/** Minimal storage surface; localStorage in the app, a Map in tests. */
export interface ThemeStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** Returns the page's localStorage, or null when unavailable (SSR, private mode). */
export function getThemeStorage(): ThemeStorage | null {
  try {
    if (typeof localStorage === 'undefined') return null
    return localStorage
  } catch {
    return null
  }
}

/**
 * Reads and normalizes the stored selection, migrating a legacy `ficus-theme`
 * value on the fly. Unreadable/unknown values fall back to the defaults; this
 * never throws.
 */
export function readThemeSelection(storage: ThemeStorage | null): StoredThemeSelection {
  const defaultAppearance = hostDefaultAppearance()
  if (!storage)
    return normalizeStoredThemeSelection({ themeId: null, appearance: null, legacyTheme: null, defaultAppearance })
  let themeId: string | null = null
  let appearance: string | null = null
  let legacyTheme: string | null = null
  try {
    themeId = storage.getItem(THEME_ID_KEY)
    appearance = storage.getItem(APPEARANCE_KEY)
    legacyTheme = storage.getItem(LEGACY_THEME_KEY)
  } catch {
    // Unreadable storage behaves like empty storage: defaults.
  }
  return normalizeStoredThemeSelection({
    themeId,
    appearance,
    legacyTheme,
    knownThemeIds: KNOWN_THEME_IDS,
    defaultAppearance,
  })
}

/**
 * The appearance before anyone chooses one. Ficus Desktop's own setup and startup
 * screens follow the OS appearance, so inside it the app does too instead of
 * flashing to light (its preload defines the Desktop bridge before page scripts
 * run, so the pre-paint script sees it). Browsers keep the light default.
 */
function hostDefaultAppearance(): AppearanceSetting | undefined {
  try {
    if (typeof window === 'undefined') return undefined
    type Bridge = { version?: unknown }
    const w = window as unknown as { ficusDesktopApp?: Bridge; tauDesktopApp?: Bridge } // K5: until Ficus Desktop (D2) ships (ficus-p5-apple)
    const bridge = w.ficusDesktopApp ?? w.tauDesktopApp // K5: until Ficus Desktop (D2) ships (ficus-p5-apple)
    return bridge?.version === 1 ? 'system' : undefined
  } catch {
    return undefined
  }
}

/**
 * Persists the selection under the new keys and clears the legacy key, making
 * the migration idempotent (the flash script can read either shape until the
 * provider has run once).
 */
export function persistThemeSelection(storage: ThemeStorage | null, selection: StoredThemeSelection): void {
  if (!storage) return
  try {
    storage.setItem(THEME_ID_KEY, selection.themeId)
    storage.setItem(APPEARANCE_KEY, selection.appearance)
    storage.removeItem(LEGACY_THEME_KEY)
  } catch {
    // Storage may be full or blocked; the in-memory theme still applies.
  }
}

export interface SurfaceSnapshot {
  readonly theme: string
  /** The resolved appearance the surface was captured under. */
  readonly appearance: EffectiveAppearance
  readonly surface: string
}

/** Stores the resolved surface color keyed by the state it was captured under. */
export function persistSurfaceSnapshot(
  storage: ThemeStorage | null,
  themeId: string,
  resolvedAppearance: EffectiveAppearance,
  surface: string
): void {
  if (!storage) return
  const snapshot: SurfaceSnapshot = { theme: themeId, appearance: resolvedAppearance, surface }
  try {
    storage.setItem(THEME_SURFACE_KEY, JSON.stringify(snapshot))
    // Keep the legacy plain-string snapshot valid for one migration cycle so a
    // downgraded build (or a stale flash script) still paints correctly.
    storage.setItem(LEGACY_SURFACE_COLOR_KEY, surface)
  } catch {
    // Best-effort only; the provider still sets the live background/meta.
  }
}

/**
 * Reads the resolved-surface snapshot for the given state. Prefers the
 * state-keyed snapshot; falls back to the legacy plain string only while the
 * structured key has never been written (a pre-upgrade browser), because the
 * legacy string carries no state and a newer write may be stale for this
 * state — e.g. an OS scheme flip between sessions.
 */
export function readSurfaceSnapshot(
  storage: ThemeStorage | null,
  themeId: string,
  resolvedAppearance: EffectiveAppearance
): string | null {
  if (!storage) return null
  try {
    const raw = storage.getItem(THEME_SURFACE_KEY)
    if (raw != null) {
      const parsed = JSON.parse(raw) as Partial<SurfaceSnapshot>
      if (
        parsed &&
        parsed.theme === themeId &&
        parsed.appearance === resolvedAppearance &&
        typeof parsed.surface === 'string' &&
        parsed.surface
      ) {
        return parsed.surface
      }
      // A structured snapshot exists but does not match this state: paint from
      // CSS rather than trusting a possibly-stale value.
      return null
    }
    // The legacy string was only ever written for Iris (the one theme before the theme architecture).
    if (themeId === IRIS_THEME.id) {
      const legacy = storage.getItem(LEGACY_SURFACE_COLOR_KEY)
      if (legacy) return legacy
    }
  } catch {
    // Corrupt snapshot: paint from CSS instead of guessing.
  }
  return null
}
