import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { randomBytes } from 'crypto'
import { db, secrets } from '../../db'
import { SecretStore, getSecretStore, resetSecretStore } from '../secrets'
import { createAccountScopedCredentialStore } from './account-auth-backend'
import { getAccount, mutateAccountStore, readAccountStore, writeAccountStore } from './account-store'
import { providerHealth, resetProviderHealthForTests } from '../provider-health/registry'

describe('AccountScopedCredentialStore', () => {
  const testKey = randomBytes(32).toString('hex')
  let store: SecretStore

  beforeEach(async () => {
    process.env.FICUS_ENCRYPTION_KEY = testKey
    await db.delete(secrets)
    resetSecretStore()
    store = getSecretStore()
    await store.initialize()
    resetProviderHealthForTests()
  })

  afterEach(() => {
    store.stopPeriodicRefresh()
    resetProviderHealthForTests()
    delete process.env.FICUS_ENCRYPTION_KEY
  })

  test('projects only selected account per provider', async () => {
    await seedAccounts()

    const { credentials, backend } = createAccountScopedCredentialStore(['anthropic'])
    backend.selectAccount('anthropic', 'a2')

    const cred = await credentials.read('anthropic')
    expect((cred as any)?.key).toBe('sk-2')
    expect(await credentials.read('openai')).toBeUndefined()
  })

  test('keeps observational credential failures eligible for account projection', async () => {
    await seedAccounts()
    providerHealth.recordFailure(providerHealth.captureAttempt('anthropic', 'a1'), { kind: 'expired-oauth' })

    const { backend } = createAccountScopedCredentialStore(['anthropic'])

    expect(backend.getSelectedAccountId('anthropic')).toBe('a1')
  })

  test('selectAccount switches projected credential live', async () => {
    await seedAccounts()

    const { credentials, backend } = createAccountScopedCredentialStore(['anthropic'])
    backend.selectAccount('anthropic', 'a1')
    expect(((await credentials.read('anthropic')) as any)?.key).toBe('sk-1')

    // No explicit reload needed — the store re-reads on every call.
    backend.selectAccount('anthropic', 'a2')
    expect(((await credentials.read('anthropic')) as any)?.key).toBe('sk-2')
  })

  test('modify updates the selected account only', async () => {
    await seedAccounts()

    const { credentials, backend } = createAccountScopedCredentialStore(['anthropic'])
    backend.selectAccount('anthropic', 'a1')

    await credentials.modify('anthropic', async () => ({ type: 'api_key' as const, key: 'sk-updated' }))
    // The write-back is an async DB write — poll instead of a fixed sleep.
    await waitFor(() => (getAccount(readAccountStore(), 'anthropic', 'a1')!.credential as any)?.key === 'sk-updated')

    const s = readAccountStore()
    expect((getAccount(s, 'anthropic', 'a1')!.credential as any).key).toBe('sk-updated')
    expect((getAccount(s, 'anthropic', 'a2')!.credential as any).key).toBe('sk-2')
  })

  test('multiple providers each project independently', async () => {
    await seedAccounts()

    const { credentials, backend } = createAccountScopedCredentialStore(['anthropic', 'openai'])
    backend.selectAccount('anthropic', 'a2')
    backend.selectAccount('openai', 'o1')

    expect(((await credentials.read('anthropic')) as any)?.key).toBe('sk-2')
    expect(((await credentials.read('openai')) as any)?.key).toBe('sk-openai')
  })

  test('same-account modify callbacks serialize without blocking unrelated writes', async () => {
    await seedAccounts()

    const { credentials, backend } = createAccountScopedCredentialStore(['anthropic'])
    backend.selectAccount('anthropic', 'a1')

    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve))
    let enteredFirst!: () => void
    const enteredFirstPromise = new Promise<void>((resolve) => (enteredFirst = resolve))
    let enteredSecond = false

    const firstModify = credentials.modify('anthropic', async (current) => {
      enteredFirst()
      expect((current as any)?.key).toBe('sk-1')
      await firstGate
      return { type: 'api_key' as const, key: 'sk-refreshed' }
    })
    await enteredFirstPromise

    const secondModify = credentials.modify('anthropic', async (current) => {
      enteredSecond = true
      // Because the callback is queued per selected account, the second modify
      // re-observes the first refresh and can perform pi-ai's double-check
      // no-op instead of firing a second refresh.
      expect((current as any)?.key).toBe('sk-refreshed')
      return undefined
    })
    await Promise.resolve()
    expect(enteredSecond).toBe(false)

    await expect(
      mutateAccountStore((store) => {
        store.accounts.zai = [{ id: 'z1', enabled: true, credential: { type: 'api_key', key: 'sk-zai' } }]
      }, 'admin')
    ).resolves.toBeUndefined()
    expect((readAccountStore().accounts.zai[0].credential as any).key).toBe('sk-zai')

    releaseFirst()
    await firstModify
    await secondModify
    expect(enteredSecond).toBe(true)
    expect((getAccount(readAccountStore(), 'anthropic', 'a1')!.credential as any).key).toBe('sk-refreshed')
  })

  test('delete disables the selected account without writing a phantom credential', async () => {
    await seedAccounts()

    const { credentials, backend } = createAccountScopedCredentialStore(['anthropic'])
    backend.selectAccount('anthropic', 'a1')

    await credentials.delete('anthropic')
    expect(await credentials.read('anthropic')).toBeUndefined()
    await waitFor(() => getAccount(readAccountStore(), 'anthropic', 'a1')!.enabled === false)

    // The account entry persists (logout ≠ delete account), but it is disabled
    // rather than being replaced by a keyless `{ type: 'api_key' }` credential
    // that still looks configured to `credential != null` checks.
    const s = readAccountStore()
    const cleared = getAccount(s, 'anthropic', 'a1')
    expect(cleared).toBeDefined()
    expect(cleared!.enabled).toBe(false)
    expect((cleared!.credential as any).key).toBe('sk-1')
    // The other account is untouched and remains enabled.
    expect(getAccount(s, 'anthropic', 'a2')!.enabled).toBe(true)
    expect((getAccount(s, 'anthropic', 'a2')!.credential as any).key).toBe('sk-2')
  })

  test('stamps lastUsedAt when selecting accounts for a new store', async () => {
    await seedAccounts()
    const before = Date.now()

    createAccountScopedCredentialStore(['anthropic'])
    // lastUsedAt is persisted by a fire-and-forget async DB write — poll it.
    await waitFor(() => getAccount(readAccountStore(), 'anthropic', 'a1')!.lastUsedAt !== undefined)

    const s = readAccountStore()
    expect(getAccount(s, 'anthropic', 'a1')!.lastUsedAt).toBeGreaterThanOrEqual(before)
    expect(getAccount(s, 'anthropic', 'a2')!.lastUsedAt).toBeUndefined()
  })
})

/** Poll until `condition` is true (10ms interval, 3s cap) — replaces fixed sleeps racing async write-backs. */
async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      if (condition()) return
    } catch {
      // store not yet consistent — keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  // Let the subsequent expect() report the actual mismatch.
}

async function seedAccounts() {
  await writeAccountStore(
    {
      version: 1,
      accounts: {
        anthropic: [
          { id: 'a1', enabled: true, credential: { type: 'api_key', key: 'sk-1' } },
          { id: 'a2', enabled: true, credential: { type: 'api_key', key: 'sk-2' } },
        ],
        openai: [{ id: 'o1', enabled: true, credential: { type: 'api_key', key: 'sk-openai' } }],
      },
    },
    'admin'
  )
}
