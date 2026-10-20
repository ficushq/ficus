import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import { db, settingAuditLog, settings } from '../../db'
import { PUBLIC_APP_URL_MIGRATED_SETTING_KEY, PUBLIC_APP_URL_SETTING_KEY } from '../../lib/public-app-url-format'
import { getSettingsStore } from '../settings/store'
import { seedPublicAppUrlFromEnvironment } from './migration'

const KEYS = [PUBLIC_APP_URL_SETTING_KEY, PUBLIC_APP_URL_MIGRATED_SETTING_KEY]

async function reset() {
  await db.delete(settings).where(inArray(settings.key, KEYS))
  await db.delete(settingAuditLog).where(eq(settingAuditLog.key, PUBLIC_APP_URL_SETTING_KEY))
  const store = getSettingsStore()
  for (const key of KEYS) await store.refreshKey(key)
}

async function auditCount() {
  return (await db.select().from(settingAuditLog).where(eq(settingAuditLog.key, PUBLIC_APP_URL_SETTING_KEY))).length
}

describe('seedPublicAppUrlFromEnvironment', () => {
  beforeEach(reset)
  afterEach(reset)

  test('seeds a non-loopback APP_URL once and marks the migration', async () => {
    const store = getSettingsStore()
    expect(await seedPublicAppUrlFromEnvironment({ APP_URL: 'https://Ficus.Example.com/app/' })).toBe('seeded')
    expect(store.getStoredValue(PUBLIC_APP_URL_SETTING_KEY)).toBe('https://ficus.example.com/app')
    expect(store.getStoredValue(PUBLIC_APP_URL_MIGRATED_SETTING_KEY)).toBeTruthy()
    expect(await seedPublicAppUrlFromEnvironment({ APP_URL: 'https://other.example' })).toBe('already-done')
    expect(store.getStoredValue(PUBLIC_APP_URL_SETTING_KEY)).toBe('https://ficus.example.com/app')
    expect(await auditCount()).toBe(1)
    const [row] = await db.select().from(settingAuditLog).where(eq(settingAuditLog.key, PUBLIC_APP_URL_SETTING_KEY))
    expect(row).toMatchObject({ actor: 'system', source: 'migration', previousValue: null })
  })

  test('seeds from legacy PUBLIC_URL', async () => {
    expect(await seedPublicAppUrlFromEnvironment({ PUBLIC_URL: 'https://legacy.example' })).toBe('seeded')
    expect(getSettingsStore().getStoredValue(PUBLIC_APP_URL_SETTING_KEY)).toBe('https://legacy.example')
  })

  test('skips loopback, invalid and absent values but still marks', async () => {
    for (const env of [{ APP_URL: 'http://localhost:3000' }, { APP_URL: 'http://127.0.0.1:61896' }, { APP_URL: 'nope' }, {}]) {
      await reset()
      expect(await seedPublicAppUrlFromEnvironment(env)).toBe('skipped')
      expect(getSettingsStore().getStoredValue(PUBLIC_APP_URL_SETTING_KEY)).toBeUndefined()
      expect(getSettingsStore().getStoredValue(PUBLIC_APP_URL_MIGRATED_SETTING_KEY)).toBeTruthy()
    }
    expect(await auditCount()).toBe(0)
  })

  test('never overwrites an existing stored value', async () => {
    const store = getSettingsStore()
    await store.writeManaged(PUBLIC_APP_URL_SETTING_KEY, 'https://admin.example', {
      expectedVersion: 'unset',
      actor: 'user:a',
      source: 'admin-api',
    })
    expect(await seedPublicAppUrlFromEnvironment({ APP_URL: 'https://env.example' })).toBe('skipped')
    expect(store.getStoredValue(PUBLIC_APP_URL_SETTING_KEY)).toBe('https://admin.example')
  })
})
