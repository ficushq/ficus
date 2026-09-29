import { describe, expect, mock, test } from 'bun:test'
import { NotionClient, NotionClientError } from './client'
import { classifyNotionError } from './adapter'

const tokenPayload = {
  access_token: 'access-token',
  refresh_token: 'refresh-token',
  workspace_id: 'workspace-id',
  workspace_name: 'Workspace',
  workspace_icon: 'https://cdn.example/icon.png',
  bot_id: 'bot-id',
  token_type: 'bearer',
  owner: { type: 'user', user: { object: 'user', id: 'user-id' } },
  duplicated_template_id: null,
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

describe('NotionClient', () => {
  test('builds the exact user-owned authorization URL without scope', () => {
    const client = new NotionClient({ fetch: mock(async () => json({})) })
    const url = client.buildAuthorizationUrl({
      clientId: 'client id',
      redirectUri: 'https://ficus.example/oauth/callback',
      state: 'state-value',
    })
    expect(url.origin + url.pathname).toBe('https://api.notion.com/v1/oauth/authorize')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'client id',
      redirect_uri: 'https://ficus.example/oauth/callback',
      response_type: 'code',
      owner: 'user',
      state: 'state-value',
    })
    expect(url.searchParams.has('scope')).toBe(false)
  })

  test('exchanges with Basic JSON/version headers and strictly parses nullable expiry', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const client = new NotionClient({
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
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: null,
      workspaceId: 'workspace-id',
      workspaceName: 'Workspace',
      workspaceIcon: 'https://cdn.example/icon.png',
      botId: 'bot-id',
    })
    expect(requests).toHaveLength(1)
    expect(requests[0].url).toBe('https://api.notion.com/v1/oauth/token')
    expect(requests[0].init).toMatchObject({ method: 'POST', redirect: 'error' })
    expect(new Headers(requests[0].init?.headers).get('authorization')).toBe(`Basic ${btoa('client-id:client-secret')}`)
    expect(new Headers(requests[0].init?.headers).get('notion-version')).toBe('2026-03-11')
    expect(JSON.parse(String(requests[0].init?.body))).toEqual({
      grant_type: 'authorization_code',
      code: 'provider-code',
      redirect_uri: 'https://ficus.example/oauth/callback',
    })
  })

  test('refreshes, revokes, and validates through fixed endpoints without redirects', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const responses = [
      json(tokenPayload),
      json({}),
      json({ object: 'user', id: 'bot-id', type: 'bot', name: null, avatar_url: null, bot: {} }),
    ]
    const client = new NotionClient({
      fetch: mock(async (url, init) => {
        requests.push({ url: String(url), init })
        return responses.shift()!
      }),
    })
    await client.refresh({ refreshToken: 'refresh-token', clientId: 'id', clientSecret: 'secret' })
    await client.revoke({ token: 'access-token', clientId: 'id', clientSecret: 'secret' })
    expect(await client.currentBot({ accessToken: 'access-token' })).toEqual({ botId: 'bot-id' })
    expect(requests.map((request) => request.url)).toEqual([
      'https://api.notion.com/v1/oauth/token',
      'https://api.notion.com/v1/oauth/revoke',
      'https://api.notion.com/v1/users/me',
    ])
    for (const request of requests) expect(request.init?.redirect).toBe('error')
    expect(JSON.parse(String(requests[0].init?.body))).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'refresh-token',
    })
    expect(JSON.parse(String(requests[1].init?.body))).toEqual({ token: 'access-token' })
  })

  test.each([{ code: 'invalid_grant' }, { error: 'invalid_grant' }])(
    'maps both provider error shapes to a fixed content-free error',
    async (body) => {
      const client = new NotionClient({
        fetch: mock(async () => json({ ...body, message: 'TOKEN-SENTINEL', error_description: 'TOKEN-SENTINEL' }, 400)),
      })
      const operation = client.exchangeCode({
        code: 'provider-code',
        clientId: 'id',
        clientSecret: 'secret',
        redirectUri: 'https://ficus.example/oauth/callback',
      })
      await expect(operation).rejects.toEqual(new NotionClientError('invalid_grant', 400))
      await expect(operation).rejects.not.toThrow('TOKEN-SENTINEL')
    }
  )

  test.each([
    { body: JSON.stringify({ code: 'invalid_auth', message: 'TOKEN-SENTINEL' }), retryAfter: '17' },
    { body: '', retryAfter: '00017' },
    { body: '{malformed', retryAfter: '17 seconds TOKEN-SENTINEL' },
  ])(
    'classifies HTTP 429 independently of its body and retains only normalized retry timing',
    async ({ body, retryAfter }) => {
      const client = new NotionClient({
        fetch: mock(
          async () =>
            new Response(body, {
              status: 429,
              headers: { 'retry-after': retryAfter },
            })
        ),
      })

      const operation = client.refresh({ refreshToken: 'refresh', clientId: 'id', clientSecret: 'secret' })
      const error = await operation.catch((caught) => caught)

      expect(classifyNotionError(error)).toEqual({
        code: 'rate_limited',
        retryable: true,
        providerRateLimited: true,
        ...(/^\d+$/.test(retryAfter) ? { retryAfterSeconds: 17 } : {}),
      })
      expect(String(error)).not.toContain('TOKEN-SENTINEL')
    }
  )

  test('does not classify a provider body code as a genuine HTTP 429', async () => {
    const client = new NotionClient({ fetch: mock(async () => json({ code: 'rate_limited' }, 400)) })
    const error = await client
      .refresh({ refreshToken: 'refresh', clientId: 'id', clientSecret: 'secret' })
      .catch((caught) => caught)

    expect(classifyNotionError(error)).toEqual({ code: 'rate_limited', retryable: true })
  })

  test('rejects oversized and structurally invalid provider responses', async () => {
    const oversized = new NotionClient({ fetch: mock(async () => json({ value: 'x'.repeat(70_000) })) })
    await expect(oversized.currentBot({ accessToken: 'access' })).rejects.toMatchObject({
      code: 'response_too_large',
    })

    const invalid = new NotionClient({ fetch: mock(async () => json({ ...tokenPayload, unexpected: true })) })
    await expect(
      invalid.exchangeCode({
        code: 'code',
        clientId: 'id',
        clientSecret: 'secret',
        redirectUri: 'https://ficus.example',
      })
    ).rejects.toEqual(new NotionClientError('invalid_response'))
  })
})
