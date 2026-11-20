import { describe, expect, mock, test } from 'bun:test'
import { LINEAR_APP_SCOPES, LinearOAuthClient, LinearOAuthError } from './client'
import { classifyLinearOAuthError, createLinearAdapter } from './adapter'
import { parseLinearAppConfiguration, safeLinearAppConfiguration } from './config'
import { fakeLinearGrant } from '../fake/adapter'

const NOW = new Date('2026-11-20T00:00:00.000Z')

function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } })
}

function recordingClient(respond: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const requests: { url: string; init?: RequestInit }[] = []
  const client = new LinearOAuthClient({
    now: () => NOW,
    fetch: mock(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init })
      return respond(String(url), init)
    }),
  })
  return { client, requests }
}

const tokenPayload = {
  access_token: 'access-token',
  token_type: 'Bearer',
  expires_in: 86399,
  scope: 'read issues:create comments:create app:assignable app:mentionable',
  refresh_token: 'refresh-token',
}

describe('LinearOAuthClient', () => {
  test('builds the app-actor install URL with the scope constant and forced consent', () => {
    const { client } = recordingClient(() => json({}))
    const url = client.buildAuthorizationUrl({
      clientId: 'client id',
      redirectUri: 'https://ficus.example/settings/integrations/oauth/callback/linear',
      state: 'state-value',
    })
    expect(url.origin + url.pathname).toBe('https://linear.app/oauth/authorize')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'client id',
      redirect_uri: 'https://ficus.example/settings/integrations/oauth/callback/linear',
      response_type: 'code',
      scope: 'read,issues:create,comments:create,app:assignable,app:mentionable',
      state: 'state-value',
      actor: 'app',
      prompt: 'consent',
    })
    expect(LINEAR_APP_SCOPES).not.toContain('admin')
    expect(url.toString()).not.toContain('secret')
  })

  test('exchanges a code with a form body and HTTP Basic client authentication', async () => {
    const { client, requests } = recordingClient(() => json(tokenPayload))
    const grant = await client.exchangeCode({
      code: 'provider-code',
      redirectUri: 'https://ficus.example/cb',
      clientId: 'client-id',
      clientSecret: 'client-secret',
    })
    expect(grant).toEqual({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: '2026-11-20T23:59:59.000Z',
      scopes: ['read', 'issues:create', 'comments:create', 'app:assignable', 'app:mentionable'],
    })
    const [request] = requests
    expect(request!.url).toBe('https://api.linear.app/oauth/token')
    expect(request!.init?.method).toBe('POST')
    expect(request!.init?.redirect).toBe('error')
    const headers = new Headers(request!.init?.headers)
    expect(headers.get('content-type')).toBe('application/x-www-form-urlencoded')
    expect(headers.get('authorization')).toBe(`Basic ${Buffer.from('client-id:client-secret').toString('base64')}`)
    expect(Object.fromEntries(new URLSearchParams(String(request!.init?.body)))).toEqual({
      grant_type: 'authorization_code',
      code: 'provider-code',
      redirect_uri: 'https://ficus.example/cb',
    })
    expect(String(request!.init?.body)).not.toContain('client-secret')
  })

  test('refresh sends the refresh grant and returns the rotated pair', async () => {
    const { client, requests } = recordingClient(() =>
      json({ ...tokenPayload, access_token: 'access-2', refresh_token: 'refresh-2' })
    )
    const grant = await client.refresh({ refreshToken: 'refresh-1', clientId: 'id', clientSecret: 'secret' })
    expect(grant.accessToken).toBe('access-2')
    expect(grant.refreshToken).toBe('refresh-2')
    expect(Object.fromEntries(new URLSearchParams(String(requests[0]!.init?.body)))).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'refresh-1',
    })
  })

  test('accepts the scope as a comma-separated string or an array, and a missing expiry', async () => {
    for (const scope of ['read,issues:create', ['read', 'issues:create']]) {
      const { client } = recordingClient(() =>
        json({ access_token: 'a', token_type: 'Bearer', scope, refresh_token: 'r' })
      )
      const grant = await client.refresh({ refreshToken: 'r', clientId: 'i', clientSecret: 's' })
      expect(grant.scopes).toEqual(['read', 'issues:create'])
      expect(grant.expiresAt).toBeNull()
    }
  })

  test('rejects malformed token responses and unbounded expiry', async () => {
    for (const body of [
      { ...tokenPayload, access_token: '' },
      { ...tokenPayload, token_type: 'mac' },
      { ...tokenPayload, expires_in: 0 },
      { ...tokenPayload, expires_in: 400 * 24 * 60 * 60 },
      { ...tokenPayload, refresh_token: 5 },
      ['not', 'an', 'object'],
    ]) {
      const { client } = recordingClient(() => json(body))
      await expect(client.refresh({ refreshToken: 'r', clientId: 'i', clientSecret: 's' })).rejects.toEqual(
        new LinearOAuthError('invalid_response')
      )
    }
  })

  test('maps token errors to safe codes without provider text', async () => {
    const cases: [Response, string][] = [
      [json({ error: 'invalid_grant', error_description: 'secret detail' }, 400), 'invalid_grant'],
      [json({ error: 'invalid_client' }, 401), 'invalid_client'],
      [json({ error: 'unsupported_grant_type' }, 400), 'invalid_request'],
      [json({ error: 'invalid_scope' }, 400), 'invalid_request'],
      [json({ message: 'no' }, 401), 'invalid_client'],
      [json({ error: 'server_error' }, 503), 'provider_unavailable'],
      [new Response('<html>bad gateway</html>', { status: 502 }), 'provider_unavailable'],
    ]
    for (const [response, code] of cases) {
      const { client } = recordingClient(() => response)
      const error = await client
        .refresh({ refreshToken: 'r', clientId: 'i', clientSecret: 's' })
        .catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(LinearOAuthError)
      expect((error as LinearOAuthError).code).toBe(code)
      expect((error as LinearOAuthError).message).not.toContain('secret detail')
    }
  })

  test('reports HTTP 429 with a sanitized Retry-After', async () => {
    const { client } = recordingClient(() => json({ errors: [] }, 429, { 'retry-after': '42' }))
    const error = (await client
      .exchangeCode({ code: 'c', redirectUri: 'https://x.test/cb', clientId: 'i', clientSecret: 's' })
      .catch((caught: unknown) => caught)) as LinearOAuthError
    expect(error.code).toBe('rate_limited')
    expect(classifyLinearOAuthError(error)).toEqual({
      code: 'rate_limited',
      retryable: true,
      providerRateLimited: true,
      retryAfterSeconds: 42,
    })
    const { client: noHint } = recordingClient(() => json({}, 429, { 'retry-after': 'soon' }))
    const unhinted = (await noHint
      .refresh({ refreshToken: 'r', clientId: 'i', clientSecret: 's' })
      .catch((caught: unknown) => caught)) as LinearOAuthError
    expect(classifyLinearOAuthError(unhinted)).toEqual({
      code: 'rate_limited',
      retryable: true,
      providerRateLimited: true,
    })
  })

  test('bounds response bodies', async () => {
    const big = JSON.stringify({ ...tokenPayload, padding: 'x'.repeat(70 * 1024) })
    const { client } = recordingClient(() => new Response(big, { status: 200 }))
    await expect(client.refresh({ refreshToken: 'r', clientId: 'i', clientSecret: 's' })).rejects.toEqual(
      new LinearOAuthError('response_too_large', 200)
    )
    const { client: declared } = recordingClient(
      () => new Response('{}', { status: 200, headers: { 'content-length': String(1024 * 1024) } })
    )
    await expect(declared.refresh({ refreshToken: 'r', clientId: 'i', clientSecret: 's' })).rejects.toEqual(
      new LinearOAuthError('response_too_large', 200)
    )
  })

  test('maps network failures and timeouts to retryable codes', async () => {
    const failing = new LinearOAuthClient({
      fetch: async () => {
        throw new Error('socket hang up with token abc')
      },
    })
    const error = (await failing
      .refresh({ refreshToken: 'r', clientId: 'i', clientSecret: 's' })
      .catch((caught: unknown) => caught)) as LinearOAuthError
    expect(error.code).toBe('provider_unavailable')
    expect(classifyLinearOAuthError(error)).toEqual({ code: 'provider_unavailable', retryable: true })

    const slow = new LinearOAuthClient({
      timeoutMs: 5,
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))),
    })
    const timeout = (await slow
      .refresh({ refreshToken: 'r', clientId: 'i', clientSecret: 's' })
      .catch((caught: unknown) => caught)) as LinearOAuthError
    expect(timeout.code).toBe('provider_timeout')
  })

  test('revokes the access token with a form body and maps 400 and 401', async () => {
    const { client, requests } = recordingClient(() => new Response(null, { status: 200 }))
    await client.revoke({ token: 'access-token', clientId: 'id', clientSecret: 'secret' })
    expect(requests[0]!.url).toBe('https://api.linear.app/oauth/revoke')
    expect(Object.fromEntries(new URLSearchParams(String(requests[0]!.init?.body)))).toEqual({
      token: 'access-token',
      token_type_hint: 'access_token',
    })
    for (const [status, code, retryable] of [
      [400, 'already_revoked', false],
      [401, 'invalid_auth', false],
      [500, 'provider_unavailable', true],
    ] as const) {
      const { client: failing } = recordingClient(() => new Response('{}', { status }))
      const error = (await failing
        .revoke({ token: 't', clientId: 'i', clientSecret: 's' })
        .catch((caught: unknown) => caught)) as LinearOAuthError
      expect(error.code).toBe(code)
      expect(classifyLinearOAuthError(error).retryable).toBe(retryable)
    }
  })

  test('reads the app identity with a Bearer token', async () => {
    const { client, requests } = recordingClient(() =>
      json({
        data: {
          viewer: { id: 'app-user', name: 'Ficus', app: true },
          organization: { id: 'org-1', name: 'Acme', urlKey: 'acme' },
        },
      })
    )
    expect(await client.identity({ accessToken: 'access-token' })).toEqual({
      appUserId: 'app-user',
      appUserName: 'Ficus',
      organizationId: 'org-1',
      organizationName: 'Acme',
      organizationUrlKey: 'acme',
    })
    expect(requests[0]!.url).toBe('https://api.linear.app/graphql')
    expect(new Headers(requests[0]!.init?.headers).get('authorization')).toBe('Bearer access-token')
    expect(String(requests[0]!.init?.body)).toContain('viewer { id name app }')
  })

  test('refuses a token whose viewer is not an app user', async () => {
    const { client } = recordingClient(() =>
      json({
        data: {
          viewer: { id: 'person', name: 'A Person', app: false },
          organization: { id: 'org-1', name: 'Acme', urlKey: 'acme' },
        },
      })
    )
    const error = (await client.identity({ accessToken: 't' }).catch((caught: unknown) => caught)) as LinearOAuthError
    expect(error.code).toBe('not_app_actor')
    expect(classifyLinearOAuthError(error).retryable).toBe(false)
  })

  test('reads a person’s identity for account linking and refuses an app token', async () => {
    const person = recordingClient(() =>
      json({ data: { viewer: { id: 'person-1', app: false }, organization: { id: 'org-1' } } })
    )
    expect(await person.client.userIdentity({ accessToken: 'user-token' })).toEqual({
      linearUserId: 'person-1',
      organizationId: 'org-1',
    })
    expect(new Headers(person.requests[0]!.init?.headers).get('authorization')).toBe('Bearer user-token')
    const app = recordingClient(() =>
      json({ data: { viewer: { id: 'app-user', app: true }, organization: { id: 'org-1' } } })
    )
    const error = (await app.client
      .userIdentity({ accessToken: 't' })
      .catch((caught: unknown) => caught)) as LinearOAuthError
    expect(error.code).toBe('not_user_actor')
    expect(classifyLinearOAuthError(error).retryable).toBe(false)
  })

  test('maps identity failures without provider text', async () => {
    const cases: [Response, string][] = [
      [json({ errors: [{ message: 'detail', extensions: { code: 'AUTHENTICATION_ERROR' } }] }), 'invalid_auth'],
      [json({ errors: [{ message: 'detail' }] }, 401), 'invalid_auth'],
      [json({ data: { viewer: { id: 'x', name: 'n', app: true } } }), 'invalid_response'],
    ]
    for (const [response, code] of cases) {
      const { client } = recordingClient(() => response)
      const error = (await client.identity({ accessToken: 't' }).catch((caught: unknown) => caught)) as LinearOAuthError
      expect(error.code).toBe(code)
      expect(error.message).not.toContain('detail')
    }
  })
})

describe('linear adapter', () => {
  test('returns the token pair with no identity so Core can persist it first', async () => {
    const { client } = recordingClient(() => json(tokenPayload))
    const adapter = createLinearAdapter(client)
    expect(adapter.key).toBe('linear')
    expect(adapter.authorizeHosts).toEqual(['linear.app'])
    const grant = await adapter.refresh({ refreshToken: 'r', clientId: 'i', clientSecret: 's' })
    expect(grant).toEqual({
      tokens: { accessToken: 'access-token', refreshToken: 'refresh-token', expiresAt: '2026-11-20T23:59:59.000Z' },
      configuration: null,
      displayName: 'Linear',
    })
  })

  test('classifies unknown errors as retryable provider errors', () => {
    expect(classifyLinearOAuthError(new Error('anything'))).toEqual({ code: 'provider_error', retryable: true })
    expect(classifyLinearOAuthError(new LinearOAuthError('invalid_grant'))).toEqual({
      code: 'invalid_grant',
      retryable: false,
    })
    expect(classifyLinearOAuthError(new LinearOAuthError('invalid_client'))).toEqual({
      code: 'invalid_client',
      retryable: false,
    })
    // A misconfigured token request stops retrying instead of degrading forever.
    expect(classifyLinearOAuthError(new LinearOAuthError('invalid_request'))).toEqual({
      code: 'invalid_request',
      retryable: false,
    })
  })
})

describe('Linear app configuration', () => {
  const configuration = {
    version: 2,
    mode: 'app',
    organizationId: 'org-1',
    organizationName: 'Acme',
    organizationUrlKey: 'acme',
    appUserId: 'app-user',
    appUserName: 'Ficus',
    scopes: ['read', 'app:assignable'],
  }

  test('parses the exact app shape and omits scopes from the safe view', () => {
    expect(parseLinearAppConfiguration(configuration)).toEqual(configuration as never)
    expect(safeLinearAppConfiguration(parseLinearAppConfiguration(configuration))).toEqual({
      version: 2,
      mode: 'app',
      organizationId: 'org-1',
      organizationName: 'Acme',
      organizationUrlKey: 'acme',
      appUserId: 'app-user',
      appUserName: 'Ficus',
    })
  })

  test('rejects extra keys, the API-key shape and malformed fields', () => {
    for (const value of [
      { version: 1 },
      { ...configuration, extra: true },
      { ...configuration, version: 1 },
      { ...configuration, mode: 'api-key' },
      { ...configuration, organizationId: '' },
      { ...configuration, organizationUrlKey: 'has space' },
      { ...configuration, scopes: 'read' },
      { ...configuration, scopes: [1] },
      { ...configuration, appUserName: 'x'.repeat(513) },
    ]) {
      expect(() => parseLinearAppConfiguration(value)).toThrow('Invalid Linear app configuration')
    }
  })

  test('fakeLinearGrant carries a valid app configuration or the raw adapter shape', () => {
    const grant = fakeLinearGrant({ organizationId: 'org-9' })
    expect(parseLinearAppConfiguration(grant.configuration).organizationId).toBe('org-9')
    expect(grant.displayName).toBe('Fake Linear workspace (Ficus app)')
    expect(fakeLinearGrant({ configuration: null })).toMatchObject({ configuration: null, displayName: 'Linear' })
  })
})
