import {
  isLoopbackHostname,
  normalizePublicAppUrl,
  PUBLIC_APP_URL_MIGRATED_SETTING_KEY,
  PUBLIC_APP_URL_SETTING_KEY,
} from '../../lib/public-app-url-format'
import { getSettingsStore, SettingVersionConflictError, type SettingsStore } from '../settings/store'

export type PublicAppUrlSeedOutcome = 'seeded' | 'skipped' | 'already-done'

/**
 * One-time upgrade step (API startup): copy an existing non-loopback
 * `APP_URL`/`PUBLIC_URL` into the `PUBLIC_APP_URL` setting so the server keeps
 * its address if the operator later removes the environment variable. While
 * the variable is still set it keeps winning (and locks the setting), so the
 * effective address never changes here.
 *
 * Loopback values (`http://localhost:<port>` from older Desktop launchers and
 * `ficus setup`) are not seeded: they would masquerade as a configured public
 * address once the launcher switches to `FICUS_LOCAL_APP_URL`.
 */
export async function seedPublicAppUrlFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  store: SettingsStore = getSettingsStore()
): Promise<PublicAppUrlSeedOutcome> {
  if (store.getStoredValue(PUBLIC_APP_URL_MIGRATED_SETTING_KEY)) return 'already-done'
  const envUrl = normalizePublicAppUrl(env.APP_URL?.trim() || env.PUBLIC_URL?.trim())
  let outcome: PublicAppUrlSeedOutcome = 'skipped'
  if (
    envUrl &&
    !isLoopbackHostname(new URL(envUrl).hostname) &&
    store.getStoredValue(PUBLIC_APP_URL_SETTING_KEY) === undefined
  ) {
    try {
      await store.writeManaged(PUBLIC_APP_URL_SETTING_KEY, envUrl, {
        expectedVersion: 'unset',
        actor: 'system',
        source: 'migration',
      })
      outcome = 'seeded'
    } catch (error) {
      // Another replica seeded (or an admin saved) first; theirs stands.
      if (!(error instanceof SettingVersionConflictError)) throw error
    }
  }
  await store.set(PUBLIC_APP_URL_MIGRATED_SETTING_KEY, new Date().toISOString(), 'system')
  return outcome
}
