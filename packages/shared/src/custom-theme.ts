import {
  ACTIVE_THEME_TOKENS,
  THEME_TOKEN_NAMES,
  customColorChannels,
  validateThemeTokenOverrides,
  type EffectiveAppearance,
  type ThemeDescriptor,
} from './theme-schema'
import { deriveThemeOverrides, validateThemePalette, type ThemePalette } from './theme-derivation'

// Re-exported for backward compatibility: this was the original home of the
// grammar; theme-derivation.ts also needs it, so the implementation moved to
// theme-schema.ts (the module both depend on) to avoid a circular import.
export { customColorChannels }
export type { ThemePalette }

/**
 * A v2 pair document can carry a FULL light+dark override of every active
 * token at once (a v1 document only ever needed one side of the grid). See
 * the "worst-case pair" test in custom-theme.test.ts for the measurement
 * this cap is sized against (roughly 30 KiB for a full dual grid with
 * #rrggbbaa values and a 40-character name); 32 KiB leaves headroom for
 * registry growth without being unboundedly generous.
 */
export const CUSTOM_THEME_MAX_BYTES = 32 * 1024

export interface CustomThemeVariantsDual {
  light: Record<string, string>
  dark: Record<string, string>
}
export interface CustomThemeVariantsUnified {
  constant: Record<string, string>
}
export type CustomThemeVariants = CustomThemeVariantsDual | CustomThemeVariantsUnified

/** The format marker every exported or stored custom-theme document carries. */
export const CUSTOM_THEME_FORMAT = 'ficus-custom-theme'

/** Markers an import accepts. Files exported before the Ficus rename carry the old marker; validation rewrites it
 * to CUSTOM_THEME_FORMAT. Remove the old marker in the Wave 3 sweep. */
const ACCEPTED_CUSTOM_THEME_FORMATS: readonly string[] = [CUSTOM_THEME_FORMAT, 'tau-custom-theme']

/** Built-in bases renamed with the Ficus rename, applied only to a document carrying the pre-rename marker (the same
 * mapping Core migration 0192 applied to stored documents): the purple base keeps its look as Iris, and Forest is
 * now Ficus. Remove with the old marker in the Wave 3 sweep. */
const PRE_RENAME_BASES: ReadonlyMap<unknown, string> = new Map([
  ['tau', 'iris'],
  ['forest', 'ficus'],
])

/** v2: a preset covers both light and dark (or a single constant variant for
 * unified bases) so it follows the Light/Dark/System toggle. v1 documents
 * (one concrete `appearance` + `overrides`) still load; validateCustomTheme
 * normalizes them into a v2 document with the other dual side empty.
 *
 * `palette` (optional) derives most tokens from a few seed colors — see
 * theme-derivation.ts. `variants` are ADVANCED explicit per-token overrides,
 * always applied AFTER derivation (may be empty; a preset created from a
 * built-in with no palette is pure explicit overrides, exactly like before). */
export interface CustomThemeDocument {
  format: typeof CUSTOM_THEME_FORMAT
  version: 2
  name: string
  base: string
  palette?: ThemePalette
  variants: CustomThemeVariants
}

/** The on-disk/wire shape for a v1 document, accepted for backward compatibility only. */
interface CustomThemeDocumentV1 {
  format: string
  version: 1
  name: string
  base: string
  appearance: EffectiveAppearance
  overrides: Record<string, string>
}

export type CustomThemeValidation =
  | { ok: true; document: CustomThemeDocument; warnings: string[] }
  | { ok: false; error: string }

type VariantResult = { ok: true; overrides: Record<string, string>; warnings: string[] } | { ok: false; error: string }

/** Validates one variant's override map: closed grammar, active-token warnings,
 * status-set coherence. Shared by v1 normalization and each v2 variant. */
function validateVariantOverrides(raw: unknown): VariantResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return { ok: false, error: 'Overrides must be a token-to-color object.' }
  const entries = Object.entries(raw as Record<string, unknown>)
  if (entries.length > THEME_TOKEN_NAMES.length) return { ok: false, error: 'Too many token overrides.' }
  const overrides: Record<string, string> = {}
  const warnings: string[] = []
  for (const [token, color] of entries) {
    // Validate even unknown entries: malicious values never get a pass.
    if (customColorChannels(color) === null)
      return { ok: false, error: `Invalid color for ${token}. Use #rgb, #rrggbb, #rrggbbaa, rgb() or rgba().` }
    if (!ACTIVE_THEME_TOKENS.includes(token)) {
      warnings.push(`Ignored unknown or inactive token: ${token}`)
      continue
    }
    overrides[token] = (color as string).trim()
  }
  const coherence = validateThemeTokenOverrides(Object.keys(overrides))
  if (!coherence.ok)
    return {
      ok: false,
      error: 'Overriding status colors requires the complete status role set (including every badge slot).',
    }
  return { ok: true, overrides, warnings }
}

/** The string boundary is intentional: byte cap BEFORE JSON.parse, on every path. */
export function validateCustomTheme(raw: string, builtins: readonly ThemeDescriptor[]): CustomThemeValidation {
  const fail = (error: string): CustomThemeValidation => ({ ok: false, error })
  if (new TextEncoder().encode(raw).length > CUSTOM_THEME_MAX_BYTES)
    return fail(`Theme document exceeds ${CUSTOM_THEME_MAX_BYTES / 1024} KiB.`)
  let input: unknown
  try {
    input = JSON.parse(raw)
  } catch {
    return fail('Theme document must be valid JSON.')
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('Theme document must be an object.')
  const doc = input as Record<string, unknown>
  if (!ACCEPTED_CUSTOM_THEME_FORMATS.includes(doc.format as string))
    return fail(`Expected format ${CUSTOM_THEME_FORMAT}.`)
  if (doc.version !== 1 && doc.version !== 2)
    return fail('Unsupported theme version. This app supports version 1 or 2.')
  if (typeof doc.name !== 'string' || !doc.name.trim() || [...doc.name].length > 40)
    return fail('Theme name must be 1–40 characters.')
  const baseId = doc.format === CUSTOM_THEME_FORMAT ? doc.base : (PRE_RENAME_BASES.get(doc.base) ?? doc.base)
  const base = builtins.find((theme) => theme.id === baseId)
  if (!base) return fail('Choose a known built-in base theme.')

  let palette: ThemePalette | undefined
  if (doc.version === 2 && doc.palette !== undefined && doc.palette !== null) {
    const result = validateThemePalette(doc.palette)
    if (!result.ok) return fail(result.error)
    palette = result.palette
  }

  const warnings: string[] = []
  let variants: CustomThemeVariants

  if (doc.version === 1) {
    const v1 = doc as unknown as CustomThemeDocumentV1
    if (base.kind === 'unified' ? v1.appearance !== 'constant' : v1.appearance !== 'light' && v1.appearance !== 'dark')
      return fail('Appearance must match the base: light/dark for dual themes, constant for unified themes.')
    const result = validateVariantOverrides(v1.overrides)
    if (!result.ok) return fail(result.error)
    warnings.push(...result.warnings)
    variants =
      base.kind === 'unified'
        ? { constant: result.overrides }
        : v1.appearance === 'light'
          ? { light: result.overrides, dark: {} }
          : { light: {}, dark: result.overrides }
  } else {
    if (!doc.variants || typeof doc.variants !== 'object' || Array.isArray(doc.variants))
      return fail('Theme variants must be an object.')
    const rawVariants = doc.variants as Record<string, unknown>
    if (base.kind === 'unified') {
      if (!('constant' in rawVariants)) return fail('Unified themes require a constant variant.')
      const result = validateVariantOverrides(rawVariants.constant)
      if (!result.ok) return fail(result.error)
      warnings.push(...result.warnings)
      variants = { constant: result.overrides }
    } else {
      if (!('light' in rawVariants) || !('dark' in rawVariants))
        return fail('Dual themes require light and dark variants.')
      const light = validateVariantOverrides(rawVariants.light)
      if (!light.ok) return fail(`light: ${light.error}`)
      const dark = validateVariantOverrides(rawVariants.dark)
      if (!dark.ok) return fail(`dark: ${dark.error}`)
      warnings.push(...light.warnings.map((w) => `light: ${w}`), ...dark.warnings.map((w) => `dark: ${w}`))
      variants = { light: light.overrides, dark: dark.overrides }
    }
  }

  return {
    ok: true,
    document: {
      format: CUSTOM_THEME_FORMAT,
      version: 2,
      name: doc.name,
      base: base.id,
      ...(palette ? { palette } : {}),
      variants,
    },
    warnings,
  }
}

/** Reads one variant's RAW (uncompiled) overrides — the editor's per-tab draft
 * source. 'constant' documents ignore the requested light/dark side. */
export function readCustomThemeVariant(
  variants: CustomThemeVariants,
  variant: EffectiveAppearance
): Record<string, string> {
  if ('constant' in variants) return variants.constant
  return variants[variant === 'dark' ? 'dark' : 'light']
}

/** Replaces one variant's raw overrides, preserving the other side for a dual
 * document. 'constant' documents ignore the requested light/dark side, just
 * like `readCustomThemeVariant`. Shared by the editor UI and the assistant's
 * pure `applyThemeOperations` so both stay in lockstep. */
export function withCustomThemeVariant(
  variants: CustomThemeVariants,
  variant: EffectiveAppearance,
  overrides: Record<string, string>
): CustomThemeVariants {
  if ('constant' in variants) return { constant: overrides }
  return { ...variants, [variant === 'dark' ? 'dark' : 'light']: overrides }
}

/** Reshapes `variants` across a base-kind change: unified -> dual seeds both
 * sides with the same starting overrides; dual -> unified merges both sides
 * (dark taking precedence on conflicting tokens is an arbitrary but stable
 * choice — the caller reviews the result, live, immediately). Shared by the
 * editor UI and the assistant's `set-base` operation. */
export function reshapeCustomThemeForBase(
  doc: CustomThemeDocument,
  nextBase: Pick<ThemeDescriptor, 'id' | 'kind'>
): CustomThemeDocument {
  let variants: CustomThemeVariants
  if (nextBase.kind === 'unified') {
    const merged = 'constant' in doc.variants ? doc.variants.constant : { ...doc.variants.light, ...doc.variants.dark }
    variants = { constant: merged }
  } else if ('constant' in doc.variants) {
    variants = { light: doc.variants.constant, dark: doc.variants.constant }
  } else {
    variants = doc.variants
  }
  return { ...doc, base: nextBase.id, variants }
}

/** Revalidate at the application boundary, not merely at file-open time: callers
 * apply an already-normalized `CustomThemeDocument` (typically the result of a
 * fresh `validateCustomTheme` call), then compile the resolved variant.
 *
 * `baseTokens` (optional) is the base theme's own resolved token values for
 * this appearance (e.g. read via getComputedStyle once the built-in CSS has
 * painted) — required to compute `doc.palette`'s derived overrides. Without
 * it (e.g. the synchronous pre-paint script, which cannot trust the cascade
 * yet), only explicit `variants` overrides apply; a palette-only preset has
 * no effect until the next repaint supplies base tokens. Explicit overrides
 * always win over derived ones for the same token. */
export function compileCustomTheme(
  doc: CustomThemeDocument,
  appearance: EffectiveAppearance,
  baseTokens?: Record<string, string>
): Record<string, string> {
  const explicit = readCustomThemeVariant(doc.variants, appearance)
  const derived =
    doc.palette && baseTokens ? deriveThemeOverrides({ baseTokens, palette: doc.palette, appearance }) : {}
  const overrides = { ...derived, ...explicit }
  return Object.fromEntries(
    Object.entries(overrides).flatMap(([token, color]) => {
      const channels = customColorChannels(color)!
      const [rgb, alpha = '1'] = channels.split(' / ')
      return [
        [token, channels],
        [`--custom-rgb-${token.slice(2)}`, rgb!],
        [`--custom-alpha-${token.slice(2)}`, alpha],
      ]
    })
  )
}
