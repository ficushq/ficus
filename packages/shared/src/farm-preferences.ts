import { isFarmLook, type FarmLook } from './farm-look'

/**
 * The farm UI's per-account settings: one small document per user, so new
 * durable farm state is a new key here rather than a new column. Every key is
 * optional (absent means "no account choice yet"; the farm falls back to what
 * the browser remembers) and validated, so only known settings are stored.
 *
 * The farm UI (apps/farm) draws the same farm in several visual styles; the
 * one a person picks follows their account, like the web app's theme does.
 */
export const FARM_STYLES = ['nostalgic', 'cozy', 'futurist', 'blueprint', 'sketchbook'] as const

export type FarmStyle = (typeof FARM_STYLES)[number]

export interface FarmSettings {
  style?: FarmStyle
  /** Chimes when the farm changes (off unless turned on). */
  sound?: boolean
  /** Seen by and seeing other people on the farm (on unless turned off: single-player). */
  multiplayer?: boolean
  /** How they look on the farm (the character builder); absent until they choose. */
  look?: FarmLook
}

export interface MyFarmPreferences {
  userId: string
  settings: FarmSettings
}

export function isFarmStyle(value: unknown): value is FarmStyle {
  return typeof value === 'string' && (FARM_STYLES as readonly string[]).includes(value)
}

/** Each setting's check: a new setting is a new entry here (and in FarmSettings). */
const CHECKS: { [K in keyof Required<FarmSettings>]: (value: unknown) => value is FarmSettings[K] } = {
  style: isFarmStyle,
  sound: (value): value is boolean => typeof value === 'boolean',
  multiplayer: (value): value is boolean => typeof value === 'boolean',
  look: isFarmLook,
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

/** A change to some settings: only known keys, each valid. Keys it doesn't name are left as they are. */
export function validateFarmSettingsPatch(
  input: unknown
): { ok: true; patch: FarmSettings } | { ok: false; error: string } {
  if (!isPlainObject(input)) return { ok: false, error: 'Expected a settings object.' }
  const patch: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    const check = CHECKS[key as keyof FarmSettings]
    if (!check) return { ok: false, error: `Unknown farm setting: ${key}.` }
    if (!check(value)) return { ok: false, error: `Invalid value for farm setting: ${key}.` }
    patch[key] = value
  }
  return { ok: true, patch: patch as FarmSettings }
}

/** Stored settings as the current code understands them: unknown or no-longer-valid keys are dropped. */
export function readFarmSettings(stored: unknown): FarmSettings {
  if (!isPlainObject(stored)) return {}
  const settings: Record<string, unknown> = {}
  for (const [key, check] of Object.entries(CHECKS)) if (check(stored[key])) settings[key] = stored[key]
  return settings as FarmSettings
}
