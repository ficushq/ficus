import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  configureOAuthApp,
  getOAuthAppSettings,
  resolveHistoricalLocalOAuthClientCredentials,
  resolveOAuthClientCredentials,
  SELF_HOSTED_OAUTH_APP_KEY,
} from './client-credentials'

class MemoryStore {
  readonly values = new Map<string, string>()
  reads = 0
  writes = 0
  refreshes = 0
  get(key: string) {
    this.reads += 1
    return this.values.get(key)
  }
  async refreshKey() {
    this.refreshes += 1
  }
  async set(key: string, value: string) {
    this.writes += 1
    this.values.set(key, value)
  }
}

const priorEnv = {
  managed: process.env.FICUS_MANAGED,
  keys: process.env.FICUS_MANAGED_SECRET_KEYS,
  clientId: process.env.NOTION_OAUTH_CLIENT_ID,
  clientSecret: process.env.NOTION_OAUTH_CLIENT_SECRET,
}

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

describe('OAuth application credentials', () => {
  let store: MemoryStore

  beforeEach(() => {
    store = new MemoryStore()
    delete process.env.FICUS_MANAGED
    delete process.env.FICUS_MANAGED_SECRET_KEYS
    delete process.env.NOTION_OAUTH_CLIENT_ID
    delete process.env.NOTION_OAUTH_CLIENT_SECRET
  })

  afterEach(() => {
    restore('FICUS_MANAGED', priorEnv.managed)
    restore('FICUS_MANAGED_SECRET_KEYS', priorEnv.keys)
    restore('NOTION_OAUTH_CLIENT_ID', priorEnv.clientId)
    restore('NOTION_OAUTH_CLIENT_SECRET', priorEnv.clientSecret)
  })

  test('hosted settings are authority-derived and no configuration exposes managed Notion credentials', () => {
    process.env.FICUS_MANAGED = '1'
    process.env.FICUS_MANAGED_SECRET_KEYS =
      'NOTION_OAUTH_CLIENT_ID,NOTION_OAUTH_CLIENT_SECRET,FICUS_PLATFORM_INSTANCE_TOKEN'
    process.env.NOTION_OAUTH_CLIENT_ID = 'should-be-unreachable-id'
    process.env.NOTION_OAUTH_CLIENT_SECRET = 'should-be-unreachable-secret'
    store.values.set(
      SELF_HOSTED_OAUTH_APP_KEY.notion,
      JSON.stringify({
        version: 1,
        clientId: 'stale-tenant-id',
        clientSecret: 'stale-tenant-secret',
        capabilitiesAcknowledged: true,
      })
    )

    expect(resolveOAuthClientCredentials('notion', store)).toBeUndefined()
    expect(getOAuthAppSettings('notion', store, 'https://tau.example/callback')).toEqual({
      authority: 'platform_broker',
      configured: true,
      clientId: null,
      callbackUrl: 'https://tau.example/callback',
      requiredCapabilities: ['read_content', 'insert_content', 'update_content'],
    })
    expect(store.reads).toBe(0)
    expect(JSON.stringify(getOAuthAppSettings('notion', store, 'https://tau.example/callback'))).not.toContain(
      'should-be-unreachable'
    )
  })

  test('historical local credentials are refreshed and available only through the revoke-only resolver', async () => {
    process.env.FICUS_MANAGED = '1'
    store.values.set(
      SELF_HOSTED_OAUTH_APP_KEY.notion,
      JSON.stringify({
        version: 1,
        clientId: 'historical-id',
        clientSecret: 'historical-secret',
        capabilitiesAcknowledged: true,
      })
    )

    expect(resolveOAuthClientCredentials('notion', store)).toBeUndefined()
    expect(await resolveHistoricalLocalOAuthClientCredentials('notion', store)).toEqual({
      clientId: 'historical-id',
      clientSecret: 'historical-secret',
    })
    expect(store.refreshes).toBe(1)
  })

  test('hosted configuration rejects before parsing or writing local credentials', async () => {
    process.env.FICUS_MANAGED = '1'

    await expect(
      configureOAuthApp(
        'notion',
        { clientId: 'tenant-id', clientSecret: 'tenant-secret', capabilitiesAcknowledged: false },
        store,
        'user:operator',
        'https://tau.example/callback'
      )
    ).rejects.toThrow('OAuth application credentials are platform-managed')
    expect(store.reads).toBe(0)
    expect(store.writes).toBe(0)
  })

  test('stores one strict self-hosted encrypted bundle and never returns its secret', async () => {
    const safe = await configureOAuthApp(
      'notion',
      {
        clientId: 'self-hosted-id',
        clientSecret: 'self-hosted-secret',
        capabilitiesAcknowledged: true,
      },
      store,
      'user:operator',
      'https://tau.example/callback'
    )

    expect(safe).toEqual({
      authority: 'local',
      configured: true,
      clientId: 'self-hosted-id',
      callbackUrl: 'https://tau.example/callback',
      requiredCapabilities: ['read_content', 'insert_content', 'update_content'],
    })
    expect(JSON.stringify(safe)).not.toContain('self-hosted-secret')
    expect(resolveOAuthClientCredentials('notion', store)).toEqual({
      clientId: 'self-hosted-id',
      clientSecret: 'self-hosted-secret',
    })
  })

  test('validates the self-hosted client ID limit after whitespace normalization', async () => {
    const clientId = 'x'.repeat(512)
    const configured = await configureOAuthApp(
      'notion',
      { clientId: `  ${clientId}  `, clientSecret: 'secret', capabilitiesAcknowledged: true },
      store,
      'user:operator',
      'https://tau.example/callback'
    )
    expect(configured.clientId).toBe(clientId)

    const overLimit = new MemoryStore()
    await expect(
      configureOAuthApp(
        'notion',
        { clientId: ` ${'x'.repeat(513)} `, clientSecret: 'secret', capabilitiesAcknowledged: true },
        overLimit,
        'user:operator',
        'https://tau.example/callback'
      )
    ).rejects.toThrow('Invalid OAuth application settings')
    expect(overLimit.writes).toBe(0)
  })

  test('strictly validates provider and self-hosted input without echoing secrets', async () => {
    expect(() => getOAuthAppSettings('unsupported', store, 'https://tau.example/callback')).toThrow(
      'Unsupported OAuth application provider'
    )
    for (const input of [
      { clientId: '', clientSecret: 'secret', capabilitiesAcknowledged: true },
      { clientId: 'id', clientSecret: '', capabilitiesAcknowledged: true },
      { clientId: 'id', clientSecret: 'secret', capabilitiesAcknowledged: false },
      { clientId: 'id', clientSecret: 'secret', capabilitiesAcknowledged: true, extra: true },
    ]) {
      try {
        await configureOAuthApp('notion', input, store, 'user:operator', 'https://tau.example/callback')
        throw new Error('expected invalid input')
      } catch (error) {
        expect(String(error)).not.toContain('secret')
      }
    }
  })
})
