// Source for the generated synchronous inline pre-paint script in index.html.
// Regenerate with: bun apps/web/scripts/generate-theme-flash.ts
import { applyResolvedTheme } from './apply'
import { resolveWebTheme } from './registry'
import { getThemeStorage, readSurfaceSnapshot } from './storage'
import { applyCustomTheme, clearCustomTheme, loadCustomTheme, readResolvedSnapshot } from './custom'
import { tokenColor } from './tokenReader'

try {
  const root = document.documentElement
  const storage = getThemeStorage()
  const state = loadCustomTheme(storage)
  let dark = false
  try {
    dark = !!window.matchMedia?.('(prefers-color-scheme: dark)').matches
  } catch {
    /* default light */
  }
  const resolved = resolveWebTheme(state.selection.themeId, state.selection.appearance, dark)
  applyResolvedTheme(root, resolved.theme, resolved.appearance)
  if (state.custom) {
    try {
      // A palette needs getComputedStyle on the built-in CSS to derive, which
      // is not guaranteed loaded this early. Instead, prefer a PERSISTED
      // resolved snapshot from the last time ThemeProvider actually derived
      // this exact (document, resolved appearance) pair — this is what lets a
      // palette preset paint its derived look before CSS/React, instead of
      // flashing the plain base theme. A miss (edited doc, different resolved
      // side, or no snapshot yet) falls back to explicit-overrides-only; the
      // next real repaint derives fully and persists a fresh snapshot.
      const snapshot = readResolvedSnapshot(storage, state.custom, resolved.appearance)
      if (snapshot) {
        for (const [token, value] of Object.entries(snapshot)) root.style.setProperty(token, value)
      } else {
        applyCustomTheme(root, state.custom, resolved.appearance, { deriveFromComputedStyle: false })
      }
    } catch {
      clearCustomTheme(storage)
      state.custom = null
    }
  }
  // Minimal pre-CSS surface fallback; parity checked against the built-in CSS.
  const surfaces: Record<string, Partial<Record<string, string>>> = {
    ficus: { light: 'rgb(245 240 230)', dark: 'rgb(47 42 36)' },
    iris: { light: 'rgb(255 255 255)', dark: 'rgb(16 17 28)' },
    harbor: { light: 'rgb(255 255 255)', dark: 'rgb(15 30 40)' },
    ember: { light: 'rgb(255 253 249)', dark: 'rgb(35 26 23)' },
    'high-contrast': { constant: 'rgb(255 255 255)' },
    // BigBrain-ported unified built-ins (docs/wiki/theme/builtins.md), kept in
    // sync with apps/web/scripts/generate-bigbrain-builtins.ts's own output.
    nurebairo: { constant: 'rgb(41 33 40)' },
    phosphorus: { constant: 'rgb(204 217 207)' },
    yamabukiiro: { constant: 'rgb(217 165 36)' },
    moegiiro: { constant: 'rgb(48 111 68)' },
    adzukiiro: { constant: 'rgb(133 60 89)' },
    asagiiro: { constant: 'rgb(61 101 128)' },
  }
  // A custom surface comes from the validated document, never a stale snapshot.
  const surface =
    (state.custom
      ? tokenColor(root.style.getPropertyValue('--color-bg-surface'))
      : readSurfaceSnapshot(storage, resolved.theme.id, resolved.appearance)) ||
    surfaces[resolved.theme.id]![resolved.appearance]!
  const tile = tokenColor(root.style.getPropertyValue('--brand-tile'))
  if (tile) document.querySelector('meta[name="msapplication-TileColor"]')?.setAttribute('content', tile)
  root.style.backgroundColor = surface
  const meta = document.querySelector('meta[name="theme-color"]')
  meta?.setAttribute('content', surface)
} catch {
  /* theme resolution must never prevent first paint */
}
