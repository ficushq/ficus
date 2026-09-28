// Generates the DUAL (light+dark) primary/secondary/tertiary/neutral-palette
// built-in theme CSS blocks written into apps/web/src/theme/builtins.css,
// between the GENERATED PALETTE BUILTINS markers. Regenerate with:
// bun apps/web/scripts/generate-palette-builtins.ts
//
// Unlike generate-bigbrain-builtins.ts (which starts from a bg/fg/activity
// triple and layers BigBrain's own explicit sRGB color-mix formulas on top),
// each entry here is a genuine ThemePalette (primary/secondary/tertiary/
// neutral seeds, the same shape a user's own custom theme uses), so no
// explicit-token layer is needed:
//
// 1. Parse Iris's own `:root`/`.dark` blocks in index.css into a token->value
//    map per appearance (the derivation BASE — built-ins still involve no
//    runtime color generation; this script bakes the CSS once). A built-in
//    with pinned surfaces (Ficus) swaps its page/surface colors into that
//    base first and moves the surface-relative chrome (borders, inputs, code,
//    glass, overlay) by the same lightness step, so the hierarchy holds.
// 2. Run the shared palette derivation (`deriveThemeOverrides`, the same pure
//    engine `packages/shared/src/theme-derivation.ts` uses for custom
//    themes) against that appearance's own base tokens, restricted to the
//    same `DERIVABLE_TOKENS` set generate-bigbrain-builtins.ts uses (only the
//    `chrome` token family plus `--swatch-secondary`/`-tertiary`/
//    `--on-accent-fg` vary between built-ins; every other family — status,
//    agent-type, badge-decoration, voice-material, utility-decoration/
//    -chrome, log-terminal, ansi, brand, most of syntax/terminal/graph — is
//    copied verbatim from Iris, matching Harbor/Ember/every BigBrain-ported
//    built-in).
// 3. Run the same strict-gate contrast repair pass
//    (`repairContrastPairs`, shared with generate-bigbrain-builtins.ts)
//    separately per appearance.
//
// Status mode: `utilityParity.test.ts`'s legacy-utility-colors fixture
// freezes every built-in's `--status-ROLE-{50..950}` ramp tokens
// byte-identical to Iris's own (they share the STATUS_TOKENS family with the
// semantic fg/surface/badge slots, and `deriveThemeOverrides`'s harmonized
// mode moves every token sharing a role's `--status-ROLE-` prefix, ramp steps
// included). So even where a source preset requests `status: 'harmonized'`,
// every entry below stays `'static'` — the same choice every existing
// built-in (including the BigBrain ports) already makes — to keep that gate
// green without weakening it.
import { resolve } from 'node:path'
import { deriveThemeOverrides, type ThemePalette } from '@ficus/shared/theme-derivation'
import { customColorChannels } from '@ficus/shared/theme-schema'
import { oklchToSrgb, srgbToOklch } from '@ficus/shared/color-oklch'
import type { ResolvedAppearance } from '@ficus/shared/theme-schema'
import { cssBlockDeclarations, DERIVABLE_TOKENS, repairContrastPairs } from './theme-builtin-shared'

export const GENERATED_START =
  '\n  /* BEGIN GENERATED PALETTE BUILTINS — apps/web/scripts/generate-palette-builtins.ts. Do not edit by hand. */\n'
export const GENERATED_END = '  /* END GENERATED PALETTE BUILTINS */\n'

export interface WebPaletteBuiltin {
  /** Theme id, matching registry.ts's BUILT_IN_THEMES entry. */
  id: string
  label: string
  /** Short intent blurb, echoed into the generated CSS comment. */
  intent: string
  palette: ThemePalette
  /** Seeds that differ in one appearance (Ficus's dark UI uses sage as its leaf). */
  appearancePalette?: Partial<Record<ResolvedAppearance, Partial<ThemePalette>>>
  /** Exact page and surface colors per appearance, pinned before and after derivation. */
  surfaces?: Record<ResolvedAppearance, { page: string; surface: string }>
  /** Exact token values (hex) pinned after derivation, before the interaction tints and contrast repair. Any token
   * may be pinned, including ones outside DERIVABLE_TOKENS. */
  pinned?: Partial<Record<ResolvedAppearance, Record<string, string>>>
  /** The colour the interaction surfaces tint from (hex), when it is not the appearance's own primary. */
  interactionTint?: Partial<Record<ResolvedAppearance, string>>
}

/** The Ficus brand palette (docs/wiki/theme/builtins.md): leaf primary, terracotta secondary and moss tertiary over
 * linen surfaces in light, and sage as the leaf over soil surfaces in dark. Chrome takes a warm soil tint. */
export const PALETTE_BUILTINS: readonly WebPaletteBuiltin[] = [
  {
    id: 'ficus',
    label: 'Ficus',
    intent: 'Brand palette: leaf primary, terracotta secondary, moss tertiary, linen and soil surfaces.',
    palette: {
      primary: '#3f6b4f',
      secondary: '#b0582f',
      tertiary: '#8a9a5b',
      neutral: '#2f2a24',
      contrast: 'standard',
      status: 'static',
    },
    appearancePalette: { dark: { primary: '#9fb57f' } },
    surfaces: {
      light: { page: '#f1e9db', surface: '#f5f0e6' },
      dark: { page: '#1c1a17', surface: '#2f2a24' },
    },
    // Sage is already the light accent of the dark UI, so its link/focus tone is sage itself (the derived offset from
    // a dark base primary would wash out to white), and text on a sage fill is soil.
    // The logo tile is the brand mark's own greens (brand/README.md), not a derivation of the base theme's purple.
    pinned: {
      light: { '--brand-gradient-from': '#8a9a5b', '--brand-gradient-to': '#3f6b4f', '--brand-tile': '#3f6b4f' },
      dark: {
        '--color-primary-light': '#9fb57f',
        '--color-focus': '#9fb57f',
        '--on-accent-fg': '#1c1a17',
        '--brand-gradient-from': '#87945a',
        '--brand-gradient-to': '#9fb57f',
        '--brand-tile': '#5e7f4e',
      },
    },
    // Dark hover/selection surfaces tint from the leaf: pale sage would only grey the soil.
    interactionTint: { dark: '#3f6b4f' },
  },
]

/** Chrome tokens that sit on or beside the surface; pinned surfaces move them by the surface's lightness step. */
const SURFACE_RELATIVE_TOKENS = [
  '--color-bg-surface-secondary',
  '--color-bg-pill',
  '--color-bg-surface-hover',
  '--color-bg-inset',
  '--color-border',
  '--color-border-hover',
  '--color-input-bg',
  '--color-code-bg',
  '--color-glass',
  '--color-overlay',
]

/** Parses "r g b" or "r g b / a" channels. */
function parseChannels(value: string): { rgb: [number, number, number]; alpha: string | undefined } {
  const [rgb, alpha] = value.split('/').map((part) => part.trim())
  const [r, g, b] = rgb!.split(/\s+/).map(Number)
  return { rgb: [r!, g!, b!], alpha }
}

function formatChannels(rgb: readonly number[], alpha: string | undefined): string {
  const channels = rgb.map((channel) => Math.round(Math.min(255, Math.max(0, channel)))).join(' ')
  return alpha === undefined ? channels : `${channels} / ${alpha}`
}

/** Swaps pinned page/surface colors into the derivation base and shifts the surface-relative chrome's lightness by
 * the surface's own step, keeping each token's hue, chroma and alpha. */
function withPinnedSurfaces(
  baseTokens: Record<string, string>,
  surfaces: { page: string; surface: string }
): Record<string, string> {
  const next = { ...baseTokens }
  const surface = customColorChannels(surfaces.surface)!
  const step =
    srgbToOklch(parseChannels(surface).rgb).l - srgbToOklch(parseChannels(baseTokens['--color-bg-surface']!).rgb).l
  for (const token of SURFACE_RELATIVE_TOKENS) {
    const value = next[token]
    if (!value) continue
    const { rgb, alpha } = parseChannels(value)
    const oklch = srgbToOklch(rgb)
    next[token] = formatChannels(oklchToSrgb({ ...oklch, l: Math.min(1, Math.max(0, oklch.l + step)) }), alpha)
  }
  next['--color-bg-page'] = customColorChannels(surfaces.page)!
  next['--color-bg-surface'] = surface
  return next
}

/**
 * Harbor and Ember paint every interactive surface (hover, pill, inset and selection) with one tint of their accent
 * over the surface, the secondary surface with a lighter one, and the selection border (in light, the input border
 * too) with a stronger mix. The shared derivation leaves those close to the plain surface for a palette (a palette's light
 * selection came out lighter than its own page), so palette built-ins apply the same structure after deriving, before
 * the contrast repair. Dark tints from the primary itself: a pale dark-mode accent would only grey the surface.
 */
const INTERACTION_TINTS: Record<
  ResolvedAppearance,
  { tint: [string, number]; secondary: number; border: [string, number]; inputBorder: boolean }
> = {
  light: { tint: ['--color-primary', 12], secondary: 7, border: ['--color-primary', 38], inputBorder: true },
  dark: { tint: ['--color-primary', 24], secondary: 12, border: ['--color-primary-light', 32], inputBorder: false },
}

/** `pct`% of channel color `a` over channel color `b`, in sRGB, as "r g b" channels. */
function mixChannels(a: string, pct: number, b: string): string {
  const [x, y] = [a, b].map((value) => value.trim().split(/\s+/).slice(0, 3).map(Number))
  return x!.map((channel, i) => Math.round((channel * pct + y![i]! * (100 - pct)) / 100)).join(' ')
}

function applyInteractionTints(
  tokens: Record<string, string>,
  appearance: ResolvedAppearance,
  tintColor: string | undefined
): void {
  const { tint, secondary, border, inputBorder } = INTERACTION_TINTS[appearance]
  const surface = tokens['--color-bg-surface']!
  const source = tintColor ? customColorChannels(tintColor)! : tokens[tint[0]]!
  const tinted = mixChannels(source, tint[1], surface)
  for (const token of ['--color-bg-surface-hover', '--color-bg-pill', '--color-bg-inset', '--color-selection-bg'])
    tokens[token] = tinted
  tokens['--color-bg-surface-secondary'] = mixChannels(source, secondary, surface)
  tokens['--color-selection-border'] = mixChannels(tokens[border[0]]!, border[1], surface)
  if (inputBorder) tokens['--color-input-border'] = tokens['--color-selection-border']
}

/** Builds the full compiled token map for one built-in's one appearance. */
function buildThemeTokens(
  builtin: WebPaletteBuiltin,
  sourceTokens: Record<string, string>,
  appearance: ResolvedAppearance
) {
  const palette = { ...builtin.palette, ...builtin.appearancePalette?.[appearance] }
  const surfaces = builtin.surfaces?.[appearance]
  const baseTokens = surfaces ? withPinnedSurfaces(sourceTokens, surfaces) : sourceTokens
  const derivedHex = deriveThemeOverrides({ baseTokens, palette, appearance })
  if (surfaces) {
    derivedHex['--color-bg-page'] = surfaces.page
    derivedHex['--color-bg-surface'] = surfaces.surface
  }
  const pinned = builtin.pinned?.[appearance] ?? {}
  const combined: Record<string, string> = {}
  for (const token of Object.keys(baseTokens)) {
    if (token.startsWith('--opacity-')) {
      // Intrinsic-alpha metadata is independent of the color token's own
      // stored channels (see generate-bigbrain-builtins.ts's doc comment
      // step 6); Ficus keeps Iris's own translucent values, like Harbor/Ember.
      combined[token] = baseTokens[token]!
      continue
    }
    // A pinned value wins over derivation, and may name a token outside DERIVABLE_TOKENS.
    const derived = pinned[token] ?? (DERIVABLE_TOKENS.has(token) ? derivedHex[token] : undefined)
    combined[token] = derived ? (customColorChannels(derived) ?? baseTokens[token]!) : baseTokens[token]!
  }
  applyInteractionTints(combined, appearance, builtin.interactionTint?.[appearance])
  // The checked checkbox's tick sits on the accent fill, so it takes the same ink as text on that fill.
  combined['--checkbox-check'] = combined['--on-accent-fg']!
  return repairContrastPairs(combined)
}

function themeCssBlock(
  builtin: WebPaletteBuiltin,
  appearance: ResolvedAppearance,
  tokens: Record<string, string>
): string {
  const selector = `  :root[data-theme='${builtin.id}'][data-appearance='${appearance}'],\n  [data-theme-scope][data-theme='${builtin.id}'][data-appearance='${appearance}'] {`
  const lines = Object.entries(tokens).map(([token, value]) => `    ${token}: ${value};`)
  return `${selector}\n    color-scheme: ${appearance};\n    /* ${builtin.label}: ${builtin.intent} See docs/wiki/theme/builtins.md. */\n${lines.join('\n')}\n  }\n`
}

export interface GeneratedPaletteTheme {
  builtin: WebPaletteBuiltin
  appearance: ResolvedAppearance
  css: string
  /** Fg tokens whose lightness the contrast repair pass moved (see
   * `repairContrastPairs`), for the docs table / generator report. */
  adjusted: string[]
}

export async function generatePaletteThemes(): Promise<GeneratedPaletteTheme[]> {
  const indexCss = await Bun.file(resolve(import.meta.dir, '../src/index.css')).text()
  const irisLight = cssBlockDeclarations(indexCss, ':root')
  const irisDark = cssBlockDeclarations(indexCss, '.dark')
  const results: GeneratedPaletteTheme[] = []
  for (const builtin of PALETTE_BUILTINS) {
    for (const [appearance, baseTokens] of [
      ['light', irisLight],
      ['dark', irisDark],
    ] as const) {
      const { tokens, adjusted } = buildThemeTokens(builtin, baseTokens, appearance)
      results.push({ builtin, appearance, css: themeCssBlock(builtin, appearance, tokens), adjusted })
    }
  }
  return results
}

export async function generatePaletteBuiltinsCss(): Promise<string> {
  const themes = await generatePaletteThemes()
  return `${GENERATED_START}${themes.map((t) => t.css).join('\n')}${GENERATED_END}`
}

if (import.meta.main) {
  const target = resolve(import.meta.dir, '../src/theme/builtins.css')
  const file = Bun.file(target)
  const current = await file.text()
  const themes = await generatePaletteThemes()
  const generated = `${GENERATED_START}${themes.map((t) => t.css).join('\n')}${GENERATED_END}`
  const markerRe = new RegExp(
    `${GENERATED_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${GENERATED_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`
  )
  if (markerRe.test(current)) {
    await Bun.write(target, current.replace(markerRe, generated))
  } else {
    // First run: insert right after Harbor's dark block, right before
    // Ember's light block.
    const anchor = "  :root[data-theme='ember'][data-appearance='light'],"
    const anchorIndex = current.indexOf(anchor)
    if (anchorIndex < 0) throw new Error('could not find the ember light block to insert the palette built-ins before')
    await Bun.write(target, current.slice(0, anchorIndex) + generated + current.slice(anchorIndex))
  }
  for (const theme of themes) {
    console.log(
      `${theme.builtin.id}/${theme.appearance}: ${theme.adjusted.length ? theme.adjusted.join(', ') : '(no contrast adjustments)'}`
    )
  }
}
