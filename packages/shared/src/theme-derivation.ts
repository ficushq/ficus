/**
 * Derives a full custom-theme override set from a handful of seed colors
 * ("primary", optionally "secondary"/"tertiary"/"neutral") plus a base
 * theme's own resolved token values. Pure, dependency-free (no DOM/node);
 * callers (apps/web) supply the base theme's resolved tokens (read via
 * getComputedStyle once the built-in CSS has painted) and merge the result
 * UNDER any explicit per-token overrides before compiling.
 *
 * Mapping (see docs/wiki/theme/custom-themes.md for the human-readable table):
 * - chrome/neutral tokens (surfaces, text, borders, inputs, shadows, overlays,
 *   scrims, terminal/log backgrounds): hue/chroma replaced by the neutral
 *   tint; lightness and alpha are preserved from the base token, so the base
 *   theme's own contrast structure carries over.
 * - the primary/accent family: derived from the primary seed, with a
 *   lightness OFFSET and a chroma RATIO both modeled on how that token
 *   differs from the base theme's own --color-primary (so e.g. "hover" stays
 *   proportionally different from the seed the same way it differs in the base theme).
 * - --on-accent-fg is chosen (black or white) by contrast against the
 *   derived primary, not hue-derived.
 * - interaction surfaces (hover, pill, inset, secondary surface, selection
 *   background and border): with a secondary seed, a light tint of its hue at
 *   the base lightness, as Harbor and Ember tint theirs; without one, the
 *   neutral/primary mapping above.
 * - brand gradient/tile/ink and voice-material glows: the tertiary hue; base
 *   lightness/chroma preserved.
 * - swatch secondary/tertiary: the palette's own secondary/tertiary, or their
 *   colour-theory companions when unset (see `suggestPaletteSeeds`).
 * - categorical families (agent-type, badge-decoration, graph chart
 *   categories/links, a curated syntax-accent subset, utility-decoration):
 *   hue picked from primary/secondary/tertiary by slot index; base
 *   lightness/chroma preserved.
 * - status roles and ANSI-named terminal/log slots keep their base values —
 *   semantic meaning (danger=red, success=green, ...) is never reassigned —
 *   UNLESS `palette.status === 'harmonized'`, which bounded-shifts each
 *   role's hue toward the nearest seed color (capped, and clamped so a role
 *   can never cross into a neighboring role's hue band) and blends chroma
 *   toward the seed's, keeping base lightness per step.
 * - a contrast pass afterward nudges a small set of critical derived pairs
 *   (text/surface, primary/page, and status fg/surface when harmonized)
 *   toward the WCAG target (4.5, or 7 for `contrast: 'high'`) by moving
 *   lightness only, never hue/chroma.
 *
 * Unmapped/unrecognized tokens (including every status/ANSI slot in 'static'
 * mode) are simply absent from the returned overrides, so they keep
 * inheriting from the base theme's CSS cascade exactly as today.
 */
import { oklchToSrgb, srgbToOklch, type Oklch } from './color-oklch'
import {
  STATUS_ROLES,
  STATUS_TOKENS,
  customColorChannels,
  themeTokenFamily,
  type EffectiveAppearance,
} from './theme-schema'

export interface ThemePalette {
  primary: string
  secondary?: string
  tertiary?: string
  /** Tint for chrome/neutral surfaces; defaults to the primary hue at very low chroma. */
  neutral?: string
  contrast?: 'standard' | 'high'
  /** 'static' (default) keeps status-role colors exactly as the base theme defines them. */
  status?: 'static' | 'harmonized'
}

function isThemePaletteShape(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** Structural + color-grammar validation only (no derivation math here). */
export function validateThemePalette(raw: unknown): { ok: true; palette: ThemePalette } | { ok: false; error: string } {
  if (!isThemePaletteShape(raw)) return { ok: false, error: 'Palette must be an object.' }
  if (typeof raw.primary !== 'string' || customColorChannels(raw.primary) === null)
    return { ok: false, error: 'Palette requires a valid primary color.' }
  const palette: ThemePalette = { primary: raw.primary }
  for (const key of ['secondary', 'tertiary', 'neutral'] as const) {
    if (raw[key] === undefined) continue
    if (typeof raw[key] !== 'string' || customColorChannels(raw[key]) === null)
      return { ok: false, error: `Invalid palette color for ${key}.` }
    palette[key] = raw[key]
  }
  if (raw.contrast !== undefined) {
    if (raw.contrast !== 'standard' && raw.contrast !== 'high')
      return { ok: false, error: "Palette contrast must be 'standard' or 'high'." }
    palette.contrast = raw.contrast
  }
  if (raw.status !== undefined) {
    if (raw.status !== 'static' && raw.status !== 'harmonized')
      return { ok: false, error: "Palette status mode must be 'static' or 'harmonized'." }
    palette.status = raw.status
  }
  return { ok: true, palette }
}

// --- color helpers -----------------------------------------------------

/** Parses the CLOSED-GRAMMAR OUTPUT / CSS custom-property form ("r g b" or "r g b / a"). */
function parseCompiledChannels(value: string): { rgb: [number, number, number]; alpha: number } | null {
  const [rgb, alpha] = value.split(' / ')
  const parts = rgb!.trim().split(/\s+/).map(Number)
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null
  return { rgb: [parts[0]!, parts[1]!, parts[2]!], alpha: alpha === undefined ? 1 : Number(alpha) }
}
/** Accepts either raw user-input color grammar (hex / rgb() / rgba(), e.g. a palette
 * seed) OR the already-compiled "r g b" / "r g b / a" form (e.g. a base theme's
 * resolved token, or this module's own `serialize()` output re-read from `overrides`). */
function parseChannels(value: string): { rgb: [number, number, number]; alpha: number } | null {
  const viaImportGrammar = customColorChannels(value)
  return parseCompiledChannels(viaImportGrammar ?? value)
}
function toOklch(value: string): { oklch: Oklch; alpha: number } | null {
  const parsed = parseChannels(value)
  if (!parsed) return null
  return { oklch: srgbToOklch(parsed.rgb), alpha: parsed.alpha }
}
function serialize(oklch: Oklch, alpha: number): string {
  const [r, g, b] = oklchToSrgb(oklch)
  const hex = (n: number) => n.toString(16).padStart(2, '0')
  return alpha >= 1 ? `#${hex(r)}${hex(g)}${hex(b)}` : `#${hex(r)}${hex(g)}${hex(b)}${hex(Math.round(alpha * 255))}`
}
/** `serialize`, lowering chroma first until the colour fits sRGB, so clamping never shifts its hue or lightness. */
function serializeInGamut(oklch: Oklch, alpha: number): string {
  let c = oklch.c
  for (let step = 0; step < 40; step++) {
    const [r, g, b] = oklchToSrgb({ ...oklch, c })
    const back = srgbToOklch([r, g, b])
    const hueOff = c < 1e-3 ? 0 : Math.abs(circularDelta(oklch.h, back.h))
    if (hueOff < 1.5 && Math.abs(back.l - oklch.l) < 0.01) break
    c *= 0.9
  }
  return serialize({ ...oklch, c }, alpha)
}
function circularDelta(from: number, to: number): number {
  let delta = ((to - from + 180) % 360) - 180
  if (delta < -180) delta += 360
  return delta
}
function normalizeHue(h: number): number {
  return ((h % 360) + 360) % 360
}
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * Colour-theory companions for a primary: an analogous secondary (+30 degrees, the calm tint used for interaction
 * surfaces) and a split-complementary tertiary (+150 degrees, contrasting highlights), at the primary's lightness and
 * chroma. The editor fills unset seeds with these, and derivation falls back to them.
 */
export function suggestPaletteSeeds(primary: string): { secondary: string; tertiary: string } | null {
  const seed = toOklch(primary)
  if (!seed) return null
  const { l, c, h } = seed.oklch
  return {
    secondary: serializeInGamut({ l, c, h: normalizeHue(h + 30) }, 1),
    tertiary: serializeInGamut({ l, c, h: normalizeHue(h + 150) }, 1),
  }
}

// --- WCAG contrast (pure; mirrors apps/web/src/theme/contrast.ts's formula) ---

function relativeLuminance([r, g, b]: readonly [number, number, number]): number {
  return [r, g, b]
    .map((c) => c / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
    .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i]!, 0)
}
function wcagContrast(fg: readonly [number, number, number], bg: readonly [number, number, number]): number {
  const a = relativeLuminance(fg)
  const b = relativeLuminance(bg)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

// --- token classification -----------------------------------------------

const PRIMARY_FAMILY = [
  '--color-primary',
  '--color-primary-hover',
  '--color-primary-active',
  '--color-primary-light',
  '--color-selection-bg',
  '--color-selection-border',
  '--color-focus',
]
const BRAND_VOICE_FAMILIES = new Set(['brand', 'voice-material'])
const CATEGORICAL_FAMILIES = new Set(['agent-type', 'badge-decoration', 'utility-decoration'])
const SYNTAX_ACCENTS = [
  '--syntax-keyword',
  '--syntax-string',
  '--syntax-number',
  '--syntax-function',
  '--syntax-variable',
  '--syntax-property',
  '--syntax-url',
]
/** Surfaces a secondary seed tints, as Harbor and Ember tint theirs; the secondary surface a little less. */
const INTERACTION_SURFACES = ['--color-bg-surface-hover', '--color-bg-pill', '--color-bg-inset', '--color-selection-bg']
const SECONDARY_SURFACE = '--color-bg-surface-secondary'
const SELECTION_BORDER = '--color-selection-border'
/** Terminal/log-terminal tokens whose slot name names an ANSI color: kept unchanged (semantic). */
const ANSI_NAMED = /-(black|red|green|yellow|blue|magenta|cyan|white)$/

type Bucket = 'neutral' | 'primary' | 'ink' | 'brand' | 'swatch' | 'categorical' | 'status' | 'unchanged'

function classify(token: string): Bucket {
  if (token === '--on-accent-fg') return 'ink'
  if (PRIMARY_FAMILY.includes(token)) return 'primary'
  const family = themeTokenFamily(token)
  if (!family) return 'unchanged'
  if (family.family === 'status') return 'status'
  if (family.family === 'swatch') return 'swatch'
  if (family.family === 'ansi') return 'unchanged'
  if (family.family === 'terminal' || family.family === 'log-terminal')
    return ANSI_NAMED.test(token) ? 'unchanged' : 'neutral'
  if (BRAND_VOICE_FAMILIES.has(family.family)) return 'brand'
  if (CATEGORICAL_FAMILIES.has(family.family) || SYNTAX_ACCENTS.includes(token)) return 'categorical'
  if (/graph-chart-category-\d+/.test(token) || /graph-link-\d+/.test(token)) return 'categorical'
  return 'neutral'
}

/** Stable per-family slot index (0-based) used to spread categorical hues. */
function slotIndex(token: string): number {
  const match = /-(\d+)(?:-|$)/.exec(token)
  return match ? Number(match[1]) - 1 : 0
}

// --- derivation ------------------------------------------------------------

export interface DeriveOptions {
  /** All active tokens' base RGB channel strings ("r g b" or "r g b / a"), e.g. from readPreviewTokens. */
  baseTokens: Record<string, string>
  palette: ThemePalette
  appearance: EffectiveAppearance
}

const HARMONIZE_MAX_SHIFT_DEG = 22
const HARMONIZE_BUFFER_DEG = 2
const HARMONIZE_CHROMA_BLEND = 0.3

/** Derives the full override set (before any explicit per-token overrides are
 * layered on top). `appearance` is not read directly — it is already implicit
 * in `baseTokens` (the caller resolves the base theme for that side first). */
export function deriveThemeOverrides({ baseTokens, palette }: DeriveOptions): Record<string, string> {
  const primary = toOklch(palette.primary)
  if (!primary) return {}
  const secondary = palette.secondary ? toOklch(palette.secondary) : null
  const tertiary = palette.tertiary ? toOklch(palette.tertiary) : null
  const neutralSeed = palette.neutral ? toOklch(palette.neutral) : null
  const neutral: Oklch = neutralSeed ? neutralSeed.oklch : { l: primary.oklch.l, c: 0.01, h: primary.oklch.h }
  const companions = suggestPaletteSeeds(palette.primary)!
  const secondaryOklch: Oklch = (secondary ?? toOklch(companions.secondary)!).oklch
  const tertiaryOklch: Oklch = (tertiary ?? toOklch(companions.tertiary)!).oklch
  // A tint, not a colour: enough chroma to read as the secondary's hue on a surface, capped so text contrast holds.
  const tint = secondary ? clamp(secondary.oklch.c * 0.18, 0.006, 0.03) : 0
  const seeds = [primary.oklch, secondaryOklch, tertiaryOklch]
  const hueOptions = seeds.map((s) => s.h)

  const basePrimary = toOklch(baseTokens['--color-primary'] ?? '')
  const overrides: Record<string, string> = {}

  for (const [token, raw] of Object.entries(baseTokens)) {
    if (token.startsWith('--opacity-')) continue
    const base = toOklch(raw)
    if (!base) continue
    const bucket = classify(token)
    if (bucket === 'unchanged' || bucket === 'status' || bucket === 'ink') continue
    if (secondary && (INTERACTION_SURFACES.includes(token) || token === SECONDARY_SURFACE)) {
      const c = token === SECONDARY_SURFACE ? tint * 0.6 : tint
      overrides[token] = serializeInGamut({ l: base.oklch.l, c, h: secondaryOklch.h }, base.alpha)
    } else if (secondary && token === SELECTION_BORDER) {
      const c = clamp(secondary.oklch.c * 0.45, 0.02, 0.09)
      overrides[token] = serializeInGamut({ l: base.oklch.l, c, h: secondaryOklch.h }, base.alpha)
    } else if (bucket === 'neutral') {
      overrides[token] = serialize({ l: base.oklch.l, c: neutral.c, h: neutral.h }, base.alpha)
    } else if (bucket === 'primary') {
      if (!basePrimary) continue
      const offsetL = base.oklch.l - basePrimary.oklch.l
      const chromaRatio = basePrimary.oklch.c > 1e-4 ? base.oklch.c / basePrimary.oklch.c : 1
      overrides[token] = serialize(
        {
          l: clamp(primary.oklch.l + offsetL, 0, 1),
          c: Math.max(0, primary.oklch.c * chromaRatio),
          h: primary.oklch.h,
        },
        base.alpha
      )
    } else if (bucket === 'swatch') {
      // The swatch shows the palette's own secondary/tertiary (or their colour-theory companions).
      const seed = token === '--swatch-tertiary' ? tertiaryOklch : secondaryOklch
      overrides[token] = serialize(seed, base.alpha)
    } else if (bucket === 'brand') {
      overrides[token] = serialize({ l: base.oklch.l, c: base.oklch.c, h: tertiaryOklch.h }, base.alpha)
    } else if (bucket === 'categorical') {
      const hue = hueOptions[slotIndex(token) % hueOptions.length]!
      overrides[token] = serialize({ l: base.oklch.l, c: base.oklch.c, h: hue }, base.alpha)
    }
  }

  if (palette.status === 'harmonized') Object.assign(overrides, harmonizeStatus(baseTokens, seeds))

  const textMinRatio = palette.contrast === 'high' ? 7 : 4.5
  const uiMinRatio = palette.contrast === 'high' ? 4.5 : 3
  const statusContrastPairs: Array<[fg: string, bg: string]> =
    palette.status === 'harmonized'
      ? STATUS_ROLES.flatMap((role) => [
          [`--status-${role}-fg`, `--status-${role}-surface`],
          [`--status-${role}-badge-fg`, `--status-${role}-badge-surface`],
        ])
      : []
  contrastPass(overrides, baseTokens, textMinRatio, uiMinRatio, statusContrastPairs)

  // --on-accent-fg: black or white by contrast against the FINAL primary —
  // i.e. AFTER the contrast pass above may have nudged --color-primary's
  // lightness. Choosing this against the pre-pass primary (the previous
  // ordering) picks ink for a color that never actually ships: the CSS pairs
  // --on-accent-fg with the post-pass --color-primary, so a stale choice can
  // under-shoot the target against what's really on screen.
  chooseInk(overrides, textMinRatio)
  return overrides
}

/** Chooses --on-accent-fg (black or white) by contrast against the FINAL
 * --color-primary, and must run after `contrastPass`. For any fixed
 * background, the better of pure black/white text always clears ~4.58:1
 * (the minimum, at the luminance where both candidates tie) — comfortably
 * above the 'standard' 4.5:1 target by construction, no nudge ever needed.
 * The 'high' (7:1) target is NOT guaranteed by construction, so when neither
 * candidate reaches it, this nudges --color-primary's lightness (hue/chroma
 * held fixed, same bisection shape as `contrastPass`) toward whichever
 * extreme makes one of them pass, picking whichever candidate needs the
 * smaller move from the current lightness. If even the sRGB gamut extreme
 * can't reach the target (rare, high-chroma edge case), it falls back to
 * whichever of black/white is best against the un-nudged final primary. */
function chooseInk(overrides: Record<string, string>, textMinRatio: number) {
  const primaryValue = overrides['--color-primary']
  if (!primaryValue) return
  const primary = toOklch(primaryValue)
  if (!primary) return
  const black: [number, number, number] = [0, 0, 0]
  const white: [number, number, number] = [255, 255, 255]
  const primaryRgb = parseChannels(primaryValue)!.rgb
  const contrastBlack = wcagContrast(black, primaryRgb)
  const contrastWhite = wcagContrast(white, primaryRgb)
  if (Math.max(contrastBlack, contrastWhite) >= textMinRatio) {
    overrides['--on-accent-fg'] = contrastBlack >= contrastWhite ? '#000000' : '#ffffff'
    return
  }
  const nudgedL = (ink: readonly [number, number, number]): number | null => {
    // Black ink needs a lighter bg; white ink needs a darker bg.
    const extreme = ink[0] === 0 ? 1 : 0
    const passes = (l: number) =>
      wcagContrast(ink, oklchToSrgb({ l, c: primary.oklch.c, h: primary.oklch.h })) >= textMinRatio
    if (!passes(extreme)) return null
    let near = primary.oklch.l
    let far = extreme
    for (let i = 0; i < 30; i++) {
      const mid = (near + far) / 2
      if (passes(mid)) far = mid
      else near = mid
    }
    return far
  }
  const candidates = (
    [
      { l: nudgedL(black), ink: '#000000' as const },
      { l: nudgedL(white), ink: '#ffffff' as const },
    ] as Array<{ l: number | null; ink: '#000000' | '#ffffff' }>
  ).filter((c): c is { l: number; ink: '#000000' | '#ffffff' } => c.l !== null)
  if (candidates.length === 0) {
    overrides['--on-accent-fg'] = contrastBlack >= contrastWhite ? '#000000' : '#ffffff'
    return
  }
  const chosen = candidates.reduce((best, c) =>
    Math.abs(c.l - primary.oklch.l) < Math.abs(best.l - primary.oklch.l) ? c : best
  )
  overrides['--color-primary'] = serialize({ l: chosen.l, c: primary.oklch.c, h: primary.oklch.h }, primary.alpha)
  overrides['--on-accent-fg'] = chosen.ink
}

function harmonizeStatus(baseTokens: Record<string, string>, seeds: readonly Oklch[]): Record<string, string> {
  const overrides: Record<string, string> = {}
  const roleHue = (role: string) => toOklch(baseTokens[`--status-${role}-solid`] ?? '')?.oklch.h ?? 0
  const baseHues = STATUS_ROLES.map(roleHue)
  for (let i = 0; i < STATUS_ROLES.length; i++) {
    const role = STATUS_ROLES[i]!
    const hue = baseHues[i]!
    // Nearest available seed (by circular hue distance), for both hue and chroma blending.
    let nearest = seeds[0]!
    let bestAbs = Infinity
    for (const seed of seeds) {
      const abs = Math.abs(circularDelta(hue, seed.h))
      if (abs < bestAbs) {
        bestAbs = abs
        nearest = seed
      }
    }
    const rawDelta = circularDelta(hue, nearest.h)
    // Never cross into a neighboring role's band: clamp to half the gap to
    // either circular neighbor (by base hue), minus a small buffer.
    const gaps = baseHues.filter((_, j) => j !== i).map((other) => Math.abs(circularDelta(hue, other)))
    const maxSafeShift = Math.max(
      0,
      Math.min(HARMONIZE_MAX_SHIFT_DEG, ...gaps.map((g) => g / 2 - HARMONIZE_BUFFER_DEG))
    )
    const delta = clamp(rawDelta, -maxSafeShift, maxSafeShift)
    const newHue = normalizeHue(hue + delta)
    for (const slot of STATUS_TOKENS.filter((t) => t.startsWith(`--status-${role}-`))) {
      const base = toOklch(baseTokens[slot] ?? '')
      if (!base) continue
      const chroma = base.oklch.c + (nearest.c - base.oklch.c) * HARMONIZE_CHROMA_BLEND
      overrides[slot] = serialize({ l: base.oklch.l, c: Math.max(0, chroma), h: newHue }, base.alpha)
    }
  }
  return overrides
}

/** Nudges lightness only (never hue/chroma) on a small set of derived-token
 * pairs until they clear the WCAG target, or gives up after bounded steps —
 * this is best-effort, never throws, and never touches hue/chroma so the
 * palette's identity is preserved.
 *
 * `textMinRatio` (WCAG 1.4.3, 4.5:1 / 7:1 high) applies to body-text pairs.
 * `--color-primary` vs `--color-bg-page` is deliberately held to the lower
 * `uiMinRatio` (WCAG 1.4.11 non-text contrast, 3:1 / 4.5:1 high): it is a UI
 * accent (buttons, borders, icons), not body text, and text-level contrast
 * for readable content ON it is `--on-accent-fg`'s job, computed separately.
 * A text-level target here would force a bright, valid seed color to darken
 * far more than a user choosing it as their brand color would expect.
 *
 * `statusPairs` are the harmonized-mode-only status fg/surface and
 * badge-fg/badge-surface pairs (empty in 'static' mode, whose status tokens
 * are absent from `overrides` and untouched) — held to `textMinRatio` like
 * body text, since these fg tokens ARE rendered as text on their surface. */
function contrastPass(
  overrides: Record<string, string>,
  baseTokens: Record<string, string>,
  textMinRatio: number,
  uiMinRatio: number,
  statusPairs: Array<[fg: string, bg: string]> = []
) {
  const pairs: Array<[fg: string, bg: string, minRatio: number]> = [
    ['--color-text-primary', '--color-bg-surface', textMinRatio],
    ['--color-text-secondary', '--color-bg-surface', textMinRatio],
    ['--color-primary', '--color-bg-page', uiMinRatio],
    ...statusPairs.map(([fg, bg]): [string, string, number] => [fg, bg, textMinRatio]),
  ]
  for (const [fgToken, bgToken, minRatio] of pairs) {
    const fgValue = overrides[fgToken] ?? baseTokens[fgToken]
    const bgValue = overrides[bgToken] ?? baseTokens[bgToken]
    if (!fgValue || !bgValue) continue
    const fg = toOklch(fgValue)
    const bg = toOklch(bgValue)
    if (!fg || !bg) continue
    const bgRgb = parseChannels(bgValue)!.rgb
    const passes = (l: number) => wcagContrast(oklchToSrgb({ l, c: fg.oklch.c, h: fg.oklch.h }), bgRgb) >= minRatio
    if (passes(fg.oklch.l)) continue
    // Contrast against a fixed bg is monotonic in fg lightness moving toward
    // the extreme opposite the bg: push dark-on-light down to 0, light-on-dark
    // up to 1. Bisect for the closest-to-original L that still passes.
    const extreme = bg.oklch.l >= 0.5 ? 0 : 1
    if (!passes(extreme)) continue // even the extreme can't clear the target: leave hue/chroma-preserving base value
    let near = fg.oklch.l
    let far = extreme
    for (let i = 0; i < 30; i++) {
      const mid = (near + far) / 2
      if (passes(mid)) far = mid
      else near = mid
    }
    overrides[fgToken] = serialize({ l: far, c: fg.oklch.c, h: fg.oklch.h }, fg.alpha)
  }
}
