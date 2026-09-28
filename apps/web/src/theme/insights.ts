import type { EffectiveAppearance, ThemeInsightsVariant } from '@ficus/shared'
import { tokenRgba } from './contrast'

/** The small, model-facing set of "at a glance" colors — enough to judge
 * warmth/contrast/accent without walking the whole token grid. Keys match
 * `themeInsightsVariantSchema`'s `keyColors` enum in `@ficus/shared`. */
const KEY_COLOR_TOKENS: Record<string, string> = {
  primary: '--color-primary',
  surface: '--color-bg-surface',
  page: '--color-bg-page',
  text: '--color-text-primary',
  border: '--color-border',
  onAccent: '--on-accent-fg',
  danger: '--status-danger-solid',
  success: '--status-success-solid',
}

function toHex(tokens: Record<string, string>, token: string): string | undefined {
  try {
    const [r, g, b] = tokenRgba(tokens, token)
    const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)))
    const hex = (n: number) => clamp(n).toString(16).padStart(2, '0')
    return `#${hex(r!)}${hex(g!)}${hex(b!)}`
  } catch {
    return undefined
  }
}

/** A minimal shape for an already-computed contrast warning, matching the
 * editor's own `Warning` state — avoids a second pass over `contrastPairs`. */
export interface InsightWarning {
  pair: { fg: string; bg: string; minimum: number; under?: string }
  ratio: number | null
}

/** Builds one variant's model-facing insights from the resolved tokens (read
 * via `readPreviewTokens` after painting) and the already-computed contrast
 * warnings for that same paint. Pure aside from reading `tokens`. Bounded by
 * `themeInsightsVariantSchema` downstream (contrastWarnings capped at 20). */
export function computeThemeInsights(
  tokens: Record<string, string>,
  resolvedAppearance: EffectiveAppearance,
  warnings: readonly InsightWarning[]
): ThemeInsightsVariant {
  const keyColors: Record<string, string> = {}
  for (const [name, token] of Object.entries(KEY_COLOR_TOKENS)) {
    const hex = toHex(tokens, token)
    if (hex) keyColors[name] = hex
  }
  const contrastWarnings = warnings
    .slice(0, 20)
    .map(
      ({ pair, ratio }) =>
        `${pair.fg} on ${pair.bg}${pair.under ? ` over ${pair.under}` : ''}: ${
          ratio === null ? 'unknown backdrop' : `${ratio.toFixed(2)}:1 (needs ${pair.minimum}:1)`
        }`
    )
  return { resolvedAppearance, keyColors, contrastWarnings }
}
