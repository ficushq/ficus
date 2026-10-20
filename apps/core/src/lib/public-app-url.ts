import { getSettingsStore } from '../services/settings/store'
import { LOCAL_APP_URL_ENV, normalizePublicAppUrl, PUBLIC_APP_URL_SETTING_KEY } from './public-app-url-format'

export {
  isLoopbackHostname,
  LOCAL_APP_URL_ENV,
  MAX_PUBLIC_APP_URL_LENGTH,
  normalizePublicAppUrl,
  PUBLIC_APP_URL_MIGRATED_SETTING_KEY,
  PUBLIC_APP_URL_SETTING_KEY,
} from './public-app-url-format'

/** Where the effective public application URL came from. */
export type PublicAppUrlSource = 'environment' | 'setting' | 'local-default' | 'none'

export interface PublicAppUrlState {
  /** Effective canonical URL (origin + base path, no trailing slash), or undefined. */
  url: string | undefined
  source: PublicAppUrlSource
  /** True when administrators cannot change it in Settings (environment APP_URL/PUBLIC_URL, or FICUS_MANAGED=1). */
  locked: boolean
  lockedBy?: 'environment' | 'managed'
  /** Normalized APP_URL/PUBLIC_URL when set and valid. */
  environmentUrl?: string
  /** APP_URL/PUBLIC_URL is set but rejected: the effective URL is undefined (no silent fallback). */
  environmentInvalid?: boolean
  /** Normalized stored setting value. */
  storedUrl?: string
  /** Launcher-provided local default (FICUS_LOCAL_APP_URL), normalized. */
  localUrl?: string
  /** FICUS_DESKTOP_MANAGED=1: an env lock came from the Ficus Desktop launcher. */
  desktopManaged: boolean
}

function storedPublicAppUrl(): string | undefined {
  return getSettingsStore().getStoredValue(PUBLIC_APP_URL_SETTING_KEY)
}

/**
 * Layered resolution of the canonical public application address:
 * `APP_URL` env → legacy `PUBLIC_URL` env (both lock the setting) → stored
 * `PUBLIC_APP_URL` setting → launcher local default `FICUS_LOCAL_APP_URL`
 * (never a lock) → none. `FICUS_API_URL` is intentionally excluded: it can be
 * an internal/loopback address. Never derived from request headers.
 *
 * `stored` defaults to the settings cache (a Map lookup), so this is cheap to
 * call per request and follows admin changes without a restart.
 */
export function describePublicAppUrl(
  env: NodeJS.ProcessEnv = process.env,
  stored: string | undefined = storedPublicAppUrl()
): PublicAppUrlState {
  const desktopManaged = env.FICUS_DESKTOP_MANAGED === '1'
  const managed = env.FICUS_MANAGED === '1'
  const localUrl = normalizePublicAppUrl(env[LOCAL_APP_URL_ENV])
  const storedUrl = normalizePublicAppUrl(stored)
  const base = { storedUrl, localUrl, desktopManaged }
  const envCandidate = env.APP_URL?.trim() || env.PUBLIC_URL?.trim()
  if (envCandidate) {
    const environmentUrl = normalizePublicAppUrl(envCandidate)
    return {
      ...base,
      url: environmentUrl,
      source: 'environment',
      locked: true,
      lockedBy: managed ? 'managed' : 'environment',
      environmentUrl,
      environmentInvalid: environmentUrl === undefined,
    }
  }
  const lock = managed ? { locked: true, lockedBy: 'managed' as const } : { locked: false }
  if (storedUrl) return { ...base, ...lock, url: storedUrl, source: 'setting' }
  if (localUrl) return { ...base, ...lock, url: localUrl, source: 'local-default' }
  return { ...base, ...lock, url: undefined, source: 'none' }
}

/** Effective canonical public application address, or undefined. See {@link describePublicAppUrl}. */
export function resolvePublicAppUrl(
  env: NodeJS.ProcessEnv = process.env,
  stored: string | undefined = storedPublicAppUrl()
): string | undefined {
  return describePublicAppUrl(env, stored).url
}
