import {
  createContext,
  useContext,
  useState,
  useEffect,
  useLayoutEffect,
  useCallback,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import {
  type CustomThemeDocument,
  type ThemePreset,
  type ThemePresetOwner,
  type AppearanceSetting,
} from '@ficus/shared'
import { findWebTheme, resolveWebTheme, type WebThemeDefinition } from '../theme/registry'
import { tokenColor } from '../theme/tokenReader'
import { applyResolvedTheme } from '../theme/apply'
import { getThemeStorage, persistSurfaceSnapshot } from '../theme/storage'

import { applyCustomTheme, customSelection, persistResolvedSnapshot, removeCustomProperties } from '../theme/custom'
import { ThemeSyncStore } from '../theme/sync'
import { CUSTOM_THEME_KEY } from '../theme/custom'
import { THEME_ID_KEY, APPEARANCE_KEY, LEGACY_THEME_KEY } from '../theme/storage'

/**
 * The resolved appearance (light/dark). Kept as `theme` for the existing
 * toggle UX and call sites; `appearance` is the user's setting, which may be
 * 'system'.
 */
type Theme = 'light' | 'dark'

interface ThemeContextValue {
  syncAvailable: boolean
  /** The registered theme id currently applied (e.g. 'ficus'). */
  customTheme: CustomThemeDocument | null
  customThemeError: string | null
  /** The library preset `customTheme` came from, or null when detached
   * (built-in selection, a one-off import, the preset was later deleted, or
   * — Phase 2 — a shared preset was unshared/deleted). */
  presetId: string | null
  /** Phase 2: the owner of `presetId`'s preset, populated for every applied
   * preset (own or another user's shared preset) and RETAINED even once
   * `presetId` goes null on a live-link 404 — `presetId === null &&
   * presetOwnerId !== null` is what marks "a shared theme is no longer
   * available" for the Settings UI, as opposed to silently detaching from
   * your own deleted preset (`presetOwnerId` also null in that case). */
  presetOwnerId: string | null
  applyCustom: (doc: CustomThemeDocument) => void
  applyPreset: (preset: Pick<ThemePreset, 'id' | 'document'> & { owner: Pick<ThemePresetOwner, 'id'> }) => void
  themeId: string
  /** The user's appearance setting: 'light' | 'dark' | 'system'. */
  appearance: AppearanceSetting
  /** The resolved appearance after 'system' is resolved against the OS. */
  theme: Theme
  /**
   * The user's appearance setting resolved against the OS, whatever the current theme. It differs from `theme` only on
   * a one-appearance theme, which keeps the setting for other themes: previews and swatches of those use this.
   */
  preferredTheme: Theme
  toggleTheme: () => void
  setTheme: (theme: Theme) => void
  setThemeId: (themeId: string) => void
  setAppearance: (appearance: AppearanceSetting) => void
}

const ThemeSyncContext = createContext<ThemeSyncStore | null>(null)

// eslint-disable-next-line react-refresh/only-export-components
export function useThemeSyncStore() {
  const store = useContext(ThemeSyncContext)
  if (!store) throw new Error('useThemeSyncStore must be used within ThemeProvider')
  return store
}

/** A whole-app preview repaint: pure DOM, no return value (contrast this with
 * paintRoot, which callers use to build one of these closures). */
export type ThemePreviewPainter = () => void

interface ThemePreviewApi {
  /** Registers the ACTIVE preview painter (last registrant wins — only one
   * preview is ever active), paints it immediately, and returns an unregister
   * function. The provider's own root-paint effect reapplies whichever
   * painter is currently registered AFTER its own real paint, every time it
   * paints — so an unrelated repaint (setAppearance, a storage event, remote
   * account-sync adoption) never silently clobbers an open preview.
   *
   * The returned unregister function repaints the CURRENT real selection
   * (never a stale one) and is a no-op if a later registrant has since taken
   * over the slot — callers should register on open/hover-start and call the
   * returned function on close/unmount/hover-end, exactly like a React effect
   * cleanup (usually IS one). */
  setPreview: (painter: ThemePreviewPainter) => () => void
}
const ThemePreviewContext = createContext<ThemePreviewApi | null>(null)

// eslint-disable-next-line react-refresh/only-export-components
export function useThemePreview(): ThemePreviewApi {
  const ctx = useContext(ThemePreviewContext)
  if (!ctx) throw new Error('useThemePreview must be used within ThemeProvider')
  return ctx
}

/** The preview slot inside ThemeProvider, otherwise null (for pickers also rendered standalone). */
// eslint-disable-next-line react-refresh/only-export-components
export function useOptionalThemePreview(): ThemePreviewApi | null {
  return useContext(ThemePreviewContext)
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

// eslint-disable-next-line react-refresh/only-export-components
export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider')
  return ctx
}

/** The theme context inside ThemeProvider, otherwise null (for components also rendered standalone). */
// eslint-disable-next-line react-refresh/only-export-components
export function useOptionalTheme(): ThemeContextValue | null {
  return useContext(ThemeContext)
}

/** Reads the OS color-scheme preference once; light when unavailable. */
function readSystemPrefersDark(): boolean {
  try {
    if (typeof window === 'undefined' || !window.matchMedia) return false
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  } catch {
    return false
  }
}

/** Derives a palette document's OTHER (currently non-visible) resolved side
 * off-screen, for the resolved-theme snapshot — a 'system'-appearance user's
 * OS preference can flip between this real paint and the next cold load's
 * pre-paint script, so only having a snapshot for the CURRENTLY visible side
 * would flash the plain base theme after such a flip while a fresh
 * derivation catches up.
 *
 * Reuses the same `[data-theme-scope][data-theme][data-appearance]`
 * attribute-selector scoping the built-in CSS already defines for nested
 * previews (ThemeQuickPicker's circles, the editor's contrast probes) — a
 * detached-looking, zero-size, visibility:hidden element gets that side's
 * base tokens from the SAME cascade the visible root uses, via
 * getComputedStyle, without ever painting anything on screen. */
function readOtherSideDerivedVars(
  base: WebThemeDefinition,
  otherSide: 'light' | 'dark',
  custom: CustomThemeDocument
): Record<string, string> | null {
  const probe = document.createElement('div')
  probe.setAttribute('data-theme-scope', '')
  probe.setAttribute('data-theme', base.id)
  probe.setAttribute('data-appearance', otherSide)
  probe.style.position = 'absolute'
  probe.style.width = '0'
  probe.style.height = '0'
  probe.style.overflow = 'hidden'
  probe.style.visibility = 'hidden'
  probe.style.pointerEvents = 'none'
  document.body.appendChild(probe)
  try {
    return applyCustomTheme(probe, custom, otherSide)
  } catch {
    return null
  } finally {
    probe.remove()
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  // The stored selection is read once, synchronously: legacy 'ficus-theme'
  // values migrate here, unreadable values fall back to the defaults.
  const [store] = useState(() => new ThemeSyncStore(getThemeStorage()))
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const { selection, custom, presetId, presetOwnerId, error } = state
  const [systemPrefersDark, setSystemPrefersDark] = useState(readSystemPrefersDark)

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.storageArea && event.storageArea !== getThemeStorage()) return
      if (event.key === null || [THEME_ID_KEY, APPEARANCE_KEY, LEGACY_THEME_KEY, CUSTOM_THEME_KEY].includes(event.key))
        store.reloadFromStorage()
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [store])

  // Live system-preference tracking: a 'system' appearance follows OS scheme
  // changes without a reload (new capability in phase 0).
  useEffect(() => {
    try {
      if (typeof window === 'undefined' || !window.matchMedia) return
      const query = window.matchMedia('(prefers-color-scheme: dark)')
      const onChange = (event: MediaQueryListEvent) => setSystemPrefersDark(event.matches)
      query.addEventListener('change', onChange)
      return () => query.removeEventListener('change', onChange)
    } catch {
      return
    }
  }, [])

  const resolved = resolveWebTheme(selection.themeId, selection.appearance, systemPrefersDark)
  const { theme: resolvedThemeDefinition, appearance: resolvedAppearance } = resolved
  const resolvedTheme: Theme = resolvedAppearance === 'dark' ? 'dark' : 'light'

  // The preview slot (see useThemePreview's doc comment above): `previewRef`
  // holds the currently-registered painter (or null), and `realPaintRef`
  // always holds a FRESH closure that paints the real, current selection —
  // reassigned every render (the "latest ref" pattern, not memoized), so the
  // preview-clearing restore below is never stale even if it runs long after
  // the render that registered it.
  const previewRef = useRef<ThemePreviewPainter | null>(null)
  const realPaintRef = useRef<() => void>(() => {})
  realPaintRef.current = () => {
    const root = document.documentElement
    removeCustomProperties(root)
    applyResolvedTheme(root, resolvedThemeDefinition, resolvedAppearance)
    if (!custom) return
    try {
      applyCustomTheme(root, custom, resolvedAppearance)
    } catch {
      store.recoverCustom()
    }
  }
  const setPreview = useCallback((painter: ThemePreviewPainter) => {
    previewRef.current = painter
    painter()
    return () => {
      // Only clear if we're still the registered painter — a later
      // registrant (e.g. the editor opening while a quick-picker hover
      // preview is still technically "active") already owns the slot, and
      // this stale cleanup must not clobber it.
      if (previewRef.current !== painter) return
      previewRef.current = null
      realPaintRef.current()
    }
  }, [])

  useLayoutEffect(() => {
    const root = document.documentElement
    removeCustomProperties(root)
    applyResolvedTheme(root, resolvedThemeDefinition, resolvedAppearance)
    if (custom) {
      try {
        const vars = applyCustomTheme(root, custom, resolvedAppearance)
        // The only place this is ever written: the ACTIVE document's own real
        // (derivation-enabled) root paint. Lets the next cold load's
        // pre-paint script apply this exact resolved result instead of
        // flashing the plain base theme while it waits for a real repaint.
        //
        // This also runs for a storage-event-driven repaint (another tab
        // changed the selection) — harmless, not just redundant: `vars` is a
        // pure function of (doc, base tokens), so every tab derives the
        // IDENTICAL value for the same (doc, appearance) pair, and
        // RESOLVED_SNAPSHOT_KEY is never one of the keys `onStorage` below
        // reacts to, so writing it can never itself trigger another
        // storage-event repaint (no feedback loop).
        persistResolvedSnapshot(getThemeStorage(), custom, resolvedAppearance, vars)
        // A 'system'-appearance user's OS can flip while this tab is open or
        // between sessions; snapshot the OTHER resolved side too (derived
        // off-screen) so a flip never flashes. Only worth the extra
        // derivation for a palette document on a dual-kind base — an
        // explicit-only document's other side needs no cascade/
        // getComputedStyle at all (the flash script's fallback path already
        // gets it exactly right), and a unified base has no other side.
        if (selection.appearance === 'system' && custom.palette && resolvedThemeDefinition.kind === 'dual') {
          const otherSide = resolvedAppearance === 'dark' ? 'light' : 'dark'
          const otherVars = readOtherSideDerivedVars(resolvedThemeDefinition, otherSide, custom)
          if (otherVars) persistResolvedSnapshot(getThemeStorage(), custom, otherSide, otherVars)
        }
      } catch {
        store.recoverCustom()
        return
      }
    }
    const tile = tokenColor(window.getComputedStyle(root).getPropertyValue('--brand-tile').trim())
    if (tile) document.querySelector('meta[name="msapplication-TileColor"]')?.setAttribute('content', tile)

    // Store the resolved surface color so the flash-prevention script can use
    // it before React boots. Share the pre-paint serializer: valid custom
    // alpha may compile to exponent notation, which is not a bare CSS color.
    const channels = window.getComputedStyle(root).getPropertyValue('--color-bg-surface').trim()
    const surface = tokenColor(channels)
    if (surface) {
      persistSurfaceSnapshot(getThemeStorage(), resolvedThemeDefinition.id, resolvedAppearance, surface)
      root.style.backgroundColor = surface

      // Keep the theme-color meta in sync: Safari/iOS tints its chrome (tab
      // bar, PWA status glass) with it, so it must match the header surface.
      let meta = document.querySelector<HTMLMetaElement>("meta[name='theme-color']")
      if (!meta) {
        meta = document.createElement('meta')
        meta.name = 'theme-color'
        document.head.appendChild(meta)
      }
      meta.content = surface
    }

    // Reapply the active preview (editor draft, quick-picker hover), if any,
    // AFTER our own real paint above. This is what makes a preview survive
    // an unrelated repaint — setAppearance, a storage event from another tab,
    // remote account-sync adoption — instead of being silently clobbered by
    // it: every time this effect repaints the real selection, it hands
    // control straight back to whatever's currently in the preview slot.
    previewRef.current?.()
  }, [resolvedThemeDefinition, resolvedAppearance, selection, custom, store])

  const setThemeId = useCallback(
    (themeId: string) => {
      // Deactivates the custom theme (and its preset ring) without deleting
      // anything from the library — the preset row is untouched server-side.
      store.change({
        ...store.getSnapshot().selection,
        themeId: findWebTheme(themeId).id,
        customTheme: null,
        presetId: null,
        presetOwnerId: null,
      })
    },
    [store]
  )
  const setAppearance = useCallback(
    (appearance: AppearanceSetting) => {
      // A v2 document covers both variants: changing appearance keeps the
      // active preset (and its owner, for the live link) and just resolves a
      // different side of it.
      const snapshot = store.getSnapshot()
      store.change({
        ...snapshot.selection,
        appearance,
        customTheme: snapshot.custom,
        presetId: snapshot.presetId,
        presetOwnerId: snapshot.presetOwnerId,
      })
    },
    [store]
  )
  const setTheme = useCallback((theme: Theme) => setAppearance(theme), [setAppearance])
  const toggleTheme = useCallback(() => {
    const snapshot = store.getSnapshot()
    const current = snapshot.selection
    const resolved = resolveWebTheme(current.themeId, current.appearance, systemPrefersDark)
    store.change({
      ...current,
      appearance: resolved.appearance === 'dark' ? 'light' : 'dark',
      customTheme: snapshot.custom,
      presetId: snapshot.presetId,
      presetOwnerId: snapshot.presetOwnerId,
    })
  }, [store, systemPrefersDark])
  /** Applies a one-off document not tied to a saved preset (import, or a raw
   * apply from the editor's "Save as new" flow before the row exists yet). */
  const applyCustom = useCallback(
    (doc: CustomThemeDocument) => {
      store.change({
        ...customSelection(doc, store.getSnapshot().selection),
        customTheme: doc,
        presetId: null,
        presetOwnerId: null,
      })
    },
    [store]
  )
  const applyPreset = useCallback(
    (preset: Pick<ThemePreset, 'id' | 'document'> & { owner: Pick<ThemePresetOwner, 'id'> }) => {
      store.change({
        ...customSelection(preset.document, store.getSnapshot().selection),
        customTheme: preset.document,
        presetId: preset.id,
        presetOwnerId: preset.owner.id,
      })
    },
    [store]
  )
  const contextValue: ThemeContextValue = {
    syncAvailable: state.syncAvailable,
    customTheme: custom,
    customThemeError: error,
    presetId,
    presetOwnerId,
    applyCustom,
    applyPreset,
    themeId: resolvedThemeDefinition.id,
    appearance: selection.appearance,
    theme: resolvedTheme,
    preferredTheme: selection.appearance === 'system' ? (systemPrefersDark ? 'dark' : 'light') : selection.appearance,
    toggleTheme,
    setTheme,
    setAppearance,
    setThemeId,
  }
  const previewContextValue = useMemo(() => ({ setPreview }), [setPreview])

  return (
    <ThemeSyncContext.Provider value={store}>
      <ThemePreviewContext.Provider value={previewContextValue}>
        <ThemeContext.Provider value={contextValue}>{children}</ThemeContext.Provider>
      </ThemePreviewContext.Provider>
    </ThemeSyncContext.Provider>
  )
}
