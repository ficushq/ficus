import { describe, test, expect, afterEach } from 'bun:test'
import { getSettingsStore, SettingsStore, SettingValidationError, SETTING_CHANGED_CHANNEL } from './store'
import { listPeriodicRunnerNames, listPeriodicRunners } from '../../lib/infra/PeriodicRunner'
import { listen } from '../../lib/infra/local-events'
import { createProviderHealthRegistry, PROVIDER_HEALTH_STATE_KEY } from '../provider-health/registry'
import {
  MAX_CONCURRENT_AGENTS_SETTING_KEY,
  MAX_MAX_CONCURRENT_AGENTS,
  envMaxConcurrentAgents,
} from '../execution/max-concurrent'

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Timed out waiting for cross-process invalidation')
}

describe('inbox attachment settings', () => {
  test('expose configured defaults', async () => {
    const store = getSettingsStore()
    await store.initialize()
    // The store is a process-wide singleton and other test files set these keys
    // (e.g. quota tests set them to 0). Clear any override so this test verifies
    // the KNOWN_SETTINGS defaults deterministically, independent of file order.
    await store.delete('INBOX_MAX_ATTACHMENT_BYTES')
    await store.delete('INBOX_MAX_TOTAL_STORAGE_BYTES')
    expect(store.getTyped('INBOX_MAX_ATTACHMENT_BYTES')).toBe(10485760)
    expect(store.getTyped('INBOX_MAX_TOTAL_STORAGE_BYTES')).toBe(10737418240)
    const settings = await store.list()
    expect(settings.find(({ key }) => key === 'INBOX_MAX_ATTACHMENT_BYTES')?.description).toBe(
      'Maximum size in bytes of a single binary attachment'
    )
    expect(settings.find(({ key }) => key === 'INBOX_MAX_TOTAL_STORAGE_BYTES')?.description).toBe(
      'Global cap in bytes on total attachment storage for this instance'
    )
  })
})

describe('retired question rollout setting', () => {
  // The rollout gate is retired. The literal stays local to this compatibility
  // fixture: a stored row from an older deployment must be inert, and no
  // production consumer may read it. The row is deliberately left in place —
  // erasing it would break rollback safety.
  const LEGACY_QUESTION_ROLLOUT_KEY = 'AGENT_QUESTION_AUDIENCE_ROLLOUT'

  afterEach(async () => {
    await getSettingsStore().delete(LEGACY_QUESTION_ROLLOUT_KEY)
  })

  test('does not list the retired question rollout setting even when its row survives an upgrade', async () => {
    const store = getSettingsStore()
    await store.set(LEGACY_QUESTION_ROLLOUT_KEY, 'off')
    await store.initialize()

    expect((await store.list()).some(({ key }) => key === LEGACY_QUESTION_ROLLOUT_KEY)).toBe(false)
  })
})

describe('agent lifecycle retention settings', () => {
  test('independently configures dormant and terminated-private retention budgets', async () => {
    const store = getSettingsStore()
    await store.initialize()
    try {
      await store.set('AGENT_DORMANT_RETENTION_DAYS', '2')
      await store.set('AGENT_PRIVATE_ARCHIVE_RETENTION_DAYS', '9')
      expect(store.getTyped('AGENT_DORMANT_RETENTION_DAYS')).toBe(2)
      expect(store.getTyped('AGENT_PRIVATE_ARCHIVE_RETENTION_DAYS')).toBe(9)
    } finally {
      await store.delete('AGENT_DORMANT_RETENTION_DAYS')
      await store.delete('AGENT_PRIVATE_ARCHIVE_RETENTION_DAYS')
    }
  })
})

test('dormant retention accepts whole days from 1 to 3650 only', async () => {
  const store = getSettingsStore()
  await store.initialize()
  try {
    for (const value of ['', '0', '-1', '1.5', 'NaN', '3651'])
      await expect(store.set('AGENT_DORMANT_RETENTION_DAYS', value)).rejects.toThrow(SettingValidationError)
    await store.set('AGENT_DORMANT_RETENTION_DAYS', '30')
    expect(store.getTyped('AGENT_DORMANT_RETENTION_DAYS')).toBe(30)
  } finally {
    await store.delete('AGENT_DORMANT_RETENTION_DAYS')
  }
})

describe('OPENROUTER_TIER_EXPANSION_ENABLED setting registration', () => {
  test('is listed as a default-off cross-process boolean setting', async () => {
    const seen: string[] = []
    const unlisten = await listen(SETTING_CHANGED_CHANNEL, (key) => seen.push(key))
    const store = getSettingsStore()
    try {
      await store.initialize()
      await store.delete('OPENROUTER_TIER_EXPANSION_ENABLED')
      const entry = (await store.list()).find((setting) => setting.key === 'OPENROUTER_TIER_EXPANSION_ENABLED')
      expect(entry).toMatchObject({ type: 'boolean', default: 'false', value: 'false', isDefault: true })
      seen.length = 0
      await store.set('OPENROUTER_TIER_EXPANSION_ENABLED', 'true')
      await waitFor(() => seen.includes('OPENROUTER_TIER_EXPANSION_ENABLED'))
    } finally {
      unlisten()
      await store.delete('OPENROUTER_TIER_EXPANSION_ENABLED')
    }
  })
})

describe('MAX_CONCURRENT_AGENTS setting registration', () => {
  afterEach(async () => {
    await getSettingsStore().delete(MAX_CONCURRENT_AGENTS_SETTING_KEY)
  })

  // Mutation caught: forgetting to register the key in KNOWN_SETTINGS at all —
  // GET /settings would omit it and the UI would have nothing to render.
  test('is listed with number type and an env-aware default', async () => {
    const store = getSettingsStore()
    await store.initialize()
    await store.delete(MAX_CONCURRENT_AGENTS_SETTING_KEY)

    const entry = (await store.list()).find((s) => s.key === MAX_CONCURRENT_AGENTS_SETTING_KEY)
    expect(entry).toBeDefined()
    expect(entry!.type).toBe('number')
    expect(entry!.isDefault).toBe(true)
    // The displayed default must be the cap that ACTUALLY applies with nothing
    // stored (env var, else 30) — otherwise "revert to default" lies.
    // Mutation caught: hardcoding '30' here while the instance runs env=20.
    expect(entry!.default).toBe(String(envMaxConcurrentAgents()))
    expect(entry!.value).toBe(String(envMaxConcurrentAgents()))
    // Precedence must be discoverable from the description alone.
    expect(entry!.description).toContain('MAX_CONCURRENT_AGENTS environment variable')
  })

  // Mutation caught: reading the cache's default-filled `get()` instead of the
  // raw stored row, which would make the env var unreachable as a fallback.
  test('getStoredValue distinguishes "nothing stored" from the default', async () => {
    const store = getSettingsStore()
    await store.initialize()
    await store.delete(MAX_CONCURRENT_AGENTS_SETTING_KEY)
    expect(store.getStoredValue(MAX_CONCURRENT_AGENTS_SETTING_KEY)).toBeUndefined()
    // ...while get() still hands back the default, as it always has.
    expect(store.get(MAX_CONCURRENT_AGENTS_SETTING_KEY)).toBe(String(envMaxConcurrentAgents()))

    await store.set(MAX_CONCURRENT_AGENTS_SETTING_KEY, '7')
    expect(store.getStoredValue(MAX_CONCURRENT_AGENTS_SETTING_KEY)).toBe('7')
  })
})

describe('MAX_CONCURRENT_AGENTS write-boundary validation', () => {
  afterEach(async () => {
    await getSettingsStore().delete(MAX_CONCURRENT_AGENTS_SETTING_KEY)
  })

  test('accepts in-range integers', async () => {
    const store = getSettingsStore()
    await store.initialize()
    await store.set(MAX_CONCURRENT_AGENTS_SETTING_KEY, '1')
    expect(store.getStoredValue(MAX_CONCURRENT_AGENTS_SETTING_KEY)).toBe('1')
    await store.set(MAX_CONCURRENT_AGENTS_SETTING_KEY, String(MAX_MAX_CONCURRENT_AGENTS))
    expect(store.getStoredValue(MAX_CONCURRENT_AGENTS_SETTING_KEY)).toBe(String(MAX_MAX_CONCURRENT_AGENTS))
  })

  // Mutation caught: validating only on the HTTP route (so scripts, migrations
  // and tests could still persist a cap of 0 that halts the instance), or
  // dropping the throw so the bad value is written and merely logged.
  test.each([
    ['zero', '0'],
    ['negative', '-1'],
    ['non-numeric', 'banana'],
    ['fractional', '2.5'],
    ['empty', ''],
    ['absurdly large', String(MAX_MAX_CONCURRENT_AGENTS + 1)],
  ])('rejects %s and writes nothing', async (_label, badValue) => {
    const store = getSettingsStore()
    await store.initialize()
    await store.set(MAX_CONCURRENT_AGENTS_SETTING_KEY, '9')

    let error: unknown
    try {
      await store.set(MAX_CONCURRENT_AGENTS_SETTING_KEY, badValue)
    } catch (err) {
      error = err
    }

    expect(error).toBeInstanceOf(SettingValidationError)
    expect((error as Error).message).toContain('between 1 and')
    // The previous good value survives — a rejected write is a no-op.
    expect(store.getStoredValue(MAX_CONCURRENT_AGENTS_SETTING_KEY)).toBe('9')
    const persisted = (await store.list()).find((s) => s.key === MAX_CONCURRENT_AGENTS_SETTING_KEY)
    expect(persisted!.value).toBe('9')
  })

  // Mutation caught: applying the concurrency validator to every numeric
  // setting, which would break the inbox-quota tests that legitimately store 0.
  test('validation is scoped to this key only', async () => {
    const store = getSettingsStore()
    await store.initialize()
    await store.set('INBOX_MAX_ATTACHMENT_BYTES', '0')
    expect(store.getTyped('INBOX_MAX_ATTACHMENT_BYTES')).toBe(0)
    await store.delete('INBOX_MAX_ATTACHMENT_BYTES')
  })
})

/**
 * NOTE ON SCOPE — these tests do NOT cross a process boundary.
 *
 * `SettingsStore` reaches the transport through the module-level
 * `notify`/`listen`, and in tests that transport has no `peerUrl` configured,
 * so a notification rides the local `queueMicrotask` dispatch rather than the
 * loopback POST. What is proven here is the store's half of the wiring: that a
 * write publishes on `SETTING_CHANGED_CHANNEL`, and that a second
 * `SettingsStore` subscribed to that channel re-reads the key from the DB
 * without any periodic refresh running.
 *
 * The HTTP hop itself — one transport posting to another transport's real
 * loopback server, with auth — is covered directly in
 * `lib/infra/local-events.test.ts` ("round trip through the real transport").
 * Splitting it that way is deliberate: the store has no seam to inject a
 * second transport, and asserting the hop here would only re-test
 * local-events through a longer pipe.
 */
describe('SettingsStore SETTING_CHANGED subscription (in-process)', () => {
  afterEach(async () => {
    await getSettingsStore().delete(MAX_CONCURRENT_AGENTS_SETTING_KEY)
  })

  // Mutation caught: relying on the 60s periodic refresh alone. `tau-api` (the
  // writer) and `tau-worker` (where pickup reads the cap) are separate OS
  // processes with separate caches; without the notification the worker keeps
  // admitting at the OLD cap for up to a minute after the operator saves.
  test('a second store subscribed to the channel re-reads the cap on a write', async () => {
    const writer = getSettingsStore()
    await writer.initialize()

    const reader = new SettingsStore() // stands in for the worker process
    await reader.initialize()
    // Deliberately NOT started: this proves the notification did the work.
    expect(listPeriodicRunnerNames()).not.toContain('settings-store-refresh')
    await reader.startCrossProcessInvalidation()

    try {
      await writer.set(MAX_CONCURRENT_AGENTS_SETTING_KEY, '3')
      await waitFor(() => reader.getStoredValue(MAX_CONCURRENT_AGENTS_SETTING_KEY) === '3')

      await writer.set(MAX_CONCURRENT_AGENTS_SETTING_KEY, '9')
      await waitFor(() => reader.getStoredValue(MAX_CONCURRENT_AGENTS_SETTING_KEY) === '9')

      // A revert-to-default must propagate too, not just a new value.
      await writer.delete(MAX_CONCURRENT_AGENTS_SETTING_KEY)
      await waitFor(() => reader.getStoredValue(MAX_CONCURRENT_AGENTS_SETTING_KEY) === undefined)
    } finally {
      reader.stopCrossProcessInvalidation()
    }
  })

  // Mutation caught: broadcasting the VALUE instead of the key, or firing
  // listeners on a no-op refresh.
  test('refreshKey fires change listeners only when the value actually changed', async () => {
    const store = new SettingsStore()
    await store.initialize()
    const seen: Array<[string, string]> = []
    store.onChange((key, value) => {
      seen.push([key, value])
    })

    await getSettingsStore().set(MAX_CONCURRENT_AGENTS_SETTING_KEY, '4')
    await store.refreshKey(MAX_CONCURRENT_AGENTS_SETTING_KEY)
    expect(seen).toEqual([[MAX_CONCURRENT_AGENTS_SETTING_KEY, '4']])

    // Same value again — no second notification.
    await store.refreshKey(MAX_CONCURRENT_AGENTS_SETTING_KEY)
    expect(seen).toHaveLength(1)
  })
})

describe('SettingsStore cross-process broadcast scope', () => {
  /** Let the transport's queueMicrotask dispatch and the fire-and-forget notify settle. */
  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }

  afterEach(async () => {
    const store = getSettingsStore()
    await store.delete(MAX_CONCURRENT_AGENTS_SETTING_KEY)
    await store.delete('PROVIDER_HEALTH_STATE')
    await store.delete('INBOX_MAX_ATTACHMENT_BYTES')
  })

  /**
   * Broadcasting on EVERY write is not free. `PROVIDER_HEALTH` is rewritten by
   * the worker on every `markExhausted`/`markAvailable` — i.e. repeatedly,
   * during exactly the rate-limit storms when the instance is least idle — and
   * each broadcast costs a loopback POST plus a `SELECT` on the peer to
   * re-read a key that peer does not consult. Only keys whose consumer lives in
   * the OTHER process need the fast path; everything else is already served by
   * the periodic refresh.
   *
   * Mutation caught: emitting unconditionally from `set`/`delete`.
   */
  test('only opted-in keys broadcast; hot-path writes stay local', async () => {
    const seen: string[] = []
    const unlisten = await listen(SETTING_CHANGED_CHANNEL, (key) => {
      seen.push(key)
    })

    try {
      const store = getSettingsStore()
      await store.initialize()

      await store.set(MAX_CONCURRENT_AGENTS_SETTING_KEY, '6')
      await settle()
      expect(seen).toEqual([MAX_CONCURRENT_AGENTS_SETTING_KEY])

      await store.set('PROVIDER_HEALTH_STATE', JSON.stringify({ version: 1, records: [], revisions: {} }))
      await store.set('INBOX_MAX_ATTACHMENT_BYTES', '4096')
      await settle()
      expect(seen).toEqual([MAX_CONCURRENT_AGENTS_SETTING_KEY, 'PROVIDER_HEALTH_STATE'])

      await store.delete('PROVIDER_HEALTH_STATE')
      await settle()
      expect(seen).toEqual([MAX_CONCURRENT_AGENTS_SETTING_KEY, 'PROVIDER_HEALTH_STATE', 'PROVIDER_HEALTH_STATE'])

      await store.delete(MAX_CONCURRENT_AGENTS_SETTING_KEY)
      await settle()
      expect(seen).toEqual([
        MAX_CONCURRENT_AGENTS_SETTING_KEY,
        'PROVIDER_HEALTH_STATE',
        'PROVIDER_HEALTH_STATE',
        MAX_CONCURRENT_AGENTS_SETTING_KEY,
      ])
    } finally {
      await unlisten()
    }
  })
})

describe('SettingsStore periodic refresh', () => {
  test('rehydrates an API provider-health replica after a missed change notification', async () => {
    const writer = getSettingsStore()
    const reader = new SettingsStore()
    const unresolved = {
      version: 1,
      records: [
        {
          provider: 'anthropic',
          kind: 'rate-limit',
          message: 'Rate limit reached',
          since: 1_000,
          retryAt: Date.now() + 60_000,
        },
      ],
      revisions: { anthropic: 1 },
    }
    await writer.set(PROVIDER_HEALTH_STATE_KEY, JSON.stringify(unresolved))
    await reader.initialize()
    const replica = createProviderHealthRegistry({
      persistence: { get: (key) => reader.getStoredValue(key), set: async () => {} },
    })
    await replica.hydrateFromPersistence()
    expect(replica.getRecord('anthropic')?.lastSuccessAt).toBeUndefined()

    await writer.set(
      PROVIDER_HEALTH_STATE_KEY,
      JSON.stringify({
        ...unresolved,
        records: [{ ...unresolved.records[0], lastSuccessAt: 2_000 }],
        revisions: { anthropic: 2 },
      })
    )
    reader.startPeriodicRefresh(10, () => replica.hydrateFromPersistence())

    try {
      await waitFor(() => replica.getRecord('anthropic')?.lastSuccessAt === 2_000)
    } finally {
      reader.stopPeriodicRefresh()
      await writer.delete(PROVIDER_HEALTH_STATE_KEY)
    }
  })

  test('registers with the periodic-runner registry', () => {
    const store = getSettingsStore()
    store.startPeriodicRefresh()
    expect(listPeriodicRunnerNames()).toContain('settings-store-refresh')

    store.stopPeriodicRefresh()
    expect(listPeriodicRunnerNames()).not.toContain('settings-store-refresh')
  })

  test('refreshes every 5 minutes by default, behind cross-process invalidation', () => {
    const store = getSettingsStore()
    store.startPeriodicRefresh()
    const runner = listPeriodicRunners().find((r) => r.runnerName === 'settings-store-refresh')
    expect(runner?.runnerIntervalMs).toBe(5 * 60_000)

    store.stopPeriodicRefresh()
  })
})
