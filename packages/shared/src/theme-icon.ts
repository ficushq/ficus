/**
 * The app icon a theme gets: the Ficus mark (center leaf, two side leaves, pot) on a tile, colored from the theme's
 * own tokens. Every surface that shows a themed icon uses this one mapping, so they agree: the brand generator
 * (`scripts/brand/generate.ts`, the built-in themes' Desktop icons), the web favicon, and Desktop's Dock icon for a
 * custom theme. See brand/README.md, "Theme icons". Pure and dependency-free: imported by the browser bundle.
 */

/** The tokens the mapping reads, by role. Values are the bare `r g b` channels the theme CSS defines (or `#rrggbb`). */
export const THEME_ICON_TOKENS = {
  tile: '--color-bg-page',
  primary: '--color-primary',
  primaryHover: '--color-primary-hover',
  primaryLight: '--color-primary-light',
  text: '--color-text-primary',
  secondary: '--swatch-secondary',
  tertiary: '--swatch-tertiary',
} as const

export type ThemeIconTokenRole = keyof typeof THEME_ICON_TOKENS
export type ThemeIconTokens = Readonly<Record<ThemeIconTokenRole, string>>

/** Each part's color as lowercase `#rrggbb`. */
export interface ThemeIconColors {
  readonly tile: string
  readonly leaf: string
  readonly pot: string
  readonly sideLeaves: string
}

/** Today's bundled dark icon (brand/ficus-mark-dark.svg on soil). The built-in Ficus dark theme keeps it exactly. */
export const FICUS_DARK_ICON_COLORS: ThemeIconColors = {
  tile: '#1c1a17',
  leaf: '#5e7f4e',
  pot: '#c46a3c',
  sideLeaves: '#87945a',
}

/** The leaf must read against the tile at the WCAG non-text contrast floor. */
const LEAF_CONTRAST = 3
/** Below this, the secondary swatch is the tile's own color (a three-color theme) and cannot be the pot. */
const POT_CONTRAST = 2
/** A darkened-leaf pot closer than this to the tile is pushed further. */
const DERIVED_POT_CONTRAST = 1.8
const SIDE_LEAF_CONTRAST = 1.5
/** Side leaves this close (RGB distance) to the leaf or pot would merge with them. */
const SIDE_LEAF_DISTANCE = 40
/** How far side leaves derived from the leaf fade toward the tile. */
const SIDE_LEAF_BLEND = 0.45

type Rgb = readonly [number, number, number]

/** Parses `r g b`, `r g b / a` (alpha ignored) or `#rrggbb`; channels are rounded and clamped to 0–255. */
export function parseThemeIconColor(value: string): Rgb | null {
  const text = value.trim()
  const hex = /^#([0-9a-f]{6})$/i.exec(text)
  if (hex) {
    const n = Number.parseInt(hex[1]!, 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  }
  const parts = text.split('/')[0]!.trim().split(/\s+/).map(Number)
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) return null
  return parts.map((part) => Math.min(255, Math.max(0, Math.round(part)))) as unknown as Rgb
}

function hex(rgb: Rgb): string {
  return `#${rgb.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`
}

function luminance(rgb: Rgb): number {
  return rgb
    .map((c) => c / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
    .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i]!, 0)
}

function contrast(a: Rgb, b: Rgb): number {
  const [la, lb] = [luminance(a), luminance(b)]
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

function mix(a: Rgb, b: Rgb, amount: number): Rgb {
  return a.map((channel, i) => Math.round(channel * (1 - amount) + b[i]! * amount)) as unknown as Rgb
}

function distance(a: Rgb, b: Rgb): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}

const BLACK: Rgb = [0, 0, 0]
const WHITE: Rgb = [255, 255, 255]

/**
 * Colors the mark from a theme's tokens:
 *
 * - tile: the page background;
 * - leaf: the primary, else its hover or light shade, else the text color, whichever first reaches 3:1 on the tile;
 * - pot: the secondary swatch when it reaches 2:1 on the tile. Three-color themes (background, text, accent) have no
 *   separate secondary, so the pot is the leaf color darkened instead (lightened on a near-black tile);
 * - side leaves: the tertiary swatch, unless it is too faint on the tile, merges with the leaf or pot, or the pot was
 *   derived; then the leaf blended toward the tile.
 *
 * `builtIn` names the built-in theme the tokens came from, for its fixed exceptions (Ficus dark keeps today's dark
 * icon); leave it out for a custom theme. Returns null when any token is missing or unparseable.
 */
export function themeIconColors(
  tokens: Readonly<Partial<Record<ThemeIconTokenRole, string>>>,
  builtIn?: { themeId: string; appearance: 'light' | 'dark' | 'constant' }
): ThemeIconColors | null {
  if (builtIn?.themeId === 'ficus' && builtIn.appearance === 'dark') return FICUS_DARK_ICON_COLORS
  const parsed = {} as Record<ThemeIconTokenRole, Rgb>
  for (const role of Object.keys(THEME_ICON_TOKENS) as ThemeIconTokenRole[]) {
    const value = tokens[role]
    const rgb = value === undefined ? null : parseThemeIconColor(value)
    if (!rgb) return null
    parsed[role] = rgb
  }
  const tile = parsed.tile
  const leafCandidates = [parsed.primary, parsed.primaryHover, parsed.primaryLight, parsed.text]
  const leaf =
    leafCandidates.find((candidate) => contrast(candidate, tile) >= LEAF_CONTRAST) ??
    leafCandidates.reduce((best, candidate) => (contrast(candidate, tile) > contrast(best, tile) ? candidate : best))

  let pot: Rgb
  let sideLeaves: Rgb
  if (contrast(parsed.secondary, tile) >= POT_CONTRAST) {
    pot = parsed.secondary
    const tertiary = parsed.tertiary
    sideLeaves =
      contrast(tertiary, tile) < SIDE_LEAF_CONTRAST ||
      distance(tertiary, pot) < SIDE_LEAF_DISTANCE ||
      distance(tertiary, leaf) < SIDE_LEAF_DISTANCE
        ? mix(leaf, tile, SIDE_LEAF_BLEND)
        : tertiary
  } else {
    pot = mix(leaf, BLACK, 0.35)
    if (contrast(pot, tile) < DERIVED_POT_CONTRAST)
      pot = luminance(tile) < 0.05 ? mix(leaf, WHITE, 0.35) : mix(leaf, BLACK, 0.55)
    sideLeaves = mix(leaf, tile, SIDE_LEAF_BLEND)
  }
  return { tile: hex(tile), leaf: hex(leaf), pot: hex(pot), sideLeaves: hex(sideLeaves) }
}

/** The source mark's own fills (brand/ficus-mark.svg and the generated favicon), by part. */
export const BRAND_MARK_FILLS = { leaf: '#3f6b4f', sideLeaves: '#8a9a5b', pot: '#b0582f' } as const

/** Recolors markup drawn in the brand mark's fills (any of the source SVGs) to `colors`. */
export function recolorMark(markup: string, colors: Pick<ThemeIconColors, 'leaf' | 'pot' | 'sideLeaves'>): string {
  // One pass, so a part whose new color happens to be another part's brand fill is not recolored twice.
  const byFill: Record<string, string> = {
    [BRAND_MARK_FILLS.leaf]: colors.leaf,
    [BRAND_MARK_FILLS.sideLeaves]: colors.sideLeaves,
    [BRAND_MARK_FILLS.pot]: colors.pot,
  }
  return markup.replace(/#3f6b4f|#8a9a5b|#b0582f/gi, (fill) => byFill[fill.toLowerCase()]!)
}
