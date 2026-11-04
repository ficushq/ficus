// Shared machinery for baking a built-in theme's CSS from the shared palette
// derivation engine (deriveThemeOverrides). Used by both
// generate-bigbrain-builtins.ts (six unified BigBrain-ported palettes) and
// generate-palette-builtins.ts (dual primary/secondary/tertiary/neutral
// palettes, e.g. Ficus). See docs/wiki/theme/builtins.md.
import { THEME_TOKEN_FAMILIES, customColorChannels } from '@ficus/shared/theme-schema'
import { oklchToSrgb, srgbToOklch } from '@ficus/shared/color-oklch'
import { contrast, contrastPairs, pairBackground, tokenRgba } from '../src/theme/contrast'

/** Slices a balanced `{ ... }` block's raw custom-property declarations,
 * starting at the first match of `selector` — mirrors tokenCoverage.test.ts's
 * `cssBlock` helper so both agree on where a CSS scope starts/ends.
 * Preserves declaration order (used to keep generated CSS's token order
 * matching the source block's own, for easy review). */
export function cssBlockDeclarations(css: string, selector: string): Record<string, string> {
  const start = css.indexOf(selector)
  if (start < 0) throw new Error(`selector not found: ${selector}`)
  const open = css.indexOf('{', start)
  let depth = 0
  let close = -1
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++
    if (css[i] === '}') {
      depth--
      if (depth === 0) {
        close = i
        break
      }
    }
  }
  if (close < 0) throw new Error(`unbalanced block for selector ${selector}`)
  const block = css.slice(open + 1, close)
  const tokens: Record<string, string> = {}
  for (const match of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) tokens[match[1]!] = match[2]!.trim()
  return tokens
}

/** The only tokens the shared palette derivation is allowed to touch for a
 * built-in theme (docs/wiki/theme/builtins.md's Generation section):
 * verified against the actual CSS, only the `chrome` token family plus
 * `--swatch-secondary`/`-tertiary`/`--on-accent-fg` actually vary between
 * built-ins — every other family is copied verbatim from Iris. The
 * notification badge pair is derived too: its fill follows the theme's own
 * secondary (the same value as `--swatch-secondary`), with ink chosen by
 * contrast against it. */
export const DERIVABLE_TOKENS = new Set<string>([
  ...THEME_TOKEN_FAMILIES.find((family) => family.family === 'chrome')!.tokens,
  '--swatch-secondary',
  '--swatch-tertiary',
  '--on-accent-fg',
  '--badge',
  '--on-badge',
])

/**
 * Final corrective pass: the strict built-in contrast gate
 * (`apps/web/src/theme/builtins.test.ts`, `contrastPairs`) checks every
 * foreground — including tokens copied verbatim from Iris — against EVERY
 * chrome surface this theme now has, a broader check than the shared
 * derivation engine's own internal contrast pass. This nudges ONLY a
 * failing token's LIGHTNESS (hue/chroma held fixed, the identical bisection
 * technique `theme-derivation.ts`'s own `contrastPass` uses) toward
 * whichever extreme clears every gated pair for that one theme, never
 * touching the derivation engine itself. If lightness alone can't reach the
 * target even at the sRGB gamut extreme, it falls back to also reducing
 * chroma toward gray at that extreme, same bisection technique. Tokens
 * already passing are left untouched (byte-identical). */
export function repairContrastPairs(tokens: Record<string, string>): {
  tokens: Record<string, string>
  adjusted: string[]
} {
  const next = { ...tokens }
  const adjusted: string[] = []
  const fgTokenNames = [...new Set(contrastPairs.map((pair) => pair.fg))]
  for (const fgToken of fgTokenNames) {
    if (next[fgToken] === undefined) continue
    const pairs = contrastPairs.filter((pair) => pair.fg === fgToken)
    let fgRgba: number[]
    try {
      fgRgba = tokenRgba(next, fgToken)
    } catch {
      continue // not a color token (e.g. a 'none'/'auto' sentinel)
    }
    const alpha = fgRgba[3] ?? 1
    const backgrounds = pairs
      .map((pair) => ({ bg: pairBackground(next, pair), minimum: pair.minimum }))
      .filter((b): b is { bg: number[]; minimum: number } => !!b.bg)
    if (backgrounds.length === 0) continue
    const oklch = srgbToOklch([fgRgba[0]!, fgRgba[1]!, fgRgba[2]!])
    // Normalized score: min over every gated pair of (actual ratio / required
    // minimum). >= 1 means every pair for this token passes.
    const scoreAt = (l: number, c: number) => {
      const rgb = oklchToSrgb({ l, c, h: oklch.h })
      return Math.min(...backgrounds.map(({ bg, minimum }) => contrast([...rgb, alpha], bg) / minimum))
    }
    if (scoreAt(oklch.l, oklch.c) >= 1) continue
    const extreme = scoreAt(1, oklch.c) > scoreAt(0, oklch.c) ? 1 : 0
    let near = oklch.l
    let far = extreme
    for (let i = 0; i < 40; i++) {
      const mid = (near + far) / 2
      if (scoreAt(mid, oklch.c) >= 1) far = mid
      else near = mid
    }
    let finalL = scoreAt(far, oklch.c) >= 1 ? far : extreme
    let finalC = oklch.c
    // Gamut-limited last resort: fixed chroma at the lightness extreme still
    // doesn't clear every pair (a saturated hue can't get light/dark enough
    // without desaturating). Bisect chroma toward 0 (a neutral gray) at that
    // extreme instead, same technique, never touching hue.
    if (scoreAt(finalL, finalC) < 1) {
      let nearC = oklch.c
      let farC = 0
      for (let i = 0; i < 40; i++) {
        const midC = (nearC + farC) / 2
        if (scoreAt(extreme, midC) >= 1) farC = midC
        else nearC = midC
      }
      finalL = extreme
      finalC = scoreAt(extreme, farC) >= 1 ? farC : 0
    }
    const [r, g, b] = oklchToSrgb({ l: finalL, c: finalC, h: oklch.h })
    const hex = (n: number) =>
      Math.round(Math.min(255, Math.max(0, n)))
        .toString(16)
        .padStart(2, '0')
    const alphaHex = alpha < 1 ? hex(Math.round(alpha * 255)) : ''
    next[fgToken] = customColorChannels(`#${hex(r)}${hex(g)}${hex(b)}${alphaHex}`)!
    adjusted.push(fgToken)
  }
  return { tokens: next, adjusted }
}

/** OKLab distance (about two just-noticeable differences) a selected row keeps from both a hovered row and the plain
 * surface, so selection never reads as hover. `builtins.test.ts` holds every built-in to it. */
const SELECTION_MIN_DISTANCE = 0.04

/** Euclidean distance between two sRGB colors in OKLab. */
function oklabDistance(a: readonly number[], b: readonly number[]): number {
  const lab = (rgb: readonly number[]) => {
    const { l, c, h } = srgbToOklch([rgb[0]!, rgb[1]!, rgb[2]!])
    const radians = (h * Math.PI) / 180
    return [l, c * Math.cos(radians), c * Math.sin(radians)]
  }
  const [x, y] = [lab(a), lab(b)]
  return Math.hypot(x[0]! - y[0]!, x[1]! - y[1]!, x[2]! - y[2]!)
}

/** Whether text on a selection background stays readable: primary and secondary text clear 4.5:1, and the accent text
 * selected rows use (`--color-primary-light`) clears 4.5:1, or where the theme's accent text falls short of that on
 * its own hover surface, at least matches its ratio there. */
function selectionTextReadable(tokens: Record<string, string>, background: readonly number[]): boolean {
  const bg = [...background]
  const hover = tokenRgba(tokens, '--color-bg-surface-hover').slice(0, 3)
  const accentText = tokenRgba(tokens, '--color-primary-light')
  return (
    contrast(tokenRgba(tokens, '--color-text-primary'), bg) >= 4.5 &&
    contrast(tokenRgba(tokens, '--color-text-secondary'), bg) >= 4.5 &&
    contrast(accentText, bg) >= Math.min(4.5, contrast(accentText, hover))
  )
}

/**
 * The selection background (`--color-selection-bg`): the accent mixed over the hover surface, starting at 10% and
 * strengthened in 5% steps until it sits SELECTION_MIN_DISTANCE from both the hover and the plain surface. When a mix
 * would make text on it unreadable (`selectionTextReadable`), its OKLCH lightness moves away from the primary text,
 * hue and chroma held, by the same bisection `repairContrastPairs` uses, so the accent tint carries the difference.
 * `accent` is "r g b" channels; returns channels.
 */
export function fitSelectionBackground(tokens: Record<string, string>, accent: string): string {
  const channels = (value: string) => value.split('/')[0]!.trim().split(/\s+/).slice(0, 3).map(Number)
  const surface = tokenRgba(tokens, '--color-bg-surface').slice(0, 3)
  const hover = tokenRgba(tokens, '--color-bg-surface-hover').slice(0, 3)
  const tint = channels(accent)
  const lightText =
    srgbToOklch(tokenRgba(tokens, '--color-text-primary').slice(0, 3) as [number, number, number]).l > 0.5
  for (let pct = 10; pct <= 100; pct += 5) {
    let candidate = tint.map((channel, i) => Math.round((channel * pct + hover[i]! * (100 - pct)) / 100))
    if (!selectionTextReadable(tokens, candidate)) {
      const oklch = srgbToOklch(candidate as [number, number, number])
      let near = oklch.l
      let far = lightText ? 0 : 1
      for (let i = 0; i < 40; i++) {
        const mid = (near + far) / 2
        if (selectionTextReadable(tokens, oklchToSrgb({ ...oklch, l: mid }))) far = mid
        else near = mid
      }
      candidate = oklchToSrgb({ ...oklch, l: far })
    }
    if (
      selectionTextReadable(tokens, candidate) &&
      oklabDistance(candidate, hover) >= SELECTION_MIN_DISTANCE &&
      oklabDistance(candidate, surface) >= SELECTION_MIN_DISTANCE
    )
      return candidate.join(' ')
  }
  throw new Error('No readable selection background is distinct from hover; adjust the palette.')
}
