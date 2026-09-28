import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { randomBytes } from 'crypto'
import { db, secrets } from '../../db'
import { SecretStore, getSecretStore, resetSecretStore } from '../secrets'
import {
  SecretStoreCredentialStore,
  firstProviderCredential,
  getModelRuntime,
  refreshModelRuntime,
  resetModelRuntimeForTests,
} from './auth-backend'
import { mutateAccountStore, writeAccountStore, readAccountStore } from './account-store'

describe('SecretStoreCredentialStore', () => {
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

  test('read returns undefined for a provider with no stored credential', async () => {
    const cs = new SecretStoreCredentialStore()
    expect(await cs.read('anthropic')).toBeUndefined()
  })

  test('modify writes and read returns the credential', async () => {
    const cs = new SecretStoreCredentialStore()
    const cred = await cs.modify('anthropic', async () => ({ type: 'api_key' as const, key: 'sk-test' }))
    expect(cred?.type).toBe('api_key')

    const accounts = readAccountStore().accounts['anthropic']
    expect(accounts).toBeDefined()
    expect(accounts[0].credential.type).toBe('api_key')
    expect((accounts[0].credential as any).key).toBe('sk-test')
  })

  test('read returns the credential after modify', async () => {
    const cs = new SecretStoreCredentialStore()
    await cs.modify('openai', async () => ({ type: 'api_key' as const, key: 'sk-openai' }))
    const cred = await cs.read('openai')
    expect(cred).toBeDefined()
    expect(cred!.type).toBe('api_key')
    expect((cred as any).key).toBe('sk-openai')
  })

  test('delete removes the provider credential', async () => {
    const cs = new SecretStoreCredentialStore()
    await cs.modify('anthropic', async () => ({ type: 'api_key' as const, key: 'sk-test' }))
    expect(await cs.read('anthropic')).toBeDefined()

    await cs.delete('anthropic')
    expect(await cs.read('anthropic')).toBeUndefined()
  })

  test('list returns metadata for configured providers', async () => {
    const cs = new SecretStoreCredentialStore()
    await cs.modify('anthropic', async () => ({ type: 'api_key' as const, key: 'sk-1' }))
    await cs.modify('openai', async () => ({ type: 'api_key' as const, key: 'sk-2' }))

    const list = await cs.list()
    expect(list).toHaveLength(2)
    const ids = list.map((e) => e.providerId).sort()
    expect(ids).toEqual(['anthropic', 'openai'])
    expect(list.every((e) => e.type === 'api_key')).toBe(true)
  })

  test('modify updates the existing credential in place', async () => {
    const cs = new SecretStoreCredentialStore()
    await cs.modify('anthropic', async () => ({ type: 'api_key' as const, key: 'sk-old' }))
    await cs.modify('anthropic', async () => ({ type: 'api_key' as const, key: 'sk-new' }))

    const cred = await cs.read('anthropic')
    expect((cred as any).key).toBe('sk-new')
  })

  test('modify returning undefined is a no-op and resolves the current credential', async () => {
    await writeAccountStore(
      {
        version: 1,
        accounts: {
          anthropic: [
            { id: 'a1', enabled: true, credential: { type: 'api_key', key: 'sk-1' } },
            { id: 'a2', enabled: true, credential: { type: 'api_key', key: 'sk-2' } },
          ],
        },
      },
      'admin'
    )

    const cs = new SecretStoreCredentialStore()
    const resolved = await cs.modify('anthropic', async () => undefined)

    expect((resolved as any)?.key).toBe('sk-1')
    const accounts = readAccountStore().accounts.anthropic
    expect(accounts).toHaveLength(2)
    expect((accounts[0].credential as any).key).toBe('sk-1')
    expect((accounts[1].credential as any).key).toBe('sk-2')
  })

  test('modify does not overwrite an enabled api_key account with an oauth credential', async () => {
    await writeAccountStore(
      {
        version: 1,
        accounts: {
          anthropic: [{ id: 'a1', enabled: true, credential: { type: 'api_key', key: 'sk-keep' } }],
        },
      },
      'admin'
    )

    const cs = new SecretStoreCredentialStore()
    const resolved = await cs.modify('anthropic', async () => ({
      type: 'oauth' as const,
      refresh: 'r',
      access: 'a',
      expires: 123,
    }))

    // Nothing is written: the api_key survives untouched and modify resolves it.
    expect(resolved?.type).toBe('api_key')
    expect((resolved as any).key).toBe('sk-keep')
    const accounts = readAccountStore().accounts.anthropic
    expect(accounts).toHaveLength(1)
    expect(accounts[0].credential).toEqual({ type: 'api_key', key: 'sk-keep' })
  })

  test('modify lands an oauth credential on the enabled oauth account of a mixed provider', async () => {
    await writeAccountStore(
      {
        version: 1,
        accounts: {
          anthropic: [
            { id: 'key', enabled: true, credential: { type: 'api_key', key: 'sk-keep' } },
            { id: 'oauth-off', enabled: false, credential: { type: 'oauth', refresh: 'r0', access: 'a0', expires: 1 } },
            { id: 'oauth-on', enabled: true, credential: { type: 'oauth', refresh: 'r1', access: 'a1', expires: 2 } },
          ],
        },
      },
      'admin'
    )

    const cs = new SecretStoreCredentialStore()
    const resolved = await cs.modify('anthropic', async () => ({
      type: 'oauth' as const,
      refresh: 'r2',
      access: 'a2',
      expires: 3,
    }))

    expect(resolved?.type).toBe('oauth')
    const accounts = readAccountStore().accounts.anthropic
    expect(accounts[0].credential).toEqual({ type: 'api_key', key: 'sk-keep' })
    expect(accounts[1].credential).toEqual({ type: 'oauth', refresh: 'r0', access: 'a0', expires: 1 })
    expect(accounts[2].credential).toEqual({ type: 'oauth', refresh: 'r2', access: 'a2', expires: 3 })
  })

  test('modify does not overwrite a migrated api_key account with an oauth credential', async () => {
    await writeAccountStore(
      {
        version: 1,
        accounts: {
          anthropic: [{ id: 'acc_migrated', enabled: false, credential: { type: 'api_key', key: 'sk-keep' } }],
        },
      },
      'admin'
    )

    const cs = new SecretStoreCredentialStore()
    const resolved = await cs.modify('anthropic', async () => ({
      type: 'oauth' as const,
      refresh: 'r',
      access: 'a',
      expires: 123,
    }))

    expect(resolved?.type).toBe('api_key')
    const accounts = readAccountStore().accounts.anthropic
    expect(accounts).toHaveLength(1)
    expect(accounts[0].credential).toEqual({ type: 'api_key', key: 'sk-keep' })
    // The migrated branch must not force-enable an account it did not write.
    expect(accounts[0].enabled).toBe(false)
  })

  test('slow modify callback does not block unrelated account-store writes', async () => {
    await writeAccountStore(
      {
        version: 1,
        accounts: {
          anthropic: [{ id: 'a1', enabled: true, credential: { type: 'api_key', key: 'sk-1' } }],
        },
      },
      'admin'
    )

    const cs = new SecretStoreCredentialStore()
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    let entered!: () => void
    const enteredPromise = new Promise<void>((resolve) => (entered = resolve))
    const modify = cs.modify('anthropic', async () => {
      entered()
      await gate
      return { type: 'api_key' as const, key: 'sk-updated' }
    })
    await enteredPromise

    await expect(
      mutateAccountStore((store) => {
        store.accounts.openai = [{ id: 'o1', enabled: true, credential: { type: 'api_key', key: 'sk-openai' } }]
      }, 'admin')
    ).resolves.toBeUndefined()
    expect((readAccountStore().accounts.openai[0].credential as any).key).toBe('sk-openai')

    release()
    await modify
  })
})

describe('getModelRuntime', () => {
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
    // The refresh()/refreshModelRuntime() tests permanently rebuild the
    // process-singleton runtime's configuredProviders snapshot; without this
    // reset that leaked state flips hasRuntimeRoute() answers in every later
    // test file (catalogued CI flake: base.test.ts real-selector failover).
    resetModelRuntimeForTests()
  })

  test('returns a ModelRuntime singleton', async () => {
    const rt1 = await getModelRuntime()
    const rt2 = await getModelRuntime()
    expect(rt1).toBe(rt2)
  })

  test('hasConfiguredAuth returns false for unconfigured provider', async () => {
    const rt = await getModelRuntime()
    expect(rt.hasConfiguredAuth('anthropic')).toBe(false)
  })

  test('hasConfiguredAuth returns true after storing a credential', async () => {
    await writeAccountStore(
      {
        version: 1,
        accounts: { anthropic: [{ id: 'a1', enabled: true, credential: { type: 'api_key', key: 'sk-test' } }] },
      },
      'admin'
    )
    const rt = await getModelRuntime()
    // hasConfiguredAuth reads a snapshot built during refresh; rebuild it
    // to pick up the credential we just stored.
    await rt.refresh({ allowNetwork: false })
    expect(rt.hasConfiguredAuth('anthropic')).toBe(true)
  })

  test('refreshModelRuntime rebuilds the snapshot after a direct account-store write', async () => {
    const rt = await getModelRuntime()
    // No zai credential yet.
    expect(rt.hasConfiguredAuth('zai')).toBe(false)

    // Write a credential directly to the account store, bypassing the runtime
    // (mirrors the PUT /:provider endpoint).
    await writeAccountStore(
      {
        version: 1,
        accounts: { zai: [{ id: 'acc_migrated', enabled: true, credential: { type: 'api_key', key: 'sk-zai' } }] },
      },
      'admin'
    )
    // The snapshot is stale until refreshed.
    expect(rt.hasConfiguredAuth('zai')).toBe(false)

    // refreshModelRuntime rebuilds the snapshot so hasConfiguredAuth reflects it.
    await refreshModelRuntime()
    expect(rt.hasConfiguredAuth('zai')).toBe(true)
  })
})

describe('firstProviderCredential', () => {
  const accounts = [
    { id: 'key', enabled: true, credential: { type: 'api_key' as const, key: 'sk-1' } },
    {
      id: 'oauth-off',
      enabled: false,
      credential: { type: 'oauth' as const, refresh: 'r0', access: 'a0', expires: 1 },
    },
    { id: 'oauth-on', enabled: true, credential: { type: 'oauth' as const, refresh: 'r1', access: 'a1', expires: 2 } },
  ]

  test('without a requested type returns the first enabled credential', () => {
    expect(firstProviderCredential(accounts)).toEqual({ type: 'api_key', key: 'sk-1' })
  })

  test('returns the enabled credential of the requested type', () => {
    expect(firstProviderCredential(accounts, 'oauth')).toEqual({
      type: 'oauth',
      refresh: 'r1',
      access: 'a1',
      expires: 2,
    })
    expect(firstProviderCredential(accounts, 'api_key')).toEqual({ type: 'api_key', key: 'sk-1' })
  })

  test('falls back to a disabled credential of the requested type', () => {
    const disabledOnly = [
      { id: 'key', enabled: true, credential: { type: 'api_key' as const, key: 'sk-1' } },
      {
        id: 'oauth-off',
        enabled: false,
        credential: { type: 'oauth' as const, refresh: 'r0', access: 'a0', expires: 1 },
      },
    ]
    expect(firstProviderCredential(disabledOnly, 'oauth')).toEqual({
      type: 'oauth',
      refresh: 'r0',
      access: 'a0',
      expires: 1,
    })
  })

  test('returns undefined when no credential of the requested type exists', () => {
    const keyOnly = [{ id: 'key', enabled: true, credential: { type: 'api_key' as const, key: 'sk-1' } }]
    expect(firstProviderCredential(keyOnly, 'oauth')).toBeUndefined()
  })
})
