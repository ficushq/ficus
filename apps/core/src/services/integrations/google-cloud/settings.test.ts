import { afterEach, beforeEach, expect, test } from 'bun:test'
import { inArray } from 'drizzle-orm'
import { db, secrets, settings } from '../../../db'
import { getSecretStore, resetSecretStore } from '../../secrets'
import { getSettingsStore, resetSettingsStore } from '../../settings'
const credentialKeys = ['GOOGLE_SERVICE_ACCOUNT_JSON']
const settingKeys = ['__integration-enabled:google-cloud']
const priorEnv = new Map<string, string | undefined>()
let priorSecrets: (typeof secrets.$inferSelect)[] = []
let priorSettings: (typeof settings.$inferSelect)[] = []
beforeEach(async () => {
  for (const key of [
    ...credentialKeys,
    'FICUS_ENCRYPTION_KEY',
    'FICUS_MANAGED',
    'FICUS_MANAGED_SECRET_KEYS',
    'GOOGLE_APPLICATION_CREDENTIALS',
  ]) {
    priorEnv.set(key, process.env[key])
    delete process.env[key]
  }
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
  for (const [key, value] of priorEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  resetSecretStore()
  resetSettingsStore()
})

import { generateKeyPairSync } from 'node:crypto'
import {
  configureGoogleCloudIntegration,
  getGoogleCloudIntegrationSettings,
  initializeGoogleCloudIntegrationState,
  requireGoogleCloudSpeechEnabled,
  setGoogleCloudIntegrationEnabled,
} from './settings'
const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString()
const validJson = JSON.stringify({
  type: 'service_account',
  client_email: 'fixture@example.iam.gserviceaccount.com',
  private_key: privateKey,
})

test('Google validates and hides saved JSON, preserving the previous key on invalid input', async () => {
  await configureGoogleCloudIntegration({ GOOGLE_SERVICE_ACCOUNT_JSON: validJson }, 'test')
  const fields = getGoogleCloudIntegrationSettings().fields
  expect(fields[0]).toMatchObject({ configured: true, multiline: true, secret: true })
  expect(JSON.stringify(fields)).not.toContain(privateKey)
  expect(fields[0]).not.toHaveProperty('value')
  const stored = await db.select().from(secrets).where(inArray(secrets.key, credentialKeys))
  expect(JSON.stringify(stored)).not.toContain('BEGIN PRIVATE KEY')
  for (const value of [
    'invalid-sensitive-json',
    '{}',
    JSON.stringify({ type: 'authorized_user', client_secret: 'secret' }),
  ]) {
    await expect(configureGoogleCloudIntegration({ GOOGLE_SERVICE_ACCOUNT_JSON: value }, 'test')).rejects.toThrow(
      'valid Google Cloud'
    )
    expect(getSecretStore().get('GOOGLE_SERVICE_ACCOUNT_JSON')).toBe(validJson)
  }
  await expect(configureGoogleCloudIntegration({ OPENAI_API_KEY: 'wrong-field' }, 'test')).rejects.toThrow('Unknown')
  await expect(configureGoogleCloudIntegration({ GOOGLE_SERVICE_ACCOUNT_JSON: null }, 'test')).rejects.toThrow(
    'required'
  )
  expect(getGoogleCloudIntegrationSettings().fields[0].configured).toBe(true)
})
test('fresh Google integration is disabled, existing keys survive upgrade, explicit disable wins', async () => {
  await initializeGoogleCloudIntegrationState()
  await expect(requireGoogleCloudSpeechEnabled()).rejects.toThrow('Enable Google Cloud')
  await db.delete(settings).where(inArray(settings.key, settingKeys))
  await configureGoogleCloudIntegration({ GOOGLE_SERVICE_ACCOUNT_JSON: validJson }, 'test')
  await initializeGoogleCloudIntegrationState()
  await requireGoogleCloudSpeechEnabled()
  await setGoogleCloudIntegrationEnabled(false, 'test')
  await initializeGoogleCloudIntegrationState()
  await expect(requireGoogleCloudSpeechEnabled()).rejects.toThrow('Enable Google Cloud')
  expect(getSecretStore().get('GOOGLE_SERVICE_ACCOUNT_JSON')).toBe(validJson)
})
test('ADC file installations are recognized but remain subject to global disable', async () => {
  process.env.GOOGLE_APPLICATION_CREDENTIALS = '/operator/configured/credential.json'
  await initializeGoogleCloudIntegrationState()
  await requireGoogleCloudSpeechEnabled()
  await setGoogleCloudIntegrationEnabled(false, 'test')
  await expect(requireGoogleCloudSpeechEnabled()).rejects.toThrow('Enable Google Cloud')
})
test('platform-managed Google keys stay hidden and cannot be replaced', async () => {
  process.env.FICUS_MANAGED = '1'
  process.env.FICUS_MANAGED_SECRET_KEYS = 'GOOGLE_SERVICE_ACCOUNT_JSON'
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON = validJson
  expect(getGoogleCloudIntegrationSettings().fields[0]).toMatchObject({ managed: true, configured: true })
  await expect(configureGoogleCloudIntegration({ GOOGLE_SERVICE_ACCOUNT_JSON: validJson }, 'test')).rejects.toThrow(
    'managed'
  )
})
