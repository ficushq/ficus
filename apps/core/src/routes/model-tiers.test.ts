import * as piCatalog from '@earendil-works/pi-ai/compat'
import * as modelCatalog from '../services/model-selection/model-catalog'
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { agentTypes, db, modelTiers } from '../db'
import { identityMiddleware } from '../middleware/identity'
import { ModelTierSync } from '../services/config-sync/model-tier-sync'
import { setOpenRouterTierExpansionEnabled, setProviderEnabled } from '../services/model-selection'
import { providerHealth, resetProviderHealthForTests } from '../services/provider-health/registry'
import * as accountStore from '../services/agent/account-store'
import { getSettingsStore } from '../services/settings'
import { authHeaders, cleanupTestRbac, createTestAdmin } from '../test-utils'
import type { TestUser } from '../test-utils/rbac'
import { modelTiersRoutes } from './model-tiers'
class TestSync extends ModelTierSync {
  constructor(public override readonly directory: string) {
    super()
  }
}
const app = new Hono().use('*', identityMiddleware).route('/api/model-tiers', modelTiersRoutes)
describe('model tier routes', () => {
  const prefix = `tier-route-${Date.now()}`
  let admin: TestUser
  beforeAll(async () => {
    admin = await createTestAdmin({ prefix, canonicalAdmin: true })
  })
  afterAll(async () => cleanupTestRbac(prefix))
  beforeEach(async () => {
    await db.delete(agentTypes)
    await db.delete(modelTiers)
  })
  test('catalog is permission-gated and returns only display metadata', async () => {
    const projected = modelCatalog.projectModelCatalog([
      {
        provider: 'local',
        id: 'model:preview',
        name: 'Local Model',
        api: 'openai-completions',
        reasoning: true,
        input: ['text', 'image'],
        contextWindow: 32000,
        maxTokens: 4096,
        baseUrl: 'https://private.example',
        headers: { Authorization: 'secret-fixture' },
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ])
    const spy = spyOn(modelCatalog, 'getModelCatalog').mockResolvedValue(projected)
    try {
      const denied = await app.request('/api/model-tiers/catalog')
      expect(denied.status).toBe(401)
      expect(spy).not.toHaveBeenCalled()
      const response = await app.request('/api/model-tiers/catalog', { headers: authHeaders(admin.token) })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual([
        {
          provider: 'local',
          id: 'model:preview',
          name: 'Local Model',
          reasoning: true,
          input: ['text', 'image'],
          contextWindow: 32000,
          maxTokens: 4096,
        },
      ])
    } finally {
      spy.mockRestore()
    }
  })
  test('GET exposes derived fallbacks at actual appended positions only while OpenRouter is enabled', async () => {
    await getSettingsStore().initialize()
    await db.insert(modelTiers).values({
      slug: 'visible-fallbacks',
      label: 'Visible',
      chain: 'openai-codex:gpt-5.6-sol:high,anthropic:claude-sonnet-5:medium',
    })
    const read = async () =>
      (await (await app.request('/api/model-tiers', { headers: authHeaders(admin.token) })).json())[0]

    const derived = ['openrouter:openai/gpt-5.6-sol:high', 'openrouter:anthropic/claude-sonnet-5:medium']
    expect((await read()).derivedOpenRouterFallbacks).toEqual([])
    await setOpenRouterTierExpansionEnabled(true)
    expect((await read()).derivedOpenRouterFallbacks).toEqual([]) // unauthenticated

    const readAccountStoreSpy = spyOn(accountStore, 'readAccountStore').mockReturnValue({
      version: 1,
      accounts: {
        openrouter: [{ id: 'or1', enabled: true, credential: { type: 'api_key', key: 'sk-or' } }],
      },
    })
    try {
      expect((await read()).derivedOpenRouterFallbacks).toEqual(derived) // authenticated and ready
      await setProviderEnabled('openrouter', false)
      expect((await read()).derivedOpenRouterFallbacks).toEqual([]) // disabled
      await setProviderEnabled('openrouter', true)
      providerHealth.markAccountExhausted('openrouter', 'or1', { reason: 'rate-limit' })
      expect((await read()).derivedOpenRouterFallbacks).toEqual(derived) // stable while accounts cool down
      resetProviderHealthForTests()
      expect((await read()).derivedOpenRouterFallbacks).toEqual(derived) // recovered
    } finally {
      readAccountStoreSpy.mockRestore()
      resetProviderHealthForTests()
      await setProviderEnabled('openrouter', true)
      await setOpenRouterTierExpansionEnabled(false)
    }
  })

  test('GET reports the candidates a one-shot tier call can use right now', async () => {
    await getSettingsStore().initialize()
    await db.insert(modelTiers).values([
      { slug: 'lite-test', label: 'Lite', chain: 'anthropic:claude-haiku-4-5:off,zai:glm-5.3-flash:off' },
      { slug: 'lite-off', label: 'Off', chain: 'anthropic:claude-haiku-4-5:off', disabled: true },
    ])
    const read = async () => {
      const response = await app.request('/api/model-tiers', { headers: authHeaders(admin.token) })
      expect(response.status).toBe(200)
      const tiers = await response.json()
      return Object.fromEntries(tiers.map((tier: any) => [tier.slug, tier.usableCandidates]))
    }
    const envKeys = ['ANTHROPIC_API_KEY', 'ANTHROPIC_OAUTH_TOKEN', 'ZAI_API_KEY'] as const
    const savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]))
    for (const key of envKeys) delete process.env[key]
    const readAccountStoreSpy = spyOn(accountStore, 'readAccountStore').mockReturnValue({ version: 1, accounts: {} })
    try {
      expect(await read()).toEqual({ 'lite-test': [], 'lite-off': [] }) // nobody signed in
      readAccountStoreSpy.mockReturnValue({
        version: 1,
        accounts: { anthropic: [{ id: 'a1', enabled: true, credential: { type: 'api_key', key: 'sk-ant' } }] },
      })
      expect(await read()).toEqual({ 'lite-test': ['anthropic:claude-haiku-4-5:off'], 'lite-off': [] })
    } finally {
      readAccountStoreSpy.mockRestore()
      for (const key of envKeys) if (savedEnv[key] !== undefined) process.env[key] = savedEnv[key]
    }
  })

  test('GET keeps mixed malformed legacy tiers available and dedupes authored OpenRouter candidates', async () => {
    await getSettingsStore().initialize()
    await setOpenRouterTierExpansionEnabled(true)
    await db.insert(modelTiers).values([
      {
        slug: 'mixed-legacy',
        label: 'Mixed',
        chain: 'malformed,anthropic:claude-sonnet-5:high',
      },
      {
        slug: 'authored-dedupe',
        label: 'Dedupe',
        chain: 'anthropic:claude-sonnet-5:high,openrouter:anthropic/claude-sonnet-5:high',
      },
    ])
    const readAccountStoreSpy = spyOn(accountStore, 'readAccountStore').mockReturnValue({
      version: 1,
      accounts: {
        openrouter: [{ id: 'or1', enabled: true, credential: { type: 'api_key', key: 'sk-or' } }],
      },
    })
    try {
      const response = await app.request('/api/model-tiers', { headers: authHeaders(admin.token) })
      expect(response.status).toBe(200)
      const tiers = await response.json()
      expect(tiers.find((tier: any) => tier.slug === 'mixed-legacy').derivedOpenRouterFallbacks).toEqual([
        'openrouter:anthropic/claude-sonnet-5:high',
      ])
      expect(tiers.find((tier: any) => tier.slug === 'authored-dedupe').derivedOpenRouterFallbacks).toEqual([])
    } finally {
      readAccountStoreSpy.mockRestore()
      await setOpenRouterTierExpansionEnabled(false)
    }
  })

  test('GET and PUT tolerate slash syntax and authored OpenRouter entries', async () => {
    for (const [slug, chain] of [
      ['slash-syntax', 'anthropic/claude-sonnet-5:high'],
      ['authored-router', 'openrouter:anthropic/claude-sonnet-5:high'],
    ] as const) {
      const response = await app.request(`/api/model-tiers/${slug}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', ...authHeaders(admin.token) },
        body: JSON.stringify({ label: slug, chain, sortOrder: 1 }),
      })
      expect(response.status).toBe(200)
    }
    const response = await app.request('/api/model-tiers', { headers: authHeaders(admin.token) })
    expect(response.status).toBe(200)
    expect((await response.json()).map((tier: any) => tier.chain).sort()).toEqual([
      'anthropic/claude-sonnet-5:high',
      'openrouter:anthropic/claude-sonnet-5:high',
    ])
  })

  test('PUT preserves a direct-valid custom chain and warns when its OpenRouter slug is absent', async () => {
    // Keep the missing-fallback fixture stable as Pi adds new OpenRouter models.
    const getModels = piCatalog.getModels
    const catalogSpy = spyOn(piCatalog, 'getModels').mockImplementation((provider) =>
      getModels(provider).filter((model) => provider !== 'openrouter' || model.id !== 'z-ai/glm-5.3')
    )
    try {
      const response = await app.request('/api/model-tiers/custom-router-warning', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', ...authHeaders(admin.token) },
        body: JSON.stringify({ label: 'Custom', chain: 'zai:glm-5.3:high', sortOrder: 1 }),
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        chain: 'zai:glm-5.3:high',
        warnings: [
          'OpenRouter fallback skipped: z-ai/glm-5.3 is not in the Pi catalog or has no verified endpoint mapping',
        ],
      })
      expect((await db.select().from(modelTiers))[0].chain).toBe('zai:glm-5.3:high')
    } finally {
      catalogSpy.mockRestore()
    }
  })

  test('PUT records a chain override that survives ConfigSync restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'tier-route-'))
    try {
      writeFileSync(
        join(directory, 'test.yaml'),
        'slug: test-tier\nlabel: Test\nchain: openai:gpt-5.2:low\nsortOrder: 1\n'
      )
      const sync = new TestSync(directory)
      await sync.sync()
      const response = await app.request('/api/model-tiers/test-tier', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', ...authHeaders(admin.token) },
        body: JSON.stringify({ label: 'Test', chain: 'openai:gpt-5.2:high', sortOrder: 1 }),
      })
      expect(response.status).toBe(200)
      expect((await db.select().from(modelTiers))[0].yamlFieldOverrides).toContain('chain')
      await sync.sync()
      expect((await db.select().from(modelTiers))[0].chain).toBe('openai:gpt-5.2:high')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
