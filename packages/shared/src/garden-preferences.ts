/**
 * The garden UI's per-account preferences. The garden (apps/garden) draws the
 * same farm in several visual styles; the one a person picks follows their
 * account, like the web app's theme does.
 */
export const GARDEN_STYLES = ['nostalgic', 'futurist', 'blueprint', 'sketchbook'] as const

export type GardenStyle = (typeof GARDEN_STYLES)[number]

export interface MyGardenPreferences {
  userId: string
  /** No row means no account choice yet; the garden falls back to what this browser remembers. */
  style: GardenStyle | null
}

export function isGardenStyle(value: unknown): value is GardenStyle {
  return typeof value === 'string' && (GARDEN_STYLES as readonly string[]).includes(value)
}

export function validateGardenStyle(input: unknown): { ok: true; style: GardenStyle } | { ok: false; error: string } {
  return isGardenStyle(input) ? { ok: true, style: input } : { ok: false, error: 'Unknown garden style.' }
}
