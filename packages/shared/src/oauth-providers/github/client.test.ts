import { describe, expect, test } from 'bun:test'
import { GitHubOAuthClient, GitHubOAuthError } from './client'
import { parseGitHubConfiguration } from './config'

function fixture(responses: unknown[]) {
  const requests: { url: string; input: RequestInit }[] = []
  const client = new GitHubOAuthClient({
    now: () => new Date('2026-09-07T12:00:00.000Z'),
    fetch: (async (url, input) => {
      requests.push({ url: String(url), input: input! })
      if (!responses.length) throw new Error('Unexpected request')
      const next = responses.shift()
      return next instanceof Response ? next : Response.json(next)
    }) as typeof fetch,
  })
  return { client, requests }
}

const token = { access_token: 'ghu_access', refresh_token: 'ghr_refresh', token_type: 'bearer', expires_in: 28800 }

describe('GitHub App authorization client', () => {
  test('authorization asks which account to connect instead of silently reusing the signed-in account', () => {
    const { client } = fixture([])
    const url = client.buildAuthorizationUrl({
      clientId: 'Iv1.public',
      redirectUri: 'https://ficus.test/callback',
      state: 'opaque',
    })
    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'Iv1.public',
      redirect_uri: 'https://ficus.test/callback',
      state: 'opaque',
      prompt: 'select_account',
    })
  })

  test('device grant preserves expiry and never sends a secret or token in the URL', async () => {
    const { client, requests } = fixture([
      {
        device_code: 'device',
        user_code: 'ABCD-EFGH',
        verification_uri: 'https://github.com/login/device',
        expires_in: 900,
        interval: 5,
      },
      { error: 'authorization_pending' },
      { error: 'slow_down', interval: 10 },
      token,
    ])
    expect(await client.startDevice({ clientId: 'Iv1.public' })).toEqual({
      deviceCode: 'device',
      userCode: 'ABCD-EFGH',
      verificationUri: 'https://github.com/login/device',
      expiresIn: 900,
      interval: 5,
    })
    expect(await client.pollDevice({ clientId: 'Iv1.public', deviceCode: 'device' })).toEqual({ status: 'pending' })
    expect(await client.pollDevice({ clientId: 'Iv1.public', deviceCode: 'device' })).toEqual({
      status: 'slow_down',
      interval: 10,
    })
    expect(await client.pollDevice({ clientId: 'Iv1.public', deviceCode: 'device' })).toEqual({
      status: 'authorized',
      tokens: { accessToken: 'ghu_access', refreshToken: 'ghr_refresh', expiresAt: '2026-09-07T20:00:00.000Z' },
    })
    for (const request of requests) {
      expect(new URL(request.url).search).toBe('')
      expect(request.input.redirect).toBe('error')
      expect(JSON.parse(String(request.input.body))).not.toHaveProperty('client_secret')
    }
  })

  test('device refresh does not require a secret or perform a fallible identity lookup', async () => {
    const { client, requests } = fixture([token])
    expect((await client.refresh({ clientId: 'Iv1.public', refreshToken: 'old' })).refreshToken).toBe('ghr_refresh')
    expect(requests).toHaveLength(1)
    expect(JSON.parse(String(requests[0]!.input.body))).toEqual({
      client_id: 'Iv1.public',
      grant_type: 'refresh_token',
      refresh_token: 'old',
    })
  })

  test('custom app code exchange and refresh use supplied application credentials', async () => {
    const { client, requests } = fixture([token, token])
    await client.exchangeCode({
      clientId: 'custom',
      clientSecret: 'secret',
      code: 'code',
      redirectUri: 'https://self.test/callback',
    })
    await client.refresh({ clientId: 'custom', clientSecret: 'secret', refreshToken: 'old' })
    expect(JSON.parse(String(requests[0]!.input.body))).toEqual({
      client_id: 'custom',
      client_secret: 'secret',
      code: 'code',
      redirect_uri: 'https://self.test/callback',
    })
    expect(JSON.parse(String(requests[1]!.input.body)).client_secret).toBe('secret')
  })

  test('preserves explicitly non-expiring grants', async () => {
    const { client } = fixture([{ access_token: 'access', token_type: 'bearer' }])
    expect(await client.refresh({ clientId: 'id', refreshToken: 'old' })).toEqual({
      accessToken: 'access',
      refreshToken: null,
      expiresAt: null,
    })
  })

  test.each(['access_denied', 'expired_token', 'device_flow_disabled', 'bad_refresh_token'])(
    'sanitizes terminal %s responses',
    async (code) => {
      const { client } = fixture([{ error: code, error_description: 'SECRET provider payload' }])
      await expect(client.pollDevice({ clientId: 'id', deviceCode: 'device' })).rejects.toThrow(code)
    }
  )

  test('does not accept a provider-directed verification URL', async () => {
    const { client } = fixture([
      {
        device_code: 'd',
        user_code: 'ABCD',
        verification_uri: 'https://attacker.test/login',
        expires_in: 900,
        interval: 5,
      },
    ])
    await expect(client.startDevice({ clientId: 'id' })).rejects.toThrow('invalid_response')
  })

  test('validates stable user identity while tolerating GitHub profile additions', async () => {
    const { client } = fixture([{ id: 123, login: 'new-name', unrelated: 'ignored' }])
    expect(await client.currentUser({ accessToken: 'access' })).toEqual({ version: 1, userId: 123, login: 'new-name' })
    expect(() => parseGitHubConfiguration({ version: 1, userId: 0, login: 'name' })).toThrow()
    expect(() => parseGitHubConfiguration({ version: 1, userId: 123, login: 'name', accessToken: 'secret' })).toThrow()
  })

  test('public client disconnect cannot pretend to remotely revoke a token', async () => {
    const { client, requests } = fixture([])
    await expect(client.revoke({ clientId: 'public', token: 'access' })).rejects.toThrow('manual_revocation_required')
    expect(requests).toHaveLength(0)
  })

  test('custom app remote revocation accepts GitHub empty success response', async () => {
    const { client, requests } = fixture([new Response(null, { status: 204 })])
    await client.revoke({ clientId: 'custom', clientSecret: 'secret', token: 'access' })
    expect(requests[0]!.url).toBe('https://api.github.com/applications/custom/token')
    expect(requests[0]!.input.method).toBe('DELETE')
    expect(JSON.parse(String(requests[0]!.input.body))).toEqual({ access_token: 'access' })
  })

  test.each([429, 403])('recognizes HTTP %s rate limiting without claiming a synthetic 429', async (status) => {
    const { client } = fixture([new Response('SECRET', { status, headers: { 'retry-after': '12' } })])
    try {
      await client.currentUser({ accessToken: 'access' })
      throw new Error('Expected rejection')
    } catch (error) {
      expect(error).toBeInstanceOf(GitHubOAuthError)
      expect(error).toMatchObject({
        code: 'rate_limited',
        status,
        retryAfterSeconds: 12,
        providerRateLimited: status === 429 ? true : undefined,
      })
      expect(String(error)).not.toContain('SECRET')
    }
  })

  test('bounds streamed bodies even without a content length', async () => {
    const { client } = fixture([new Response('x'.repeat(256 * 1024 + 1))])
    await expect(client.currentUser({ accessToken: 'access' })).rejects.toThrow('response_too_large')
  })

  test('cancellation also interrupts a stalled response body', async () => {
    let canceled = false
    const controller = new AbortController()
    let bodyStarted!: () => void
    const ready = new Promise<void>((resolve) => {
      bodyStarted = resolve
    })
    const { client } = fixture([
      new Response(
        new ReadableStream({
          pull() {
            bodyStarted()
          },
          cancel() {
            canceled = true
          },
        })
      ),
    ])
    const pending = client.currentUser({ accessToken: 'access', signal: controller.signal })
    await ready
    controller.abort()
    await expect(pending).rejects.toThrow('request_aborted')
    expect(canceled).toBe(true)
  })
})
