import { afterEach, beforeEach, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { db, secrets } from '../../../db'
import { SecretStore } from '../../secrets/store'
import {
  configureGitHubWebhook,
  getGitHubWebhookSettings,
  GITHUB_WEBHOOK_SETTINGS_KEY,
  LEGACY_GITHUB_WEBHOOK_SECRET_KEY,
  migrateGitHubWebhookSettings,
  resolveGitHubWebhookSecret,
} from './webhook-settings'

let store: SecretStore
const original = {
  encryption: process.env.FICUS_ENCRYPTION_KEY,
  app: process.env.APP_URL,
  base: process.env.APP_BASE_PATH,
  legacy: process.env.GITHUB_WEBHOOK_SECRET,
}
beforeEach(async () => {
  process.env.FICUS_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
  process.env.APP_URL = 'https://tau.example/team'
  delete process.env.APP_BASE_PATH
  delete process.env.GITHUB_WEBHOOK_SECRET
  await db.delete(secrets).where(eq(secrets.key, GITHUB_WEBHOOK_SETTINGS_KEY))
  await db.delete(secrets).where(eq(secrets.key, LEGACY_GITHUB_WEBHOOK_SECRET_KEY))
  store = new SecretStore()
  await store.initialize()
})
afterEach(async () => {
  await db.delete(secrets).where(eq(secrets.key, GITHUB_WEBHOOK_SETTINGS_KEY))
  await db.delete(secrets).where(eq(secrets.key, LEGACY_GITHUB_WEBHOOK_SECRET_KEY))
  for (const [key, value] of Object.entries({
    FICUS_ENCRYPTION_KEY: original.encryption,
    APP_URL: original.app,
    APP_BASE_PATH: original.base,
    GITHUB_WEBHOOK_SECRET: original.legacy,
  })) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

test('settings encrypt signing material, return only status and preserve public base paths', async () => {
  const candidate = 'webhook-signing-material'
  const result = await configureGitHubWebhook({ secret: candidate }, store, 'user:test')
  expect(result).toEqual({ configured: true, webhookUrl: 'https://tau.example/team/api/webhooks/github' })
  expect(getGitHubWebhookSettings(store)).toEqual(result)
  expect(resolveGitHubWebhookSecret(store)).toBe(candidate)
  const [row] = await db.select().from(secrets).where(eq(secrets.key, GITHUB_WEBHOOK_SETTINGS_KEY))
  expect(JSON.stringify(row)).not.toContain(candidate)
  expect(await store.list()).not.toContainEqual(expect.objectContaining({ key: GITHUB_WEBHOOK_SETTINGS_KEY }))
  await configureGitHubWebhook({ secret: null }, store, 'user:test')
  expect(resolveGitHubWebhookSecret(store)).toBeNull()
  expect(getGitHubWebhookSettings(store).configured).toBe(false)
})

test('invalid settings cannot change an existing secret', async () => {
  await configureGitHubWebhook({ secret: 'original' }, store, 'user:test')
  for (const input of [
    {},
    { secret: '' },
    { secret: ' ' },
    { secret: 123 },
    { secret: 'x', extra: true },
    { secret: 'x'.repeat(16_385) },
  ]) {
    await expect(configureGitHubWebhook(input, store, 'user:test')).rejects.toThrow()
    expect(resolveGitHubWebhookSecret(store)).toBe('original')
  }
})

test('startup migrates legacy database settings once and removes the old row', async () => {
  await store.set(LEGACY_GITHUB_WEBHOOK_SECRET_KEY, 'legacy-db-secret')
  const upgraded = new SecretStore()
  await upgraded.initialize()
  expect(resolveGitHubWebhookSecret(upgraded)).toBe('legacy-db-secret')
  expect(await db.select().from(secrets).where(eq(secrets.key, LEGACY_GITHUB_WEBHOOK_SECRET_KEY))).toHaveLength(0)
})

test('legacy environment import cannot restore a disabled or rotated webhook on restart', async () => {
  process.env.GITHUB_WEBHOOK_SECRET = 'legacy-env-secret'
  const upgraded = new SecretStore()
  await upgraded.initialize()
  expect(resolveGitHubWebhookSecret(upgraded)).toBe('legacy-env-secret')
  for (const secret of ['rotated-secret', null]) {
    await configureGitHubWebhook({ secret }, upgraded, 'user:test')
    const restarted = new SecretStore()
    await restarted.initialize()
    expect(resolveGitHubWebhookSecret(restarted)).toBe(secret)
  }
})

test('migration uses current durable settings even when its local cache predates a rotation', async () => {
  await store.set(LEGACY_GITHUB_WEBHOOK_SECRET_KEY, 'old-secret')
  const writer = new SecretStore()
  await writer.initialize()
  await configureGitHubWebhook({ secret: 'new-secret' }, writer, 'user:test')
  await migrateGitHubWebhookSettings(store)
  expect(resolveGitHubWebhookSecret(store)).toBe('new-secret')
})
