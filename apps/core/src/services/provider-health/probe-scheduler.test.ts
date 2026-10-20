import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import { runProbeSweepOnce } from './probe-scheduler'
import { providerHealth, resetProviderHealthForTests } from './registry'
import { anthropicProbe } from './probes/anthropic'
import type { HealthProbe, ProbeResult } from './probes'

describe('runProbeSweepOnce', () => {
  beforeEach(() => {
    resetProviderHealthForTests()
  })

  it('marks a provider exhausted when its probe reports unhealthy', async () => {
    const probe: HealthProbe = {
      provider: 'openrouter',
      probe: async () => ({ state: 'unhealthy', kind: 'plan-credit' }),
    }
    await runProbeSweepOnce({
      getApiKey: async () => 'k',
      getProviders: () => ['openrouter'],
      getProbe: () => probe,
    })
    expect(providerHealth.isProviderHealthy('openrouter')).toBe(false)
    expect(providerHealth.getHealth('openrouter').reason).toBe('plan-credit')
  })

  it('marks a previously-exhausted provider available when its probe reports healthy', async () => {
    providerHealth.markExhausted('openrouter', { reason: 'rate-limit' })
    const probe: HealthProbe = {
      provider: 'openrouter',
      probe: async () => ({ state: 'healthy' }),
    }
    await runProbeSweepOnce({
      getApiKey: async () => 'k',
      getProviders: () => ['openrouter'],
      getProbe: () => probe,
    })
    expect(providerHealth.isProviderHealthy('openrouter')).toBe(true)
  })

  it('skips providers with no auth configured without resolving their existing episode', async () => {
    providerHealth.markExhausted('openrouter', { reason: 'rate-limit' })
    const probeCall = async (): Promise<ProbeResult> => {
      throw new Error('probe should not be called')
    }
    const probe: HealthProbe = { provider: 'openrouter', probe: probeCall }
    await runProbeSweepOnce({
      getApiKey: async () => undefined,
      getProviders: () => ['openrouter'],
      getProbe: () => probe,
    })
    expect(providerHealth.getRecord('openrouter')?.lastSuccessAt).toBeUndefined()
    expect(providerHealth.isProviderHealthy('openrouter')).toBe(false)
  })

  it('skips providers that have no probe registered without resolving their existing episode', async () => {
    providerHealth.markExhausted('anthropic', { reason: 'rate-limit' })
    await runProbeSweepOnce({
      getApiKey: async () => 'k',
      getProviders: () => ['anthropic'],
      getProbe: () => undefined,
    })
    expect(providerHealth.getRecord('anthropic')?.lastSuccessAt).toBeUndefined()
    expect(providerHealth.isProviderHealthy('anthropic')).toBe(false)
  })

  it('continues past a probe that throws (logs, does not crash)', async () => {
    const throwing: HealthProbe = {
      provider: 'openrouter',
      probe: async () => {
        throw new Error('network down')
      },
    }
    await runProbeSweepOnce({
      getApiKey: async () => 'k',
      getProviders: () => ['openrouter'],
      getProbe: () => throwing,
    })
    // Registry untouched because the probe failed.
    expect(providerHealth.isProviderHealthy('openrouter')).toBe(true)
  })

  it('leaves existing health unchanged when a registered probe is inconclusive', async () => {
    providerHealth.markExhausted('openrouter', { reason: 'rate-limit' })
    const probe: HealthProbe = { provider: 'openrouter', probe: async () => ({ state: 'inconclusive' }) }

    await runProbeSweepOnce({
      getApiKey: async () => 'k',
      getProviders: () => ['openrouter'],
      getProbe: () => probe,
    })

    expect(providerHealth.getRecord('openrouter')?.lastSuccessAt).toBeUndefined()
    expect(providerHealth.isProviderHealthy('openrouter')).toBe(false)
  })

  it('continues probing sibling accounts after one account probe throws', async () => {
    providerHealth.markAccountExhausted('openrouter', 'a2', { reason: 'rate-limit' })
    const probe: HealthProbe = {
      provider: 'openrouter',
      probe: async ({ apiKey }) => {
        if (apiKey === 'k1') throw new Error('network down')
        return { state: 'healthy' }
      },
    }

    await runProbeSweepOnce({
      getAccounts: () => [
        { id: 'a1', enabled: true, credential: { type: 'api_key', key: 'k1' } },
        { id: 'a2', enabled: true, credential: { type: 'api_key', key: 'k2' } },
      ],
      getApiKey: async (_provider, account) => (account?.credential as any)?.key,
      getProviders: () => ['openrouter'],
      getProbe: () => probe,
    })

    expect(providerHealth.getRecord('openrouter', 'a2')?.lastSuccessAt).toBeDefined()
  })

  it('marks individual accounts exhausted without exhausting sibling accounts', async () => {
    const probe: HealthProbe = {
      provider: 'openrouter',
      probe: async ({ apiKey }) =>
        apiKey === 'k1' ? { state: 'unhealthy', kind: 'plan-credit' } : { state: 'healthy' },
    }
    await runProbeSweepOnce({
      getAccounts: () => [
        { id: 'a1', enabled: true, credential: { type: 'api_key', key: 'k1' } },
        { id: 'a2', enabled: true, credential: { type: 'api_key', key: 'k2' } },
      ],
      getApiKey: async (_provider, account) => (account?.credential as any)?.key,
      getProviders: () => ['openrouter'],
      getProbe: () => probe,
    })
    expect(providerHealth.isAccountHealthy('openrouter', 'a1')).toBe(false)
    expect(providerHealth.isAccountHealthy('openrouter', 'a2')).toBe(true)
    expect(providerHealth.getAccountHealth('openrouter', 'a1').reason).toBe('plan-credit')
  })

  it('marks a previously exhausted account available when its probe reports healthy', async () => {
    providerHealth.markAccountExhausted('openrouter', 'a1', { reason: 'rate-limit' })
    const probe: HealthProbe = { provider: 'openrouter', probe: async () => ({ state: 'healthy' }) }
    await runProbeSweepOnce({
      getAccounts: () => [{ id: 'a1', enabled: true, credential: { type: 'api_key', key: 'k1' } }],
      getApiKey: async (_provider, account) => (account?.credential as any)?.key,
      getProviders: () => ['openrouter'],
      getProbe: () => probe,
    })
    expect(providerHealth.isAccountHealthy('openrouter', 'a1')).toBe(true)
  })

  it('honors retryAt/status from an unhealthy probe result', async () => {
    const retryAt = Date.now() + 120_000
    const probe: HealthProbe = {
      provider: 'openrouter',
      probe: async () => ({ state: 'unhealthy', kind: 'rate-limit', retryAt, status: 429 }),
    }
    await runProbeSweepOnce({
      getApiKey: async () => 'k',
      getProviders: () => ['openrouter'],
      getProbe: () => probe,
    })
    const h = providerHealth.getHealth('openrouter')
    expect(h.state).toBe('exhausted')
    expect(h.retryAt).toBe(retryAt)
    expect(h.lastObservedStatus).toBe(429)
  })
})

describe('Anthropic auth-only probe recovery', () => {
  let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>>

  beforeEach(() => {
    resetProviderHealthForTests()
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))
  })

  afterEach(() => {
    fetchSpy.mockRestore()
    resetProviderHealthForTests()
  })

  for (const kind of ['plan-credit', 'rate-limit', 'capacity', 'error', 'network'] as const) {
    for (const accountId of [undefined, 'a1']) {
      it(`does not recover ${kind} for ${accountId ?? 'provider-wide'} on model listing success`, async () => {
        providerHealth.recordFailure(providerHealth.captureAttempt('anthropic', accountId), { kind })
        const original = providerHealth.snapshotRecords()
        const attempt = providerHealth.captureAttempt('anthropic', accountId)

        await runProbeSweepOnce({
          getAccounts: () =>
            accountId ? [{ id: accountId, enabled: true, credential: { type: 'api_key', key: 'k' } }] : [],
          getApiKey: async () => 'k',
          getProviders: () => ['anthropic'],
          getProbe: () => anthropicProbe,
        })

        expect(providerHealth.snapshotRecords()).toEqual(original)
        expect(providerHealth.captureAttempt('anthropic', accountId)).toEqual(attempt)
        expect(fetchSpy).toHaveBeenCalledTimes(1)
      })
    }
  }

  for (const kind of ['invalid-credential', 'expired-oauth'] as const) {
    it(`recovers ${kind} only for the successfully probed account`, async () => {
      for (const accountId of ['a1', 'a2']) {
        providerHealth.recordFailure(providerHealth.captureAttempt('anthropic', accountId), { kind })
      }
      await runProbeSweepOnce({
        getAccounts: () => [{ id: 'a1', enabled: true, credential: { type: 'api_key', key: 'k' } }],
        getApiKey: async () => 'k',
        getProviders: () => ['anthropic'],
        getProbe: () => anthropicProbe,
      })
      expect(providerHealth.getRecord('anthropic', 'a1')?.lastSuccessAt).toBeDefined()
      expect(providerHealth.getRecord('anthropic', 'a2')?.lastSuccessAt).toBeUndefined()
    })
  }
})
