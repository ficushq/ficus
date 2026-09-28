import { afterEach, beforeEach, expect, test } from 'bun:test'
import { inArray } from 'drizzle-orm'
import { db, secrets, settings } from '../../../db'
import { getSecretStore, resetSecretStore } from '../../secrets'
import { getSettingsStore, resetSettingsStore } from '../../settings'
const credentialKeys = ['OPENAI_API_KEY', 'PROVIDER_AUTH_DATA']
const settingKeys = ['__integration-enabled:openai-services', 'DISABLED_PROVIDERS']
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

import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { SecretStoreCredentialStore } from '../../agent/auth-backend'
import { readAccountStore, writeAccountStore } from '../../agent/account-store'
import { setProviderEnabled, isProviderDisabled } from '../../model-selection/disabled-providers'
import { EmbeddingService } from '../../memory/indexer/EmbeddingService'
import {
  configureOpenAIServices,
  getOpenAIServiceKey,
  initializeOpenAIServicesState,
  setOpenAIServicesEnabled,
} from './settings'

test('service credentials and toggles never enroll OpenAI into agent model fallback', async () => {
  await setProviderEnabled('openai', false)
  await configureOpenAIServices({ OPENAI_API_KEY: 'service-only-test-key' }, 'test')
  await initializeOpenAIServicesState()
  expect(getOpenAIServiceKey()).toBe('service-only-test-key')
  expect(readAccountStore().accounts.openai).toBeUndefined()
  expect(process.env.OPENAI_API_KEY).toBeUndefined()
  expect(isProviderDisabled('openai')).toBe(true)
  const runtime = await ModelRuntime.create({
    credentials: new SecretStoreCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false,
  })
  expect(runtime.hasConfiguredAuth('openai')).toBe(false)
  await setOpenAIServicesEnabled(false, 'test')
  await setOpenAIServicesEnabled(true, 'test')
  expect(isProviderDisabled('openai')).toBe(true)
  expect(await runtime.getAuth('openai')).toBeUndefined()
})
test('agent-model accounts do not implicitly configure API services', async () => {
  await writeAccountStore(
    {
      version: 1,
      accounts: {
        openai: [{ id: 'model-only', enabled: true, credential: { type: 'api_key', key: 'model-only-test-key' } }],
      },
    },
    'test'
  )
  await initializeOpenAIServicesState()
  expect(getOpenAIServiceKey()).toBeUndefined()
  const runtime = await ModelRuntime.create({
    credentials: new SecretStoreCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false,
  })
  expect(runtime.hasConfiguredAuth('openai')).toBe(true)
  await configureOpenAIServices({ OPENAI_API_KEY: 'different-service-key' }, 'test')
  await setOpenAIServicesEnabled(true, 'test')
  await setOpenAIServicesEnabled(false, 'test')
  expect(await new SecretStoreCredentialStore().read('openai')).toEqual({ type: 'api_key', key: 'model-only-test-key' })
})
test('existing OpenAI services migrate enabled; disable gates existing embedding clients without deleting keys', async () => {
  await configureOpenAIServices({ OPENAI_API_KEY: 'existing-services-key' }, 'test')
  await initializeOpenAIServicesState()
  const embeddings = new EmbeddingService()
  expect(embeddings.isEnabled()).toBe(true)
  await setOpenAIServicesEnabled(false, 'test')
  expect(getOpenAIServiceKey()).toBeUndefined()
  expect(embeddings.isEnabled()).toBe(false)
  await initializeOpenAIServicesState()
  expect(getOpenAIServiceKey()).toBeUndefined()
  expect(getSecretStore().get('OPENAI_API_KEY')).toBe('existing-services-key')
  await setOpenAIServicesEnabled(true, 'test')
  expect(embeddings.isEnabled()).toBe(true)
})

import { Hono } from 'hono'
import { voiceRouter } from '../../../routes/voice'
import { voiceSessionRouter } from '../../../routes/voice-session'
import { createTranscribeRouter } from '../../../routes/transcribe'

test('service disable gates voice and transcription, and transcription uses rotated service credentials', async () => {
  const app = new Hono()
  app.use('*', async (c, next) => {
    c.set(
      'identity' as never,
      { type: 'system', systemTokenId: 'service-test', name: 'test', scopes: ['ai:voice', 'ai:transcribe'] } as never
    )
    await next()
  })
  app.route('/voice', voiceRouter)
  app.route('/session', voiceSessionRouter)
  const authorizations: string[] = []
  app.route(
    '/transcribe',
    createTranscribeRouter(async (key) => {
      authorizations.push(key)
      return { text: 'fixture transcription' }
    })
  )
  function audio() {
    const form = new FormData()
    form.set('audio', new File(['fixture'], 'audio.wav', { type: 'audio/wav' }))
    return form
  }
  {
    await configureOpenAIServices({ OPENAI_API_KEY: 'first-service-key' }, 'test')
    await setOpenAIServicesEnabled(false, 'test')
    expect(await (await app.request('/voice/status')).json()).toEqual({
      enabled: false,
      realtimeEnabled: false,
      transcriptionEnabled: false,
    })
    const sdp = new FormData()
    sdp.set('sdp', 'fixture-sdp')
    expect((await app.request('/session', { method: 'POST', body: sdp })).status).toBe(503)
    expect((await app.request('/transcribe', { method: 'POST', body: audio() })).status).toBe(503)
    expect(authorizations).toEqual([])
    await setOpenAIServicesEnabled(true, 'test')
    expect((await app.request('/transcribe', { method: 'POST', body: audio() })).status).toBe(200)
    await configureOpenAIServices({ OPENAI_API_KEY: 'rotated-service-key' }, 'test')
    expect((await app.request('/transcribe', { method: 'POST', body: audio() })).status).toBe(200)
    expect(authorizations).toEqual(['first-service-key', 'rotated-service-key'])
  }
})
