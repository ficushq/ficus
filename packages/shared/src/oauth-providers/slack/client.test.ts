import { describe, expect, mock, test } from 'bun:test'
import { SlackClient, SlackClientError, SLACK_BOT_SCOPES } from './client'
import { classifySlackError } from './adapter'

const tokenPayload = {
  ok: true,
  app_id: 'A1234567890',
  authed_user: { id: 'U1111111111', scope: 'identify', access_token: 'xoxp-user', token_type: 'user' },
  scope: 'commands,chat:write',
  token_type: 'bot',
  access_token: 'xoxb-token-value',
  bot_user_id: 'U2222222222',
  team: { id: 'T1234567890', name: 'Acme Corp' },
  enterprise: null,
  is_enterprise_install: false,
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

describe('SlackClient', () => {
  test('builds the exact bot-scoped authorization URL', () => {
    const client = new SlackClient({ fetch: mock(async () => json({})) })
    const url = client.buildAuthorizationUrl({
      clientId: 'client id',
      redirectUri: 'https://ficus.example/oauth/callback',
      state: 'state-value',
    })
    expect(url.origin + url.pathname).toBe('https://slack.com/oauth/v2/authorize')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'client id',
      scope: SLACK_BOT_SCOPES.join(','),
      redirect_uri: 'https://ficus.example/oauth/callback',
      state: 'state-value',
    })
    expect(url.toString()).not.toContain('client_secret')
    expect(url.searchParams.get('scope')).not.toContain(' ')
  })

  test('exchanges with Basic auth and form-encoded body, parsing the bot grant', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const client = new SlackClient({
      fetch: mock(async (url, init) => {
        requests.push({ url: String(url), init })
        return json(tokenPayload)
      }),
    })
    const grant = await client.exchangeCode({
      code: 'provider-code',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      redirectUri: 'https://ficus.example/oauth/callback',
    })
    expect(grant).toEqual({
      accessToken: 'xoxb-token-value',
      refreshToken: null,
      expiresAt: null,
      appId: 'A1234567890',
      botUserId: 'U2222222222',
      team: { id: 'T1234567890', name: 'Acme Corp' },
    })
    expect(requests).toHaveLength(1)
    expect(requests[0].url).toBe('https://slack.com/api/oauth.v2.access')
    expect(requests[0].init).toMatchObject({ method: 'POST', redirect: 'error' })
    expect(new Headers(requests[0].init?.headers).get('authorization')).toBe(`Basic ${btoa('client-id:client-secret')}`)
    expect(new Headers(requests[0].init?.headers).get('content-type')).toBe('application/x-www-form-urlencoded')
    expect(String(requests[0].init?.body)).toBe(
      new URLSearchParams({ code: 'provider-code', redirect_uri: 'https://ficus.example/oauth/callback' }).toString()
    )
  })

  test('refreshes via grant_type=refresh_token and reports rotated tokens', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const client = new SlackClient({
      fetch: mock(async (url, init) => {
        requests.push({ url: String(url), init })
        return json({ ...tokenPayload, refresh_token: 'xoxe-refresh', expires_in: 3600 })
      }),
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    })
    const grant = await client.refresh({ refreshToken: 'xoxe-refresh-old', clientId: 'id', clientSecret: 'secret' })
    expect(grant.refreshToken).toBe('xoxe-refresh')
    expect(grant.expiresAt).toBe('2026-01-01T01:00:00.000Z')
    expect(String(requests[0].init?.body)).toBe(
      new URLSearchParams({ grant_type: 'refresh_token', refresh_token: 'xoxe-refresh-old' }).toString()
    )
  })

  test('revokes via Bearer auth and treats already-revoked errors as success', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const client = new SlackClient({
      fetch: mock(async (url, init) => {
        requests.push({ url: String(url), init })
        return json({ ok: true, revoked: true })
      }),
    })
    await client.revoke({ token: 'xoxb-token', clientId: 'unused', clientSecret: 'unused' })
    expect(requests[0].url).toBe('https://slack.com/api/auth.revoke')
    expect(new Headers(requests[0].init?.headers).get('authorization')).toBe('Bearer xoxb-token')

    for (const error of ['invalid_auth', 'token_revoked', 'account_inactive', 'not_authed']) {
      const idempotent = new SlackClient({ fetch: mock(async () => json({ ok: false, error })) })
      await expect(
        idempotent.revoke({ token: 'xoxb-token', clientId: 'u', clientSecret: 'u' })
      ).resolves.toBeUndefined()
    }
  })

  test('revoke surfaces a genuine failure instead of swallowing it', async () => {
    const client = new SlackClient({ fetch: mock(async () => json({ ok: false, error: 'ratelimited' })) })
    await expect(client.revoke({ token: 'xoxb-token', clientId: 'u', clientSecret: 'u' })).rejects.toMatchObject({
      code: 'rate_limited',
    })
  })

  test('authTest parses the bot identity and rejects unknown keys', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const client = new SlackClient({
      fetch: mock(async (url, init) => {
        requests.push({ url: String(url), init })
        return json({
          ok: true,
          url: 'https://acme.slack.com/',
          team: 'Acme Corp',
          user: 'tau',
          team_id: 'T1234567890',
          user_id: 'U2222222222',
          bot_id: 'B3333333333',
        })
      }),
    })
    const identity = await client.authTest({ accessToken: 'xoxb-token' })
    expect(identity).toEqual({
      teamId: 'T1234567890',
      userId: 'U2222222222',
      botId: 'B3333333333',
      enterpriseId: null,
      isEnterpriseInstall: false,
    })
    expect(requests[0].url).toBe('https://slack.com/api/auth.test')
    expect(new Headers(requests[0].init?.headers).get('authorization')).toBe('Bearer xoxb-token')

    const withUnknownKey = new SlackClient({
      fetch: mock(async () =>
        json({
          ok: true,
          url: 'https://acme.slack.com/',
          team: 'Acme Corp',
          user: 'tau',
          team_id: 'T1234567890',
          user_id: 'U2222222222',
          bot_id: 'B3333333333',
          unexpected: true,
        })
      ),
    })
    await expect(withUnknownKey.authTest({ accessToken: 'xoxb-token' })).rejects.toMatchObject({
      code: 'invalid_response',
    })
  })

  test('botInfo resolves the owning app id via bots.info', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const client = new SlackClient({
      fetch: mock(async (url, init) => {
        requests.push({ url: String(url), init })
        return json({
          ok: true,
          bot: {
            id: 'B3333333333',
            deleted: false,
            name: 'tau',
            updated: 1700000000,
            app_id: 'A1234567890',
            user_id: 'U2222222222',
            team_id: 'T1234567890',
          },
        })
      }),
    })
    const info = await client.botInfo({ accessToken: 'xoxb-token', botId: 'B3333333333' })
    expect(info).toEqual({ appId: 'A1234567890', teamId: 'T1234567890' })
    expect(requests[0].url).toBe('https://slack.com/api/bots.info?bot=B3333333333')
  })

  test('rejects org-wide enterprise installs as non-retryable', async () => {
    const client = new SlackClient({ fetch: mock(async () => json({ ...tokenPayload, is_enterprise_install: true })) })
    const operation = client.exchangeCode({
      code: 'code',
      clientId: 'id',
      clientSecret: 'secret',
      redirectUri: 'https://ficus.example',
    })
    await expect(operation).rejects.toEqual(new SlackClientError('unsupported_enterprise_install'))
    const error = await operation.catch((caught) => caught)
    expect(classifySlackError(error)).toEqual({ code: 'unsupported_enterprise_install', retryable: false })
  })

  test.each([{ error: 'invalid_code' }, { error: 'code_already_used' }, { error: 'bad_redirect_uri' }])(
    'maps grant errors ($error) to invalid_grant',
    async ({ error }) => {
      const client = new SlackClient({ fetch: mock(async () => json({ ok: false, error }, 200)) })
      const operation = client.exchangeCode({
        code: 'code',
        clientId: 'id',
        clientSecret: 'secret',
        redirectUri: 'https://ficus.example',
      })
      await expect(operation).rejects.toEqual(new SlackClientError('invalid_grant'))
    }
  )

  test.each([
    { error: 'invalid_client_id' },
    { error: 'bad_client_secret' },
    { error: 'invalid_auth' },
    { error: 'token_revoked' },
    { error: 'account_inactive' },
    { error: 'token_expired' },
    { error: 'not_authed' },
  ])('maps auth errors ($error) to invalid_auth', async ({ error }) => {
    const client = new SlackClient({ fetch: mock(async () => json({ ok: false, error }, 200)) })
    const operation = client.refresh({ refreshToken: 'r', clientId: 'id', clientSecret: 'secret' })
    await expect(operation).rejects.toEqual(new SlackClientError('invalid_auth'))
  })

  test.each([
    { error: 'token_revoked' },
    { error: 'account_inactive' },
    { error: 'token_expired' },
    { error: 'not_authed' },
  ])(
    'authTest on a revoked/expired token ($error) is classified as invalid_auth and non-retryable, not retried forever',
    async ({ error }) => {
      const client = new SlackClient({ fetch: mock(async () => json({ ok: false, error }, 200)) })
      const operation = client.authTest({ accessToken: 'xoxb-stale' })
      await expect(operation).rejects.toEqual(new SlackClientError('invalid_auth'))
      const caught = await operation.catch((thrown) => thrown)
      expect(classifySlackError(caught)).toEqual({ code: 'invalid_auth', retryable: false })
    }
  )

  test('maps a body-level ratelimited error to rate_limited without a genuine 429', async () => {
    const client = new SlackClient({ fetch: mock(async () => json({ ok: false, error: 'ratelimited' }, 200)) })
    const error = await client
      .refresh({ refreshToken: 'r', clientId: 'id', clientSecret: 'secret' })
      .catch((caught) => caught)
    expect(classifySlackError(error)).toEqual({ code: 'rate_limited', retryable: true })
  })

  test('classifies a genuine HTTP 429 with normalized retry-after and 5xx as provider_unavailable', async () => {
    const rateLimited = new SlackClient({
      fetch: mock(async () => new Response('', { status: 429, headers: { 'retry-after': '21' } })),
    })
    const rateLimitError = await rateLimited
      .refresh({ refreshToken: 'r', clientId: 'id', clientSecret: 'secret' })
      .catch((caught) => caught)
    expect(classifySlackError(rateLimitError)).toEqual({
      code: 'rate_limited',
      retryable: true,
      providerRateLimited: true,
      retryAfterSeconds: 21,
    })

    const unavailable = new SlackClient({ fetch: mock(async () => new Response('', { status: 503 })) })
    const unavailableError = await unavailable
      .refresh({ refreshToken: 'r', clientId: 'id', clientSecret: 'secret' })
      .catch((caught) => caught)
    expect(classifySlackError(unavailableError)).toEqual({ code: 'provider_unavailable', retryable: true })
  })

  test('rejects oversized and structurally invalid provider responses', async () => {
    const oversized = new SlackClient({ fetch: mock(async () => json({ ...tokenPayload, value: 'x'.repeat(70_000) })) })
    await expect(
      oversized.exchangeCode({
        code: 'code',
        clientId: 'id',
        clientSecret: 'secret',
        redirectUri: 'https://ficus.example',
      })
    ).rejects.toMatchObject({ code: 'response_too_large' })

    const invalid = new SlackClient({ fetch: mock(async () => json({ ...tokenPayload, token_type: 'user' })) })
    await expect(
      invalid.exchangeCode({
        code: 'code',
        clientId: 'id',
        clientSecret: 'secret',
        redirectUri: 'https://ficus.example',
      })
    ).rejects.toEqual(new SlackClientError('invalid_response'))
  })

  test('rejects a request that exceeds the timeout budget', async () => {
    const client = new SlackClient({
      timeoutMs: 5,
      fetch: mock(
        (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
          })
      ),
    })
    await expect(client.authTest({ accessToken: 'xoxb-token' })).rejects.toMatchObject({ code: 'provider_timeout' })
  })

  test('never follows a redirect', async () => {
    const client = new SlackClient({
      fetch: mock(async (_url, init) => {
        expect(init?.redirect).toBe('error')
        return json(tokenPayload)
      }),
    })
    await client.exchangeCode({
      code: 'code',
      clientId: 'id',
      clientSecret: 'secret',
      redirectUri: 'https://ficus.example',
    })
  })
})
