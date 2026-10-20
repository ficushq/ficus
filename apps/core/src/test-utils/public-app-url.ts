import { eq } from 'drizzle-orm'
import { db, settingAuditLog, settings } from '../db'
import { PUBLIC_APP_URL_SETTING_KEY } from '../lib/public-app-url-format'
import { getSettingsStore } from '../services/settings/store'

const ENV_KEYS = ['APP_URL', 'PUBLIC_URL', 'FICUS_LOCAL_APP_URL'] as const

async function clearStoredPublicAppUrl(): Promise<void> {
  await db.delete(settings).where(eq(settings.key, PUBLIC_APP_URL_SETTING_KEY))
  await db.delete(settingAuditLog).where(eq(settingAuditLog.key, PUBLIC_APP_URL_SETTING_KEY))
  await getSettingsStore().refreshKey(PUBLIC_APP_URL_SETTING_KEY)
}

/**
 * Run `body` with the admin public address setting set to `url` and the
 * APP_URL/PUBLIC_URL/FICUS_LOCAL_APP_URL environment cleared, so consumers must
 * read the stored setting through the resolver. Restores everything afterwards.
 */
export async function withStoredPublicAppUrl<T>(url: string, body: () => T | Promise<T>): Promise<T> {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  for (const k of ENV_KEYS) delete process.env[k]
  await clearStoredPublicAppUrl()
  try {
    await getSettingsStore().writeManaged(PUBLIC_APP_URL_SETTING_KEY, url, {
      expectedVersion: 'unset',
      actor: 'system',
      source: 'test',
    })
    return await body()
  } finally {
    await clearStoredPublicAppUrl()
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  }
}
