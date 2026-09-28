import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import { randomBytes } from 'crypto'
import { db, secrets } from '../../db'
import { SecretStore, getSecretStore, resetSecretStore } from '../secrets'
import { eq } from 'drizzle-orm'
import * as onboardingEvents from '../onboarding/events'
import {
  readAccountStore,
  writeAccountStore,
  mutateAccountStore,
  mutateAccountStoreAsync,
  migrateLegacyAuthData,
  listAccounts,
  addAccount,
  updateAccount,
  deleteAccount,
  getAccount,
  reorderAccounts,
  credentialIdentity,
  persistOAuthCredential,
  PROVIDER_AUTH_DATA_KEY,
  type AccountStoreV1,
} from './account-store'
import type { Credential } from '@earendil-works/pi-ai'

describe('account-store', () => {
  const testKey = randomBytes(32).toString('hex')
  let store: SecretStore

  beforeEach(async () => {
    process.env.FICUS_ENCRYPTION_KEY = testKey
    await db.delete(secrets)
    resetSecretStore()
    store = getSecretStore()
    await store.initialize()
  })

  afterEach(() => {
    store.stopPeriodicRefresh()
    delete process.env.FICUS_ENCRYPTION_KEY
  })

  test('empty blob returns empty store', () => {
    const s = readAccountStore()
    expect(s.version).toBe(1)
    expect(Object.keys(s.accounts)).toHaveLength(0)
  })

  test('migrates legacy Record<provider, AuthCredential>', () => {
    const legacy = { anthropic: { type: 'api_key', key: 'sk-1' } }
    const s = migrateLegacyAuthData(legacy as any)
    expect(s.version).toBe(1)
    expect(s.accounts.anthropic).toHaveLength(1)
    expect(s.accounts.anthropic[0].credential).toEqual({ type: 'api_key', key: 'sk-1' })
    expect(s.accounts.anthropic[0].enabled).toBe(true)
    expect(s.accounts.anthropic[0].id).toBe('acc_migrated')
  })

  test('readAccountStore migrates legacy PROVIDER_AUTH_DATA on read', async () => {
    await store.set(
      'PROVIDER_AUTH_DATA',
      JSON.stringify({
        anthropic: { type: 'api_key', key: 'sk-legacy' },
        openai: { type: 'api_key', key: 'sk-openai' },
      }),
      'admin'
    )
    const s = readAccountStore()
    expect(s.accounts.anthropic).toHaveLength(1)
    expect((s.accounts.anthropic[0].credential as any).key).toBe('sk-legacy')
    expect(s.accounts.openai).toHaveLength(1)
  })

  test('V1 blob round-trips', async () => {
    const s: AccountStoreV1 = {
      version: 1,
      accounts: {
        anthropic: [{ id: 'acc_1', enabled: true, credential: { type: 'api_key', key: 'sk-1' } }],
      },
    }
    await writeAccountStore(s, 'admin')
    const read = readAccountStore()
    expect(read).toEqual(s)
  })

  test('addAccount generates unique id', () => {
    const s = { version: 1, accounts: {} } as AccountStoreV1
    const a1 = addAccount(s, 'anthropic', { type: 'api_key', key: 'sk-1' })
    const a2 = addAccount(s, 'anthropic', { type: 'api_key', key: 'sk-2' }, 'Work')
    expect(a1.id).not.toBe(a2.id)
    expect(a2.label).toBe('Work')
    expect(listAccounts(s, 'anthropic')).toHaveLength(2)
  })

  test('updateAccount changes label/enabled', () => {
    const s = {
      version: 1,
      accounts: {
        anthropic: [{ id: 'acc_1', enabled: true, credential: { type: 'api_key', key: 'sk-1' } }],
      },
    } as AccountStoreV1
    updateAccount(s, 'anthropic', 'acc_1', { label: 'Prod', enabled: false })
    expect(getAccount(s, 'anthropic', 'acc_1')!.label).toBe('Prod')
    expect(getAccount(s, 'anthropic', 'acc_1')!.enabled).toBe(false)
  })

  test('salvages a stray top-level credential key into accounts', async () => {
    // A racing legacy writer (the SDK's fire-and-forget auth write) could land
    // a bare provider->credential key next to version/accounts.
    await store.set(
      'PROVIDER_AUTH_DATA',
      JSON.stringify({
        version: 1,
        accounts: {
          openai: [{ id: 'acc_1', enabled: true, credential: { type: 'api_key', key: 'sk-1' } }],
        },
        'openai-codex': { type: 'oauth', refresh: 'r', access: 'a', expires: 123 },
      }),
      'admin'
    )

    const s = readAccountStore()
    expect(s.accounts['openai-codex']).toHaveLength(1)
    expect(s.accounts['openai-codex'][0]).toEqual({
      id: 'acc_migrated',
      enabled: true,
      credential: { type: 'oauth', refresh: 'r', access: 'a', expires: 123 } as any,
    })
    // Existing accounts are untouched.
    expect(s.accounts.openai).toHaveLength(1)

    // Idempotent: repeated reads yield the same store (deterministic id).
    expect(readAccountStore()).toEqual(s)

    // Persisting strips the stray key while keeping the salvaged account.
    await writeAccountStore(s, 'admin')
    const raw = JSON.parse(store.get('PROVIDER_AUTH_DATA')!)
    expect(Object.keys(raw).sort()).toEqual(['accounts', 'version'])
    expect(readAccountStore()).toEqual(s)
  })

  test('salvage skips stray keys already represented by a same-type account', async () => {
    await store.set(
      'PROVIDER_AUTH_DATA',
      JSON.stringify({
        version: 1,
        accounts: {
          'openai-codex': [
            { id: 'acc_live', enabled: true, credential: { type: 'oauth', refresh: 'r2', access: 'a2', expires: 456 } },
          ],
        },
        'openai-codex': { type: 'oauth', refresh: 'r1', access: 'a1', expires: 123 },
      }),
      'admin'
    )

    const s = readAccountStore()
    expect(s.accounts['openai-codex']).toHaveLength(1)
    expect(s.accounts['openai-codex'][0].id).toBe('acc_live')
  })

  test('salvage never reuses an existing acc_migrated id', async () => {
    await store.set(
      'PROVIDER_AUTH_DATA',
      JSON.stringify({
        version: 1,
        accounts: {
          codexish: [{ id: 'acc_migrated', enabled: true, credential: { type: 'api_key', key: 'sk-1' } }],
        },
        codexish: { type: 'oauth', refresh: 'r', access: 'a', expires: 123 },
      }),
      'admin'
    )

    const s = readAccountStore()
    const ids = s.accounts.codexish.map((a) => a.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test('salvage ignores stray values that do not look like credentials', async () => {
    await store.set(
      'PROVIDER_AUTH_DATA',
      JSON.stringify({
        version: 1,
        accounts: {},
        junkString: 'nope',
        junkObject: { notACredential: true },
      }),
      'admin'
    )

    const s = readAccountStore()
    expect(Object.keys(s.accounts)).toHaveLength(0)
  })

  test('salvage rejects a stray key whose type is not a recognized credential type', async () => {
    // A bare `type` field isn't enough — `{ type: 123 }` or `{ type: 'bogus' }`
    // must not be lifted into a selectable account with a bogus credential.
    await store.set(
      'PROVIDER_AUTH_DATA',
      JSON.stringify({
        version: 1,
        accounts: {},
        someprovider: { type: 123 },
        otherprovider: { type: 'bogus' },
      }),
      'admin'
    )

    const s = readAccountStore()
    expect(Object.keys(s.accounts)).toHaveLength(0)
  })

  test('deleteAccount removes account', () => {
    const s = {
      version: 1,
      accounts: {
        anthropic: [{ id: 'acc_1', enabled: true, credential: { type: 'api_key', key: 'sk-1' } }],
      },
    } as AccountStoreV1
    expect(deleteAccount(s, 'anthropic', 'acc_1')).toBe(true)
    expect(listAccounts(s, 'anthropic')).toHaveLength(0)
  })

  describe('reorderAccounts', () => {
    function threeAccountStore(): AccountStoreV1 {
      return {
        version: 1,
        accounts: {
          anthropic: [
            { id: 'a1', enabled: true, credential: { type: 'api_key', key: 'k1' } },
            { id: 'a2', enabled: true, credential: { type: 'api_key', key: 'k2' } },
            { id: 'a3', enabled: true, credential: { type: 'api_key', key: 'k3' } },
          ],
        },
      } as AccountStoreV1
    }

    test('happy path rewrites accounts in the given order', () => {
      const s = threeAccountStore()
      reorderAccounts(s, 'anthropic', ['a3', 'a1', 'a2'])
      expect(listAccounts(s, 'anthropic').map((a) => a.id)).toEqual(['a3', 'a1', 'a2'])
      // Account objects themselves are preserved, not recreated.
      expect(listAccounts(s, 'anthropic')[1].credential).toEqual({ type: 'api_key', key: 'k1' })
    })

    test('throws when order is missing an id', () => {
      const s = threeAccountStore()
      expect(() => reorderAccounts(s, 'anthropic', ['a1', 'a2'])).toThrow()
      // Store is untouched on failure.
      expect(listAccounts(s, 'anthropic').map((a) => a.id)).toEqual(['a1', 'a2', 'a3'])
    })

    test('throws when order has an extra/unknown id', () => {
      const s = threeAccountStore()
      expect(() => reorderAccounts(s, 'anthropic', ['a1', 'a2', 'a3', 'a4'])).toThrow()
    })

    test('throws when order has a duplicate id', () => {
      const s = threeAccountStore()
      expect(() => reorderAccounts(s, 'anthropic', ['a1', 'a1', 'a2'])).toThrow()
    })

    test('throws for an unknown provider', () => {
      const s = threeAccountStore()
      expect(() => reorderAccounts(s, 'openai', ['a1'])).toThrow()
    })
  })

  describe('mutateAccountStore (transactional cross-process RMW)', () => {
    /** Read the final DB state through a completely fresh instance (no shared cache). */
    async function readFinalDbStore(): Promise<AccountStoreV1> {
      const fresh = new SecretStore()
      await fresh.initialize()
      return JSON.parse(fresh.get(PROVIDER_AUTH_DATA_KEY)!) as AccountStoreV1
    }

    test("a stale-cache mutate does not clobber another process's new account (oauth regression)", async () => {
      // Worker (the singleton) starts with one api_key account in its cache.
      await writeAccountStore(
        {
          version: 1,
          accounts: {
            anthropic: [{ id: 'acc_key', enabled: true, credential: { type: 'api_key', key: 'sk-1' } }],
          },
        },
        'admin'
      )

      // API process (separate instance over the same DB) completes an OAuth
      // login and adds a second account. The worker's cache never sees it.
      const apiStore = new SecretStore()
      await apiStore.initialize()
      const apiView = JSON.parse(apiStore.get(PROVIDER_AUTH_DATA_KEY)!) as AccountStoreV1
      apiView.accounts.anthropic.push({
        id: 'acc_oauth',
        enabled: true,
        credential: { type: 'oauth', refresh: 'rt', access: 'at', expires: 0 } as never,
      })
      await apiStore.set(PROVIDER_AUTH_DATA_KEY, JSON.stringify(apiView), 'admin')

      // Worker-side lastUsedAt stamp through the (stale-cached) singleton.
      expect(readAccountStore().accounts.anthropic).toHaveLength(1) // cache is stale
      await mutateAccountStore((s) => {
        const account = getAccount(s, 'anthropic', 'acc_key')
        if (!account) return false
        account.lastUsedAt = 1234
      }, 'system')

      // The OAuth account SURVIVES and the stamp landed.
      const final = await readFinalDbStore()
      expect(final.accounts.anthropic.map((a) => a.id).sort()).toEqual(['acc_key', 'acc_oauth'])
      expect(getAccount(final, 'anthropic', 'acc_key')!.lastUsedAt).toBe(1234)
      // The mutating process's cache also converged on the merged state.
      expect(readAccountStore().accounts.anthropic).toHaveLength(2)
    })

    test('mutate returning false writes nothing', async () => {
      await writeAccountStore(
        {
          version: 1,
          accounts: { anthropic: [{ id: 'a1', enabled: true, credential: { type: 'api_key', key: 'k' } }] },
        },
        'admin'
      )
      const [before] = await db.select().from(secrets).where(eq(secrets.key, PROVIDER_AUTH_DATA_KEY))

      await mutateAccountStore(() => false, 'system')

      const [after] = await db.select().from(secrets).where(eq(secrets.key, PROVIDER_AUTH_DATA_KEY))
      expect(after).toEqual(before)
    })

    test('first-ever mutate inserts the row', async () => {
      await mutateAccountStore((s) => {
        addAccount(s, 'anthropic', { type: 'api_key', key: 'sk-first' } as never, 'First')
      }, 'admin')

      const final = await readFinalDbStore()
      expect(final.accounts.anthropic).toHaveLength(1)
      expect((final.accounts.anthropic[0].credential as { key?: string }).key).toBe('sk-first')
    })

    test('malformed stored JSON rejects the mutation instead of writing a fresh-empty store', async () => {
      await store.set(PROVIDER_AUTH_DATA_KEY, '{not-json', 'admin')
      const [before] = await db.select().from(secrets).where(eq(secrets.key, PROVIDER_AUTH_DATA_KEY))

      await expect(
        mutateAccountStore((s) => {
          addAccount(s, 'anthropic', { type: 'api_key', key: 'sk-x' } as never)
        }, 'system')
      ).rejects.toThrow()

      const [after] = await db.select().from(secrets).where(eq(secrets.key, PROVIDER_AUTH_DATA_KEY))
      expect(after).toEqual(before)
    })
  })

  describe('onboarding notification (operator-reported path — provider account add/remove)', () => {
    test('mutateAccountStore notifies onboarding after a real write (API-key add path)', async () => {
      const spy = spyOn(onboardingEvents, 'notifyOnboardingChanged')

      await mutateAccountStore((s) => {
        addAccount(s, 'anthropic', { type: 'api_key', key: 'sk-add' } as never)
      }, 'admin')

      expect(spy).toHaveBeenCalledTimes(1)
      spy.mockRestore()
    })

    test('mutateAccountStore does NOT notify onboarding when mutate returns false (no-op write)', async () => {
      const spy = spyOn(onboardingEvents, 'notifyOnboardingChanged')

      await mutateAccountStore(() => false, 'system')

      expect(spy).not.toHaveBeenCalled()
      spy.mockRestore()
    })

    test('mutateAccountStoreAsync notifies onboarding after a real write (OAuth round-trip path)', async () => {
      const spy = spyOn(onboardingEvents, 'notifyOnboardingChanged')

      await mutateAccountStoreAsync(async (s) => {
        addAccount(s, 'anthropic', { type: 'oauth', refresh: 'r', access: 'a', expires: 0 } as never)
      }, 'admin')

      expect(spy).toHaveBeenCalledTimes(1)
      spy.mockRestore()
    })

    test('mutateAccountStoreAsync does NOT notify onboarding when mutate returns false (no-op write)', async () => {
      const spy = spyOn(onboardingEvents, 'notifyOnboardingChanged')

      await mutateAccountStoreAsync(async () => false, 'system')

      expect(spy).not.toHaveBeenCalled()
      spy.mockRestore()
    })
  })

  describe('onboarding notification is fingerprint-gated (does not fire on signal-inert writes)', () => {
    test('mutateAccountStore does NOT notify when only lastUsedAt is stamped', async () => {
      await mutateAccountStore((s) => {
        addAccount(s, 'anthropic', { type: 'api_key', key: 'sk-1' } as never, undefined)
      }, 'admin')
      const [account] = listAccounts(readAccountStore(), 'anthropic')

      const spy = spyOn(onboardingEvents, 'notifyOnboardingChanged')
      await mutateAccountStore((s) => {
        const a = getAccount(s, 'anthropic', account.id)
        if (!a) return false
        a.lastUsedAt = Date.now()
      }, 'system')

      expect(spy).not.toHaveBeenCalled()
      spy.mockRestore()
    })

    test('mutateAccountStore DOES notify when an account is added', async () => {
      const spy = spyOn(onboardingEvents, 'notifyOnboardingChanged')

      await mutateAccountStore((s) => {
        addAccount(s, 'anthropic', { type: 'api_key', key: 'sk-add' } as never)
      }, 'admin')

      expect(spy).toHaveBeenCalledTimes(1)
      spy.mockRestore()
    })

    test('mutateAccountStore DOES notify when the last account for a provider is removed', async () => {
      await mutateAccountStore((s) => {
        addAccount(s, 'anthropic', { type: 'api_key', key: 'sk-1' } as never)
      }, 'admin')
      const [account] = listAccounts(readAccountStore(), 'anthropic')

      const spy = spyOn(onboardingEvents, 'notifyOnboardingChanged')
      await mutateAccountStore((s) => {
        deleteAccount(s, 'anthropic', account.id)
      }, 'admin')

      expect(spy).toHaveBeenCalledTimes(1)
      spy.mockRestore()
    })

    test('mutateAccountStore DOES notify when an account is disabled', async () => {
      await mutateAccountStore((s) => {
        addAccount(s, 'anthropic', { type: 'api_key', key: 'sk-1' } as never)
      }, 'admin')
      const [account] = listAccounts(readAccountStore(), 'anthropic')

      const spy = spyOn(onboardingEvents, 'notifyOnboardingChanged')
      await mutateAccountStore((s) => {
        updateAccount(s, 'anthropic', account.id, { enabled: false })
      }, 'admin')

      expect(spy).toHaveBeenCalledTimes(1)
      spy.mockRestore()
    })

    test('mutateAccountStore does NOT notify on a reorder write (no enabled-count change)', async () => {
      await mutateAccountStore((s) => {
        addAccount(s, 'anthropic', { type: 'api_key', key: 'sk-1' } as never)
        addAccount(s, 'anthropic', { type: 'api_key', key: 'sk-2' } as never)
      }, 'admin')
      const [a1, a2] = listAccounts(readAccountStore(), 'anthropic')

      const spy = spyOn(onboardingEvents, 'notifyOnboardingChanged')
      await mutateAccountStore((s) => {
        reorderAccounts(s, 'anthropic', [a2.id, a1.id])
      }, 'admin')

      expect(spy).not.toHaveBeenCalled()
      spy.mockRestore()
    })

    test('mutateAccountStoreAsync does NOT notify when only lastUsedAt is stamped', async () => {
      await mutateAccountStoreAsync(async (s) => {
        addAccount(s, 'anthropic', { type: 'api_key', key: 'sk-1' } as never)
      }, 'admin')
      const [account] = listAccounts(readAccountStore(), 'anthropic')

      const spy = spyOn(onboardingEvents, 'notifyOnboardingChanged')
      await mutateAccountStoreAsync(async (s) => {
        const a = getAccount(s, 'anthropic', account.id)
        if (!a) return false
        a.lastUsedAt = Date.now()
      }, 'system')

      expect(spy).not.toHaveBeenCalled()
      spy.mockRestore()
    })

    test('mutateAccountStoreAsync DOES notify when an account is added', async () => {
      const spy = spyOn(onboardingEvents, 'notifyOnboardingChanged')

      await mutateAccountStoreAsync(async (s) => {
        addAccount(s, 'anthropic', { type: 'oauth', refresh: 'r', access: 'a', expires: 0 } as never)
      }, 'admin')

      expect(spy).toHaveBeenCalledTimes(1)
      spy.mockRestore()
    })
  })
})

describe('credentialIdentity', () => {
  test('extracts accountId from an oauth credential (codex shape)', () => {
    const cred = { type: 'oauth', access: 'a', refresh: 'r', expires: 0, accountId: 'chatgpt-acct-42' } as Credential
    expect(credentialIdentity(cred)).toBe('chatgpt-acct-42')
  })

  test('returns undefined when the oauth credential carries no identity', () => {
    expect(credentialIdentity({ type: 'oauth', access: 'a', refresh: 'r', expires: 0 } as Credential)).toBeUndefined()
  })

  test('returns undefined for api_key credentials and blank/non-string accountId', () => {
    expect(credentialIdentity({ type: 'api_key', key: 'sk-1' } as Credential)).toBeUndefined()
    expect(
      credentialIdentity({ type: 'oauth', access: 'a', refresh: 'r', expires: 0, accountId: '' } as Credential)
    ).toBeUndefined()
    expect(
      credentialIdentity({
        type: 'oauth',
        access: 'a',
        refresh: 'r',
        expires: 0,
        accountId: 123,
      } as unknown as Credential)
    ).toBeUndefined()
  })
})

describe('persistOAuthCredential', () => {
  const oauth = (access: string, extra: Record<string, unknown> = {}): Credential =>
    ({ type: 'oauth', access, refresh: `r-${access}`, expires: 0, ...extra }) as Credential
  const apiKey = (key: string): Credential => ({ type: 'api_key', key }) as Credential

  const storeWith = (accounts: AccountStoreV1['accounts']): AccountStoreV1 => ({ version: 1, accounts })

  // (a) ADD appends a new account and preserves every existing account byte-for-byte.
  test('ADD (no accountId) appends a new oauth account, preserving existing accounts exactly', () => {
    const existing = { id: 'acc_migrated', enabled: true, credential: apiKey('sk-existing') }
    const existingOAuth = { id: 'acc_old', enabled: true, credential: oauth('access-old') }
    const store = storeWith({ openai: [structuredClone(existing), structuredClone(existingOAuth)] })
    const snapshotExisting = structuredClone(existing)
    const snapshotOAuth = structuredClone(existingOAuth)

    const result = persistOAuthCredential(store, 'openai', oauth('access-new'))

    expect(result.status).toBe('added')
    const accounts = store.accounts.openai
    expect(accounts).toHaveLength(3)
    // Existing accounts untouched, byte-for-byte.
    expect(accounts[0]).toEqual(snapshotExisting)
    expect(accounts[1]).toEqual(snapshotOAuth)
    // The appended account is brand new (fresh id, not acc_migrated/acc_old).
    expect(accounts[2].id).not.toBe('acc_migrated')
    expect(accounts[2].id).not.toBe('acc_old')
    expect(accounts[2].enabled).toBe(true)
    expect((accounts[2].credential as { access: string }).access).toBe('access-new')
  })

  // (b) REAUTHORIZE updates exactly the named account among several, touching no other.
  test('REAUTHORIZE (accountId) updates exactly the named account among several', () => {
    const store = storeWith({
      openai: [
        { id: 'acc_a', enabled: true, credential: oauth('access-a') },
        { id: 'acc_b', enabled: false, credential: oauth('access-b') },
        { id: 'acc_c', enabled: true, credential: oauth('access-c') },
      ],
    })
    const snapshotA = structuredClone(store.accounts.openai[0])
    const snapshotC = structuredClone(store.accounts.openai[2])

    const result = persistOAuthCredential(store, 'openai', oauth('access-b-refreshed'), 'acc_b')

    expect(result.status).toBe('reauthorized')
    const accounts = store.accounts.openai
    expect(accounts).toHaveLength(3)
    // Only acc_b changed (and was re-enabled); acc_a and acc_c are untouched.
    expect(accounts[0]).toEqual(snapshotA)
    expect(accounts[2]).toEqual(snapshotC)
    expect(accounts[1].id).toBe('acc_b')
    expect(accounts[1].enabled).toBe(true)
    expect((accounts[1].credential as { access: string }).access).toBe('access-b-refreshed')
  })

  // (c) REAUTHORIZE of a deleted accountId errors without touching any other account.
  test('REAUTHORIZE of a missing accountId returns account_not_found and mutates nothing', () => {
    const store = storeWith({
      openai: [
        { id: 'acc_a', enabled: true, credential: oauth('access-a') },
        { id: 'acc_b', enabled: true, credential: oauth('access-b') },
      ],
    })
    const before = structuredClone(store.accounts.openai)

    const result = persistOAuthCredential(store, 'openai', oauth('access-x'), 'acc_gone')

    expect(result.status).toBe('account_not_found')
    expect(store.accounts.openai).toEqual(before)
  })

  // (d) Identity dedupe: a same-identity ADD folds into an in-place update.
  test('ADD folds into an in-place update when the credential identity matches an existing account', () => {
    const store = storeWith({
      openai: [
        { id: 'acc_other', enabled: true, credential: oauth('access-other', { accountId: 'ident-OTHER' }) },
        { id: 'acc_same', enabled: false, credential: oauth('access-old', { accountId: 'ident-SAME' }) },
      ],
    })
    const snapshotOther = structuredClone(store.accounts.openai[0])

    const result = persistOAuthCredential(store, 'openai', oauth('access-fresh', { accountId: 'ident-SAME' }))

    expect(result.status).toBe('reauthorized')
    const accounts = store.accounts.openai
    // No duplicate appended; the matching account updated in place + re-enabled.
    expect(accounts).toHaveLength(2)
    expect(accounts[0]).toEqual(snapshotOther)
    expect(accounts[1].id).toBe('acc_same')
    expect(accounts[1].enabled).toBe(true)
    expect((accounts[1].credential as { access: string }).access).toBe('access-fresh')
  })

  test('ADD with a NON-matching identity appends rather than deduping', () => {
    const store = storeWith({
      openai: [{ id: 'acc_a', enabled: true, credential: oauth('access-a', { accountId: 'ident-A' }) }],
    })
    const result = persistOAuthCredential(store, 'openai', oauth('access-b', { accountId: 'ident-B' }))
    expect(result.status).toBe('added')
    expect(store.accounts.openai).toHaveLength(2)
  })

  test('REAUTHORIZE refuses when stored and incoming identities differ, writing nothing', () => {
    const store = storeWith({
      openai: [
        { id: 'acc_work', enabled: true, credential: oauth('access-a', { accountId: 'ident-A' }) },
        { id: 'acc_personal', enabled: true, credential: oauth('access-b', { accountId: 'ident-B' }) },
      ],
    })
    const before = structuredClone(store.accounts.openai)

    // Re-authorizing `work` but signing in as identity B.
    const result = persistOAuthCredential(store, 'openai', oauth('access-b2', { accountId: 'ident-B' }), 'acc_work')

    expect(result.status).toBe('identity_mismatch')
    expect(result).toMatchObject({ expected: 'ident-A', actual: 'ident-B' })
    // Nothing written — and no second account carrying identity B.
    expect(store.accounts.openai).toEqual(before)
  })

  // Account ids are deterministic and recycled (acc_migrated / acc_salvaged), so
  // "the id still resolves" does not mean "same account". identity comparison
  // cannot save an api_key target — credentialIdentity(api_key) is undefined.
  test('REAUTHORIZE refuses when the id now resolves to a NON-oauth account', () => {
    const store = storeWith({
      openai: [{ id: 'acc_migrated', enabled: true, credential: apiKey('sk-precious') }],
    })
    const before = structuredClone(store.accounts.openai)

    const result = persistOAuthCredential(store, 'openai', oauth('access-new'), 'acc_migrated')

    expect(result.status).toBe('wrong_type')
    expect(result).toMatchObject({ actual: 'api_key' })
    expect(store.accounts.openai).toEqual(before)
    expect((store.accounts.openai[0].credential as { key: string }).key).toBe('sk-precious')
  })

  test('REAUTHORIZE proceeds when identities match, or when either side lacks one', () => {
    const matching = storeWith({
      openai: [{ id: 'acc_a', enabled: true, credential: oauth('access-old', { accountId: 'ident-A' }) }],
    })
    expect(
      persistOAuthCredential(matching, 'openai', oauth('access-new', { accountId: 'ident-A' }), 'acc_a').status
    ).toBe('reauthorized')

    // Providers with no identity claim (anthropic, xai, copilot, radius) must be
    // unaffected by the guard.
    const noIdentity = storeWith({
      anthropic: [{ id: 'acc_a', enabled: true, credential: oauth('access-old') }],
    })
    expect(persistOAuthCredential(noIdentity, 'anthropic', oauth('access-new'), 'acc_a').status).toBe('reauthorized')

    // Stored credential predates identity capture → still allowed.
    const storedWithout = storeWith({
      openai: [{ id: 'acc_a', enabled: true, credential: oauth('access-old') }],
    })
    expect(
      persistOAuthCredential(storedWithout, 'openai', oauth('access-new', { accountId: 'ident-A' }), 'acc_a').status
    ).toBe('reauthorized')
  })

  // Documented behaviour: re-authorizing (or a same-identity ADD) re-enables a
  // deliberately DISABLED account — re-authorizing is taken as intent to use it
  // again, and the user can disable it afresh.
  test('a same-identity ADD re-enables a disabled account (documented)', () => {
    const store = storeWith({
      openai: [{ id: 'acc_a', enabled: false, credential: oauth('access-old', { accountId: 'ident-A' }) }],
    })
    const result = persistOAuthCredential(store, 'openai', oauth('access-new', { accountId: 'ident-A' }))
    expect(result.status).toBe('reauthorized')
    expect(store.accounts.openai).toHaveLength(1)
    expect(store.accounts.openai[0].enabled).toBe(true)
  })

  // Two codex accounts both labelled a bare 'OAuth' are indistinguishable in the
  // UI; the identity tail disambiguates them.
  test('appended accounts are labelled distinguishably when an identity is present', () => {
    const store = storeWith({ openai: [] })
    persistOAuthCredential(store, 'openai', oauth('access-a', { accountId: 'chatgpt-acct-AAAAAA' }))
    persistOAuthCredential(store, 'openai', oauth('access-b', { accountId: 'chatgpt-acct-BBBBBB' }))

    const labels = store.accounts.openai.map((a) => a.label)
    expect(labels).toEqual(['OAuth (…AAAAAA)', 'OAuth (…BBBBBB)'])
    expect(new Set(labels).size).toBe(2)
  })

  test('appended accounts fall back to a plain OAuth label when no identity is present', () => {
    const store = storeWith({ openai: [] })
    persistOAuthCredential(store, 'openai', oauth('access-a'))
    expect(store.accounts.openai[0].label).toBe('OAuth')
  })

  // (e) Serialized-writer property: persistOAuthCredential mutates ONLY the store
  // object handed to it — it has no access to the SecretStore, so it structurally
  // cannot perform a raw read-modify-write. Persistence must go through the
  // caller's serialized mutateAccountStore. Verified here by confirming the
  // durable store is untouched after a direct call.
  test('mutates only the passed store object; performs no durable write itself', async () => {
    process.env.FICUS_ENCRYPTION_KEY = randomBytes(32).toString('hex')
    await db.delete(secrets)
    resetSecretStore()
    const secretStore = getSecretStore()
    await secretStore.initialize()
    try {
      const local = storeWith({ openai: [] })
      persistOAuthCredential(local, 'openai', oauth('access-new'))
      expect(local.accounts.openai).toHaveLength(1)
      // Nothing was persisted to the durable store by the pure function.
      expect(readAccountStore().accounts.openai ?? []).toHaveLength(0)
      expect(secretStore.get(PROVIDER_AUTH_DATA_KEY)).toBeUndefined()
    } finally {
      secretStore.stopPeriodicRefresh()
      delete process.env.FICUS_ENCRYPTION_KEY
    }
  })
})
