import { afterEach, beforeEach, expect, test } from 'bun:test'
import { inArray } from 'drizzle-orm'
import { db, secrets, settings } from '../../../db'
import { getSecretStore, resetSecretStore } from '../../secrets'
import { getSettingsStore, resetSettingsStore } from '../../settings'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  configurePushIntegration,
  getPushIntegrationSettings,
  initializePushIntegrationStates,
  setPushIntegrationEnabled,
} from './settings'
import { getApnsConfig } from '../../push/apns'
import { getVapidContactSubject, loadOrGenerateVapidKeys } from '../../push/vapid'
import { NotificationService } from '../../notifications/service'
let tempDir = ''
const credentialKeys = [
  'APNS_KEY_P8',
  'APNS_KEY_P8_FILE',
  'APNS_KEY_ID',
  'APNS_TEAM_ID',
  'APNS_BUNDLE_ID',
  'APNS_ENV',
  'VAPID_SUBJECT',
  'VAPID_PUBLIC_KEY',
  'VAPID_PRIVATE_KEY',
]
const settingKeys = ['__integration-enabled:apple-push', '__integration-enabled:web-push']
const priorEnv = new Map<string, string | undefined>()
let priorSecrets: (typeof secrets.$inferSelect)[] = []
let priorSettings: (typeof settings.$inferSelect)[] = []
beforeEach(async () => {
  for (const key of [
    ...credentialKeys,
    'FICUS_ENCRYPTION_KEY',
    'FICUS_MANAGED',
    'FICUS_MANAGED_SECRET_KEYS',
    'VAPID_KEYS_PATH',
  ]) {
    priorEnv.set(key, process.env[key])
    delete process.env[key]
  }
  tempDir = mkdtempSync(join(tmpdir(), 'tau-push-settings-'))
  process.env.VAPID_KEYS_PATH = join(tempDir, 'vapid.json')
  process.env.FICUS_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
  priorSecrets = await db.select().from(secrets).where(inArray(secrets.key, credentialKeys))
  priorSettings = await db.select().from(settings).where(inArray(settings.key, settingKeys))
  await db.delete(secrets).where(inArray(secrets.key, credentialKeys))
  await db.delete(settings).where(inArray(settings.key, settingKeys))
  resetSecretStore()
  resetSettingsStore()
  await getSecretStore().initialize()
  await getSettingsStore().initialize()
})
afterEach(async () => {
  await db.delete(secrets).where(inArray(secrets.key, credentialKeys))
  await db.delete(settings).where(inArray(settings.key, settingKeys))
  if (priorSecrets.length) await db.insert(secrets).values(priorSecrets)
  if (priorSettings.length) await db.insert(settings).values(priorSettings)
  rmSync(tempDir, { recursive: true, force: true })
  for (const [key, value] of priorEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  resetSecretStore()
  resetSettingsStore()
})

const privateKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString()
const apple = {
  APNS_KEY_P8: privateKey,
  APNS_KEY_ID: 'ABCDE12345',
  APNS_TEAM_ID: 'FGHIJ67890',
  APNS_BUNDLE_ID: 'test.tau',
}

test('push credentials are validated before writes and private keys remain redacted', async () => {
  await configurePushIntegration('apple-push', apple, 'test')
  expect(getPushIntegrationSettings('apple-push').fields[0]).toMatchObject({ configured: true, secret: true })
  expect(JSON.stringify(getPushIntegrationSettings('apple-push'))).not.toContain(privateKey)
  await expect(
    configurePushIntegration('apple-push', { APNS_KEY_P8: 'bad', APNS_BUNDLE_ID: 'changed' }, 'test')
  ).rejects.toThrow('valid Apple')
  expect(getSecretStore().get('APNS_BUNDLE_ID')).toBe('test.tau')
  await expect(configurePushIntegration('apple-push', { FICUS_PASSWORD: 'bad' }, 'test')).rejects.toThrow('Unknown')
  for (const subject of ['mailto:', 'mailto:not-an-email', 'ftp://example.com'])
    await expect(configurePushIntegration('web-push', { VAPID_SUBJECT: subject }, 'test')).rejects.toThrow(
      'contact URL'
    )
  await configurePushIntegration('web-push', { VAPID_SUBJECT: 'mailto:admin@example.com' }, 'test')
  expect(getPushIntegrationSettings('web-push').fields[0]).toMatchObject({ value: 'mailto:admin@example.com' })
})
test('fresh push integrations start disabled and keep that choice after keys are generated', async () => {
  await initializePushIntegrationStates()
  for (const key of settingKeys) expect(getSettingsStore().getStoredValue(key)).toBe('false')
  await loadOrGenerateVapidKeys()
  await initializePushIntegrationStates()
  expect(getSettingsStore().getStoredValue(settingKeys[1])).toBe('false')
})
test('existing push delivery survives upgrade, disable gates delivery, and resume preserves signing keys', async () => {
  await configurePushIntegration('apple-push', apple, 'test')
  const vapid = await loadOrGenerateVapidKeys()
  await initializePushIntegrationStates()
  expect(getApnsConfig()?.keyId).toBe(apple.APNS_KEY_ID)
  expect(getSettingsStore().getStoredValue(settingKeys[1])).toBe('true')
  await setPushIntegrationEnabled('apple-push', false, 'test')
  await setPushIntegrationEnabled('web-push', false, 'test')
  await initializePushIntegrationStates()
  expect(getApnsConfig()).toBeNull()
  expect(getSettingsStore().getStoredValue(settingKeys[1])).toBe('false')
  // Disabled delivery returns before querying subscriptions, even with an invalid recipient.
  const service = new NotificationService() as unknown as {
    sendWebPush: (users: string[], event: unknown) => Promise<void>
  }
  await service.sendWebPush(['not-a-uuid'], {})
  await setPushIntegrationEnabled('apple-push', true, 'test')
  await setPushIntegrationEnabled('web-push', true, 'test')
  expect(getApnsConfig()?.keyP8).toBe(privateKey)
  expect(await loadOrGenerateVapidKeys()).toEqual(vapid)
})
test('platform-managed inline and file signing keys cannot be overridden', async () => {
  process.env.FICUS_MANAGED = '1'
  process.env.FICUS_MANAGED_SECRET_KEYS = 'APNS_KEY_P8_FILE'
  process.env.APNS_KEY_P8_FILE = '/platform/protected.p8'
  expect(getPushIntegrationSettings('apple-push').fields[0]).toMatchObject({ managed: true, configured: true })
  expect(JSON.stringify(getPushIntegrationSettings('apple-push'))).not.toContain('/platform/')
  await expect(configurePushIntegration('apple-push', { APNS_KEY_P8: privateKey }, 'test')).rejects.toThrow('managed')
  process.env.FICUS_MANAGED_SECRET_KEYS = 'APNS_KEY_P8'
  process.env.APNS_KEY_P8 = privateKey
  await expect(configurePushIntegration('apple-push', { APNS_KEY_P8: null }, 'test')).rejects.toThrow('managed')
})

test('Web Push stays unconfigured without a valid contact and rejects clearing a required contact', async () => {
  await setPushIntegrationEnabled('web-push', true, 'test')
  expect(getPushIntegrationSettings('web-push').fields[0]).toMatchObject({ required: true, configured: false })
  const service = new NotificationService() as unknown as {
    sendWebPush: (users: string[], event: unknown) => Promise<void>
  }
  await service.sendWebPush(['not-a-uuid'], {})
  for (const value of ['', 'mailto:', 'not-an-address']) expect(getVapidContactSubject(value)).toBeUndefined()
  await configurePushIntegration('web-push', { VAPID_SUBJECT: 'mailto:admin@example.com' }, 'test')
  await expect(configurePushIntegration('web-push', { VAPID_SUBJECT: '  ' }, 'test')).rejects.toThrow()
  expect(getVapidContactSubject()).toBe('mailto:admin@example.com')
  expect(getPushIntegrationSettings('web-push').fields[0].configured).toBe(true)
})
