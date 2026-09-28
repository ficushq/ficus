import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll, spyOn } from 'bun:test'
import { randomBytes } from 'crypto'
import { inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import { db, modelTiers, secrets, settings } from '../db'
import { getSecretStore, resetSecretStore } from '../services/secrets'
import { getSettingsStore, resetSettingsStore } from '../services/settings'
import type { OAuthLoginCallbacks } from '@earendil-works/pi-ai/oauth'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import providerAuthRouter, { accountSummary, setOAuthCallbackTimeoutForTests } from './provider-auth'
import { identityMiddleware } from '../middleware/identity'
import {
  INVALID_JSON_BODY_MESSAGE,
  jsonBodyErrorHandler,
  jsonBodyErrorMiddleware,
} from '../middleware/json-body-errors'
import { authHeaders, cleanupTestRbac, createTestAdmin, createTestUser, type TestUser } from '../test-utils'
import { providerHealth, resetProviderHealthForTests } from '../services/provider-health/registry'
import {
  restoreProviderHealthTestState,
  snapshotProviderHealthTestState,
  type ProviderHealthTestSnapshot,
} from '../test-utils/openrouter-test-state'
import {
  addAccount,
  listAccounts,
  mutateAccountStore,
  mutateAccountStoreAsync,
  readAccountStore,
} from '../services/agent/account-store'
import { getModelRuntime, refreshModelRuntime } from '../services/agent/auth-backend'

const app = new Hono()
app.use('*', jsonBodyErrorMiddleware)
app.onError(jsonBodyErrorHandler)
app.use('*', identityMiddleware)
app.route('/', providerAuthRouter)

const prefix = `provider-auth-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
let admin: TestUser
let unprivileged: TestUser

function jsonReq(method = 'GET', body?: unknown, token = admin.token) {
  return {
    method,
    headers: { ...authHeaders(token), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }
}

async function guardRequest(path: string, init?: RequestInit, token?: string) {
  const headers = new Headers(init?.headers)
  if (token) {
    for (const [key, value] of Object.entries(authHeaders(token))) headers.set(key, value)
  }
  return app.request(path, { ...init, headers })
}

/**
 * Register a mock OAuth provider on the app-wide ModelRuntime singleton so the
 * provider-auth routes (which resolve providers via getModelRuntime()) can see
 * it. The OAuth login uses the legacy OAuthLoginCallbacks shape, which the
 * runtime bridges onto its AuthInteraction internally. Returns an unregister
 * fn for cleanup.
 */
async function registerMockProvider(
  id: string,
  login: (cb: OAuthLoginCallbacks) => Promise<{ refresh: string; access: string; expires: number }>
): Promise<void> {
  const runtime = await getModelRuntime()
  runtime.registerProvider(id, {
    name: `Mock ${id}`,
    api: 'openai-completions',
    baseUrl: `https://${id}.example.com/v1`,
    models: [
      {
        id: `${id}-mock`,
        name: `Mock ${id}`,
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 4096,
        maxTokens: 1024,
      },
    ],
    oauth: {
      name: `Mock ${id}`,
      login: login as any,
      refreshToken: async (c: any) => c,
      getApiKey: (c: any) => c.access,
    },
  })
}

async function unregisterOAuthProvider(id: string): Promise<void> {
  const runtime = await getModelRuntime()
  runtime.unregisterProvider(id)
}

const DUMMY_CREDS = { refresh: 'r', access: 'a', expires: Date.now() + 3_600_000 }
const OPENROUTER_ROUTING_TEST_TIERS = [
  'router-test',
  'mixed-malformed-summary',
  'slash-summary',
  'authored-router-summary',
]

describe('provider-auth routes', () => {
  test('OpenAI-compatible account creation reaches its dedicated route rather than generic API-key creation', async () => {
    const response = await app.request('/openai-compatible/accounts', jsonReq('POST', {}))
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'baseUrl, model, and providerId are required' })
  })

  const testKey = randomBytes(32).toString('hex')
  let originalEncryptionKey: string | undefined
  let providerHealthState: ProviderHealthTestSnapshot

  beforeAll(async () => {
    admin = await createTestAdmin({ prefix })
    unprivileged = await createTestUser({ prefix })
  })

  afterAll(async () => {
    await cleanupTestRbac(prefix)
  })

  beforeEach(async () => {
    originalEncryptionKey = process.env.FICUS_ENCRYPTION_KEY
    process.env.FICUS_ENCRYPTION_KEY = testKey
    providerHealthState = snapshotProviderHealthTestState()
    resetProviderHealthForTests()
    await db.delete(modelTiers).where(inArray(modelTiers.slug, OPENROUTER_ROUTING_TEST_TIERS))
    await db.delete(secrets)
    await db.delete(settings)
    resetSecretStore()
    resetSettingsStore()
    const store = getSecretStore()
    await store.initialize()
    await getSettingsStore().initialize()
  })

  afterEach(async () => {
    getSecretStore().stopPeriodicRefresh()
    await db.delete(modelTiers).where(inArray(modelTiers.slug, OPENROUTER_ROUTING_TEST_TIERS))
    await db.delete(secrets)
    await db.delete(settings)
    resetSecretStore()
    resetSettingsStore()
    restoreProviderHealthTestState(providerHealthState)
    if (originalEncryptionKey === undefined) delete process.env.FICUS_ENCRYPTION_KEY
    else process.env.FICUS_ENCRYPTION_KEY = originalEncryptionKey
    // Credential routes refresh the process-wide runtime; restore its empty
    // account snapshot so later suites do not inherit this file's last write.
    await refreshModelRuntime()
  })

  // --- API Key routes ---

  test('GET / returns empty list initially', async () => {
    const res = await app.request('/', jsonReq())
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data).toEqual([])
  })

  test('PUT /:provider sets an API key', async () => {
    const res = await app.request('/anthropic', jsonReq('PUT', { key: 'sk-ant-test-123' }))
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data).toEqual({ provider: 'anthropic', updated: true })
  })

  test('GET / lists providers after setting', async () => {
    await app.request('/anthropic', jsonReq('PUT', { key: 'sk-ant-test' }))
    await app.request('/openai', jsonReq('PUT', { key: 'sk-openai-test' }))

    const res = await app.request('/', jsonReq())
    const data = await res.json()
    expect(data).toHaveLength(2)
    const anthropic = data.find((p: any) => p.provider === 'anthropic')
    expect(anthropic).toMatchObject({
      provider: 'anthropic',
      type: 'api_key',
      hasCredential: true,
      configured: true,
      disabled: false,
      health: 'available',
    })
    expect(anthropic.accounts).toHaveLength(1)
    // Keys are never exposed in list
    expect(data.find((p: any) => p.key)).toBeUndefined()
  })

  test('GET /:provider returns status without key', async () => {
    await app.request('/anthropic', jsonReq('PUT', { key: 'sk-ant-test' }))

    const res = await app.request('/anthropic', jsonReq())
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data).toMatchObject({
      provider: 'anthropic',
      type: 'api_key',
      hasCredential: true,
      configured: true,
      disabled: false,
      health: 'available',
    })
    expect(data.accounts).toHaveLength(1)
  })

  test('GET /:provider returns 404 for unset provider', async () => {
    const res = await app.request('/nonexistent', jsonReq())
    expect(res.status).toBe(404)
  })

  test('GET / reflects provider exhaustion health from the registry', async () => {
    await app.request('/anthropic', jsonReq('PUT', { key: 'sk-ant-test' }))

    // Healthy by default.
    let res = await app.request('/', jsonReq())
    let data = await res.json()
    expect(data.find((p: any) => p.provider === 'anthropic').health).toBe('available')
    expect(data.find((p: any) => p.provider === 'anthropic').retryAt).toBeUndefined()

    // Mark exhausted — the API surfaces it with a retryAt.
    providerHealth.markExhausted('anthropic', { reason: 'rate-limit' })
    res = await app.request('/', jsonReq())
    data = await res.json()
    const entry = data.find((p: any) => p.provider === 'anthropic')
    expect(entry.health).toBe('exhausted')
    expect(entry.retryAt).toBeGreaterThan(Date.now())

    // The per-provider endpoint surfaces it too.
    const single = await (await app.request('/anthropic', jsonReq())).json()
    expect(single.health).toBe('exhausted')
    expect(single.retryAt).toBeGreaterThan(Date.now())
  })

  test('GET / keeps elapsed unresolved provider and account observations exhausted until genuine success', async () => {
    const added = await (
      await app.request('/anthropic/accounts', jsonReq('POST', { key: 'sk-a1', label: 'A1' }))
    ).json()
    providerHealth.markExhausted('anthropic', { reason: 'rate-limit', retryAt: Date.now() + 5 })
    providerHealth.markAccountExhausted('anthropic', added.id, { reason: 'rate-limit', retryAt: Date.now() + 5 })
    await Bun.sleep(10)

    let entry = (await (await app.request('/', jsonReq())).json()).find((p: any) => p.provider === 'anthropic')
    expect(entry).toMatchObject({ health: 'exhausted' })
    expect(entry.accounts[0]).toMatchObject({ health: 'exhausted' })
    expect(entry.retryAt).toBeNumber()
    expect(entry.accounts[0].retryAt).toBeNumber()

    expect(providerHealth.recordSuccess(providerHealth.captureAttempt('anthropic', added.id))).toBe(true)
    entry = (await (await app.request('/', jsonReq())).json()).find((p: any) => p.provider === 'anthropic')
    expect(entry).toMatchObject({ health: 'available' })
    expect(entry.accounts[0]).toMatchObject({ health: 'available' })

    expect(providerHealth.recordSuccess(providerHealth.captureAttempt('anthropic'))).toBe(true)
    entry = (await (await app.request('/', jsonReq())).json()).find((p: any) => p.provider === 'anthropic')
    expect(entry).toMatchObject({ health: 'available' })
    expect(entry.accounts[0]).toMatchObject({ health: 'available' })
  })

  test('DELETE /:provider removes a provider', async () => {
    await app.request('/anthropic', jsonReq('PUT', { key: 'sk-ant-test' }))

    const delRes = await app.request('/anthropic', jsonReq('DELETE'))
    expect(delRes.status).toBe(200)

    const getRes = await app.request('/anthropic', jsonReq())
    expect(getRes.status).toBe(404)
  })

  test('account endpoints add list update and delete accounts', async () => {
    const add = await app.request('/anthropic/accounts', jsonReq('POST', { key: 'sk-a1', label: 'Work' }))
    expect(add.status).toBe(200)
    const added = await add.json()
    expect(added.id).toStartWith('acc_')

    let list = await (await app.request('/anthropic/accounts', jsonReq())).json()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ id: added.id, label: 'Work', enabled: true, type: 'api_key', health: 'available' })
    expect(list[0].key).toBeUndefined()

    const update = await app.request(
      `/anthropic/accounts/${added.id}`,
      jsonReq('PUT', { label: 'Personal', enabled: false })
    )
    expect(update.status).toBe(200)
    list = await (await app.request('/anthropic/accounts', jsonReq())).json()
    expect(list[0]).toMatchObject({ label: 'Personal', enabled: false })

    const del = await app.request(`/anthropic/accounts/${added.id}`, jsonReq('DELETE'))
    expect(del.status).toBe(200)
    list = await (await app.request('/anthropic/accounts', jsonReq())).json()
    expect(list).toHaveLength(0)
  })

  test('PUT /:provider/accounts/order reorders accounts and returns the updated summaries', async () => {
    const a1 = await (
      await app.request('/anthropic/accounts', jsonReq('POST', { key: 'sk-a1', label: 'First' }))
    ).json()
    const a2 = await (
      await app.request('/anthropic/accounts', jsonReq('POST', { key: 'sk-a2', label: 'Second' }))
    ).json()
    const a3 = await (
      await app.request('/anthropic/accounts', jsonReq('POST', { key: 'sk-a3', label: 'Third' }))
    ).json()

    const res = await app.request('/anthropic/accounts/order', jsonReq('PUT', { order: [a3.id, a1.id, a2.id] }))
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.map((a: any) => a.id)).toEqual([a3.id, a1.id, a2.id])

    const list = await (await app.request('/anthropic/accounts', jsonReq())).json()
    expect(list.map((a: any) => a.id)).toEqual([a3.id, a1.id, a2.id])
  })

  test('PUT /:provider/accounts/order rejects a non-permutation order', async () => {
    const a1 = await (await app.request('/anthropic/accounts', jsonReq('POST', { key: 'sk-a1' }))).json()
    const a2 = await (await app.request('/anthropic/accounts', jsonReq('POST', { key: 'sk-a2' }))).json()

    // Missing an id.
    let res = await app.request('/anthropic/accounts/order', jsonReq('PUT', { order: [a1.id] }))
    expect(res.status).toBe(400)

    // Extra/unknown id.
    res = await app.request('/anthropic/accounts/order', jsonReq('PUT', { order: [a1.id, a2.id, 'acc_bogus'] }))
    expect(res.status).toBe(400)

    // Duplicate id.
    res = await app.request('/anthropic/accounts/order', jsonReq('PUT', { order: [a1.id, a1.id] }))
    expect(res.status).toBe(400)

    // Order untouched by the rejected requests.
    const list = await (await app.request('/anthropic/accounts', jsonReq())).json()
    expect(list.map((a: any) => a.id)).toEqual([a1.id, a2.id])
  })

  test('PUT /:provider/accounts/order rejects a malformed body', async () => {
    const res = await app.request('/anthropic/accounts/order', jsonReq('PUT', { order: 'not-an-array' }))
    expect(res.status).toBe(400)
  })

  test('legacy PUT upserts migrated default account without flattening multi-account data', async () => {
    await app.request('/anthropic', jsonReq('PUT', { key: 'sk-first' }))
    await app.request('/anthropic', jsonReq('PUT', { key: 'sk-updated' }))

    let accounts = await (await app.request('/anthropic/accounts', jsonReq())).json()
    expect(accounts).toHaveLength(1)
    expect(accounts[0].id).toBe('acc_migrated')

    await app.request('/anthropic/accounts', jsonReq('POST', { key: 'sk-second', label: 'Second' }))
    await app.request('/anthropic', jsonReq('PUT', { key: 'sk-third' }))
    accounts = await (await app.request('/anthropic/accounts', jsonReq())).json()
    expect(accounts).toHaveLength(3)
  })

  // D2: the legacy api-key PUT upserts a lone `acc_migrated` in place. That is
  // only safe when the account is itself an api_key — a legacy MIGRATED OAUTH
  // login also lands as a single `acc_migrated`, and overwriting it with an api
  // key would silently destroy the OAuth credential.
  test('legacy PUT does not overwrite a lone migrated OAUTH account with an api key', async () => {
    const provider = 'apikey-guard'
    await mutateAccountStore((store) => {
      store.accounts[provider] = [
        {
          id: 'acc_migrated',
          enabled: true,
          credential: { type: 'oauth', refresh: 'r-1', access: 'access-oauth', expires: 0 } as never,
        },
      ]
    }, 'system')

    const res = await app.request(`/${provider}`, jsonReq('PUT', { key: 'sk-new' }))
    expect(res.status).toBe(200)

    const accounts = listAccounts(readAccountStore(), provider)
    // The OAuth credential survives, and the api key is added ALONGSIDE it.
    expect(accounts).toHaveLength(2)
    const oauth = accounts.find((a) => a.credential.type === 'oauth')!
    expect(oauth.id).toBe('acc_migrated')
    expect((oauth.credential as any).access).toBe('access-oauth')
    expect(accounts.filter((a) => a.credential.type === 'api_key')).toHaveLength(1)
    expect((accounts.find((a) => a.credential.type === 'api_key')!.credential as any).key).toBe('sk-new')
  })

  test('GET / includes account summaries', async () => {
    await app.request('/anthropic/accounts', jsonReq('POST', { key: 'sk-a1', label: 'A1' }))
    const res = await app.request('/', jsonReq())
    const data = await res.json()
    const anthropic = data.find((p: any) => p.provider === 'anthropic')
    expect(anthropic.accounts).toHaveLength(1)
    expect(anthropic.accounts[0]).toMatchObject({ label: 'A1', health: 'available' })
  })

  test('PUT without key returns 400', async () => {
    const res = await app.request('/anthropic', jsonReq('PUT', {}))
    expect(res.status).toBe(400)
  })

  // --- OAuth routes ---

  test('GET /catalog returns providers from the pi registry', async () => {
    const res = await app.request('/catalog', jsonReq())
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(Array.isArray(data)).toBe(true)
    const ids = data.map((p: any) => p.id)
    expect(ids).toContain('zai')
    expect(ids).toContain('anthropic')
    expect(ids).toContain('openrouter')

    const zai = data.find((p: any) => p.id === 'zai')
    expect(zai.label).toBeDefined()
    expect(typeof zai.modelCount).toBe('number')
    expect(typeof zai.oauthAvailable).toBe('boolean')
    expect(typeof zai.disabled).toBe('boolean')
  })

  test('GET /catalog marks oauth-capable providers', async () => {
    const res = await app.request('/catalog', jsonReq())
    expect(res.status).toBe(200)
    const data = await res.json()
    const anthropic = data.find((p: any) => p.id === 'anthropic')
    expect(anthropic.oauthAvailable).toBe(true)
  })

  test('OpenRouter routing switch defaults off and reports valid derived tier positions', async () => {
    await db.insert(modelTiers).values({
      slug: 'router-test',
      label: 'Router Test',
      chain: 'anthropic:claude-sonnet-5:high,zai:unroutable:low,openai-codex:gpt-5.6-sol:xhigh',
    })
    const res = await app.request('/openrouter/routing', jsonReq())
    expect(res.status).toBe(200)
    const summary = await res.json()
    expect(summary.enabled).toBe(false)
    expect(summary.vendors).toEqual(expect.arrayContaining(['anthropic', 'openai']))
    expect(summary.tiers.find((tier: any) => tier.slug === 'router-test')).toMatchObject({
      fallbacks: ['openrouter:anthropic/claude-sonnet-5:high', 'openrouter:openai/gpt-5.6-sol:xhigh'],
    })
  })

  test('OpenRouter routing summary stays available for mixed malformed legacy chains', async () => {
    await db.insert(modelTiers).values({
      slug: 'mixed-malformed-summary',
      label: 'Mixed malformed',
      chain: 'malformed,anthropic:claude-sonnet-5:high',
    })
    const response = await app.request('/openrouter/routing', jsonReq())
    expect(response.status).toBe(200)
    const tier = (await response.json()).tiers.find((item: any) => item.slug === 'mixed-malformed-summary')
    expect(tier.fallbacks).toEqual(['openrouter:anthropic/claude-sonnet-5:high'])
  })

  test('OpenRouter routing summary tolerates slash syntax and authored OpenRouter candidates', async () => {
    await db.insert(modelTiers).values([
      { slug: 'slash-summary', label: 'Slash', chain: 'anthropic/claude-sonnet-5:high' },
      {
        slug: 'authored-router-summary',
        label: 'Authored',
        chain: 'openrouter:anthropic/claude-sonnet-5:high',
      },
    ])
    const response = await app.request('/openrouter/routing', jsonReq())
    expect(response.status).toBe(200)
    const tiers = (await response.json()).tiers
    expect(tiers.find((tier: any) => tier.slug === 'slash-summary').fallbacks).toEqual([
      'openrouter:anthropic/claude-sonnet-5:high',
    ])
    expect(tiers.find((tier: any) => tier.slug === 'authored-router-summary').fallbacks).toEqual([])
  })

  test('OpenRouter routing switch persists independently of credentials', async () => {
    await app.request('/openrouter', jsonReq('PUT', { key: 'sk-or' }))
    expect((await (await app.request('/openrouter/routing', jsonReq())).json()).enabled).toBe(false)

    const enabled = await app.request('/openrouter/routing', jsonReq('PUT', { enabled: true }))
    expect(enabled.status).toBe(200)
    expect((await enabled.json()).enabled).toBe(true)
    expect((await (await app.request('/openrouter', jsonReq())).json()).hasCredential).toBe(true)
  })

  // --- Provider enable/disable toggle ---

  test('PUT /:provider/enabled disables a provider (persisted, reflected by GET)', async () => {
    // provider-auth:write is required (admin holds '*').
    const res = await app.request('/anthropic/enabled', jsonReq('PUT', { enabled: false }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ provider: 'anthropic', enabled: false })

    // Catalog reflects the disabled flag.
    const catalogRes = await app.request('/catalog', jsonReq())
    const catalog = await catalogRes.json()
    expect(catalog.find((p: any) => p.id === 'anthropic').disabled).toBe(true)
  })

  test('PUT /:provider/enabled disabling does NOT delete credentials', async () => {
    // Set a credential, then disable the provider.
    await app.request('/anthropic', jsonReq('PUT', { key: 'sk-ant-test' }))
    await app.request('/anthropic/enabled', jsonReq('PUT', { enabled: false }))

    // The credential is still present (hasCredential stays true), just disabled.
    const res = await app.request('/anthropic', jsonReq())
    const data = await res.json()
    expect(data.hasCredential).toBe(true)
    expect(data.disabled).toBe(true)
    expect(data.configured).toBe(true)

    // Re-enabling reuses the existing credential.
    await app.request('/anthropic/enabled', jsonReq('PUT', { enabled: true }))
    const reEnabled = await (await app.request('/anthropic', jsonReq())).json()
    expect(reEnabled.hasCredential).toBe(true)
    expect(reEnabled.disabled).toBe(false)
  })

  test('PUT /:provider/enabled rejects a missing/invalid enabled flag', async () => {
    const res = await app.request('/anthropic/enabled', jsonReq('PUT', {}))
    expect(res.status).toBe(400)
  })

  test('GET /oauth/providers lists available OAuth providers', async () => {
    const res = await app.request('/oauth/providers', jsonReq())
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(Array.isArray(data)).toBe(true)
    // Should include at least anthropic and openai-codex
    const ids = data.map((p: any) => p.id)
    expect(ids).toContain('anthropic')
    expect(ids).toContain('openai-codex')
    // Each provider has id and name
    for (const p of data) {
      expect(p.id).toBeDefined()
      expect(p.name).toBeDefined()
    }
  })

  test('GET /:provider/oauth/status returns none when no flow pending', async () => {
    const res = await app.request('/anthropic/oauth/status', jsonReq())
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data).toEqual({ provider: 'anthropic', status: 'none' })
  })

  // These route contracts own mock providers; the real Anthropic login binds a
  // fixed callback port and can collide with an actual local login or another suite.
  async function withCodeFlow(provider: string, run: () => Promise<void>) {
    await registerMockProvider(provider, async (cb) => {
      cb.onAuth({ url: 'https://example.com/oauth/authorize' })
      await cb.onPrompt({ message: 'Authorization code' })
      return DUMMY_CREDS
    })
    try {
      await run()
    } finally {
      await app.request(`/${provider}/oauth/cancel`, jsonReq('POST'))
      await unregisterOAuthProvider(provider)
    }
  }

  test('POST /:provider/oauth/start starts a flow and returns auth URL', async () => {
    await withCodeFlow('mock-start-code', async () => {
      const res = await app.request('/mock-start-code/oauth/start', jsonReq('POST'))
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.provider).toBe('mock-start-code')
      expect(data.status).toBe('started')
      expect(data.need.kind).toBe('code')
      expect(data.need.authUrl).toBe('https://example.com/oauth/authorize')
    })
  })

  test('POST /:provider/oauth/start returns existing flow if already started', async () => {
    await withCodeFlow('mock-reuse-code', async () => {
      await app.request('/mock-reuse-code/oauth/start', jsonReq('POST'))
      const res = await app.request('/mock-reuse-code/oauth/start', jsonReq('POST'))
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.status).toBe('already_started')
      expect(data.need.kind).toBe('code')
      expect(data.need.authUrl).toBe('https://example.com/oauth/authorize')
    })
  })

  test('GET /:provider/oauth/status shows pending after start', async () => {
    await withCodeFlow('mock-status-code', async () => {
      await app.request('/mock-status-code/oauth/start', jsonReq('POST'))
      const res = await app.request('/mock-status-code/oauth/status', jsonReq())
      const data = await res.json()
      expect(data.status).toBe('pending')
      expect(data.need.kind).toBe('code')
      expect(data.need.authUrl).toBe('https://example.com/oauth/authorize')
    })
  })

  test('POST /:provider/oauth/callback returns 400 without pending flow', async () => {
    const res = await app.request('/openai/oauth/callback', jsonReq('POST', { code: 'test-code' }))
    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.error).toContain('No pending OAuth flow')
  })

  test('POST /:provider/oauth/callback returns 400 without code', async () => {
    await app.request('/anthropic/oauth/start', jsonReq('POST'))
    const res = await app.request('/anthropic/oauth/callback', jsonReq('POST', {}))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('Missing "code"')
  })

  test('POST /:provider/oauth/callback with invalid code returns 500', async () => {
    await app.request('/anthropic/oauth/start', jsonReq('POST'))
    // Provide a bogus code — the token exchange will fail
    const res = await app.request('/anthropic/oauth/callback', jsonReq('POST', { code: 'bogus-code#bogus-state' }))
    expect(res.status).toBe(500)
    const data = await res.json()
    expect(data.error).toContain('OAuth flow failed')
  })

  test('GET / surfaces the exhaustion reason and message alongside health', async () => {
    const a1 = await (await app.request('/anthropic/accounts', jsonReq('POST', { key: 'sk-a1', label: 'A1' }))).json()

    // Available accounts carry no reason at all.
    let entry = (await (await app.request('/', jsonReq())).json()).find((p: any) => p.provider === 'anthropic')
    expect(entry.healthReason).toBeUndefined()
    expect(entry.accounts[0].healthReason).toBeUndefined()

    providerHealth.markAccountExhausted('anthropic', a1.id, {
      reason: 'plan-credit',
      retryAt: Date.now() + 30 * 60_000,
    })
    entry = (await (await app.request('/', jsonReq())).json()).find((p: any) => p.provider === 'anthropic')
    expect(entry.accounts[0]).toMatchObject({
      health: 'exhausted',
      healthReason: 'plan-credit',
      healthMessage: 'Provider plan credit exhausted.',
    })
    // The provider summary reflects the account record that makes it unusable.
    expect(entry).toMatchObject({ health: 'exhausted', healthReason: 'plan-credit' })
  })

  test('GET /:provider reports a provider-level record reason when there are no account records', async () => {
    await app.request('/anthropic/accounts', jsonReq('POST', { key: 'sk-a1', label: 'A1' }))
    providerHealth.markExhausted('anthropic', { reason: 'rate-limit', retryAt: Date.now() + 60_000 })
    const summary = await (await app.request('/anthropic', jsonReq())).json()
    expect(summary).toMatchObject({
      health: 'exhausted',
      healthReason: 'rate-limit',
      healthMessage: 'Provider rate limit reached.',
    })
  })

  describe('provider health reset', () => {
    const RESET_AT = () => Date.now() + 30 * 60_000

    test('POST /:provider/health/reset clears the provider and all of its accounts', async () => {
      const a1 = await (await app.request('/anthropic/accounts', jsonReq('POST', { key: 'sk-a1', label: 'A1' }))).json()
      const a2 = await (await app.request('/anthropic/accounts', jsonReq('POST', { key: 'sk-a2', label: 'A2' }))).json()
      providerHealth.markExhausted('anthropic', { reason: 'plan-credit', retryAt: RESET_AT() })
      providerHealth.markAccountExhausted('anthropic', a1.id, { reason: 'plan-credit', retryAt: RESET_AT() })
      providerHealth.markAccountExhausted('anthropic', a2.id, { reason: 'plan-credit', retryAt: RESET_AT() })

      const res = await app.request('/anthropic/health/reset', jsonReq('POST'))
      expect(res.status).toBe(200)
      const summary = await res.json()
      expect(summary.provider).toBe('anthropic')
      expect(summary.health).toBe('available')
      expect(summary.retryAt).toBeUndefined()
      for (const account of summary.accounts) {
        expect(account.health).toBe('available')
        expect(account.retryAt).toBeUndefined()
      }
      expect(providerHealth.isProviderHealthy('anthropic')).toBe(true)
      expect(providerHealth.isAccountHealthy('anthropic', a1.id)).toBe(true)
      expect(providerHealth.isAccountHealthy('anthropic', a2.id)).toBe(true)
    })

    test('POST /:provider/accounts/:accountId/health/reset clears only that account', async () => {
      const a1 = await (await app.request('/anthropic/accounts', jsonReq('POST', { key: 'sk-a1', label: 'A1' }))).json()
      const a2 = await (await app.request('/anthropic/accounts', jsonReq('POST', { key: 'sk-a2', label: 'A2' }))).json()
      providerHealth.markAccountExhausted('anthropic', a1.id, { reason: 'plan-credit', retryAt: RESET_AT() })
      providerHealth.markAccountExhausted('anthropic', a2.id, { reason: 'plan-credit', retryAt: RESET_AT() })

      const res = await app.request(`/anthropic/accounts/${a1.id}/health/reset`, jsonReq('POST'))
      expect(res.status).toBe(200)
      const summary = await res.json()
      expect(summary.accounts.find((a: any) => a.id === a1.id)).toMatchObject({ health: 'available' })
      expect(summary.accounts.find((a: any) => a.id === a1.id).retryAt).toBeUndefined()
      expect(summary.accounts.find((a: any) => a.id === a2.id)).toMatchObject({ health: 'exhausted' })
      expect(providerHealth.isAccountHealthy('anthropic', a2.id)).toBe(false)
    })

    test('resets a provider that has a record but no stored accounts', async () => {
      // Providers configured by environment variable have no account-store rows,
      // yet failures still record provider-level health against them.
      providerHealth.markExhausted('envprovider', { reason: 'plan-credit', retryAt: RESET_AT() })
      const res = await app.request('/envprovider/health/reset', jsonReq('POST'))
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ provider: 'envprovider', health: 'available' })
      expect(providerHealth.isProviderHealthy('envprovider')).toBe(true)
    })

    test('refuses to clear a credential-kind account record', async () => {
      const a1 = await (await app.request('/anthropic/accounts', jsonReq('POST', { key: 'sk-a1', label: 'A1' }))).json()
      providerHealth.recordFailure(providerHealth.captureAttempt('anthropic', a1.id), { kind: 'invalid-credential' })

      const res = await app.request(`/anthropic/accounts/${a1.id}/health/reset`, jsonReq('POST'))
      expect(res.status).toBe(409)
      expect(await res.json()).toMatchObject({ code: 'credential_health' })
      // The remediation signal survives — re-authorizing is the only real fix.
      expect(providerHealth.getRecord('anthropic', a1.id)?.kind).toBe('invalid-credential')
    })

    test('provider reset clears transient records and reports the credential ones it skipped', async () => {
      const a1 = await (await app.request('/anthropic/accounts', jsonReq('POST', { key: 'sk-a1', label: 'A1' }))).json()
      const a2 = await (await app.request('/anthropic/accounts', jsonReq('POST', { key: 'sk-a2', label: 'A2' }))).json()
      providerHealth.markAccountExhausted('anthropic', a1.id, { reason: 'plan-credit', retryAt: RESET_AT() })
      providerHealth.recordFailure(providerHealth.captureAttempt('anthropic', a2.id), { kind: 'expired-oauth' })

      const res = await app.request('/anthropic/health/reset', jsonReq('POST'))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.skippedCredentialHealth).toEqual({ provider: false, accounts: [a2.id] })
      expect(providerHealth.isAccountHealthy('anthropic', a1.id)).toBe(true)
      expect(providerHealth.getRecord('anthropic', a2.id)?.kind).toBe('expired-oauth')
    })

    test('returns 404 for an unknown provider or account', async () => {
      await app.request('/anthropic/accounts', jsonReq('POST', { key: 'sk-a1', label: 'A1' }))
      expect((await app.request('/nonexistent/health/reset', jsonReq('POST'))).status).toBe(404)
      expect((await app.request('/anthropic/accounts/acct_missing/health/reset', jsonReq('POST'))).status).toBe(404)
      expect((await app.request('/nonexistent/accounts/acct_missing/health/reset', jsonReq('POST'))).status).toBe(404)
    })

    test('requires provider-auth:write', async () => {
      const a1 = await (await app.request('/anthropic/accounts', jsonReq('POST', { key: 'sk-a1', label: 'A1' }))).json()
      for (const path of ['/anthropic/health/reset', `/anthropic/accounts/${a1.id}/health/reset`]) {
        expect((await guardRequest(path, { method: 'POST' })).status).toBe(401)
        expect((await guardRequest(path, { method: 'POST' }, unprivileged.token)).status).toBe(403)
      }
    })
  })

  describe('RBAC guards', () => {
    test('requires provider-auth:read for read endpoints', async () => {
      for (const path of ['/', '/oauth/providers', '/anthropic', '/anthropic/oauth/status']) {
        expect((await guardRequest(path)).status).toBe(401)
        expect((await guardRequest(path, undefined, unprivileged.token)).status).toBe(403)
      }
    })

    test('rejects unauthorized non-object OAuth start before parsing', async () => {
      for (const token of [undefined, unprivileged.token]) {
        const response = await guardRequest(
          '/anthropic/oauth/start',
          { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'null' },
          token
        )
        expect(response.status).toBe(token ? 403 : 401)
      }
    })

    test('requires provider-auth:write for credential mutations', async () => {
      const routes: Array<[string, RequestInit]> = [
        ['/anthropic', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' }],
        ['/anthropic', { method: 'DELETE' }],
        ['/anthropic/oauth/start', { method: 'POST' }],
        ['/anthropic/oauth/callback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }],
        ['/anthropic/oauth/select', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }],
        [
          '/anthropic/accounts/order',
          { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ order: [] }) },
        ],
      ]
      for (const [path, init] of routes) {
        expect((await guardRequest(path, init)).status).toBe(401)
        expect((await guardRequest(path, init, unprivileged.token)).status).toBe(403)
      }
    })
  })

  describe('OAuth onSelect / device-code', () => {
    const cleanup: string[] = []
    afterEach(async () => {
      for (const id of cleanup) await unregisterOAuthProvider(id)
      cleanup.length = 0
    })

    test('POST /start rejects malformed optional JSON without starting a flow', async () => {
      const provider = 'mock-malformed-start-json'
      const secretMarker = 'credential-marker-must-not-leak'
      let loginCalls = 0

      await registerMockProvider(provider, async (callbacks) => {
        loginCalls++
        callbacks.onAuth({ url: 'https://example.com/auth', instructions: 'paste code' })
        await callbacks.onPrompt({ message: 'code?' })
        return DUMMY_CREDS
      })
      cleanup.push(provider)

      const response = await app.request(`/${provider}/oauth/start`, {
        method: 'POST',
        headers: { ...authHeaders(admin.token), 'content-type': 'application/json' },
        body: `{"accountId":"${secretMarker}"`,
      })
      const responseText = await response.text()

      expect(response.status).toBe(400)
      expect(response.headers.get('content-type')).toStartWith('application/json')
      expect(JSON.parse(responseText)).toEqual({ error: INVALID_JSON_BODY_MESSAGE })
      expect(responseText).not.toContain(secretMarker)
      expect(loginCalls).toBe(0)
      expect(await (await app.request(`/${provider}/oauth/status`, jsonReq())).json()).toEqual({
        provider,
        status: 'none',
      })
    })

    test('POST /start rejects an array root before provider login', async () => {
      const provider = 'mock-array-root-start-json'
      const secretMarker = 'oauth-root-secret-marker'
      let loginCalls = 0

      await registerMockProvider(provider, async (callbacks) => {
        loginCalls++
        callbacks.onAuth({ url: 'https://example.com/auth', instructions: 'paste code' })
        await callbacks.onPrompt({ message: 'code?' })
        return DUMMY_CREDS
      })
      cleanup.push(provider)

      const response = await app.request(`/${provider}/oauth/start`, {
        method: 'POST',
        headers: { ...authHeaders(admin.token), 'content-type': 'text/plain' },
        body: `["${secretMarker}"]`,
      })
      const responseText = await response.text()

      expect({ loginCalls }).toEqual({ loginCalls: 0 })
      expect(response.status).toBe(400)
      expect(response.headers.get('content-type')).toStartWith('application/json')
      expect(JSON.parse(responseText)).toEqual({ error: INVALID_JSON_BODY_MESSAGE })
      expect(responseText).not.toContain(secretMarker)
      expect(await (await app.request(`/${provider}/oauth/status`, jsonReq())).json()).toEqual({
        provider,
        status: 'none',
      })
    })

    test('cancel retires device login and allows a fresh browser choice', async () => {
      const provider = 'mock-cancel-restart'
      let deviceReady!: () => void
      const device = new Promise<void>((resolve) => {
        deviceReady = resolve
      })
      let browserReady!: () => void
      const browser = new Promise<void>((resolve) => {
        browserReady = resolve
      })
      await registerMockProvider(provider, async (cb) => {
        const choice = await cb.onSelect({
          message: 'Choose',
          options: [
            { id: 'device', label: 'Device' },
            { id: 'browser', label: 'Browser' },
          ],
        })
        if (choice === 'device') {
          cb.onDeviceCode({ userCode: 'TEST-CODE', verificationUri: 'https://example.com/device' })
          deviceReady()
        } else {
          cb.onAuth({ url: 'https://example.com/browser' })
          browserReady()
        }
        await cb.onPrompt({ message: 'code?' })
        return DUMMY_CREDS
      })
      cleanup.push(provider)
      try {
        await app.request(`/${provider}/oauth/start`, jsonReq('POST'))
        await app.request(`/${provider}/oauth/select`, jsonReq('POST', { optionId: 'device' }))
        await device
        const forbidden = await app.request(`/${provider}/oauth/cancel`, jsonReq('POST', undefined, unprivileged.token))
        expect(forbidden.status).toBe(403)
        const cancelled = await app.request(`/${provider}/oauth/cancel`, jsonReq('POST'))
        expect(cancelled.status).toBe(200)
        expect(await (await app.request(`/${provider}/oauth/status`, jsonReq())).json()).toEqual({
          provider,
          status: 'none',
        })
        expect((await app.request(`/${provider}/oauth/cancel`, jsonReq('POST'))).status).toBe(200)
        const fresh = await (await app.request(`/${provider}/oauth/start`, jsonReq('POST'))).json()
        expect(fresh.need.kind).toBe('select')
        await app.request(`/${provider}/oauth/select`, jsonReq('POST', { optionId: 'browser' }))
        await browser
        const status = await (await app.request(`/${provider}/oauth/status`, jsonReq())).json()
        expect(status.need.kind).toBe('code')
        expect(status.need.authUrl).toBe('https://example.com/browser')
        expect(listAccounts(readAccountStore(), provider)).toHaveLength(0)
      } finally {
        await app.request(`/${provider}/oauth/cancel`, jsonReq('POST'))
      }
    })

    test('POST /start surfaces a select need', async () => {
      await registerMockProvider('mock-select', async (cb) => {
        await cb.onSelect({
          message: 'Pick a login method',
          options: [
            { id: 'browser', label: 'Browser' },
            { id: 'device', label: 'Device code' },
          ],
        })
        return DUMMY_CREDS
      })
      cleanup.push('mock-select')

      const res = await app.request('/mock-select/oauth/start', jsonReq('POST'))
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.provider).toBe('mock-select')
      expect(data.need.kind).toBe('select')
      expect(data.need.message).toBe('Pick a login method')
      expect(data.need.options).toEqual([
        { id: 'browser', label: 'Browser' },
        { id: 'device', label: 'Device code' },
      ])
    })

    test('POST /select advances a browser choice to a code need', async () => {
      await registerMockProvider('mock-browser', async (cb) => {
        const choice = await cb.onSelect({ message: 'Pick', options: [{ id: 'browser', label: 'Browser' }] })
        if (choice !== 'browser') throw new Error('unexpected choice')
        cb.onAuth({ url: 'https://example.com/auth?x=1', instructions: 'paste code' })
        await cb.onPrompt({ message: 'code?' })
        return DUMMY_CREDS
      })
      cleanup.push('mock-browser')

      await app.request('/mock-browser/oauth/start', jsonReq('POST'))
      const res = await app.request('/mock-browser/oauth/select', {
        method: 'POST',
        headers: { ...authHeaders(admin.token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ optionId: 'browser' }),
      })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true })

      let need: any
      for (let i = 0; i < 40; i++) {
        need = (await (await app.request('/mock-browser/oauth/status', jsonReq())).json()).need
        if (need?.kind === 'code') break
        await new Promise((r) => setTimeout(r, 25))
      }
      expect(need.kind).toBe('code')
      expect(need.authUrl).toBe('https://example.com/auth?x=1')
    })

    test('POST /select advances a device choice to a device_code need', async () => {
      let release!: () => void
      const gate = new Promise<void>((r) => (release = r))
      await registerMockProvider('mock-device', async (cb) => {
        const choice = await cb.onSelect({ message: 'Pick', options: [{ id: 'device', label: 'Device' }] })
        if (choice !== 'device') throw new Error('unexpected choice')
        cb.onDeviceCode({ userCode: 'ABCD-1234', verificationUri: 'https://example.com/device' })
        await gate
        return DUMMY_CREDS
      })
      cleanup.push('mock-device')

      await app.request('/mock-device/oauth/start', jsonReq('POST'))
      await app.request('/mock-device/oauth/select', {
        method: 'POST',
        headers: { ...authHeaders(admin.token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ optionId: 'device' }),
      })

      let need: any
      for (let i = 0; i < 40; i++) {
        need = (await (await app.request('/mock-device/oauth/status', jsonReq())).json()).need
        if (need?.kind === 'device_code') break
        await new Promise((r) => setTimeout(r, 25))
      }
      expect(need).toEqual({
        kind: 'device_code',
        userCode: 'ABCD-1234',
        verificationUri: 'https://example.com/device',
      })
      release()
    })

    test('POST /select with null cancels selection and surfaces SDK cancellation error', async () => {
      await registerMockProvider('mock-cancel-select', async (cb) => {
        const choice = await cb.onSelect({ message: 'Pick', options: [{ id: 'browser', label: 'Browser' }] })
        if (choice === undefined) throw new Error('Login cancelled')
        return DUMMY_CREDS
      })
      cleanup.push('mock-cancel-select')

      await app.request('/mock-cancel-select/oauth/start', jsonReq('POST'))
      const res = await app.request('/mock-cancel-select/oauth/select', {
        method: 'POST',
        headers: { ...authHeaders(admin.token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ optionId: null }),
      })
      expect(res.status).toBe(200)

      let need: any
      for (let i = 0; i < 40; i++) {
        need = (await (await app.request('/mock-cancel-select/oauth/status', jsonReq())).json()).need
        if (need?.kind === 'error') break
        await new Promise((r) => setTimeout(r, 25))
      }
      expect(need.kind).toBe('error')
      expect(need.message).toContain('Login cancelled')
    })

    test('POST /select rejects invalid and non-pending selections', async () => {
      let release!: () => void
      const gate = new Promise<void>((r) => (release = r))
      await registerMockProvider('mock-invalid-select', async (cb) => {
        await cb.onSelect({ message: 'Pick', options: [{ id: 'browser', label: 'Browser' }] })
        await gate
        return DUMMY_CREDS
      })
      cleanup.push('mock-invalid-select')

      const noFlow = await app.request('/missing/oauth/select', {
        method: 'POST',
        headers: { ...authHeaders(admin.token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ optionId: 'browser' }),
      })
      expect(noFlow.status).toBe(400)

      await app.request('/mock-invalid-select/oauth/start', jsonReq('POST'))
      const invalid = await app.request('/mock-invalid-select/oauth/select', {
        method: 'POST',
        headers: { ...authHeaders(admin.token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ optionId: 'device' }),
      })
      expect(invalid.status).toBe(400)
      release()
    })
  })

  describe('store mutation races', () => {
    const cleanup: string[] = []
    afterEach(async () => {
      for (const id of cleanup) await unregisterOAuthProvider(id)
      cleanup.length = 0
    })

    test('concurrent account additions across providers all persist', async () => {
      const providers = ['race-p1', 'race-p2', 'race-p3', 'race-p4', 'race-p5']
      const responses = await Promise.all(
        providers.map((p, i) => app.request(`/${p}/accounts`, jsonReq('POST', { key: `sk-${i}`, label: p })))
      )
      for (const res of responses) expect(res.status).toBe(200)

      const store = readAccountStore()
      for (const p of providers) {
        expect(listAccounts(store, p)).toHaveLength(1)
      }
    })

    test('completing an OAuth flow does not clobber accounts added while the flow was pending', async () => {
      await registerMockProvider('mock-slow-oauth', async (cb) => {
        cb.onAuth({ url: 'https://example.com/auth', instructions: 'paste code' })
        await cb.onPrompt({ message: 'code?' })
        return DUMMY_CREDS
      })
      cleanup.push('mock-slow-oauth')

      // Start the flow; it now waits for the code.
      const startRes = await app.request('/mock-slow-oauth/oauth/start', jsonReq('POST'))
      expect(startRes.status).toBe(200)
      expect((await startRes.json()).need.kind).toBe('code')

      // While the flow is pending, add an unrelated API-key account.
      const addRes = await app.request('/race-other/accounts', jsonReq('POST', { key: 'sk-other' }))
      expect(addRes.status).toBe(200)

      // Complete the OAuth flow with the code — the callback awaits completion.
      const cbRes = await app.request('/mock-slow-oauth/oauth/callback', jsonReq('POST', { code: 'any-code' }))
      expect(cbRes.status).toBe(200)
      expect((await cbRes.json()).status).toBe('authenticated')

      // The OAuth merge must not have clobbered the account added mid-flow.
      const store = readAccountStore()
      expect(listAccounts(store, 'race-other')).toHaveLength(1)
      expect(listAccounts(store, 'mock-slow-oauth')).toHaveLength(1)
    })

    test('OAuth add with existing accounts preserves them and adds one OAuth account', async () => {
      const provider = 'mock-multi-oauth'
      await registerMockProvider(provider, async (cb) => {
        cb.onAuth({ url: 'https://example.com/auth', instructions: 'paste code' })
        await cb.onPrompt({ message: 'code?' })
        return { refresh: 'refresh-new', access: 'access-new', expires: Date.now() + 3_600_000 }
      })
      cleanup.push(provider)

      expect((await app.request(`/${provider}/accounts`, jsonReq('POST', { key: 'sk-existing-1' }))).status).toBe(200)
      expect((await app.request(`/${provider}/accounts`, jsonReq('POST', { key: 'sk-existing-2' }))).status).toBe(200)

      const startRes = await app.request(`/${provider}/oauth/start`, jsonReq('POST'))
      expect(startRes.status).toBe(200)
      expect((await startRes.json()).need.kind).toBe('code')

      const cbRes = await app.request(`/${provider}/oauth/callback`, jsonReq('POST', { code: 'any-code' }))
      expect(cbRes.status).toBe(200)
      expect((await cbRes.json()).status).toBe('authenticated')

      const accounts = listAccounts(readAccountStore(), provider)
      expect(accounts).toHaveLength(3)
      expect((accounts[0].credential as any).key).toBe('sk-existing-1')
      expect((accounts[1].credential as any).key).toBe('sk-existing-2')
      const oauthAccounts = accounts.filter((account) => (account.credential as any).access === 'access-new')
      expect(oauthAccounts).toHaveLength(1)
    })
  })

  describe('OAuth add vs reauthorize intent', () => {
    const cleanup: string[] = []
    afterEach(async () => {
      for (const id of cleanup) await unregisterOAuthProvider(id)
      cleanup.length = 0
    })

    // Register a mock whose login yields a distinct oauth credential each time
    // it runs, so we can tell an appended account from an overwritten one.
    async function registerCredMock(id: string, access: () => string): Promise<void> {
      await registerMockProvider(id, async (cb) => {
        cb.onAuth({ url: 'https://example.com/auth', instructions: 'paste code' })
        await cb.onPrompt({ message: 'code?' })
        return { refresh: `r-${access()}`, access: access(), expires: Date.now() + 3_600_000 }
      })
      cleanup.push(id)
    }

    async function runOAuth(provider: string, body?: unknown): Promise<void> {
      const startRes = await app.request(`/${provider}/oauth/start`, jsonReq('POST', body))
      expect(startRes.status).toBe(200)
      expect((await startRes.json()).need.kind).toBe('code')
      const cbRes = await app.request(`/${provider}/oauth/callback`, jsonReq('POST', { code: 'any-code' }))
      expect(cbRes.status).toBe(200)
      expect((await cbRes.json()).status).toBe('authenticated')
    }

    async function mustSettle<T>(promise: Promise<T>, message: string): Promise<T> {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        return await Promise.race([
          promise,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(message)), 2_000)
          }),
        ])
      } finally {
        if (timer) clearTimeout(timer)
      }
    }

    async function waitForOAuthDone(provider: string): Promise<void> {
      const deadline = Date.now() + 2_000
      let last: any
      while (Date.now() < deadline) {
        last = await (await app.request(`/${provider}/oauth/status`, jsonReq())).json()
        if (last.status === 'pending' && last.need?.kind === 'done') return
        if (last.need?.kind === 'error') throw new Error(`OAuth flow failed: ${last.need.message}`)
        await Bun.sleep(10)
      }
      throw new Error(`OAuth successor did not complete: ${JSON.stringify(last)}`)
    }

    const oauthCred = (access: string) =>
      ({ type: 'oauth', refresh: `r-${access}`, access, expires: 0 }) as unknown as Parameters<typeof addAccount>[2]

    // D1 regression: pendingFlows is keyed by provider only, so an abandoned
    // REAUTHORIZE flow must never be handed to a later ADD click — inheriting
    // its accountId would make the ADD replace the primary credential.
    test('an abandoned REAUTHORIZE flow is not inherited by a later ADD click', async () => {
      const provider = 'mock-intent-inherit'
      let access = 'access-primary'
      await registerCredMock(provider, () => access)

      // Seed the primary oauth account.
      await mutateAccountStore((store) => {
        addAccount(store, provider, oauthCred('access-primary'), 'primary')
      }, 'system')
      const primary = listAccounts(readAccountStore(), provider)[0]

      // (1) User clicks Re-authorize on the primary account → pending flow
      // carries accountId=primary. (2) User abandons it (no server-side cancel,
      // so the flow lingers).
      const reauthStart = await app.request(`/${provider}/oauth/start`, jsonReq('POST', { accountId: primary.id }))
      expect(reauthStart.status).toBe(200)
      expect((await reauthStart.json()).need.kind).toBe('code')

      // (3) User clicks "Add account" → must NOT get the abandoned flow back.
      const addStart = await app.request(`/${provider}/oauth/start`, jsonReq('POST'))
      expect(addStart.status).toBe(200)
      expect((await addStart.json()).status).not.toBe('already_started')

      // (4) User logs in as a DIFFERENT upstream account and pastes the code.
      access = 'access-second'
      const cbRes = await app.request(`/${provider}/oauth/callback`, jsonReq('POST', { code: 'any-code' }))
      expect(cbRes.status).toBe(200)

      // The primary credential MUST be intact, and the new login appended.
      const after = listAccounts(readAccountStore(), provider)
      expect(after).toHaveLength(2)
      const primaryAfter = after.find((a) => a.id === primary.id)!
      expect((primaryAfter.credential as any).access).toBe('access-primary')
      expect(after.some((a) => (a.credential as any).access === 'access-second')).toBe(true)
    })

    test('a re-clicked flow with the SAME intent still reuses the pending flow', async () => {
      const provider = 'mock-intent-same'
      await registerCredMock(provider, () => 'access-x')

      const first = await app.request(`/${provider}/oauth/start`, jsonReq('POST'))
      expect(first.status).toBe(200)
      // Same intent (ADD both times) → the in-progress flow is reused, not restarted.
      const second = await app.request(`/${provider}/oauth/start`, jsonReq('POST'))
      expect(second.status).toBe(200)
      expect((await second.json()).status).toBe('already_started')
    })

    // F1: cancelling by rejecting the manual-code promise only stops a login
    // parked on interaction.prompt. DEVICE-CODE logins (xAI, codex's headless
    // option, radius) notify once and then poll — they never await that promise,
    // so before the `superseded` flag they ran to completion and clobbered the
    // target chosen by the abandoned flow. Shape mirrors pi-ai's loginXai.
    test('a superseded DEVICE-CODE flow (never prompts) cannot write on completion', async () => {
      const provider = 'mock-devicecode-supersede'
      const releases: (() => void)[] = []
      await registerMockProvider(provider, async (cb) => {
        let release!: () => void
        const gate = new Promise<void>((r) => (release = r))
        releases.push(release)
        // Device-code shape: notify, then poll. The manual-code promise is never
        // awaited, so rejecting it cannot cancel this login.
        cb.onDeviceCode({ userCode: 'ABCD-EFGH', verificationUri: 'https://example.com/device' })
        await gate
        return { refresh: 'r-other', access: 'access-OTHER-IDENTITY', expires: Date.now() + 3_600_000 }
      })
      cleanup.push(provider)

      await mutateAccountStore((store) => {
        addAccount(store, provider, oauthCred('access-primary'), 'primary')
      }, 'system')
      const primary = listAccounts(readAccountStore(), provider)[0]

      // Re-authorize primary → device code shown; user abandons that tab.
      const aStart = await app.request(`/${provider}/oauth/start`, jsonReq('POST', { accountId: primary.id }))
      expect(aStart.status).toBe(200)
      expect((await aStart.json()).need.kind).toBe('device_code')

      // "Add account" supersedes it.
      const bStart = await app.request(`/${provider}/oauth/start`, jsonReq('POST'))
      expect(bStart.status).toBe(200)

      // The user returns to the OLD tab and authorizes there as a DIFFERENT
      // upstream identity. Release only the superseded flow.
      expect(releases).toHaveLength(2)
      releases[0]()
      await Bun.sleep(150)

      // The abandoned flow must not have written anything.
      const after = listAccounts(readAccountStore(), provider)
      expect(after).toHaveLength(1)
      expect((after.find((a) => a.id === primary.id)!.credential as any).access).toBe('access-primary')
      // ...and it reports a clear reason rather than silently doing nothing.
      const status = await (await app.request(`/${provider}/oauth/status`, jsonReq())).json()
      expect(status.need.kind).not.toBe('done')

      releases[1]()
    })

    // F2: a predecessor's late callback must not evict the SUCCESSOR flow the
    // user is currently looking at (deletes are identity-scoped, not by key).
    test('a superseded flow completing does not delete the successor flow', async () => {
      const provider = 'mock-successor-survives'
      let gotCode = false
      let release!: () => void
      const gate = new Promise<void>((r) => (release = r))
      await registerMockProvider(provider, async (cb) => {
        cb.onAuth({ url: 'https://example.com/auth', instructions: 'paste code' })
        await cb.onPrompt({ message: 'code?' })
        gotCode = true
        await gate
        return { refresh: 'r-A', access: 'access-A', expires: Date.now() + 3_600_000 }
      })
      cleanup.push(provider)

      await mutateAccountStore((store) => {
        addAccount(store, provider, oauthCred('access-primary'), 'primary')
      }, 'system')
      const primary = listAccounts(readAccountStore(), provider)[0]

      // A = REAUTHORIZE primary; it receives its code and blocks mid-exchange.
      expect((await app.request(`/${provider}/oauth/start`, jsonReq('POST', { accountId: primary.id }))).status).toBe(
        200
      )
      const aCallback = app.request(`/${provider}/oauth/callback`, jsonReq('POST', { code: 'code-A' }))
      while (!gotCode) await Bun.sleep(5)

      // B = ADD, started while A is mid-exchange → supersedes A.
      expect((await app.request(`/${provider}/oauth/start`, jsonReq('POST'))).status).toBe(200)

      release()
      // A was superseded: it reports the discard and writes nothing.
      const aRes = await aCallback
      expect(aRes.status).toBe(500)
      expect((await aRes.json()).error).toContain('superseded')
      expect((listAccounts(readAccountStore(), provider)[0].credential as any).access).toBe('access-primary')

      // B — the flow the user is actually looking at — is still alive and usable.
      const status = await (await app.request(`/${provider}/oauth/status`, jsonReq())).json()
      expect(status.status).toBe('pending')
      const bCallback = await app.request(`/${provider}/oauth/callback`, jsonReq('POST', { code: 'code-B' }))
      expect(bCallback.status).toBe(200)
      // B appended rather than touching the primary.
      const after = listAccounts(readAccountStore(), provider)
      expect(after).toHaveLength(2)
      expect((after[0].credential as any).access).toBe('access-primary')
    })

    // F3: mirror of the api-key PUT guard — an OAuth re-authorize must not be
    // allowed to replace an api_key account's credential and destroy the key.
    test('REAUTHORIZE targeting an api_key account is rejected at start', async () => {
      const provider = 'mock-reauth-typeguard'
      await registerCredMock(provider, () => 'access-oauth')

      expect((await app.request(`/${provider}/accounts`, jsonReq('POST', { key: 'sk-precious' }))).status).toBe(200)
      const apiAccount = listAccounts(readAccountStore(), provider)[0]

      const res = await app.request(`/${provider}/oauth/start`, jsonReq('POST', { accountId: apiAccount.id }))
      expect(res.status).toBe(400)
      expect((await res.json()).error).toContain('cannot be re-authorized')

      // No flow started, and the api key is untouched.
      const status = await (await app.request(`/${provider}/oauth/status`, jsonReq())).json()
      expect(status.status).toBe('none')
      const after = listAccounts(readAccountStore(), provider)
      expect(after).toHaveLength(1)
      expect((after[0].credential as any).key).toBe('sk-precious')
    })

    // F4: a same-intent restart while the first flow is still 'starting' used to
    // fall through, orphaning it — dropped from the map (so cleanupStaleFlows,
    // which only sweeps the map, can never see it) yet still running and still
    // able to persist.
    //
    // pi-ai 0.84 changed the behaviour this scenario turned on: a login whose
    // `AbortSignal` fires no longer runs to completion and loses the write race
    // under the store lock (the 0.80 path this test used to exercise) — it
    // rejects. `retireAndRemove` aborts the superseded flow, so the retired flow
    // now reaches provider-auth's reject path and never reaches a write at all.
    // The 0.80 version of this test spied on `mutateSecret` and asserted BOTH
    // flows wrote (retired-then-guarded); under 0.84 the retired flow writes
    // nothing, so that spy choreography no longer applies. The invariant is
    // unchanged and is what this still asserts: a retired still-starting flow
    // persists NOTHING, and only the successor's credential survives.
    test('a same-intent restart retires the still-starting flow instead of orphaning it', async () => {
      const provider = 'mock-starting-orphan'
      const logins = [0, 1].map(() => ({
        entered: Promise.withResolvers<void>(),
        release: Promise.withResolvers<void>(),
      }))
      let loginCount = 0

      await registerMockProvider(provider, async (cb) => {
        const index = loginCount++
        const mine = `access-${index + 1}`
        // The flow stays in 'starting' (no need surfaced) until released — that is
        // what makes it the "still-starting" flow a same-intent restart retires
        // (rather than a flow past 'starting', which returns 'already_started').
        logins[index].entered.resolve()
        await logins[index].release.promise
        cb.onDeviceCode({ userCode: 'CODE', verificationUri: 'https://example.com/device' })
        return { refresh: `r-${mine}`, access: mine, expires: Date.now() + 3_600_000 }
      })
      cleanup.push(provider)

      const accessValues = () =>
        listAccounts(readAccountStore(), provider)
          .map((account) => (account.credential as any).access)
          .sort()

      const start0 = Promise.resolve(app.request(`/${provider}/oauth/start`, jsonReq('POST')))
      let start1: Promise<Response> | undefined
      try {
        // Predecessor enters its login and parks while still in 'starting'.
        await mustSettle(logins[0].entered.promise, 'first OAuth login did not enter')

        // Same-intent restart while the predecessor is still 'starting': this
        // retires the predecessor (aborting its signal) rather than orphaning it,
        // and starts a fresh successor flow.
        start1 = Promise.resolve(app.request(`/${provider}/oauth/start`, jsonReq('POST')))
        await mustSettle(logins[1].entered.promise, 'successor OAuth login did not enter')
        expect(loginCount).toBe(2)

        // Nothing is persisted while both flows are still parked.
        expect(accessValues()).toEqual([])

        // Let both flows run to their end. The retired predecessor persists nothing
        // (its aborted login rejects before any write); only the successor lands.
        logins[0].release.resolve()
        logins[1].release.resolve()
        await mustSettle(start0, 'first OAuth start did not return')
        await mustSettle(start1, 'second OAuth start did not return')
        await waitForOAuthDone(provider)

        // Only the successor's credential survives; the predecessor's never wrote.
        expect(accessValues()).toEqual(['access-2'])
        expect(accessValues()).not.toContain('access-1')

        // The successor — the flow the user is looking at — is the live pending one.
        const status = await (await app.request(`/${provider}/oauth/status`, jsonReq())).json()
        expect(status.status).toBe('pending')
        expect(status.need.kind).toBe('done')
      } finally {
        logins[0].release.resolve()
        logins[1].release.resolve()
        await mustSettle(
          Promise.allSettled([start0, start1 ?? Promise.resolve()]),
          'OAuth start cleanup did not settle'
        )
        await app.request(`/${provider}`, jsonReq('DELETE'))
      }
      expect(listAccounts(readAccountStore(), provider)).toHaveLength(0)
    })

    // THE bug: a second OAuth "Add account" used to overwrite the first OAuth
    // account instead of adding a second one.
    test('ADD (no accountId) appends a SECOND oauth account instead of clobbering the first', async () => {
      const provider = 'mock-add-oauth'
      let n = 0
      await registerCredMock(provider, () => `access-${n}`)

      n = 1
      await runOAuth(provider)
      n = 2
      await runOAuth(provider)

      const accounts = listAccounts(readAccountStore(), provider)
      expect(accounts).toHaveLength(2)
      const accessValues = accounts.map((a) => (a.credential as any).access).sort()
      expect(accessValues).toEqual(['access-1', 'access-2'])
    })

    test('REAUTHORIZE (accountId) updates exactly the named account among several', async () => {
      const provider = 'mock-reauth-oauth'
      let access = 'access-target'
      await registerCredMock(provider, () => access)

      // Seed THREE oauth accounts and target the MIDDLE one, so the assertion
      // fails if the write targets the first (enabled) account instead of the
      // named one — a first-position target would pass vacuously.
      await mutateAccountStore((store) => {
        addAccount(store, provider, oauthCred('access-first'), 'first')
        addAccount(store, provider, oauthCred('access-middle'), 'middle')
        addAccount(store, provider, oauthCred('access-last'), 'last')
      }, 'system')
      expect((await app.request(`/${provider}/accounts`, jsonReq('POST', { key: 'sk-a' }))).status).toBe(200)

      const before = listAccounts(readAccountStore(), provider)
      const target = before.find((a) => a.label === 'middle')!
      expect(before.indexOf(target)).toBe(1) // genuinely middle, and not first-enabled

      // Reauthorize the MIDDLE oauth account by id.
      access = 'access-middle-refreshed'
      await runOAuth(provider, { accountId: target.id })

      const after = listAccounts(readAccountStore(), provider)
      expect(after).toHaveLength(before.length) // no new account added
      // Exactly the named account changed...
      expect((after.find((a) => a.id === target.id)!.credential as any).access).toBe('access-middle-refreshed')
      // ...and every sibling is byte-for-byte untouched.
      for (const original of before) {
        if (original.id === target.id) continue
        expect(after.find((a) => a.id === original.id)).toEqual(original)
      }
    })

    test('start with an unknown accountId fails fast with 404 and starts no flow', async () => {
      const provider = 'mock-reauth-404'
      await registerCredMock(provider, () => 'access-x')

      const res = await app.request(`/${provider}/oauth/start`, jsonReq('POST', { accountId: 'acc_missing' }))
      expect(res.status).toBe(404)
      expect((await res.json()).error).toContain('not found')

      // No pending flow was created.
      const status = await (await app.request(`/${provider}/oauth/status`, jsonReq())).json()
      expect(status.status).toBe('none')
    })

    test('REAUTHORIZE of an account deleted mid-flow errors without clobbering others', async () => {
      const provider = 'mock-reauth-deleted'
      let release!: () => void
      const gate = new Promise<void>((r) => (release = r))
      await registerMockProvider(provider, async (cb) => {
        cb.onAuth({ url: 'https://example.com/auth', instructions: 'paste code' })
        await cb.onPrompt({ message: 'code?' })
        await gate // hold completion until the account is deleted
        return { refresh: 'r-new', access: 'access-new', expires: Date.now() + 3_600_000 }
      })
      cleanup.push(provider)

      // Seed an oauth account (to reauthorize) plus a surviving api-key account.
      expect((await app.request(`/${provider}/accounts`, jsonReq('POST', { key: 'sk-survivor' }))).status).toBe(200)
      await mutateAccountStore((store) => {
        addAccount(
          store,
          provider,
          { type: 'oauth', refresh: 'r-old', access: 'access-old', expires: 0 } as any,
          'OAuth'
        )
      }, 'system')
      const seeded = listAccounts(readAccountStore(), provider)
      const oauthAccount = seeded.find((a) => a.credential.type === 'oauth')!

      // Start reauthorize of that oauth account.
      const startRes = await app.request(`/${provider}/oauth/start`, jsonReq('POST', { accountId: oauthAccount.id }))
      expect(startRes.status).toBe(200)
      expect((await startRes.json()).need.kind).toBe('code')

      // Delete the targeted account WHILE the flow is pending. Deleting an account
      // now also retires any flow aimed at it (ids are recycled, so a surviving
      // flow could later meet a DIFFERENT account wearing the same id), so the
      // flow is gone immediately rather than failing later at the write.
      expect((await app.request(`/${provider}/accounts/${oauthAccount.id}`, jsonReq('DELETE'))).status).toBe(200)
      const status = await (await app.request(`/${provider}/oauth/status`, jsonReq())).json()
      expect(status.status).toBe('none')

      const cbRes = await app.request(`/${provider}/oauth/callback`, jsonReq('POST', { code: 'any-code' }))
      expect(cbRes.status).toBe(400)
      expect((await cbRes.json()).error).toContain('No pending OAuth flow')

      // And when the abandoned login finally lands, it still writes nothing.
      release()
      await Bun.sleep(150)

      // The surviving api-key account was NOT clobbered, and no stray account added.
      const after = listAccounts(readAccountStore(), provider)
      expect(after).toHaveLength(1)
      expect(after[0].credential.type).toBe('api_key')
      expect((after[0].credential as any).key).toBe('sk-survivor')
    })

    // Serialized-writer seam: an OAuth completion must persist via the row-locked
    // mutateSecret path (mutateAccountStore), never a raw SecretStore.set on the
    // account-store key.
    test('OAuth completion writes through the serialized mutateSecret path, not a raw set', async () => {
      const provider = 'mock-seam-oauth'
      await registerCredMock(provider, () => 'access-seam')

      const store = getSecretStore()
      const mutateSpy = spyOn(store, 'mutateSecret')
      const setSpy = spyOn(store, 'set')
      try {
        await runOAuth(provider)
        const mutatedAccountKey = mutateSpy.mock.calls.some((call) => call[0] === 'PROVIDER_AUTH_DATA')
        const rawSetAccountKey = setSpy.mock.calls.some((call) => call[0] === 'PROVIDER_AUTH_DATA')
        expect(mutatedAccountKey).toBe(true)
        expect(rawSetAccountKey).toBe(false)
      } finally {
        mutateSpy.mockRestore()
        setSpy.mockRestore()
      }
    })

    // F6: /oauth/callback's timeout path used to drop the flow WITHOUT retiring
    // it. `pending.completed` never rejects, so that catch is only ever the
    // timeout — the login kept running as a zombie: un-superseded, invisible to
    // both cleanupStaleFlows (map-only) and any later /oauth/start, and free to
    // land minutes later on top of whatever the user's retry had just obtained.
    test('a callback that times out retires the flow so the zombie cannot write later', async () => {
      const provider = 'mock-callback-timeout'
      let release!: () => void
      const gate = new Promise<void>((r) => (release = r))
      await registerMockProvider(provider, async (cb) => {
        cb.onAuth({ url: 'https://example.com/auth', instructions: 'paste code' })
        await cb.onPrompt({ message: 'code?' })
        await gate // exchange stalls past the callback timeout
        return { refresh: 'r-zombie', access: 'access-ZOMBIE', expires: Date.now() + 3_600_000 }
      })
      cleanup.push(provider)

      await mutateAccountStore((store) => {
        addAccount(store, provider, oauthCred('access-primary'), 'primary')
      }, 'system')
      const primary = listAccounts(readAccountStore(), provider)[0]

      // Shrink the timeout so this costs milliseconds rather than 30s.
      const restoreTimeout = setOAuthCallbackTimeoutForTests(50)
      try {
        expect((await app.request(`/${provider}/oauth/start`, jsonReq('POST', { accountId: primary.id }))).status).toBe(
          200
        )
        const cbRes = await app.request(`/${provider}/oauth/callback`, jsonReq('POST', { code: 'any-code' }))
        expect(cbRes.status).toBe(500)
        expect((await cbRes.json()).error).toContain('Timeout')
      } finally {
        restoreTimeout()
      }

      // The user retries and succeeds — nothing is pending from the timed-out flow.
      const status = await (await app.request(`/${provider}/oauth/status`, jsonReq())).json()
      expect(status.status).toBe('none')

      // Now the stalled login finally finishes. It must NOT write.
      release()
      await Bun.sleep(150)
      const after = listAccounts(readAccountStore(), provider)
      expect(after).toHaveLength(1)
      expect((after[0].credential as any).access).toBe('access-primary')
    })

    // F7: `pendingFlows.get` and `.set` used to be separated by an await, so two
    // overlapping starts could each see no existing flow, and the loser was
    // orphaned un-retired.
    test('overlapping starts never orphan an un-retired flow', async () => {
      const provider = 'mock-concurrent-start'
      let n = 0
      await registerMockProvider(provider, async (cb) => {
        const mine = `access-${++n}`
        cb.onAuth({ url: 'https://example.com/auth', instructions: 'paste code' })
        await cb.onPrompt({ message: 'code?' })
        return { refresh: `r-${mine}`, access: mine, expires: Date.now() + 3_600_000 }
      })
      cleanup.push(provider)

      await mutateAccountStore((store) => {
        addAccount(store, provider, oauthCred('access-primary'), 'primary')
      }, 'system')
      const primary = listAccounts(readAccountStore(), provider)[0]

      // Force a REAL overlap instead of hoping the scheduler produces one: hold
      // the first start inside the runtime-build window (exactly the gap between
      // the map read and the map write) until the second start has completed.
      // Asserting a fixed status pair on an un-forced Promise.all depends on
      // scheduler luck — when the two happen to serialize, the second legitimately
      // supersedes the first and BOTH return 200, which is correct behaviour.
      let releaseBuild!: () => void
      const buildGate = new Promise<void>((r) => (releaseBuild = r))
      let firstInWindow!: () => void
      const inWindow = new Promise<void>((r) => (firstInWindow = r))
      const original = ModelRuntime.create.bind(ModelRuntime)
      let calls = 0
      const spy = spyOn(ModelRuntime, 'create').mockImplementation(async (opts: any) => {
        if (++calls === 1) {
          firstInWindow()
          await buildGate
        }
        return original(opts)
      })

      try {
        // A = REAUTHORIZE, parked inside its build window.
        const a = app.request(`/${provider}/oauth/start`, jsonReq('POST', { accountId: primary.id }))
        await inWindow

        // B = ADD, runs to completion while A is parked.
        const bRes = await app.request(`/${provider}/oauth/start`, jsonReq('POST'))
        expect(bRes.status).toBe(200)

        // A resumes and must DETECT that it was displaced rather than blindly
        // re-installing itself over the live flow (which would orphan B).
        releaseBuild()
        const aRes = await a
        expect(aRes.status).toBe(409)
      } finally {
        releaseBuild()
        spy.mockRestore()
      }

      // The live flow is B (the ADD): completing it appends, leaving primary intact.
      const cbRes = await app.request(`/${provider}/oauth/callback`, jsonReq('POST', { code: 'any-code' }))
      expect(cbRes.status).toBe(200)
      await Bun.sleep(50)
      const after = listAccounts(readAccountStore(), provider)
      expect(after).toHaveLength(2)
      expect((after.find((acc) => acc.id === primary.id)!.credential as any).access).toBe('access-primary')
    })

    // Recommended in review: re-authorizing account A but signing in as account B
    // would destroy A's credential AND leave two accounts sharing one upstream
    // identity — the exact state ADD's dedupe exists to prevent.
    test('REAUTHORIZE refuses a login that lands on a DIFFERENT upstream identity', async () => {
      const provider = 'mock-identity-mismatch'
      await registerMockProvider(provider, async (cb) => {
        cb.onAuth({ url: 'https://example.com/auth', instructions: 'paste code' })
        await cb.onPrompt({ message: 'code?' })
        // The user signs into the OTHER account.
        return {
          refresh: 'r-b',
          access: 'access-B-new',
          expires: Date.now() + 3_600_000,
          accountId: 'identity-B',
        } as never
      })
      cleanup.push(provider)

      await mutateAccountStore((store) => {
        addAccount(store, provider, { ...(oauthCred('access-A') as any), accountId: 'identity-A' }, 'work')
        addAccount(store, provider, { ...(oauthCred('access-B') as any), accountId: 'identity-B' }, 'personal')
      }, 'system')
      const before = listAccounts(readAccountStore(), provider)
      const work = before.find((a) => a.label === 'work')!

      expect((await app.request(`/${provider}/oauth/start`, jsonReq('POST', { accountId: work.id }))).status).toBe(200)
      const cbRes = await app.request(`/${provider}/oauth/callback`, jsonReq('POST', { code: 'any-code' }))
      expect(cbRes.status).toBe(500)
      expect((await cbRes.json()).error).toContain('different provider account')

      // Nothing written: identity A's credential intact, no duplicate identity B.
      const after = listAccounts(readAccountStore(), provider)
      expect(after).toEqual(before)
      expect(after.filter((a) => (a.credential as any).accountId === 'identity-B')).toHaveLength(1)
    })
  })

  // The real invariant behind five review rounds is NOT "a flow left the map
  // without being retired" — that was a proxy, and it leaks. It is: A FLOW WHOSE
  // INTENT THE USER CANCELLED NEVER WRITES. These tests target the write itself,
  // which is the only place that invariant can actually be enforced.
  //
  // A lint rule (eslint.config.mjs) additionally forbids direct
  // `pendingFlows.delete` outside retireAndRemove. That is a guard rail, not a
  // proof: it cannot see an aliased receiver, nor a flow displaced via
  // `pendingFlows.set`. These behavioural tests are the genuine net.
  describe('cancelled flows never write', () => {
    const cleanup: string[] = []
    afterEach(async () => {
      for (const id of cleanup) await unregisterOAuthProvider(id)
      cleanup.length = 0
    })

    const oauthCred2 = (access: string) =>
      ({ type: 'oauth', refresh: `r-${access}`, access, expires: 0 }) as unknown as Parameters<typeof addAccount>[2]

    // A1: the guard used to be read BEFORE `await mutateAccountStore(...)`, whose
    // callback does not run inline — it queues, then runs inside a transaction
    // after a row-locked SELECT. A flow retired anywhere in that window passed the
    // stale check and still wrote. Lands on identity-less providers (anthropic,
    // xAI, Copilot, Radius) where identity_mismatch cannot act as a backstop.
    test('a flow retired DURING the store write (after the guard) still writes nothing', async () => {
      const provider = 'mock-retire-midwrite'
      let release!: () => void
      let gotCode = false
      const gate = new Promise<void>((r) => (release = r))
      await registerMockProvider(provider, async (cb) => {
        cb.onAuth({ url: 'https://example.com/auth', instructions: 'paste code' })
        await cb.onPrompt({ message: 'code?' })
        gotCode = true
        await gate
        // Deliberately identity-LESS, so only the cancellation guard can stop it.
        return { refresh: 'r-other', access: 'access-OTHER-IDENTITY', expires: Date.now() + 3_600_000 }
      })
      cleanup.push(provider)

      await mutateAccountStore((store) => {
        addAccount(store, provider, oauthCred2('access-primary'), 'primary')
      }, 'system')
      const primary = listAccounts(readAccountStore(), provider)[0]

      // REAUTHORIZE primary; submit the code so the login is past its prompt and
      // heading for the write.
      expect((await app.request(`/${provider}/oauth/start`, jsonReq('POST', { accountId: primary.id }))).status).toBe(
        200
      )
      const callback = app.request(`/${provider}/oauth/callback`, jsonReq('POST', { code: 'any-code' }))
      // Wait until the callback has actually claimed THIS flow and handed it the
      // code, so the retirement below is unambiguously hitting the flow that is
      // mid-exchange (rather than racing the callback for the map entry).
      while (!gotCode) await Bun.sleep(5)

      // Occupy the account-store write lock. The completion handler will pass its
      // guard, call mutateAccountStore, and then QUEUE behind this — which is
      // precisely the window the guard used to be read before. Retiring while the
      // write is parked here is what a pre-await check cannot see.
      let releaseLock!: () => void
      const lockHeld = new Promise<void>((r) => (releaseLock = r))
      let lockAcquired = false
      const blocker = mutateAccountStoreAsync(async () => {
        lockAcquired = true
        await lockHeld
        return false // hold the lock, write nothing
      }, 'system')
      while (!lockAcquired) await Bun.sleep(5)

      // Let the login resolve: its handler now runs and parks on the lock.
      release()
      await Bun.sleep(50)

      // NOW the user clicks "Add account", retiring the in-flight reauthorize
      // whose write is already queued.
      expect((await app.request(`/${provider}/oauth/start`, jsonReq('POST'))).status).toBe(200)

      // Release the lock so the queued write proceeds — it must re-read the flag.
      releaseLock()
      await blocker
      await callback
      await Bun.sleep(200)

      const after = listAccounts(readAccountStore(), provider)
      expect(after).toHaveLength(1)
      expect((after[0].credential as any).access).toBe('access-primary')
    })

    // Same window, ADD intent: the reviewer's caveat is that a bare `return false`
    // under the lock leaves `result` undefined and the handler then blames a
    // missing account — reporting `Account "undefined" no longer exists` for a
    // flow that never named one.
    test('a retired ADD flow reports cancellation, not a bogus missing-account error', async () => {
      const provider = 'mock-retire-add'
      let release!: () => void
      let gotCode = false
      const gate = new Promise<void>((r) => (release = r))
      await registerMockProvider(provider, async (cb) => {
        cb.onAuth({ url: 'https://example.com/auth', instructions: 'paste code' })
        await cb.onPrompt({ message: 'code?' })
        gotCode = true
        await gate
        return { refresh: 'r-add', access: 'access-ADD', expires: Date.now() + 3_600_000 }
      })
      cleanup.push(provider)

      await mutateAccountStore((store) => {
        addAccount(store, provider, oauthCred2('access-primary'), 'primary')
      }, 'system')
      const primary = listAccounts(readAccountStore(), provider)[0]

      expect((await app.request(`/${provider}/oauth/start`, jsonReq('POST'))).status).toBe(200)
      const callback = app.request(`/${provider}/oauth/callback`, jsonReq('POST', { code: 'any-code' }))
      while (!gotCode) await Bun.sleep(5)
      // Retire the ADD flow with a differing intent.
      expect((await app.request(`/${provider}/oauth/start`, jsonReq('POST', { accountId: primary.id }))).status).toBe(
        200
      )
      release()
      const res = await callback
      expect(res.status).toBe(500)
      const error = (await res.json()).error as string
      expect(error).not.toContain('undefined')
      expect(error).toMatch(/supersed|nothing was saved/i)
      // And nothing was appended.
      expect(listAccounts(readAccountStore(), provider)).toHaveLength(1)
    })

    // Round-6 hole, and the generalized rule behind it: /oauth/start validates
    // preconditions that arbitrary user actions can invalidate before the flow
    // completes, so EVERY one of them must be re-validated under the write lock.
    // The type check was the one left behind. Account ids are deterministic and
    // recycled (acc_migrated / acc_salvaged), so an id resolving later does not
    // mean it is the same account — here it comes back as an API KEY.
    //
    // The recycle here happens OUT OF BAND (as pi-ai's CredentialStore.delete
    // does — it drops the whole provider entry without consulting pendingFlows —
    // and as any second API process would). That is deliberate: routing it
    // through the DELETE endpoint would let the retire-on-delete hardening kill
    // the flow first, and the test would no longer reach the check it exists to
    // pin. Endpoint-driven deletion is covered separately below.
    async function seedRecycledApiKey(provider: string) {
      await mutateAccountStore((store) => {
        delete store.accounts[provider]
      }, 'system')
      // The legacy PUT's empty-provider branch recreates the fixed id.
      expect((await app.request(`/${provider}`, jsonReq('PUT', { key: 'sk-precious' }))).status).toBe(200)
      const recreated = listAccounts(readAccountStore(), provider)
      expect(recreated).toHaveLength(1)
      expect(recreated[0].id).toBe('acc_migrated') // id genuinely recycled
      expect(recreated[0].credential.type).toBe('api_key')
    }

    test('a reauthorize cannot overwrite an API key that recycled its account id', async () => {
      const provider = 'mock-recycled-id'
      let release!: () => void
      let gotCode = false
      const gate = new Promise<void>((r) => (release = r))
      await registerMockProvider(provider, async (cb) => {
        cb.onAuth({ url: 'https://example.com/auth', instructions: 'paste code' })
        await cb.onPrompt({ message: 'code?' })
        gotCode = true
        await gate
        return { refresh: 'r-oauth', access: 'access-OAUTH', expires: Date.now() + 3_600_000 }
      })
      cleanup.push(provider)

      // A legacy migrated OAuth account — the shape every pre-multi-account
      // instance has — and the user clicks Re-authorize on it.
      await mutateAccountStore((store) => {
        store.accounts[provider] = [{ id: 'acc_migrated', enabled: true, credential: oauthCred2('access-legacy') }]
      }, 'system')
      expect(
        (await app.request(`/${provider}/oauth/start`, jsonReq('POST', { accountId: 'acc_migrated' }))).status
      ).toBe(200)
      const callback = app.request(`/${provider}/oauth/callback`, jsonReq('POST', { code: 'any-code' }))
      while (!gotCode) await Bun.sleep(5)

      await seedRecycledApiKey(provider)

      // The in-flight OAuth login lands on the recycled id. It must NOT overwrite
      // the API key — credentialIdentity is undefined for api_key, so
      // identity_mismatch cannot catch this; only the type re-check can.
      release()
      const res = await callback
      await Bun.sleep(150)

      expect(res.status).toBe(500)
      expect((await res.json()).error).toMatch(/api_key account|nothing was saved/)
      const after = listAccounts(readAccountStore(), provider)
      expect(after).toHaveLength(1)
      expect(after[0].credential.type).toBe('api_key')
      expect((after[0].credential as any).key).toBe('sk-precious')
    })

    // The device-code variant needs NO user action to complete: the polling loop
    // finishes on its own, so destruction would be hands-free after one click.
    test('the recycled-id overwrite is refused even when the login self-completes (device code)', async () => {
      const provider = 'mock-recycled-devicecode'
      let release!: () => void
      const gate = new Promise<void>((r) => (release = r))
      await registerMockProvider(provider, async (cb) => {
        cb.onDeviceCode({ userCode: 'ABCD-EFGH', verificationUri: 'https://example.com/device' })
        await gate // stands in for the polling loop completing on its own
        return { refresh: 'r-oauth', access: 'access-OAUTH', expires: Date.now() + 3_600_000 }
      })
      cleanup.push(provider)

      await mutateAccountStore((store) => {
        store.accounts[provider] = [{ id: 'acc_migrated', enabled: true, credential: oauthCred2('access-legacy') }]
      }, 'system')
      expect(
        (await app.request(`/${provider}/oauth/start`, jsonReq('POST', { accountId: 'acc_migrated' }))).status
      ).toBe(200)

      await seedRecycledApiKey(provider)

      // No callback, no further clicks — the login just finishes.
      release()
      await Bun.sleep(200)

      const after = listAccounts(readAccountStore(), provider)
      expect(after).toHaveLength(1)
      expect(after[0].credential.type).toBe('api_key')
      expect((after[0].credential as any).key).toBe('sk-precious')
    })

    // Defence in depth (not the guarantee): deleting an account through the API
    // also retires a flow aimed at it, so the doomed login stops early and frees
    // the provider slot instead of running on to be refused at the write.
    test.each([
      ['per-account delete', (p: string) => `/${p}/accounts/acc_migrated`],
      ['provider delete', (p: string) => `/${p}`],
    ])('deleting the targeted account retires the pending flow (%s)', async (label, path) => {
      const provider = `mock-delete-retires-${label.replace(/\s+/g, '-')}`
      await registerMockProvider(provider, async (cb) => {
        cb.onAuth({ url: 'https://example.com/auth', instructions: 'paste code' })
        await cb.onPrompt({ message: 'code?' })
        return { refresh: 'r', access: 'access-x', expires: Date.now() + 3_600_000 }
      })
      cleanup.push(provider)

      await mutateAccountStore((store) => {
        store.accounts[provider] = [{ id: 'acc_migrated', enabled: true, credential: oauthCred2('access-legacy') }]
      }, 'system')
      expect(
        (await app.request(`/${provider}/oauth/start`, jsonReq('POST', { accountId: 'acc_migrated' }))).status
      ).toBe(200)

      expect((await app.request(path(provider), jsonReq('DELETE'))).status).toBe(200)

      const status = await (await app.request(`/${provider}/oauth/status`, jsonReq())).json()
      expect(status.status).toBe('none')
    })

    // A7: claiming the provider slot before the runtime build meant a build
    // failure left a phantom entry — need='starting', already-resolved
    // `completed`, never retired — so /oauth/callback answered 200
    // "authenticated" having written nothing, and the slot stayed occupied.
    test('a runtime-build failure leaves no phantom flow occupying the provider slot', async () => {
      const provider = 'mock-build-failure'
      const runtime = await getModelRuntime()
      const spy = spyOn(runtime, 'getRegisteredProviderIds').mockImplementation(() => {
        throw new Error('runtime build exploded')
      })
      try {
        const res = await app.request(`/${provider}/oauth/start`, jsonReq('POST'))
        expect(res.status).toBeGreaterThanOrEqual(500)
      } finally {
        spy.mockRestore()
      }

      // No phantom left behind...
      const status = await (await app.request(`/${provider}/oauth/status`, jsonReq())).json()
      expect(status.status).toBe('none')
      // ...and the callback must not claim success for a flow that never ran.
      const cbRes = await app.request(`/${provider}/oauth/callback`, jsonReq('POST', { code: 'x' }))
      expect(cbRes.status).toBe(400)
      expect(listAccounts(readAccountStore(), provider)).toHaveLength(0)
    })
  })
})

describe('provider account response redaction', () => {
  test('account summaries never expose credential keys', () => {
    const summary = accountSummary('local', {
      id: 'a',
      enabled: true,
      credential: { type: 'api_key', key: 'secret-value' },
      kind: 'openai-compatible',
      providerId: 'local',
      baseUrl: 'http://localhost/v1',
      model: 'qwen',
      capabilities: { tools: true, probedAt: 'now' },
    })
    expect(JSON.stringify(summary)).not.toContain('secret-value')
    expect(summary).not.toHaveProperty('credential')
  })
})
