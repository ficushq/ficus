import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Hono } from 'hono'
import { identityMiddleware } from '../middleware/identity'
import { authzSentinel } from '../middleware/authz-sentinel'
import { amtpRouter } from './amtp'
import { Peer } from '../entities/Peer'
import { InstanceIdentity } from '../entities/InstanceIdentity'
import { canonicalPeerGetString, verifyEnvelope } from 'amtp-protocol'
import { authHeaders, assignRole, cleanupTestRbac, createTestRole, createTestUser, type TestUser } from '../test-utils'

const app = new Hono()
app.use('/api/*', identityMiddleware)
app.use('/api/*', authzSentinel)
app.route('/api/amtp', amtpRouter)

const prefix = `fed-proxy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
let reader: TestUser
let sender: TestUser
let plain: TestUser
let peer: Peer
const originalFetch = globalThis.fetch

beforeAll(async () => {
  reader = await createTestUser({ prefix })
  sender = await createTestUser({ prefix })
  plain = await createTestUser({ prefix })
  const readRole = await createTestRole({ prefix, permissions: ['amtp:read'] })
  const sendRole = await createTestRole({ prefix, permissions: ['amtp:send'] })
  await assignRole({ userId: reader.id, roleId: readRole.id, scope: 'system' })
  await assignRole({ userId: sender.id, roleId: sendRole.id, scope: 'system' })
  peer = await Peer.create({
    localAlias: `${prefix}-alias`,
    instanceId: `${prefix}-instance-0000000000000000000000`,
    baseUrl: 'https://peer.example/api',
    publicKeyPem: '-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n',
  })
})

afterAll(async () => {
  await Peer.delete(peer.id)
  await cleanupTestRbac(prefix)
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

function stubPeerResponse(status = 200, body: unknown = { handles: [{ handle: 'alice' }] }) {
  globalThis.fetch = (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch
}

describe('GET /api/amtp/peers/:ref/handles', () => {
  test('unauthenticated → 401', async () => {
    const res = await app.request(`/api/amtp/peers/${peer.id}/handles`)
    expect(res.status).toBe(401)
  })

  test('no amtp:read or amtp:send → 403', async () => {
    const res = await app.request(`/api/amtp/peers/${peer.id}/handles`, { headers: authHeaders(plain.token) })
    expect(res.status).toBe(403)
  })

  test('amtp:read → 200 with the peer handles (by row id)', async () => {
    stubPeerResponse()
    const res = await app.request(`/api/amtp/peers/${peer.id}/handles`, { headers: authHeaders(reader.token) })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ handles: [{ handle: 'alice' }] })
  })

  test('amtp:send → 200; :ref resolves by localAlias and by instanceId', async () => {
    stubPeerResponse()
    const byAlias = await app.request(`/api/amtp/peers/${peer.localAlias}/handles`, {
      headers: authHeaders(sender.token),
    })
    expect(byAlias.status).toBe(200)
    stubPeerResponse()
    const byInstance = await app.request(`/api/amtp/peers/${peer.instanceId}/handles`, {
      headers: authHeaders(sender.token),
    })
    expect(byInstance.status).toBe(200)
  })

  test.each([
    ['/amtp/handles', 200],
    ['/api/amtp/handles', 502],
  ] as const)('peer verifying %s → %i without legacy-path retries', async (signedPath, expectedStatus) => {
    // AMTP 0.2 peers verify the route-relative path; prefixed 0.1 peers verify
    // the observed path. Coordinated upgrades are required for the latter.
    const identity = await InstanceIdentity.getOrCreate()
    let requests = 0
    globalThis.fetch = (async (url, init) => {
      requests++
      expect(String(url)).toBe('https://peer.example/api/amtp/handles')
      const headers = new Headers(init?.headers)
      expect(headers.get('x-amtp-instance')).toBe(identity.instanceId)
      const valid = verifyEnvelope(
        identity.publicKeyPem,
        new TextEncoder().encode(canonicalPeerGetString('GET', signedPath, Number(headers.get('x-amtp-timestamp')))),
        headers.get('x-amtp-signature')!
      )
      return valid
        ? Response.json({ handles: [{ handle: 'alice' }] })
        : Response.json({ error: 'Unauthorized' }, { status: 401 })
    }) as typeof fetch
    const res = await app.request(`/api/amtp/peers/${peer.id}/handles`, { headers: authHeaders(reader.token) })
    expect(res.status).toBe(expectedStatus)
    expect(requests).toBe(1)
    expect(await res.json()).toEqual(
      expectedStatus === 200 ? { handles: [{ handle: 'alice' }] } : { error: 'Failed to fetch handles from peer' }
    )
  })

  test('unknown ref → 404', async () => {
    const res = await app.request('/api/amtp/peers/nope-not-a-peer/handles', {
      headers: authHeaders(reader.token),
    })
    expect(res.status).toBe(404)
  })

  test('inactive peer → 409', async () => {
    await Peer.update(peer.id, { status: 'disabled' })
    const res = await app.request(`/api/amtp/peers/${peer.id}/handles`, { headers: authHeaders(reader.token) })
    expect(res.status).toBe(409)
    await Peer.update(peer.id, { status: 'active' })
  })

  test('peer fetch failure → 502', async () => {
    stubPeerResponse(500, 'down')
    const res = await app.request(`/api/amtp/peers/${peer.id}/handles`, { headers: authHeaders(reader.token) })
    expect(res.status).toBe(502)
  })
})
