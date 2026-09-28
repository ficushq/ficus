import { ACTIVE_THEME_TOKENS, type EffectiveAppearance, type StoredThemeSelection } from '@ficus/shared/theme-schema'
import {
  CUSTOM_THEME_MAX_BYTES,
  compileCustomTheme,
  validateCustomTheme,
  type CustomThemeDocument,
} from '@ficus/shared/custom-theme'
import { applyResolvedTheme } from './apply'
import { BUILTIN_CSS_FINGERPRINT } from './builtinFingerprint'
import { fnv1a } from './fnv'
import { BUILT_IN_THEMES, findWebTheme } from './registry'
import {
  LEGACY_SURFACE_COLOR_KEY,
  THEME_SURFACE_KEY,
  persistThemeSelection,
  readThemeSelection,
  type ThemeStorage,
} from './storage'
import {
  CUSTOM_THEME_RESOLVED_STORAGE_KEY,
  CUSTOM_THEME_STORAGE_KEY,
  THEME_PRESET_ID_STORAGE_KEY,
  THEME_PRESET_OWNER_ID_STORAGE_KEY,
} from '@ficus/shared/browser-keys'

export const CUSTOM_THEME_KEY = CUSTOM_THEME_STORAGE_KEY
/** Device-local only (not part of pre-paint): remembers which library preset the
 * active document came from, so the UI can restore the ring/active state on reload
 * without a network round-trip. A dangling value (deleted preset) is harmless —
 * callers treat an unmatched id as detached. */
export const PRESET_ID_KEY = THEME_PRESET_ID_STORAGE_KEY
/** Phase 2: the owner of `PRESET_ID_KEY`'s preset, populated whenever a preset
 * (own or shared) is applied. Deliberately retained even when a live-link
 * refresh clears `PRESET_ID_KEY` on a 404 — see ThemePreference.presetOwnerId
 * for why that combination (id null, owner set) is what marks "detached from
 * a shared theme" apart from an ordinary silently-detached own preset. */
export const PRESET_OWNER_ID_KEY = THEME_PRESET_OWNER_ID_STORAGE_KEY
/** A palette-derived document needs getComputedStyle to derive (see
 * applyCustomTheme below), which the synchronous pre-paint script cannot trust
 * yet — so it stores the LAST RESOLVED result here instead, keyed to the exact
 * (document, resolved appearance) pair. See readResolvedSnapshot/persistResolvedSnapshot. */
export const RESOLVED_SNAPSHOT_KEY = CUSTOM_THEME_RESOLVED_STORAGE_KEY
/** Generous but explicit safety cap: a full palette-derived theme can touch
 * most of the ~431-token registry (up to 3 compiled properties each), which a
 * real theme approaches but should never exceed by a wide margin. Exceeding
 * this just skips persisting (falls back to the explicit-overrides-only
 * pre-paint path) rather than growing localStorage unboundedly. */
export const RESOLVED_SNAPSHOT_MAX_BYTES = 200 * 1024

export function clearCustomTheme(storage: ThemeStorage | null) {
  for (const key of [
    CUSTOM_THEME_KEY,
    PRESET_ID_KEY,
    PRESET_OWNER_ID_KEY,
    RESOLVED_SNAPSHOT_KEY,
    THEME_SURFACE_KEY,
    LEGACY_SURFACE_COLOR_KEY,
  ]) {
    try {
      storage?.removeItem(key)
    } catch {
      /* storage denied: still recover in memory */
    }
  }
}

/** Deterministic, non-cryptographic (staleness detection only) hash of a
 * custom theme document (FNV-1a over its normalized JSON). Shared by the
 * React paint path and the generated pre-paint bundle so both agree on
 * exactly when a stored resolved snapshot is stale — any change to the
 * document (a palette seed, an explicit override, even the name) changes it. */
export function hashCustomThemeDocument(doc: CustomThemeDocument): string {
  return fnv1a(JSON.stringify(doc))
}

interface ResolvedThemeSnapshot {
  docHash: string
  /** See theme/builtinFingerprint.ts: invalidates every stored side when a
   * deploy changes a built-in token's own value, not just when the document
   * itself changes. */
  fingerprint: string
  /** Both resolved sides ('light'/'dark', or just 'constant' for a unified
   * base) CAN be present — a 'system'-appearance user's OS can flip between
   * this real paint and the next cold load's pre-paint script, and only a
   * snapshot covering the side that's ACTUALLY about to render avoids a
   * flash. Absent entries just mean that side has never been painted (or was
   * dropped by the byte cap below) — never treated differently from a
   * completely missing snapshot. */
  sides: Partial<Record<EffectiveAppearance, Record<string, string>>>
}

function readRawSnapshot(storage: ThemeStorage | null, doc: CustomThemeDocument): ResolvedThemeSnapshot | null {
  const raw = storage?.getItem(RESOLVED_SNAPSHOT_KEY)
  if (!raw) return null
  const parsed = JSON.parse(raw) as Partial<ResolvedThemeSnapshot>
  if (
    !parsed ||
    typeof parsed.docHash !== 'string' ||
    parsed.docHash !== hashCustomThemeDocument(doc) ||
    parsed.fingerprint !== BUILTIN_CSS_FINGERPRINT ||
    !parsed.sides ||
    typeof parsed.sides !== 'object'
  )
    return null
  return parsed as ResolvedThemeSnapshot
}

/** Persists the exact compiled vars `applyCustomTheme` just wrote for ONE
 * resolved side, keyed to the document that produced them, MERGED with
 * whatever the snapshot already holds for the OTHER side — as long as that
 * existing snapshot is for the SAME document and build (its docHash and
 * fingerprint still match; anything else starts a fresh one, dropping a
 * stale other-side entry rather than keeping it under a doc/build it no
 * longer describes). Only ever called for the ACTIVE document (ThemeProvider's
 * own root paint, for its own resolved side and — for a 'system'-appearance,
 * dual-base palette document — the off-screen-derived other side too) — never
 * for a library preset that is not currently applied. */
export function persistResolvedSnapshot(
  storage: ThemeStorage | null,
  doc: CustomThemeDocument,
  appearance: EffectiveAppearance,
  vars: Record<string, string>
): void {
  try {
    const existing = readRawSnapshot(storage, doc)
    const snapshot: ResolvedThemeSnapshot = {
      docHash: hashCustomThemeDocument(doc),
      fingerprint: BUILTIN_CSS_FINGERPRINT,
      sides: { ...existing?.sides, [appearance]: vars },
    }
    const raw = JSON.stringify(snapshot)
    if (new TextEncoder().encode(raw).length > RESOLVED_SNAPSHOT_MAX_BYTES) return
    storage?.setItem(RESOLVED_SNAPSHOT_KEY, raw)
  } catch {
    /* best-effort: the next real paint still derives correctly */
  }
}

// A number in [min, max], written as plain (non-negative, non-exponential)
// decimal digits only — never CSS syntax (no commas, functions, keywords, or
// signs that could carry a CSS-injection-shaped payload through unexamined).
function isBoundedDecimal(raw: string, min: number, max: number): boolean {
  if (!/^\d+(?:\.\d+)?$/.test(raw)) return false
  const n = Number(raw)
  return Number.isFinite(n) && n >= min && n <= max
}
// A "compiled" RGB channel string, exactly what compileCustomTheme/applyCustomTheme
// ever write: "r g b" or "r g b / a", each channel 0-255 (fractional allowed —
// OKLCH-derived base tokens keep sub-integer precision).
function isCompiledChannelValue(value: string): boolean {
  const [rgb, alpha, extra] = value.split(' / ')
  if (extra !== undefined || rgb === undefined) return false
  const channels = rgb.split(' ')
  if (channels.length !== 3 || !channels.every((c) => isBoundedDecimal(c, 0, 255))) return false
  return alpha === undefined || isBoundedDecimal(alpha, 0, 1)
}
// --custom-alpha-* is a bare 0..1 number (see applyCustomTheme's compiled output).
function isCompiledAlphaValue(value: string): boolean {
  return isBoundedDecimal(value, 0, 1)
}

/** Reads a resolved snapshot only when it exactly matches this document, this
 * build (see the fingerprint doc above), and has an entry for this resolved
 * appearance; a different document (edited elsewhere), a stale build, a
 * resolved side that was never snapshotted, corrupt JSON, or no snapshot at
 * all all return null — callers fall back to the explicit-overrides-only
 * pre-paint path. Property names are filtered to the registry-owned set
 * (custom.ts's only write surface) before use, even though this key is
 * same-origin-only: defense in depth, matching applyCustomTheme's own "only
 * individually validated, registry-owned properties" contract.
 *
 * Unlike names (silently dropped if unrecognized), a VALUE that doesn't match
 * the exact compiled grammar for its token kind rejects the ENTIRE (this
 * side's) snapshot (never partially applies it) — this is untrusted,
 * pre-paint, directly-`style.setProperty`-bound data written by a past
 * version of this same code, but localStorage can be edited by anything with
 * same-origin script access, so it gets the same "never trust, always
 * reparse" treatment as everything else on this boundary. */
export function readResolvedSnapshot(
  storage: ThemeStorage | null,
  doc: CustomThemeDocument,
  appearance: EffectiveAppearance
): Record<string, string> | null {
  try {
    const snapshot = readRawSnapshot(storage, doc)
    const sideVars = snapshot?.sides[appearance]
    if (!sideVars || typeof sideVars !== 'object') return null
    const vars: Record<string, string> = {}
    for (const [name, value] of Object.entries(sideVars)) {
      if (!customProperties.has(name)) continue
      if (typeof value !== 'string') return null
      const valid = name.startsWith('--custom-alpha-') ? isCompiledAlphaValue(value) : isCompiledChannelValue(value)
      if (!valid) return null
      vars[name] = value
    }
    return vars
  } catch {
    return null
  }
}

/** A v2 document covers both variants, so applying it never forces a particular
 * appearance — only its base theme id changes the selection. */
export function customSelection(doc: CustomThemeDocument, previous: StoredThemeSelection): StoredThemeSelection {
  return { themeId: doc.base, appearance: previous.appearance }
}

/** A preset's document always covers both variants; a circle preview/swatch
 * never forces a particular side, it just resolves the app's current one.
 * Shared by every preset swatch (ThemeQuickPicker, the Settings theme grid,
 * the "My themes" library rows) so they agree on which side a unified base
 * paints. */
export function presetAppearance(
  document: Pick<CustomThemeDocument, 'base'>,
  currentAppearance: EffectiveAppearance
): EffectiveAppearance {
  return findWebTheme(document.base).kind === 'unified' ? 'constant' : currentAppearance
}

export function readPresetId(storage: ThemeStorage | null): string | null {
  try {
    return storage?.getItem(PRESET_ID_KEY) ?? null
  } catch {
    return null
  }
}

export function persistPresetId(storage: ThemeStorage | null, presetId: string | null) {
  try {
    if (presetId) storage?.setItem(PRESET_ID_KEY, presetId)
    else storage?.removeItem(PRESET_ID_KEY)
  } catch {
    /* device-local in memory */
  }
}

export function readPresetOwnerId(storage: ThemeStorage | null): string | null {
  try {
    return storage?.getItem(PRESET_OWNER_ID_KEY) ?? null
  } catch {
    return null
  }
}

export function persistPresetOwnerId(storage: ThemeStorage | null, presetOwnerId: string | null) {
  try {
    if (presetOwnerId) storage?.setItem(PRESET_OWNER_ID_KEY, presetOwnerId)
    else storage?.removeItem(PRESET_OWNER_ID_KEY)
  } catch {
    /* device-local in memory */
  }
}

export function loadCustomTheme(storage: ThemeStorage | null): {
  selection: StoredThemeSelection
  custom: CustomThemeDocument | null
  presetId: string | null
  presetOwnerId: string | null
  error: string | null
} {
  let selection = readThemeSelection(storage)
  let raw: string | null = null
  try {
    raw = storage?.getItem(CUSTOM_THEME_KEY) ?? null
  } catch {
    /* unavailable */
  }
  if (raw === null) return { selection, custom: null, presetId: null, presetOwnerId: null, error: null }
  const result = validateCustomTheme(raw, BUILT_IN_THEMES)
  if (result.ok)
    return {
      selection: customSelection(result.document, selection),
      custom: result.document,
      presetId: readPresetId(storage),
      presetOwnerId: readPresetOwnerId(storage),
      error: result.warnings.join(' ') || null,
    }
  // A broken but readable document may still name a valid recovery base.
  // Do not parse oversized input a second time, and never trust its colors.
  if (new TextEncoder().encode(raw).length <= CUSTOM_THEME_MAX_BYTES) {
    try {
      const doc = JSON.parse(raw)
      const base = BUILT_IN_THEMES.find((theme) => theme.id === doc?.base)
      if (base) selection = { themeId: base.id, appearance: selection.appearance }
    } catch {
      /* retain the last safe built-in selection */
    }
  }
  clearCustomTheme(storage)
  persistThemeSelection(storage, selection)
  return {
    selection,
    custom: null,
    presetId: null,
    presetOwnerId: null,
    error: `Custom theme removed: ${result.error}`,
  }
}

export function persistCustomTheme(storage: ThemeStorage | null, doc: CustomThemeDocument): boolean {
  const raw = JSON.stringify(doc)
  const result = validateCustomTheme(raw, BUILT_IN_THEMES)
  if (!result.ok) throw new Error(result.error)
  try {
    if (!storage) return false
    storage.setItem(CUSTOM_THEME_KEY, JSON.stringify(result.document))
    return true
  } catch {
    return false
  }
}

const customProperties = new Set(
  ACTIVE_THEME_TOKENS.flatMap((token) => [token, `--custom-rgb-${token.slice(2)}`, `--custom-alpha-${token.slice(2)}`])
)
const propertyNames = (element: HTMLElement) =>
  Array.from({ length: element.style.length }, (_, i) => element.style.item(i))

export function removeCustomProperties(element: HTMLElement) {
  for (const name of propertyNames(element)) if (customProperties.has(name)) element.style.removeProperty(name)
  if (element.hasAttribute('data-theme-scope')) {
    // Only compiler helpers can exist inline. Mask actual ancestor overrides,
    // rather than writing hundreds of unnecessary declarations on each edit.
    for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
      for (const name of propertyNames(ancestor)) {
        if (name.startsWith('--custom-') && customProperties.has(name)) element.style.setProperty(name, 'initial')
      }
    }
  }
}

/** The ONLY custom-color DOM write path. Both preview and root use this function.
 * Names and values are revalidated (the application boundary, not just file-open
 * time); no CSS text or HTML construction exists. `appearance` picks the resolved
 * variant (light/dark/'system' already resolved by the caller, or 'constant'). */
export function applyCustomTheme(
  element: HTMLElement,
  doc: CustomThemeDocument,
  appearance: EffectiveAppearance,
  options?: { deriveFromComputedStyle?: boolean }
): Record<string, string> {
  const result = validateCustomTheme(JSON.stringify(doc), BUILT_IN_THEMES)
  if (!result.ok) throw new Error(result.error)
  removeCustomProperties(element)
  applyResolvedTheme(element, findWebTheme(doc.base), appearance)
  // A palette derives most tokens from the base theme's OWN resolved values
  // (getComputedStyle), so the plain base must paint first. Callers that
  // cannot trust the cascade yet (the synchronous pre-paint flash script,
  // before CSS is guaranteed loaded) pass deriveFromComputedStyle: false —
  // explicit `variants` overrides still apply either way.
  const deriveFromComputedStyle = options?.deriveFromComputedStyle ?? true
  const baseTokens = result.document.palette && deriveFromComputedStyle ? readPreviewTokens(element) : undefined
  const variables = compileCustomTheme(result.document, appearance, baseTokens)
  try {
    for (const [token, channels] of Object.entries(variables)) element.style.setProperty(token, channels)
  } catch (error) {
    removeCustomProperties(element)
    throw error
  }
  // Returned so the root-paint caller (ThemeProvider) can persist exactly
  // these resolved vars as a pre-paint snapshot for the next cold load.
  return variables
}

/** Contrast uses computed base values (fractional channels, aliases, sentinels
 * and intrinsic alpha intact). Input colors never change opacity metadata. */
export function readPreviewTokens(element: HTMLElement): Record<string, string> {
  const style = element.ownerDocument.defaultView!.getComputedStyle(element)
  return Object.fromEntries(
    ACTIVE_THEME_TOKENS.flatMap((token) => {
      const opacity = `--opacity-${token.replace(/^--(?:color-)?/, '')}`
      return [
        [token, style.getPropertyValue(token).trim()],
        [opacity, style.getPropertyValue(opacity).trim() || '1'],
      ]
    })
  )
}

export function exportCustomTheme(doc: CustomThemeDocument): string {
  const result = validateCustomTheme(JSON.stringify(doc), BUILT_IN_THEMES)
  if (!result.ok) throw new Error(result.error)
  // Compact serialization keeps even a near-limit imported file re-importable.
  return JSON.stringify(result.document)
}

export async function importCustomTheme(file: Pick<File, 'size' | 'text'>) {
  if (file.size > CUSTOM_THEME_MAX_BYTES)
    return { ok: false as const, error: `Theme document exceeds ${CUSTOM_THEME_MAX_BYTES / 1024} KiB.` }
  return validateCustomTheme(await file.text(), BUILT_IN_THEMES)
}
