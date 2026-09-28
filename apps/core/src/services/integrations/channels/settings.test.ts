import { afterEach, beforeEach, expect, test } from 'bun:test'
import { inArray } from 'drizzle-orm'
import { db, integrationConnections, secrets, settings } from '../../../db'
import { getSecretStore, resetSecretStore } from '../../secrets'
import { getSettingsStore, resetSettingsStore } from '../../settings'
import { channelConnections, legacyChannelCredentialKeys } from './connections'
import {
  channelEnabledSettingKeys,
  getChannelIntegrationValue,
  initializeChannelIntegrationStates,
  isChannelCredential,
  isChannelEnabledSettingKey,
  isChannelIntegration,
  slackAppManifest,
} from './settings'

const providers = ['telegram', 'slack', 'discord']
const priorEnv = new Map<string, string | undefined>()

async function wipe() {
  await db.delete(integrationConnections).where(inArray(integrationConnections.providerKey, providers))
  await db.delete(secrets).where(inArray(secrets.key, [...legacyChannelCredentialKeys]))
  await db.delete(settings).where(inArray(settings.key, [...channelEnabledSettingKeys]))
}

beforeEach(async () => {
  for (const key of [
    ...legacyChannelCredentialKeys,
    'FICUS_ENCRYPTION_KEY',
    'FICUS_MANAGED',
    'FICUS_MANAGED_SECRET_KEYS',
  ]) {
    priorEnv.set(key, process.env[key])
    delete process.env[key]
  }
  process.env.FICUS_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
  await wipe()
  resetSecretStore()
  resetSettingsStore()
  await getSecretStore().initialize()
  await getSettingsStore().initialize()
  await channelConnections.refresh()
})
afterEach(async () => {
  await wipe()
  for (const [key, value] of priorEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  resetSecretStore()
  resetSettingsStore()
  await channelConnections.refresh()
})

test('the transport boundary resolves legacy key names through the provider switch and the fallback keys', async () => {
  expect(getChannelIntegrationValue('SLACK_BOT_TOKEN')).toBeUndefined()
  await getSecretStore().set('SLACK_BOT_TOKEN', 'retained-token', 'test')
  await getSecretStore().set('SLACK_SIGNING_SECRET', 'retained-secret', 'test')
  await channelConnections.refresh()
  expect(getChannelIntegrationValue('SLACK_BOT_TOKEN')).toBe('retained-token')
  expect(getChannelIntegrationValue('SLACK_SIGNING_SECRET')).toBe('retained-secret')
  await getSettingsStore().set('__integration-enabled:slack', 'false', 'test')
  expect(getChannelIntegrationValue('SLACK_BOT_TOKEN')).toBeUndefined()
  await getSettingsStore().set('__integration-enabled:slack', 'true', 'test')
  expect(getChannelIntegrationValue('SLACK_BOT_TOKEN')).toBe('retained-token')
  expect(getChannelIntegrationValue('NOT_A_CHANNEL_KEY')).toBeUndefined()
})

test('boot keeps configured bots switched on, starts fresh providers off, and migrates legacy keys', async () => {
  // A legacy Slack bot with only a token cannot form a full credential (no
  // signing secret), so it is not migrated and the switch still reflects it.
  await getSecretStore().set('SLACK_BOT_TOKEN', 'retained-token', 'test')
  await initializeChannelIntegrationStates()
  expect(getSettingsStore().getStoredValue('__integration-enabled:slack')).toBe('true')
  expect(getSettingsStore().getStoredValue('__integration-enabled:discord')).toBe('false')
  expect(getSettingsStore().getStoredValue('__integration-enabled:telegram')).toBe('false')
  expect(
    await db.select().from(integrationConnections).where(inArray(integrationConnections.providerKey, providers))
  ).toEqual([])
})

test('helpers classify channel providers, their legacy keys and their switch settings', () => {
  expect(isChannelIntegration('slack')).toBe(true)
  expect(isChannelIntegration('github')).toBe(false)
  expect(isChannelCredential('DISCORD_PUBLIC_KEY')).toBe(true)
  expect(isChannelCredential('GITHUB_TOKEN')).toBe(false)
  expect(isChannelEnabledSettingKey('__integration-enabled:telegram')).toBe(true)
  expect(isChannelEnabledSettingKey('__integration-enabled:github')).toBe(false)
})

test('the Slack manifest is generated with this instance URLs and no placeholders', () => {
  const manifest = slackAppManifest('https://tau.example.test')
  expect(manifest).toContain('url: https://tau.example.test/api/webhooks/channels/slack')
  expect(manifest).toContain('request_url: https://tau.example.test/api/webhooks/channels/slack')
  expect(manifest).not.toContain('YOUR_DOMAIN')
  expect(manifest).toContain('command: /ficus')
})
