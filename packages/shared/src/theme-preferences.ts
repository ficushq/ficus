import { isAppearanceSetting, type StoredThemeSelection, type ThemeDescriptor } from './theme-schema'
import { validateCustomTheme, type CustomThemeDocument } from './custom-theme'

/** Cross-platform metadata only; palettes and variant classes remain web-owned. */
export const SYNC_THEME_DESCRIPTORS: readonly ThemeDescriptor[] = [
  { id: 'ficus', label: 'Ficus', kind: 'dual' },
  { id: 'iris', label: 'Iris', kind: 'dual' },
  { id: 'harbor', label: 'Harbor', kind: 'dual' },
  { id: 'ember', label: 'Ember', kind: 'dual' },
  // Six BigBrain-ported palettes (docs/wiki/theme/builtins.md) — see
  // apps/web/src/theme/registry.ts's BUILT_IN_THEMES for the web-owned
  // variant-class metadata; this list is cross-platform id/label/kind only.
  { id: 'nurebairo', label: 'nurebairo', kind: 'unified' },
  { id: 'phosphorus', label: 'Phosphorus', kind: 'unified' },
  { id: 'yamabukiiro', label: 'yamabukiiro', kind: 'unified' },
  { id: 'moegiiro', label: 'moegiiro', kind: 'unified' },
  { id: 'adzukiiro', label: 'adzukiiro', kind: 'unified' },
  { id: 'asagiiro', label: 'asagiiro', kind: 'unified' },
  // Accessibility, not a palette: always listed last.
  { id: 'high-contrast', label: 'High contrast', kind: 'unified' },
]

export interface ThemePreference extends StoredThemeSelection {
  customTheme: CustomThemeDocument | null
  /** The library preset the active custom document was applied from, or null
   * when detached (built-in selection, a one-off import, the preset was later
   * deleted, or — Phase 2 — a shared preset was unshared/deleted; the
   * snapshot in `customTheme` keeps working either way). */
  presetId: string | null
  /**
   * Phase 2: the id of the user who owns `presetId`'s preset, populated
   * whenever a preset (own or another user's shared preset) is applied.
   * Deliberately NOT cleared when a live-link refresh finds the preset gone
   * and nulls `presetId` — retaining it is what lets the UI tell "a shared
   * preset is no longer available" (show a detached notice) apart from
   * silently detaching from your own deleted preset (Phase 1 behavior,
   * unchanged): compare `presetOwnerId` against the caller's own user id.
   * Only meaningful alongside a `customTheme`; meaningless (and rejected) on
   * its own.
   */
  presetOwnerId: string | null
}
export interface MyThemePreferences {
  userId: string
  /** No row means no account choice, not an instruction to upload this device's cache. */
  theme: ThemePreference | null
}

/** Validate atomically: never accept a custom document with a different base.
 * A v2 pair follows the Light/Dark/System toggle, so (unlike v1) the stored
 * appearance is not required to match a single concrete variant. */
export function validateThemePreference(
  input: unknown
): { ok: true; theme: ThemePreference } | { ok: false; error: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    return { ok: false, error: 'Expected a theme object.' }
  const value = input as Record<string, unknown>
  if (!SYNC_THEME_DESCRIPTORS.some((theme) => theme.id === value.themeId) || !isAppearanceSetting(value.appearance))
    return { ok: false, error: 'Unknown theme or appearance.' }
  let customTheme: CustomThemeDocument | null = null
  if (value.customTheme !== null) {
    const result = validateCustomTheme(JSON.stringify(value.customTheme) ?? '', SYNC_THEME_DESCRIPTORS)
    if (!result.ok) return result
    customTheme = result.document
    if (customTheme.base !== value.themeId) return { ok: false, error: 'Custom theme must match the selected base.' }
  }
  let presetId: string | null = null
  if (value.presetId !== undefined && value.presetId !== null) {
    if (typeof value.presetId !== 'string' || !value.presetId || value.presetId.length > 200)
      return { ok: false, error: 'Invalid presetId.' }
    presetId = value.presetId
  }
  let presetOwnerId: string | null = null
  if (value.presetOwnerId !== undefined && value.presetOwnerId !== null) {
    if (typeof value.presetOwnerId !== 'string' || !value.presetOwnerId || value.presetOwnerId.length > 200)
      return { ok: false, error: 'Invalid presetOwnerId.' }
    if (!customTheme) return { ok: false, error: 'presetOwnerId requires a customTheme.' }
    presetOwnerId = value.presetOwnerId
  }
  return {
    ok: true,
    theme: { themeId: value.themeId as string, appearance: value.appearance, customTheme, presetId, presetOwnerId },
  }
}
