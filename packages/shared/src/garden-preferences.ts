/**
 * The garden UI's per-account settings: one small document per user, so new
 * durable garden state is a new key here rather than a new column. Every key is
 * optional (absent means "no account choice yet"; the garden falls back to what
 * the browser remembers) and validated, so only known settings are stored.
 *
 * The garden (apps/garden) draws the same farm in several visual styles; the
 * one a person picks follows their account, like the web app's theme does.
 */
export const GARDEN_STYLES = ['nostalgic', 'cozy', 'futurist', 'blueprint', 'sketchbook'] as const

export type GardenStyle = (typeof GARDEN_STYLES)[number]

export interface GardenSettings {
  style?: GardenStyle
  /** Chimes when the farm changes (off unless turned on). */
  sound?: boolean
}

export interface MyGardenPreferences {
  userId: string
  settings: GardenSettings
}

export function isGardenStyle(value: unknown): value is GardenStyle {
  return typeof value === 'string' && (GARDEN_STYLES as readonly string[]).includes(value)
}

/** Each setting's check: a new setting is a new entry here (and in GardenSettings). */
const CHECKS: { [K in keyof Required<GardenSettings>]: (value: unknown) => value is GardenSettings[K] } = {
  style: isGardenStyle,
  sound: (value): value is boolean => typeof value === 'boolean',
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

/** A change to some settings: only known keys, each valid. Keys it doesn't name are left as they are. */
export function validateGardenSettingsPatch(
  input: unknown
): { ok: true; patch: GardenSettings } | { ok: false; error: string } {
  if (!isPlainObject(input)) return { ok: false, error: 'Expected a settings object.' }
  const patch: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    const check = CHECKS[key as keyof GardenSettings]
    if (!check) return { ok: false, error: `Unknown garden setting: ${key}.` }
    if (!check(value)) return { ok: false, error: `Invalid value for garden setting: ${key}.` }
    patch[key] = value
  }
  return { ok: true, patch: patch as GardenSettings }
}

/** Stored settings as the current code understands them: unknown or no-longer-valid keys are dropped. */
export function readGardenSettings(stored: unknown): GardenSettings {
  if (!isPlainObject(stored)) return {}
  const settings: Record<string, unknown> = {}
  for (const [key, check] of Object.entries(CHECKS)) if (check(stored[key])) settings[key] = stored[key]
  return settings as GardenSettings
}
