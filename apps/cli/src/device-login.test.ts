import { describe, expect, it } from 'bun:test'
import { loginWithDeviceAuthorization, revokeDeviceAuthorization } from './device-login'

describe('device login client', () => {
  it('starts and polls without authenticating or exposing the polling capability', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const responses = [
      {
        status: 200,
        body: {
          deviceCode: 'poll-secret',
          verificationUri: 'https://tau.test/settings#device_request=verify',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          interval: 1,
        },
      },
      { status: 202, body: { status: 'authorization_pending', interval: 1 } },
      { status: 200, body: { token: 'tau_dev_secret', deviceId: 'd1', user: { id: 'u1', email: 'u@test' } } },
    ]
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      const next = responses.shift()!
      return new Response(JSON.stringify(next.body), {
        status: next.status,
        headers: { 'content-type': 'application/json' },
      })
    }
    const opened: string[] = []
    const result = await loginWithDeviceAuthorization({
      apiUrl: 'https://tau.test',
      name: 'Ficus CLI on atlas',
      fetchImpl,
      sleep: async () => {},
      open: async (url) => {
        opened.push(url)
        return true
      },
    })
    expect(result.token).toBe('tau_dev_secret')
    expect(opened).toEqual(['https://tau.test/settings#device_request=verify'])
    expect(calls.map((call) => call.url)).toEqual([
      'https://tau.test/api/auth/device/start',
      'https://tau.test/api/auth/device/token',
      'https://tau.test/api/auth/device/token',
    ])
    expect(JSON.stringify(calls)).not.toContain('Authorization')
  })

  // With no `interval` in the body and a non-numeric Retry-After, Math.max(1, NaN) is NaN and
  // sleep(NaN) returns immediately — the CLI would hot-loop the poll endpoint until expiry.
  it('does not hot-loop when the server sends no interval and an unparseable Retry-After', async () => {
    const sleeps: number[] = []
    let polls = 0
    const fetchImpl = async (url: string | URL | Request) => {
      if (String(url).endsWith('/device/start')) {
        return Response.json({
          deviceCode: 'poll-secret',
          verificationUri: 'https://tau.test/settings#device_request=verify',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          interval: 5,
        })
      }
      polls += 1
      if (polls >= 3) {
        return Response.json({ token: 'tau_dev_secret', deviceId: 'd1', user: { id: 'u1', email: 'u@test' } })
      }
      return new Response(JSON.stringify({ error: 'slow_down' }), {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' },
      })
    }
    await loginWithDeviceAuthorization({
      apiUrl: 'https://tau.test',
      name: 'CLI',
      fetchImpl,
      sleep: async (ms) => {
        sleeps.push(ms)
      },
      open: async () => true,
    })
    expect(sleeps.length).toBe(2)
    for (const ms of sleeps) expect(ms).toBeGreaterThanOrEqual(1000)
  })

  it('rejects insecure remote API URLs', async () => {
    await expect(loginWithDeviceAuthorization({ apiUrl: 'http://example.com', name: 'CLI' })).rejects.toThrow('HTTPS')
  })

  it('revokes with the backend bearer and treats 404 as already gone', async () => {
    let request: RequestInit | undefined
    const ok = await revokeDeviceAuthorization({
      apiUrl: 'https://tau.test',
      password: 'secret',
      deviceId: 'd1',
      fetchImpl: async (_url, init) => {
        request = init
        return new Response(null, { status: 404 })
      },
    })
    expect(ok).toBe(true)
    expect(request?.headers).toEqual({ Authorization: 'Bearer secret' })
  })
})
