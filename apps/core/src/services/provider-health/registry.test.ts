import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { randomBytes } from 'crypto'
import { db, secrets, settings } from '../../db'
import { getSecretStore, resetSecretStore } from '../../services/secrets'
import { getSettingsStore, resetSettingsStore } from '../../services/settings'
import { createProviderHealthRegistry, providerHealth, resetProviderHealthForTests } from './registry'

describe('revisioned provider health episodes', () => {
  it('assigns a finite kind-specific retry time to every transient failure', () => {
    const now = 1_000
    const defaults = {
      'rate-limit': 60_000,
      'plan-credit': 30 * 60_000,
      capacity: 5 * 60_000,
      error: 60_000,
      network: 60_000,
    } as const

    for (const [kind, cooldown] of Object.entries(defaults)) {
      const registry = createProviderHealthRegistry({ now: () => now })
      const attempt = registry.captureAttempt('anthropic')
      expect(registry.recordFailure(attempt, { kind: kind as keyof typeof defaults })).toBe(true)
      expect(registry.getRecord('anthropic')?.retryAt).toBe(now + cooldown)
    }
  })

  it('preserves since, never shortens retry, and advances the episode revision', () => {
    let now = 1_000
    const registry = createProviderHealthRegistry({ now: () => now })
    const first = registry.captureAttempt('anthropic')
    registry.recordFailure(first, { kind: 'rate-limit', retryAt: 100_000 })
    const initial = registry.getRecord('anthropic')!

    now = 2_000
    const second = registry.captureAttempt('anthropic')
    expect(registry.recordFailure(second, { kind: 'capacity', retryAt: 10_000 })).toBe(true)
    expect(registry.getRecord('anthropic')).toMatchObject({ since: initial.since, retryAt: 100_000 })
    expect(registry.captureAttempt('anthropic').revision).toBe(second.revision + 1)
  })

  it('lets only the first matching half-open failure advance and re-extend cooldown', () => {
    let now = 1_000
    const registry = createProviderHealthRegistry({ now: () => now })
    registry.recordFailure(registry.captureAttempt('anthropic'), { kind: 'rate-limit' })
    now = 61_000
    const first = registry.captureAttempt('anthropic')
    const stale = registry.captureAttempt('anthropic')

    expect(registry.recordFailure(first, { kind: 'rate-limit' })).toBe(true)
    const retryAt = registry.getRecord('anthropic')?.retryAt
    expect(registry.recordFailure(stale, { kind: 'rate-limit' })).toBe(false)
    expect(registry.getRecord('anthropic')?.retryAt).toBe(retryAt)
  })

  it('writes known-account failure exactly while guarding a provider-wide episode', () => {
    const registry = createProviderHealthRegistry({ now: () => 1_000 })
    registry.recordFailure(registry.captureAttempt('anthropic'), { kind: 'network' })
    const accountAttempt = registry.captureAttempt('anthropic', 'a1')

    expect(registry.recordFailure(accountAttempt, { kind: 'rate-limit' })).toBe(true)
    expect(registry.getRecord('anthropic')).toMatchObject({ provider: 'anthropic' })
    expect(registry.getRecord('anthropic')?.accountId).toBeUndefined()
    expect(registry.getRecord('anthropic', 'a1')).toMatchObject({ provider: 'anthropic', accountId: 'a1' })
  })

  it('starts a fresh episode when failure follows a recovered tombstone', () => {
    let now = 1_000
    const registry = createProviderHealthRegistry({ now: () => now })
    registry.recordFailure(registry.captureAttempt('anthropic', 'a1'), { kind: 'network' })
    registry.recordSuccess(registry.captureAttempt('anthropic', 'a1'))
    now = 5_000

    registry.recordFailure(registry.captureAttempt('anthropic', 'a1'), { kind: 'capacity' })

    expect(registry.getRecord('anthropic', 'a1')).toMatchObject({ since: 5_000, retryAt: 305_000 })
    expect(registry.getRecord('anthropic', 'a1')?.lastSuccessAt).toBeUndefined()
  })

  it('keeps an exact recovery tombstone only while it masks older provider-wide failure', () => {
    let now = 1_000
    const registry = createProviderHealthRegistry({ now: () => now })
    registry.recordFailure(registry.captureAttempt('anthropic'), { kind: 'network' })
    const accountAttempt = registry.captureAttempt('anthropic', 'a1')

    now = 2_000
    expect(registry.recordSuccess(accountAttempt)).toBe(true)
    expect(registry.getRecord('anthropic', 'a1')?.lastSuccessAt).toBe(2_000)

    const providerAttempt = registry.captureAttempt('anthropic')
    now = 3_000
    expect(registry.recordSuccess(providerAttempt)).toBe(true)
    expect(registry.getRecord('anthropic', 'a1')).toBeUndefined()
  })

  it('retains an exact recovery tombstone when a provider-level write extends the older episode', () => {
    let now = 1_000
    const registry = createProviderHealthRegistry({ now: () => now })
    registry.recordFailure(registry.captureAttempt('anthropic'), { kind: 'network' })
    const accountAttempt = registry.captureAttempt('anthropic', 'a1')

    now = 2_000
    expect(registry.recordSuccess(accountAttempt)).toBe(true)
    const providerAttempt = registry.captureAttempt('anthropic')
    now = 3_000
    expect(registry.recordFailure(providerAttempt, { kind: 'rate-limit' })).toBe(true)

    expect(registry.getRecord('anthropic')).toMatchObject({ since: 1_000, kind: 'rate-limit' })
    expect(registry.getRecord('anthropic', 'a1')?.lastSuccessAt).toBe(2_000)
    expect(registry.captureAttempt('anthropic', 'a1')).toMatchObject({
      applicableKey: 'anthropic::a1',
      hadActiveFailure: false,
    })
  })

  it('does not give credential observations transient retry metadata', () => {
    const registry = createProviderHealthRegistry({ now: () => 1_000 })
    registry.recordFailure(registry.captureAttempt('anthropic'), { kind: 'rate-limit' })
    registry.recordFailure(registry.captureAttempt('anthropic'), { kind: 'expired-oauth' })

    expect(registry.getRecord('anthropic')).toMatchObject({ kind: 'expired-oauth' })
    expect(registry.getRecord('anthropic')?.retryAt).toBeUndefined()
  })

  it('rejects stale success and conditionally recovers the matching route', () => {
    let now = 1_000
    const registry = createProviderHealthRegistry({ now: () => now })
    const initial = registry.captureAttempt('anthropic', 'a1')
    registry.recordFailure(initial, { kind: 'network' })
    const matching = registry.captureAttempt('anthropic', 'a1')
    const stale = matching
    now = 2_000
    registry.recordFailure(matching, { kind: 'error' })

    expect(registry.recordSuccess(stale)).toBe(false)
    const current = registry.captureAttempt('anthropic', 'a1')
    expect(registry.recordSuccess(current)).toBe(true)
    expect(registry.getRecord('anthropic', 'a1')?.lastSuccessAt).toBeGreaterThan(
      registry.getRecord('anthropic', 'a1')!.since
    )
  })
})

describe('ProviderHealthRegistry', () => {
  it('defaults to available', () => {
    const r = createProviderHealthRegistry()
    expect(r.isProviderHealthy('anthropic')).toBe(true)
    expect(r.getHealth('anthropic').state).toBe('available')
  })

  it('markExhausted sets exhausted with default cooldown', () => {
    const r = createProviderHealthRegistry()
    r.markExhausted('anthropic', { reason: 'rate-limit' })
    expect(r.isProviderHealthy('anthropic')).toBe(false)
    expect(r.getHealth('anthropic').state).toBe('exhausted')
    expect(r.getHealth('anthropic').reason).toBe('rate-limit')
    expect(r.getHealth('anthropic').retryAt).toBeGreaterThan(Date.now())
  })

  it('auto-recovers after retryAt passes', () => {
    let now = 1_000
    const r = createProviderHealthRegistry({ now: () => now })
    r.markExhausted('anthropic', { reason: 'rate-limit', retryAt: 2_000 })
    now = 2_000
    expect(r.isProviderHealthy('anthropic')).toBe(true)
    expect(r.snapshot().find((h) => h.provider === 'anthropic')).toBeUndefined()
  })

  it('markExhausted never shortens an existing cooldown', () => {
    const r = createProviderHealthRegistry()
    const far = Date.now() + 3_600_000
    r.markExhausted('anthropic', { reason: 'plan-credit', retryAt: far })
    r.markExhausted('anthropic', { reason: 'rate-limit', retryAt: Date.now() + 1000 })
    expect(r.getHealth('anthropic').retryAt).toBe(far)
  })

  it('markAvailable clears exhaustion', () => {
    const r = createProviderHealthRegistry()
    r.markExhausted('anthropic', { reason: 'rate-limit' })
    r.markAvailable('anthropic')
    expect(r.isProviderHealthy('anthropic')).toBe(true)
    expect(r.getHealth('anthropic').state).toBe('available')
  })

  it('snapshot expires passed cooldowns', () => {
    let now = 1_000
    const r = createProviderHealthRegistry({ now: () => now })
    r.markExhausted('a', { reason: 'rate-limit', retryAt: 2_000 })
    r.markExhausted('b', { reason: 'rate-limit', retryAt: 61_000 })
    now = 2_000
    const snap = r.snapshot()
    expect(snap.find((h) => h.provider === 'a')).toBeUndefined()
    expect(snap.find((h) => h.provider === 'b')?.state).toBe('exhausted')
  })

  it('plan-credit cooldown is longer than rate-limit', () => {
    const r = createProviderHealthRegistry()
    r.markExhausted('a', { reason: 'rate-limit' })
    r.markExhausted('b', { reason: 'plan-credit' })
    expect(r.getHealth('b').retryAt! - r.getHealth('b').since).toBeGreaterThan(
      r.getHealth('a').retryAt! - r.getHealth('a').since
    )
  })

  it('preserves the original "since" when re-marking an already-exhausted provider', () => {
    const r = createProviderHealthRegistry()
    r.markExhausted('anthropic', { reason: 'rate-limit' })
    const firstSince = r.getHealth('anthropic').since
    r.markExhausted('anthropic', { reason: 'plan-credit' })
    expect(r.getHealth('anthropic').since).toBe(firstSince)
    expect(r.getHealth('anthropic').reason).toBe('plan-credit')
  })

  it('records the last observed status when provided', () => {
    const r = createProviderHealthRegistry()
    r.markExhausted('anthropic', { reason: 'rate-limit', status: 429 })
    expect(r.getHealth('anthropic').lastObservedStatus).toBe(429)
    // A subsequent mark without status keeps the previously observed status.
    r.markExhausted('anthropic', { reason: 'capacity' })
    expect(r.getHealth('anthropic').lastObservedStatus).toBe(429)
  })

  it('tracks account exhaustion independently', () => {
    const r = createProviderHealthRegistry()
    r.markAccountExhausted('anthropic', 'acc_1', { reason: 'rate-limit' })
    expect(r.isAccountHealthy('anthropic', 'acc_1')).toBe(false)
    expect(r.isAccountHealthy('anthropic', 'acc_2')).toBe(true)
    expect(r.isProviderHealthy('anthropic')).toBe(true)
  })

  it('auto-recovers accounts after retryAt passes', () => {
    let now = 1_000
    const r = createProviderHealthRegistry({ now: () => now })
    r.markAccountExhausted('anthropic', 'acc_1', { reason: 'rate-limit', retryAt: 2_000 })
    now = 2_000
    expect(r.isAccountHealthy('anthropic', 'acc_1')).toBe(true)
    expect(r.snapshot().find((h) => h.provider === 'anthropic' && h.accountId === 'acc_1')).toBeUndefined()
  })

  it('markAccountAvailable clears only the selected account', () => {
    const r = createProviderHealthRegistry()
    r.markAccountExhausted('anthropic', 'acc_1', { reason: 'rate-limit' })
    r.markAccountExhausted('anthropic', 'acc_2', { reason: 'rate-limit' })
    r.markAccountAvailable('anthropic', 'acc_1')
    expect(r.isAccountHealthy('anthropic', 'acc_1')).toBe(true)
    expect(r.isAccountHealthy('anthropic', 'acc_2')).toBe(false)
  })
})

describe('isStablyHealthy', () => {
  it('is stable for a provider that was never exhausted', () => {
    expect(createProviderHealthRegistry().isStablyHealthy('anthropic', 30_000)).toBe(true)
  })

  it('is not stable while a provider is still in cooldown', () => {
    const r = createProviderHealthRegistry({ now: () => 1_000 })
    r.markExhausted('anthropic', { retryAt: 61_000 })
    expect(r.isStablyHealthy('anthropic', 30_000)).toBe(false)
  })

  it('is healthy but not stable immediately after cooldown elapses', () => {
    let now = 1_000
    const r = createProviderHealthRegistry({ now: () => now })
    r.markExhausted('anthropic', { retryAt: 61_000 })
    now = 61_000
    expect(r.isProviderHealthy('anthropic')).toBe(true)
    expect(r.isStablyHealthy('anthropic', 30_000)).toBe(false)
  })

  it('becomes stable once the stability window has elapsed past retryAt', () => {
    let now = 1_000
    const r = createProviderHealthRegistry({ now: () => now })
    r.markExhausted('anthropic', { retryAt: 61_000 })
    now = 91_000
    expect(r.isStablyHealthy('anthropic', 30_000)).toBe(true)
  })

  it('a re-exhaustion resets the stability window', () => {
    let now = 1_000
    const r = createProviderHealthRegistry({ now: () => now })
    r.markExhausted('anthropic', { retryAt: 61_000 })
    now = 91_000
    expect(r.isStablyHealthy('anthropic', 30_000)).toBe(true)
    r.markExhausted('anthropic', { retryAt: 151_000 })
    expect(r.isStablyHealthy('anthropic', 30_000)).toBe(false)
  })
})

describe('versioned provider health persistence', () => {
  it('hydrates unresolved elapsed records and revisions without declaring recovery', async () => {
    const value = JSON.stringify({
      version: 1,
      records: [
        {
          provider: 'anthropic',
          kind: 'rate-limit',
          message: 'untrusted raw text',
          since: 1_000,
          retryAt: 2_000,
        },
      ],
      revisions: { anthropic: 7 },
    })
    const store = { get: (key: string) => (key === 'PROVIDER_HEALTH_STATE' ? value : undefined), set: async () => {} }
    const registry = createProviderHealthRegistry({ now: () => 3_000, persistence: store })

    await registry.hydrateFromPersistence()

    expect(registry.getRecord('anthropic')).toMatchObject({
      message: 'Provider rate limit reached.',
      retryAt: 2_000,
    })
    expect(registry.captureAttempt('anthropic').revision).toBe(7)
    expect(registry.isProviderHealthy('anthropic')).toBe(true)
  })

  it('repairs and persists a malformed transient record without retry metadata during hydration', async () => {
    let value = JSON.stringify({
      version: 1,
      records: [{ provider: 'anthropic', kind: 'network', message: 'raw', since: 1_000 }],
      revisions: { anthropic: 4 },
    })
    const store = {
      get: (key: string) => (key === 'PROVIDER_HEALTH_STATE' ? value : undefined),
      set: async (_key: string, next: string) => {
        value = next
      },
    }
    const registry = createProviderHealthRegistry({ now: () => 5_000, persistence: store })
    registry.enablePersistence()

    await registry.hydrateFromPersistence()
    await registry.flushPersistence()

    expect(registry.getRecord('anthropic')?.retryAt).toBe(65_000)
    expect(JSON.parse(value).records[0].retryAt).toBe(65_000)
  })

  it('serializes records and revisions as one ordered latest snapshot', async () => {
    const writes: string[] = []
    let releaseFirst!: () => void
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const store = {
      get: () => undefined,
      set: async (_key: string, value: string) => {
        if (writes.length === 0) await firstBlocked
        writes.push(value)
      },
    }
    const registry = createProviderHealthRegistry({ now: () => 1_000, persistence: store })
    registry.enablePersistence()
    registry.recordFailure(registry.captureAttempt('anthropic'), { kind: 'rate-limit' })
    registry.recordFailure(registry.captureAttempt('zai'), { kind: 'capacity' })
    releaseFirst()
    await registry.flushPersistence()

    const final = JSON.parse(writes.at(-1)!)
    expect(final.version).toBe(1)
    expect(final.records.map((record: { provider: string }) => record.provider).sort()).toEqual(['anthropic', 'zai'])
    expect(final.revisions).toEqual({ anthropic: 1, zai: 1 })
  })

  it('retries a failed dirty write without another mutation', async () => {
    let attempts = 0
    const store = {
      get: () => undefined,
      set: async () => {
        attempts++
        if (attempts === 1) throw new Error('temporary settings failure')
      },
    }
    const registry = createProviderHealthRegistry({
      now: () => 1_000,
      persistence: store,
      sleep: async () => {},
    })
    registry.enablePersistence()
    registry.recordFailure(registry.captureAttempt('anthropic'), { kind: 'network' })

    await registry.flushPersistence()

    expect(attempts).toBe(2)
  })
})

describe('ProviderHealthRegistry persistence', () => {
  const testKey = randomBytes(32).toString('hex')

  beforeEach(async () => {
    process.env.FICUS_ENCRYPTION_KEY = testKey
    await db.delete(secrets)
    await db.delete(settings)
    resetSecretStore()
    resetSettingsStore()
    resetProviderHealthForTests()
    const store = getSecretStore()
    await store.initialize()
    await getSettingsStore().initialize()
  })

  afterEach(() => {
    getSecretStore().stopPeriodicRefresh()
    resetSettingsStore()
    resetProviderHealthForTests()
    delete process.env.FICUS_ENCRYPTION_KEY
  })

  /** Wait for the fire-and-forget persistence write to land in the settings DB. */
  async function waitForPersist(expectedCount?: number): Promise<void> {
    for (let i = 0; i < 30; i++) {
      const raw = getSettingsStore().get('PROVIDER_HEALTH_STATE')
      if (raw) {
        if (expectedCount === undefined) break
        const parsed = JSON.parse(raw)
        if (parsed.version === 1 && parsed.records.length === expectedCount) break
      }
      await new Promise((r) => setTimeout(r, 50))
    }
  }

  it('writes through to DB on markExhausted when persistence is enabled', async () => {
    providerHealth.enablePersistence()
    providerHealth.markExhausted('anthropic', { reason: 'rate-limit', retryAt: Date.now() + 60_000 })

    await waitForPersist(1)

    // The settings DB should now contain the exhausted entry.
    const raw = getSettingsStore().get('PROVIDER_HEALTH_STATE')
    expect(raw).toBeTruthy()
    const parsed = JSON.parse(raw!)
    expect(parsed.version).toBe(1)
    expect(parsed.records).toHaveLength(1)
    expect(parsed.records[0].provider).toBe('anthropic')
    expect(parsed.records[0].kind).toBe('rate-limit')
    expect(parsed.revisions.anthropic).toBe(1)
  })

  it('does NOT write to DB when persistence is disabled (default factory)', async () => {
    const r = createProviderHealthRegistry()
    r.markExhausted('anthropic', { reason: 'rate-limit' })

    await new Promise((r) => setTimeout(r, 100))

    const raw = getSettingsStore().get('PROVIDER_HEALTH_STATE')
    expect(raw).toBeFalsy()
  })

  it('removes the entry from DB on markAvailable', async () => {
    providerHealth.enablePersistence()
    providerHealth.markExhausted('anthropic', { reason: 'rate-limit', retryAt: Date.now() + 60_000 })
    await waitForPersist(1)
    expect(getSettingsStore().get('PROVIDER_HEALTH_STATE')).toBeTruthy()

    providerHealth.markAvailable('anthropic')
    await providerHealth.flushPersistence()

    const raw = getSettingsStore().get('PROVIDER_HEALTH_STATE')
    const parsed = raw ? JSON.parse(raw) : { records: [] }
    const record = parsed.records.find((entry: { provider: string }) => entry.provider === 'anthropic')
    expect(record.lastSuccessAt).toBeGreaterThan(record.since)
  })

  it('persists and hydrates account-scoped entries', async () => {
    providerHealth.enablePersistence()
    providerHealth.markAccountExhausted('anthropic', 'acc_1', {
      reason: 'rate-limit',
      retryAt: Date.now() + 60_000,
    })
    await waitForPersist(1)

    const raw = getSettingsStore().get('PROVIDER_HEALTH_STATE')
    expect(raw).toBeTruthy()
    const parsed = JSON.parse(raw!)
    expect(parsed.records[0].provider).toBe('anthropic')
    expect(parsed.records[0].accountId).toBe('acc_1')

    const r = createProviderHealthRegistry()
    await r.hydrateFromPersistence()
    expect(r.isAccountHealthy('anthropic', 'acc_1')).toBe(false)
    expect(r.isAccountHealthy('anthropic', 'acc_2')).toBe(true)
  })

  it('hydrates from DB on startup (survives restart)', async () => {
    // Write an exhausted entry directly to the settings DB.
    const entries = [{ provider: 'zai', reason: 'plan-credit', since: Date.now(), retryAt: Date.now() + 30 * 60_000 }]
    await getSettingsStore().set('PROVIDER_HEALTH', JSON.stringify(entries), 'admin')

    // Simulate a fresh worker: new registry, hydrate from DB.
    const r = createProviderHealthRegistry()
    expect(r.isProviderHealthy('zai')).toBe(true) // not yet hydrated

    await r.hydrateFromPersistence()

    // The exhausted state is restored.
    expect(r.isProviderHealthy('zai')).toBe(false)
    expect(r.getHealth('zai').reason).toBe('plan-credit')
  })

  it('drops expired entries during hydration', async () => {
    // Write an expired entry directly to the settings DB.
    const expired = [
      { provider: 'openai', reason: 'rate-limit', since: Date.now() - 120_000, retryAt: Date.now() - 60_000 },
    ]
    await getSettingsStore().set('PROVIDER_HEALTH', JSON.stringify(expired), 'admin')

    const r = createProviderHealthRegistry()
    await r.hydrateFromPersistence()

    // Expired entry is not hydrated — provider is considered healthy.
    expect(r.isProviderHealthy('openai')).toBe(true)
    expect(r.snapshot()).toHaveLength(0)
  })

  it('hydrates multiple providers from DB', async () => {
    // Write multiple exhausted entries directly to the settings DB (deterministic,
    // avoids fire-and-forget timing issues when test files share a DB container).
    const entries = [
      { provider: 'anthropic', reason: 'rate-limit', since: Date.now(), retryAt: Date.now() + 60_000 },
      { provider: 'zai', reason: 'plan-credit', since: Date.now(), retryAt: Date.now() + 30 * 60_000 },
    ]
    await getSettingsStore().set('PROVIDER_HEALTH', JSON.stringify(entries), 'admin')

    const r = createProviderHealthRegistry()
    await r.hydrateFromPersistence()

    expect(r.isProviderHealthy('anthropic')).toBe(false)
    expect(r.isProviderHealthy('zai')).toBe(false)
    expect(r.snapshot()).toHaveLength(2)
  })

  it('hydrates last exhaustion retryAt for switch-back stability', async () => {
    // Use a far-future retryAt so the entry survives hydration (expired entries
    // are dropped) while still testing the isStablyHealthy window gate.
    const retryAt = Date.now() + 60_000
    const entries = [{ provider: 'anthropic', reason: 'rate-limit', since: Date.now() - 60_000, retryAt }]
    await getSettingsStore().set('PROVIDER_HEALTH', JSON.stringify(entries), 'admin')

    const r = createProviderHealthRegistry()
    await r.hydrateFromPersistence()

    // Provider is exhausted with retryAt 60s in the future — not healthy yet.
    expect(r.isProviderHealthy('anthropic')).toBe(false)
    // Not stably healthy either (retryAt + 30s window hasn't elapsed).
    expect(r.isStablyHealthy('anthropic', 30_000)).toBe(false)
  })
})
