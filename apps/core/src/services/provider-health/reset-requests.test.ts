import { describe, expect, it } from 'bun:test'
import { createProviderHealthRegistry, PROVIDER_HEALTH_STATE_KEY, type ProviderHealthPersistence } from './registry'
import {
  applyProviderHealthResetRequests,
  parseProviderHealthResetRequests,
  PROVIDER_HEALTH_RESET_REQUESTS_KEY,
  requestProviderHealthReset,
} from './reset-requests'

/** One settings table shared by an "API" replica and a "worker" writer, as in production. */
function sharedSettings(): ProviderHealthPersistence & { values: Map<string, string> } {
  const values = new Map<string, string>()
  return {
    values,
    get: (key) => values.get(key),
    set: async (key, value) => {
      values.set(key, value)
    },
  }
}

const WEEK = 7 * 24 * 60 * 60_000

describe('provider health reset requests', () => {
  it('a reset made on the API replica reaches the worker and survives the next hydration', async () => {
    const settings = sharedSettings()
    let now = 1_000_000

    // The worker observes a weekly plan limit and persists it.
    const worker = createProviderHealthRegistry({ now: () => now, persistence: settings })
    worker.enablePersistence()
    worker.markAccountExhausted('anthropic', 'acc_claude_code', { reason: 'plan-credit', retryAt: now + WEEK })
    await worker.flushPersistence()

    // The API is a read-only replica of that state.
    const api = createProviderHealthRegistry({ now: () => now, persistence: settings })
    await api.hydrateFromPersistence()
    expect(api.isAccountHealthy('anthropic', 'acc_claude_code')).toBe(false)

    // The operator resets the account from Settings, which the API handles.
    now += 60_000
    await requestProviderHealthReset([{ provider: 'anthropic', accountId: 'acc_claude_code' }], {
      registry: api,
      store: settings,
      now: () => now,
    })
    expect(api.isAccountHealthy('anthropic', 'acc_claude_code')).toBe(true)

    // The worker applies the request to the state it owns and persists it.
    now += 1_000
    expect(applyProviderHealthResetRequests({ registry: worker, store: settings })).toBe(1)
    await worker.flushPersistence()
    expect(worker.isAccountHealthy('anthropic', 'acc_claude_code')).toBe(true)

    // The API's periodic hydration no longer brings the exhaustion back.
    await api.hydrateFromPersistence()
    expect(api.isAccountHealthy('anthropic', 'acc_claude_code')).toBe(true)
    // The persisted record is a recovery, which a replica drops as resolved.
    expect(settings.values.get(PROVIDER_HEALTH_STATE_KEY)).toContain('"lastSuccessAt":1061000')
    expect(api.getRecord('anthropic', 'acc_claude_code')).toBeUndefined()
  })

  it('does not clear a failure the worker observed after the reset was requested', async () => {
    const settings = sharedSettings()
    let now = 1_000_000
    const worker = createProviderHealthRegistry({ now: () => now, persistence: settings })
    worker.markAccountExhausted('anthropic', 'a1', { reason: 'plan-credit', retryAt: now + WEEK })

    now += 60_000
    await requestProviderHealthReset([{ provider: 'anthropic', accountId: 'a1' }], { store: settings, now: () => now })
    expect(applyProviderHealthResetRequests({ registry: worker, store: settings })).toBe(1)

    // The account is tried again and is still limited upstream.
    now += 60_000
    worker.markAccountExhausted('anthropic', 'a1', { reason: 'plan-credit', retryAt: now + WEEK })

    // The stored request is read again at every refresh and at startup; it must stay spent.
    now += 60_000
    expect(applyProviderHealthResetRequests({ registry: worker, store: settings })).toBe(0)
    expect(worker.isAccountHealthy('anthropic', 'a1')).toBe(false)
  })

  it('resets a provider-level record and leaves other accounts alone', async () => {
    const settings = sharedSettings()
    let now = 1_000_000
    const worker = createProviderHealthRegistry({ now: () => now, persistence: settings })
    worker.markExhausted('envprovider', { reason: 'rate-limit', retryAt: now + WEEK })
    worker.markAccountExhausted('anthropic', 'a1', { reason: 'plan-credit', retryAt: now + WEEK })
    worker.markAccountExhausted('anthropic', 'a2', { reason: 'plan-credit', retryAt: now + WEEK })

    now += 1_000
    await requestProviderHealthReset([{ provider: 'envprovider' }, { provider: 'anthropic', accountId: 'a1' }], {
      store: settings,
      now: () => now,
    })
    expect(applyProviderHealthResetRequests({ registry: worker, store: settings })).toBe(2)

    expect(worker.isProviderHealthy('envprovider')).toBe(true)
    expect(worker.isAccountHealthy('anthropic', 'a1')).toBe(true)
    expect(worker.isAccountHealthy('anthropic', 'a2')).toBe(false)
  })

  it('keeps concurrent requests, replaces a repeated one and drops requests older than a day', async () => {
    const settings = sharedSettings()
    let now = 1_000_000
    const opts = { store: settings, now: () => now }
    await Promise.all([
      requestProviderHealthReset([{ provider: 'anthropic', accountId: 'a1' }], opts),
      requestProviderHealthReset([{ provider: 'zai', accountId: 'z1' }], opts),
    ])
    now += 5_000
    await requestProviderHealthReset([{ provider: 'anthropic', accountId: 'a1' }], opts)

    expect(parseProviderHealthResetRequests(settings.values.get(PROVIDER_HEALTH_RESET_REQUESTS_KEY))).toEqual([
      { provider: 'anthropic', accountId: 'a1', requestedAt: 1_005_000 },
      { provider: 'zai', accountId: 'z1', requestedAt: 1_000_000 },
    ])

    now += 25 * 60 * 60_000
    await requestProviderHealthReset([{ provider: 'openai-codex' }], opts)
    expect(parseProviderHealthResetRequests(settings.values.get(PROVIDER_HEALTH_RESET_REQUESTS_KEY))).toEqual([
      { provider: 'openai-codex', requestedAt: now },
    ])
  })

  it('ignores a malformed stored value', () => {
    expect(parseProviderHealthResetRequests(undefined)).toEqual([])
    expect(parseProviderHealthResetRequests('not json')).toEqual([])
    expect(parseProviderHealthResetRequests(JSON.stringify({ version: 2, requests: [] }))).toEqual([])
    expect(
      parseProviderHealthResetRequests(
        JSON.stringify({
          version: 1,
          requests: [{ provider: '', requestedAt: 1 }, { provider: 'anthropic' }, { provider: 'zai', requestedAt: 7 }],
        })
      )
    ).toEqual([{ provider: 'zai', requestedAt: 7 }])
  })
})
