/**
 * Six palettes ported from the BigBrain project's own design tokens
 * (`web/ui/src/design/tokens.css`), each becoming a genuine Ficus built-in
 * theme (see `apps/web/src/theme/registry.ts`'s `BUILT_IN_THEMES` and the
 * generator at `apps/web/scripts/generate-bigbrain-builtins.ts`). Each entry
 * names three base colors — a background, a foreground/text color, and an
 * "activity" accent — plus the appearance ('light' or 'dark') BigBrain
 * itself pairs that palette with; every generated built-in is UNIFIED (a
 * single constant appearance, like High contrast), not a light/dark pair.
 *
 * `mixSrgb` is the pure sRGB channel-space mix the generator uses to turn
 * BigBrain's own `color-mix(in srgb, fg P%, bg)` formulas (text-note 88%,
 * text-muted 65%, text-faint 50%, surface 4%, paper-desk 8%, rule 18%, dash
 * 28%) into concrete `#rrggbb` colors.
 */

export interface BigBrainPalette {
  /** Stable id, matches the BigBrain source name; becomes the built-in theme id. */
  readonly id: string
  readonly label: string
  /** Background base color (`#rrggbb`). */
  readonly bg: string
  /** Foreground/text base color (`#rrggbb`). */
  readonly fg: string
  /** Activity/accent base color (`#rrggbb`). */
  readonly activity: string
  /** The appearance BigBrain itself pairs this palette with; the generated
   * built-in is unified (constant), starting from Iris's own tokens for this
   * scheme. */
  readonly scheme: 'light' | 'dark'
}

export const BIGBRAIN_PALETTES: readonly BigBrainPalette[] = [
  { id: 'nurebairo', label: 'nurebairo', bg: '#21191f', fg: '#dde9f4', activity: '#cf717a', scheme: 'dark' },
  { id: 'phosphorus', label: 'Phosphorus', bg: '#d3e0d5', fg: '#263c34', activity: '#62517a', scheme: 'light' },
  { id: 'yamabukiiro', label: 'yamabukiiro', bg: '#e0aa24', fg: '#30261a', activity: '#64204f', scheme: 'light' },
  { id: 'moegiiro', label: 'moegiiro', bg: '#286a3c', fg: '#f7eaf8', activity: '#ffda52', scheme: 'dark' },
  { id: 'adzukiiro', label: 'adzukiiro', bg: '#803653', fg: '#f2d8f5', activity: '#bcc9dd', scheme: 'dark' },
  { id: 'asagiiro', label: 'asagiiro', bg: '#355f7b', fg: '#fff6ec', activity: '#ffd65a', scheme: 'dark' },
]

function hexToRgb(hex: string): readonly [number, number, number] {
  const clean = hex.replace('#', '')
  return [0, 2, 4].map((i) => parseInt(clean.slice(i, i + 2), 16)) as unknown as readonly [number, number, number]
}

function rgbToHex(rgb: readonly [number, number, number]): string {
  const channel = (n: number) =>
    Math.round(Math.min(255, Math.max(0, n)))
      .toString(16)
      .padStart(2, '0')
  return `#${channel(rgb[0])}${channel(rgb[1])}${channel(rgb[2])}`
}

/**
 * Pure sRGB channel-space mix, matching CSS `color-mix(in srgb, from pct%,
 * into)`: `pct`% of `from` blended into `into`, producing a closed-grammar
 * `#rrggbb` string (see the custom-theme color grammar in `custom-theme.ts`).
 * `pct` is clamped to [0, 100] so a caller typo never produces an
 * out-of-gamut channel.
 */
export function mixSrgb(from: string, pct: number, into: string): string {
  const t = Math.min(100, Math.max(0, pct)) / 100
  const [fr, fg, fb] = hexToRgb(from)
  const [ir, ig, ib] = hexToRgb(into)
  return rgbToHex([fr * t + ir * (1 - t), fg * t + ig * (1 - t), fb * t + ib * (1 - t)])
}
