import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { app } from '../index'
import { authHeaders, cleanupTestRbac, createTestUser } from '../test-utils/rbac'
import { deviceAuthorizationStartLimiter } from '../services/auth/device-auth-rate-limit'
import { attachPeerAddress } from '../lib/client-address'

const prefix = 'device-auth-route'

/** Run `fn` with FICUS_WEB_ORIGIN pinned, restoring the ambient value afterwards. */
async function withWebOrigin(origin: string, fn: () => Promise<void>): Promise<void> {
  const previous = process.env.FICUS_WEB_ORIGIN
  process.env.FICUS_WEB_ORIGIN = origin
  try {
    await fn()
  } finally {
    if (previous === undefined) delete process.env.FICUS_WEB_ORIGIN
    else process.env.FICUS_WEB_ORIGIN = previous
  }
}

describe('device authorization routes', () => {
  beforeEach(() => deviceAuthorizationStartLimiter.reset())
  afterAll(() => cleanupTestRbac(prefix))

  it('requires explicit authenticated approval and returns a bearer exactly once', async () => {
    const user = await createTestUser({ prefix })
    const start = await app.request('/api/auth/device/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
      body: JSON.stringify({ name: ' Ficus CLI on atlas ' }),
    })
    expect(start.status).toBe(200)
    expect(start.headers.get('cache-control')).toBe('no-store')
    const grant = (await start.json()) as { deviceCode: string; verificationUri: string }
    expect(grant.verificationUri).toContain('#device_request=')
    expect(grant.verificationUri).not.toContain(grant.deviceCode)

    const verificationCode = new URL(grant.verificationUri).hash.split('=')[1]
    const anonymous = await app.request('/api/auth/device/inspect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ verificationCode }),
    })
    expect(anonymous.status).toBe(401)

    const headers = { ...authHeaders(user.token), 'content-type': 'application/json' }
    const inspect = await app.request('/api/auth/device/inspect', {
      method: 'POST',
      headers,
      body: JSON.stringify({ verificationCode }),
    })
    expect(inspect.status).toBe(200)
    expect(await inspect.json()).toMatchObject({ name: 'Ficus CLI on atlas', platform: 'cli' })
    const approve = await app.request('/api/auth/device/approve', {
      method: 'POST',
      headers,
      body: JSON.stringify({ verificationCode }),
    })
    expect(approve.status).toBe(200)
    const token = await app.request('/api/auth/device/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceCode: grant.deviceCode }),
    })
    expect(token.status).toBe(200)
    const minted = (await token.json()) as { token: string; deviceId: string; user: { id: string } }
    expect(minted.token).toStartWith('ficus_dev_')
    expect(minted.user.id).toBe(user.id)
    const reused = await app.request('/api/auth/device/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceCode: grant.deviceCode }),
    })
    expect(reused.status).toBe(401)

    // The minted bearer must actually authenticate as the approving user, and revoking the
    // paired device must stop it immediately — the containment story the docs advertise.
    const introspect = await app.request('/api/auth/introspect', { headers: authHeaders(minted.token) })
    expect(introspect.status).toBe(200)
    expect((await introspect.json()) as { identity: { userId: string } }).toMatchObject({
      identity: { type: 'user', userId: user.id },
    })
    const listed = await app.request('/api/auth/devices', { headers: authHeaders(minted.token) })
    expect(listed.status).toBe(200)
    expect((await listed.json()) as Array<{ id: string; platform: string; name: string }>).toContainEqual(
      expect.objectContaining({ id: minted.deviceId, platform: 'cli', name: 'Ficus CLI on atlas' })
    )

    const revoked = await app.request(`/api/auth/devices/${minted.deviceId}`, {
      method: 'DELETE',
      headers: authHeaders(user.token),
    })
    expect(revoked.status).toBe(204)
    const afterRevoke = await app.request('/api/auth/introspect', { headers: authHeaders(minted.token) })
    expect(afterRevoke.status).toBe(401)
  })

  /** Build a start request whose Bun socket peer is `peerAddress`, as the real server would. */
  async function startFrom(peerAddress: string | undefined, forwardedFor: string): Promise<number> {
    const request = new Request('http://localhost/api/auth/device/start', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-real-ip': 'spoofed',
        'x-forwarded-for': forwardedFor,
      },
      body: '{}',
    })
    attachPeerAddress(request, peerAddress)
    return (await app.request(request)).status
  }

  it('does not let a remote caller bypass the start limiter by spoofing forwarded addresses', async () => {
    const statuses: number[] = []
    for (let index = 0; index < 11; index++) statuses.push(await startFrom('203.0.113.5', `198.51.100.${index}`))
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(200))
    expect(statuses[10]).toBe(429)
  })

  // Behind caddy/nginx every peer is 127.0.0.1. If that were one bucket, ten CLI logins per
  // minute would 429 every other user on the instance.
  it('gives each client its own bucket behind a same-host reverse proxy', async () => {
    const statuses: number[] = []
    for (let index = 0; index < 11; index++) statuses.push(await startFrom('127.0.0.1', `198.51.100.${index}`))
    expect(statuses).toEqual(Array(11).fill(200))
  })

  it('still limits a single client behind a same-host reverse proxy', async () => {
    const statuses: number[] = []
    for (let index = 0; index < 11; index++) statuses.push(await startFrom('127.0.0.1', '198.51.100.7'))
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(200))
    expect(statuses[10]).toBe(429)
  })

  it('rejects a plain-HTTP non-loopback web origin', async () => {
    await withWebOrigin('http://ficus.example.com', async () => {
      const response = await app.request('/api/auth/device/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      expect(response.status).toBe(400)
    })
  })

  // The real CLI request shape: no Origin header at all, a non-loopback Host, and TLS
  // terminated by a reverse proxy in front of core (so the request core sees is plain http).
  // Deriving the origin from the request would answer 400 on every HTTPS deployment.
  it('starts a grant for a CLI behind a TLS-terminating proxy (no Origin, non-loopback Host)', async () => {
    await withWebOrigin('https://ficus.example.com', async () => {
      const response = await app.request('http://ficus.example.com/api/auth/device/start', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          host: 'ficus.example.com',
          'x-forwarded-proto': 'https',
        },
        body: JSON.stringify({ name: 'Ficus CLI on atlas' }),
      })
      expect(response.status).toBe(200)
      const grant = (await response.json()) as { verificationUri: string }
      expect(grant.verificationUri).toStartWith('https://ficus.example.com/settings?section=devices#device_request=')
    })
  })

  it('points the verification URI at the web app under APP_BASE_PATH', async () => {
    const previous = process.env.APP_BASE_PATH
    process.env.APP_BASE_PATH = '/ficus'
    try {
      await withWebOrigin('https://ficus.example.com', async () => {
        const response = await app.request('/api/auth/device/start', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
        expect(response.status).toBe(200)
        const grant = (await response.json()) as { verificationUri: string }
        expect(grant.verificationUri).toStartWith(
          'https://ficus.example.com/ficus/settings?section=devices#device_request='
        )
      })
    } finally {
      if (previous === undefined) delete process.env.APP_BASE_PATH
      else process.env.APP_BASE_PATH = previous
    }
  })

  it('ignores a caller-supplied Origin instead of reflecting it into the verification URI', async () => {
    await withWebOrigin('https://ficus.example.com', async () => {
      const response = await app.request('/api/auth/device/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://evil.example.com' },
        body: '{}',
      })
      expect(response.status).toBe(200)
      const grant = (await response.json()) as { verificationUri: string }
      expect(grant.verificationUri).toStartWith('https://ficus.example.com/')
      expect(grant.verificationUri).not.toContain('evil.example.com')
    })
  })

  it('does not fail with a server error on an unparseable Origin', async () => {
    await withWebOrigin('https://ficus.example.com', async () => {
      const response = await app.request('/api/auth/device/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'null' },
        body: '{}',
      })
      expect(response.status).toBe(200)
    })
  })

  it('refuses to mint a verification URI when the configured web origin is unparseable', async () => {
    await withWebOrigin('not a url', async () => {
      const response = await app.request('/api/auth/device/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      expect(response.status).toBe(400)
    })
  })

  it('starts desktop grants, echoes the platform, and rejects unknown platforms', async () => {
    await withWebOrigin('https://ficus.example.test', async () => {
      const start = await app.request('/api/auth/device/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'MacBook', platform: 'desktop' }),
      })
      expect(start.status).toBe(200)
      expect(((await start.json()) as { platform: string }).platform).toBe('desktop')
      const bad = await app.request('/api/auth/device/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ platform: 'toaster' }),
      })
      expect(bad.status).toBe(400)
    })
  })
})
