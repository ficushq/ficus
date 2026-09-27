// Generates the six BigBrain-palette built-in theme CSS blocks appended to
// apps/web/src/theme/builtins.css, between the GENERATED BIGBRAIN BUILTINS
// markers. Regenerate with: bun apps/web/scripts/generate-bigbrain-builtins.ts
//
// Design: each palette becomes a UNIFIED built-in (single constant
// appearance, like High contrast) starting from Ficus's own light or dark
// token set (matching the palette's native scheme) as the derivation base:
//
// 1. Parse Ficus's `:root`/`.dark` blocks in index.css into a token->value map
//    (the same declarations the running app itself uses — "no runtime color
//    derivation" for built-ins means this script bakes the CSS once, not
//    that it invents its own separate palette math).
// 2. Substitute the two tokens the shared derivation's own contrast pass
//    checks against (`--color-bg-page`, `--color-bg-surface`) with this
//    palette's OWN mixed values first, so that pass (which nudges
//    `--color-primary`'s lightness for 3:1 against page) operates against
//    the real shipped background, not Ficus's.
// 3. Run the shared palette derivation (`deriveThemeOverrides`, the same
//    pure engine `packages/shared/src/theme-derivation.ts` uses for custom
//    themes) with primary=activity, secondary=bg, tertiary=fg, neutral=bg,
//    contrast 'standard', status 'static'. Existing built-ins establish
//    (verified against the actual CSS: harbor/ember/high-contrast share
//    byte-identical status, agent-type, badge-decoration, voice-material,
//    utility-decoration/-chrome, log-terminal, ansi and brand tokens with
//    Ficus — "two recolors [that] preserve status meanings and all seven used
//    decorative Badge palettes", not a semantic recolor) that only the
//    `chrome` token family, `--swatch-secondary`/`-tertiary`, and
//    `--on-accent-fg` actually vary between built-ins; this script applies
//    derivation ONLY to that same restricted set (`DERIVABLE_TOKENS` below)
//    and copies every other family verbatim, matching that precedent
//    exactly rather than inventing a new "recolor everything" model.
// 4. Layer BigBrain's own sRGB `color-mix` formulas as EXPLICIT overrides on
//    top for the core chrome tokens (page/surfaces/text/borders/code/
//    selection) — see `mapExplicitTokens` below — winning over the derived
//    value for those tokens exactly like a custom theme's explicit
//    `variants` win over palette derivation.
// 5. Any token untouched by both (status/agent-type/badge-decoration/voice-
//    material/etc., ANSI-named terminal/log slots, var()-aliased tokens, the
//    `none`/`auto` xterm sentinels) is copied verbatim from Ficus's own value.
// 6. `--opacity-*` intrinsic-alpha metadata (input-border, panel-border, the
//    seven badge-decoration surfaces/hovers, and the nine status roles'
//    surface/badge-surface/badge-hover) is INDEPENDENT of the color token's
//    own stored channels — see tokenCoverage.test.ts and the calc() formula
//    in index.css: it is an authored "how translucent should this render
//    via an opacity utility" constant, not something derivable from the
//    channel string. `--opacity-input-border` is set to 1: input borders
//    are an explicit subtle mix drawn solid. `--opacity-panel-border` keeps
//    Ficus's 12%, like Harbor and Ember: the derived panel border is a strong
//    accent/text color, which drawn solid made every card and header rule
//    too bright. Everything else (badge-decoration
//    and status metadata) is outside BigBrain's own palette scope, so it is
//    copied verbatim from Ficus's matching-scheme block, unchanged.
import { resolve } from 'node:path'
import { BIGBRAIN_PALETTES, mixSrgb, type BigBrainPalette } from '@ficus/shared/bigbrain-palettes'
import { deriveThemeOverrides } from '@ficus/shared/theme-derivation'
import { customColorChannels } from '@ficus/shared/theme-schema'
import { cssBlockDeclarations, DERIVABLE_TOKENS, repairContrastPairs } from './theme-builtin-shared'

export const GENERATED_START =
  '\n  /* BEGIN GENERATED BIGBRAIN BUILTINS — apps/web/scripts/generate-bigbrain-builtins.ts. Do not edit by hand. */\n'
export const GENERATED_END = '  /* END GENERATED BIGBRAIN BUILTINS */\n'

/** BigBrain's own sRGB `color-mix` formulas (see docs/wiki/theme/builtins.md
 * for the full mapping table), converted to compiled "r g b" channel form. */
function mapExplicitTokens(palette: BigBrainPalette): Record<string, string> {
  const { bg, fg, activity } = palette
  const hex: Record<string, string> = {
    '--color-bg-page': bg,
    '--color-bg-surface': mixSrgb(fg, 4, bg),
    '--color-bg-surface-secondary': mixSrgb(fg, 8, bg),
    '--color-bg-inset': mixSrgb(fg, 8, bg),
    '--color-bg-surface-hover': mixSrgb(fg, 10, bg),
    '--color-bg-pill': mixSrgb(fg, 10, bg),
    '--color-input-bg': mixSrgb(fg, 2, bg),
    '--color-text-primary': fg,
    '--color-text-secondary': fitTextContrast(fg, bg, 88),
    '--color-text-muted': fitTextContrast(fg, bg, 65),
    '--color-text-placeholder': fitTextContrast(fg, bg, 50),
    '--color-border': mixSrgb(fg, 18, bg),
    '--color-input-border': mixSrgb(fg, 18, bg),
    '--color-border-hover': mixSrgb(fg, 28, bg),
    '--color-code-bg': mixSrgb(fg, 6, bg),
    '--color-code-text': fg,
    '--color-selection-bg': mixSrgb(activity, 15, bg),
    '--color-selection-border': mixSrgb(activity, 40, bg),
    // Header and sidebar glass: the page itself at Ficus's 88% glass opacity.
    '--color-glass': `${bg}e0`,
  }
  return Object.fromEntries(Object.entries(hex).map(([k, v]) => [k, customColorChannels(v)!]))
}

// --- a tiny WCAG contrast helper, mirroring the formula used elsewhere in
// the theme system (theme-derivation.ts's private wcagContrast) ---
function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace('#', '')
  return [0, 2, 4].map((i) => parseInt(clean.slice(i, i + 2), 16)) as [number, number, number]
}
function relativeLuminance([r, g, b]: readonly [number, number, number]): number {
  return [r, g, b]
    .map((c) => c / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
    .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i]!, 0)
}
function contrastRatio(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/**
 * BigBrain's text-secondary/muted/placeholder formulas are fixed mix
 * percentages (88/65/50) of fg into bg. Those pass comfortably against the
 * literal bg, but the app also renders text on several bg-derived surfaces
 * (surface, surface-secondary, pill, surface-hover, inset — each a small
 * further mix toward fg), so the SAME percentage needs to still clear
 * WCAG 4.5:1 against the least favorable of those. Rather than hand-tune
 * each palette, this nudges the percentage UP (more fg, less bg — the same
 * "increase, never invert the formula" adjustment the built-in contrast
 * corrections elsewhere in this file already use) until it does, capping at
 * 100% (pure fg, which the text-primary role already uses and which always
 * passes since it already clears the literal-bg check by construction — see
 * the shared 4.5:1 regression check in bigbrain-palettes.test.ts).
 */
function fitTextContrast(fg: string, bg: string, nominalPct: number): string {
  const bgRgb = hexToRgb(bg)
  const surfaces = [4, 8, 10].map((pct) => hexToRgb(mixSrgb(fg, pct, bg)))
  const passes = (pct: number) => {
    const textRgb = hexToRgb(mixSrgb(fg, pct, bg))
    return [bgRgb, ...surfaces].every((surface) => contrastRatio(textRgb, surface) >= 4.5)
  }
  let pct = nominalPct
  while (pct < 100 && !passes(pct)) pct += 1
  return mixSrgb(fg, pct, bg)
}

/** Builds the full compiled token map for one palette's unified built-in. */
function buildThemeTokens(palette: BigBrainPalette, tauLight: Record<string, string>, tauDark: Record<string, string>) {
  const baseTokens = { ...(palette.scheme === 'light' ? tauLight : tauDark) }
  const explicit = mapExplicitTokens(palette)
  // See the module doc comment step 2: substitute the real shipped
  // page/surface so the shared derivation's own internal contrast pass (which
  // nudges --color-primary for 3:1 against --color-bg-page, and would
  // otherwise check against Ficus's own page/surface colors) operates against
  // what this theme actually ships.
  baseTokens['--color-bg-page'] = explicit['--color-bg-page']!
  baseTokens['--color-bg-surface'] = explicit['--color-bg-surface']!

  const derivedHex = deriveThemeOverrides({
    baseTokens,
    palette: {
      primary: palette.activity,
      secondary: palette.bg,
      tertiary: palette.fg,
      neutral: palette.bg,
      contrast: 'standard',
      status: 'static',
    },
    appearance: palette.scheme,
  })

  const finalColors: Record<string, string> = {}
  for (const token of Object.keys(baseTokens)) {
    if (token.startsWith('--opacity-')) continue
    if (explicit[token]) {
      finalColors[token] = explicit[token]
      continue
    }
    const derived = DERIVABLE_TOKENS.has(token) ? derivedHex[token] : undefined
    finalColors[token] = derived ? (customColorChannels(derived) ?? baseTokens[token]!) : baseTokens[token]!
  }
  // --on-accent-fg is derived-only (chosen by contrast against the final
  // primary); it is never a baseTokens key filter miss since baseTokens
  // (Ficus's own block) already declares it.
  // Input borders are an explicit subtle mix (above), drawn solid. Panel borders keep Ficus's translucency: the derived
  // panel border is a strong accent/text color, which Ficus, Harbor and Ember all draw at 12%, never solid.
  const SOLID_OPACITY_TOKENS = new Set(['--opacity-input-border'])
  const finalOpacity: Record<string, string> = {}
  for (const token of Object.keys(baseTokens)) {
    if (!token.startsWith('--opacity-')) continue
    finalOpacity[token] = SOLID_OPACITY_TOKENS.has(token) ? '1' : baseTokens[token]!
  }

  const combined: Record<string, string> = {}
  for (const token of Object.keys(baseTokens)) {
    combined[token] = token.startsWith('--opacity-') ? finalOpacity[token]! : finalColors[token]!
  }
  return repairContrastPairs(combined)
}

function themeCssBlock(palette: BigBrainPalette, tokens: Record<string, string>): string {
  const selector = `  :root[data-theme='${palette.id}'],\n  [data-theme-scope][data-theme='${palette.id}'] {`
  const colorScheme = palette.scheme
  const lines = Object.entries(tokens).map(([token, value]) => `    ${token}: ${value};`)
  return `${selector}\n    color-scheme: ${colorScheme};\n    /* Ported from BigBrain (${palette.label}); see docs/wiki/theme/builtins.md. */\n${lines.join('\n')}\n  }\n`
}

export interface GeneratedTheme {
  palette: BigBrainPalette
  css: string
  /** Fg tokens whose lightness the contrast repair pass moved (see
   * `repairContrastPairs`), for the docs table / generator report. */
  adjusted: string[]
}

export async function generateBigBrainThemes(): Promise<GeneratedTheme[]> {
  const indexCss = await Bun.file(resolve(import.meta.dir, '../src/index.css')).text()
  const tauLight = cssBlockDeclarations(indexCss, ':root')
  const tauDark = cssBlockDeclarations(indexCss, '.dark')
  return BIGBRAIN_PALETTES.map((palette) => {
    const { tokens, adjusted } = buildThemeTokens(palette, tauLight, tauDark)
    return { palette, css: themeCssBlock(palette, tokens), adjusted }
  })
}

export async function generateBigBrainBuiltinsCss(): Promise<string> {
  const themes = await generateBigBrainThemes()
  return `${GENERATED_START}${themes.map((t) => t.css).join('\n')}${GENERATED_END}`
}

if (import.meta.main) {
  const target = resolve(import.meta.dir, '../src/theme/builtins.css')
  const file = Bun.file(target)
  const current = await file.text()
  const themes = await generateBigBrainThemes()
  const generated = `${GENERATED_START}${themes.map((t) => t.css).join('\n')}${GENERATED_END}`
  const markerRe = new RegExp(
    `${GENERATED_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${GENERATED_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`
  )
  const next = markerRe.test(current)
    ? current.replace(markerRe, generated)
    : current.replace(/\}\s*$/, `${generated}}\n`)
  await Bun.write(target, next)
  for (const theme of themes) {
    console.log(
      `${theme.palette.id}: ${theme.adjusted.length ? theme.adjusted.join(', ') : '(no contrast adjustments)'}`
    )
  }
}
