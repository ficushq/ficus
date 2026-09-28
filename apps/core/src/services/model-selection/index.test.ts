import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { randomBytes } from 'crypto'
import { db, secrets } from '../../db'
import { getSecretStore, resetSecretStore, type SecretStore } from '../secrets'
import { getSettingsStore } from '../settings'
import { writeAccountStore } from '../agent/account-store'
import { providerHealth } from '../provider-health/registry'
import {
  isolateOpenRouterTestState,
  restoreOpenRouterTestState,
  type OpenRouterTestStateSnapshot,
} from '../../test-utils/openrouter-test-state'
import {
  ModelSelectionError,
  PROVIDERS_WITHOUT_AUTH,
  selectModelSpecForCurrentEnv,
  setOpenRouterTierExpansionEnabled,
} from './index'

const ANTHROPIC = 'anthropic:claude-haiku-4-5'
const OPENAI_CODEX = 'openai-codex:gpt-5.6-sol'

describe('model-selection account-aware environment wiring', () => {
  const testKey = randomBytes(32).toString('hex')
  let store: SecretStore
  let openRouterTestState: OpenRouterTestStateSnapshot
  let unrelatedSecretRows: Array<typeof secrets.$inferSelect>
  let originalEncryptionKey: string | undefined

  beforeEach(async () => {
    originalEncryptionKey = process.env.FICUS_ENCRYPTION_KEY
    openRouterTestState = await isolateOpenRouterTestState()
    unrelatedSecretRows = await db.select().from(secrets)
    await db.delete(secrets)
    process.env.FICUS_ENCRYPTION_KEY = testKey
    resetSecretStore()
    store = getSecretStore()
    await store.initialize()
  })

  afterEach(async () => {
    store.stopPeriodicRefresh()
    await db.delete(secrets)
    if (unrelatedSecretRows.length > 0) await db.insert(secrets).values(unrelatedSecretRows)
    resetSecretStore()
    PROVIDERS_WITHOUT_AUTH.delete('zai')
    if (originalEncryptionKey === undefined) delete process.env.FICUS_ENCRYPTION_KEY
    else process.env.FICUS_ENCRYPTION_KEY = originalEncryptionKey
    await restoreOpenRouterTestState(openRouterTestState)
  })

  test('OpenRouter-only auth selects the first tier vendor through its derived fallback', async () => {
    await getSettingsStore().initialize()
    await setOpenRouterTierExpansionEnabled(true)
    await writeAccountStore(
      {
        version: 1,
        accounts: {
          openrouter: [{ id: 'or1', enabled: true, credential: { type: 'api_key', key: 'sk-or' } }],
        },
      },
      'admin'
    )

    expect(selectModelSpecForCurrentEnv('anthropic:claude-sonnet-5:high,zai:glm-5.3:low').selected).toBe(
      'openrouter:anthropic/claude-sonnet-5:high'
    )
  })

  test('OpenRouter-only auth expands an accepted provider/model chain without throwing', async () => {
    await getSettingsStore().initialize()
    await setOpenRouterTierExpansionEnabled(true)
    await writeAccountStore(
      {
        version: 1,
        accounts: {
          openrouter: [{ id: 'or1', enabled: true, credential: { type: 'api_key', key: 'sk-or' } }],
        },
      },
      'admin'
    )
    expect(selectModelSpecForCurrentEnv('anthropic/claude-sonnet-5:high').selected).toBe(
      'openrouter:anthropic/claude-sonnet-5:high'
    )
  })

  test('OpenRouter-only auth selects catalog-backed DeepSeek and Xiaomi custom tiers', async () => {
    await getSettingsStore().initialize()
    await setOpenRouterTierExpansionEnabled(true)
    await writeAccountStore(
      {
        version: 1,
        accounts: {
          openrouter: [{ id: 'or1', enabled: true, credential: { type: 'api_key', key: 'sk-or' } }],
        },
      },
      'admin'
    )
    for (const [direct, fallback] of [
      ['deepseek:deepseek-v4-flash', 'openrouter:deepseek/deepseek-v4-flash'],
      ['xiaomi:mimo-v2.5-pro', 'openrouter:xiaomi/mimo-v2.5-pro'],
    ] as const) {
      expect(selectModelSpecForCurrentEnv(direct).selected).toBe(fallback)
    }
  })

  test('an authored OpenRouter candidate remains selectable and is not re-expanded', async () => {
    await getSettingsStore().initialize()
    await setOpenRouterTierExpansionEnabled(true)
    await writeAccountStore(
      {
        version: 1,
        accounts: {
          openrouter: [{ id: 'or1', enabled: true, credential: { type: 'api_key', key: 'sk-or' } }],
        },
      },
      'admin'
    )
    const spec = 'openrouter:anthropic/claude-sonnet-5:high'
    const result = selectModelSpecForCurrentEnv(spec)
    expect(result.selected).toBe(spec)
    expect(result.candidates).toHaveLength(1)
  })

  test('a direct account stays ahead of its OpenRouter shadow', async () => {
    await getSettingsStore().initialize()
    await setOpenRouterTierExpansionEnabled(true)
    await writeAccountStore(
      {
        version: 1,
        accounts: {
          anthropic: [{ id: 'a1', enabled: true, credential: { type: 'api_key', key: 'sk-a' } }],
          openrouter: [{ id: 'or1', enabled: true, credential: { type: 'api_key', key: 'sk-or' } }],
        },
      },
      'admin'
    )

    expect(selectModelSpecForCurrentEnv('anthropic:claude-sonnet-5:high').selected).toBe(
      'anthropic:claude-sonnet-5:high'
    )
  })

  test('stored OpenRouter auth makes no routing change while the explicit switch is off', async () => {
    await getSettingsStore().initialize()
    await writeAccountStore(
      {
        version: 1,
        accounts: {
          openrouter: [{ id: 'or1', enabled: true, credential: { type: 'api_key', key: 'sk-or' } }],
        },
      },
      'admin'
    )

    expect(() => selectModelSpecForCurrentEnv('anthropic:claude-sonnet-5:high')).toThrow(ModelSelectionError)
  })

  test('keeps an explicitly auth-exempt provider route-ready without stored or runtime auth', () => {
    PROVIDERS_WITHOUT_AUTH.add('zai')

    expect(selectModelSpecForCurrentEnv('zai:glm-5.2').selected).toBe('zai:glm-5.2')
  })

  test('keeps a provider usable when at least one account is healthy', async () => {
    await seedAccounts()
    providerHealth.markAccountExhausted('anthropic', 'a1', { reason: 'rate-limit' })

    const result = selectModelSpecForCurrentEnv(`${ANTHROPIC},${OPENAI_CODEX}`)

    expect(result.selected).toBe(ANTHROPIC)
  })

  test('skips a provider as exhausted when all enabled accounts are exhausted', async () => {
    await seedAccounts()
    providerHealth.markAccountExhausted('anthropic', 'a1', { reason: 'rate-limit' })
    providerHealth.markAccountExhausted('anthropic', 'a2', { reason: 'rate-limit' })

    const result = selectModelSpecForCurrentEnv(`${ANTHROPIC},${OPENAI_CODEX}`)

    expect(result.selected).toBe(OPENAI_CODEX)
    expect(result.candidates[0]).toMatchObject({ spec: ANTHROPIC, usable: false, reason: 'provider-exhausted' })
  })

  test('keeps exhausted OpenRouter shadows in diagnostics while health marks them unusable', async () => {
    await getSettingsStore().initialize()
    await setOpenRouterTierExpansionEnabled(true)
    await writeAccountStore(
      {
        version: 1,
        accounts: {
          openrouter: [{ id: 'or1', enabled: true, credential: { type: 'api_key', key: 'sk-or' } }],
        },
      },
      'admin'
    )
    providerHealth.markAccountExhausted('openrouter', 'or1', { reason: 'rate-limit' })

    let error: ModelSelectionError | undefined
    try {
      selectModelSpecForCurrentEnv('anthropic:claude-sonnet-5:high')
    } catch (caught) {
      error = caught as ModelSelectionError
    }
    expect(error).toBeInstanceOf(ModelSelectionError)
    expect(error!.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          spec: 'openrouter:anthropic/claude-sonnet-5:high',
          usable: false,
          reason: 'provider-exhausted',
        }),
      ])
    )
  })

  test('keeps observational credential records route-ready', async () => {
    await seedAccounts()
    providerHealth.recordFailure(providerHealth.captureAttempt('anthropic', 'a1'), { kind: 'expired-oauth' })
    providerHealth.recordFailure(providerHealth.captureAttempt('anthropic', 'a2'), { kind: 'invalid-credential' })

    const result = selectModelSpecForCurrentEnv(`${ANTHROPIC},${OPENAI_CODEX}`)

    expect(result.selected).toBe(ANTHROPIC)
  })

  test('reports provider-exhausted rather than auth-missing when exhausted accounts are configured', async () => {
    await writeAccountStore(
      {
        version: 1,
        accounts: {
          anthropic: [{ id: 'a1', enabled: true, credential: { type: 'api_key', key: 'sk-1' } }],
        },
      },
      'admin'
    )
    providerHealth.markAccountExhausted('anthropic', 'a1', { reason: 'rate-limit' })

    let err: ModelSelectionError | undefined
    try {
      selectModelSpecForCurrentEnv(ANTHROPIC)
    } catch (e) {
      err = e as ModelSelectionError
    }

    expect(err).toBeInstanceOf(ModelSelectionError)
    expect(err!.candidates[0]).toMatchObject({ spec: ANTHROPIC, usable: false, reason: 'provider-exhausted' })
  })
})

async function seedAccounts() {
  await writeAccountStore(
    {
      version: 1,
      accounts: {
        anthropic: [
          { id: 'a1', enabled: true, credential: { type: 'api_key', key: 'sk-1' } },
          { id: 'a2', enabled: true, credential: { type: 'api_key', key: 'sk-2' } },
        ],
        'openai-codex': [{ id: 'o1', enabled: true, credential: { type: 'api_key', key: 'sk-openai' } }],
      },
    },
    'admin'
  )
}
