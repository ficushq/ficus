import { afterEach, describe, expect, test } from 'bun:test'
import type { OAuthProviderAdapter, OAuthProviderGrant } from '@ficus/shared/oauth-providers/types'
import { registerOAuthProviderAdapterForTest } from '@ficus/shared/oauth-providers'
import { createLocalTransport } from './transport'

const grant: OAuthProviderGrant = {
  tokens: { accessToken: 'access', refreshToken: 'refresh', expiresAt: null },
  configuration: { version: 1, workspaceId: 'workspace', botId: 'bot' },
  displayName: 'Workspace',
}

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

function registerAdapter(overrides: Partial<OAuthProviderAdapter> = {}) {
  const adapter: OAuthProviderAdapter = {
    key: 'transport-test',
    authorizeHosts: ['provider.example'],
    buildAuthorizationUrl: ({ clientId, redirectUri, state }) => {
      const url = new URL('https://provider.example/authorize')
      url.searchParams.set('client_id', clientId)
      url.searchParams.set('redirect_uri', redirectUri)
      url.searchParams.set('state', state)
      return url
    },
    exchangeCode: async () => grant,
    refresh: async () => grant,
    revoke: async () => {},
    classifyError: () => ({ code: 'provider_error', retryable: true }),
    ...overrides,
  }
  cleanups.push(registerOAuthProviderAdapterForTest(adapter))
}

describe('local OAuth transport', () => {
  test('is permanently local regardless of managed deployment markers', () => {
    const previous = process.env.FICUS_MANAGED
    process.env.FICUS_MANAGED = '1'
    try {
      const transport = createLocalTransport({ resolveClientCredentials: () => undefined })
      expect(transport.authority).toBe('local')
    } finally {
      if (previous === undefined) delete process.env.FICUS_MANAGED
      else process.env.FICUS_MANAGED = previous
    }
  })

  test('uses the persisted callback snapshot for authorization URL construction', async () => {
    registerAdapter()
    const transport = createLocalTransport({
      resolveClientCredentials: () => ({ clientId: 'client-id', clientSecret: 'client-secret' }),
      callbackUrl: () => 'https://changed.example/callback',
    })

    const result = await transport.authorizationUrl({
      providerKey: 'transport-test',
      localFlowId: 'flow',
      intent: 'connect',
      returnTo: '/settings',
      redirectUri: 'https://persisted.example/callback',
    })

    expect(new URL(result.authorizationUrl).searchParams.get('redirect_uri')).toBe('https://persisted.example/callback')
  })

  test('passes the configured client credentials to the adapter', async () => {
    const seen: unknown[] = []
    registerAdapter({
      exchangeCode: async (input) => {
        seen.push(input)
        return grant
      },
    })
    const transport = createLocalTransport({
      resolveClientCredentials: () => ({ clientId: 'client-id', clientSecret: 'client-secret' }),
      callbackUrl: () => 'https://tau.example/callback',
    })

    await transport.completeAuthorization({
      providerKey: 'transport-test',
      localFlowId: 'flow',
      code: 'provider-code',
      redirectUri: 'https://tau.example/callback',
    })

    expect(seen).toEqual([
      {
        code: 'provider-code',
        redirectUri: 'https://tau.example/callback',
        clientId: 'client-id',
        clientSecret: 'client-secret',
      },
    ])
  })

  test('throws oauth_app_unconfigured when no client is configured', async () => {
    registerAdapter()
    const transport = createLocalTransport({
      resolveClientCredentials: () => undefined,
      callbackUrl: () => 'https://tau.example/callback',
    })

    await expect(
      transport.completeAuthorization({
        providerKey: 'transport-test',
        localFlowId: 'flow',
        code: 'provider-code',
        redirectUri: 'https://tau.example/callback',
      })
    ).rejects.toMatchObject({ code: 'oauth_app_unconfigured' })
  })

  test('an irreversible provider call uses one credential snapshot', async () => {
    const credentials = [
      { clientId: 'authorized-client', clientSecret: 'authorized-secret' },
      { clientId: 'changed-client', clientSecret: 'changed-secret' },
    ]
    const seen: unknown[] = []
    registerAdapter({
      refresh: async (input) => {
        seen.push(input)
        return grant
      },
    })
    const transport = createLocalTransport({
      resolveClientCredentials: () => credentials.shift(),
      callbackUrl: () => 'https://tau.example/callback',
    })

    await transport.refresh({
      providerKey: 'transport-test',
      connectionId: 'connection',
      materialRevision: 'material',
      tokenRevision: 1,
      refreshToken: 'refresh',
    })

    expect(seen).toEqual([
      {
        refreshToken: 'refresh',
        clientId: 'authorized-client',
        clientSecret: 'authorized-secret',
      },
    ])
    expect(credentials).toHaveLength(1)
  })

  test('refresh returns the provider-reported configuration for the caller to compare', async () => {
    registerAdapter({ refresh: async () => grant })
    const transport = createLocalTransport({
      resolveClientCredentials: () => ({ clientId: 'client-id', clientSecret: 'client-secret' }),
      callbackUrl: () => 'https://tau.example/callback',
    })

    const refreshed = await transport.refresh({
      providerKey: 'transport-test',
      connectionId: 'connection',
      materialRevision: 'material',
      tokenRevision: 1,
      refreshToken: 'refresh',
    })

    expect(refreshed.configuration).toEqual({ version: 1, workspaceId: 'workspace', botId: 'bot' })
  })
})
