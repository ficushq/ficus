import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { requirePeerSignatureGet } from './require-peer-signature-get'
import { canonicalPeerGetString } from 'amtp-protocol'
import { authzSentinel } from './authz-sentinel'
import { routeParam } from '../lib/route-param'
import { Peer } from '../entities/Peer'
import { generateInstanceKeyPair, instanceIdFromPublicKeyPem, signEnvelope } from '../services/amtp/crypto'

function buildApp(prefix = '/api/amtp') {
  const app = new Hono()
  app.use('*', authzSentinel)
  app.get(
    `${prefix}/attachments/:id`,
    requirePeerSignatureGet((c) => `/amtp/attachments/${encodeURIComponent(routeParam(c, 'id'))}`),
    (c) => c.json({ ok: true, peer: c.get('peerInstanceId') })
  )
  app.get(`${prefix}/handles`, requirePeerSignatureGet('/amtp/handles'), (c) =>
    c.json({ ok: true, peer: c.get('peerInstanceId') })
  )
  return app
}

const app = buildApp()

const activeKeys = generateInstanceKeyPair()
const disabledKeys = generateInstanceKeyPair()
const unknownKeys = generateInstanceKeyPair()
const activeInstanceId = instanceIdFromPublicKeyPem(activeKeys.publicKeyPem)
const disabledInstanceId = instanceIdFromPublicKeyPem(disabledKeys.publicKeyPem)
const unknownInstanceId = instanceIdFromPublicKeyPem(unknownKeys.publicKeyPem)

let active: Peer
let disabled: Peer

beforeAll(async () => {
  active = await Peer.create({
    localAlias: `peer-sig-get-active-${Date.now()}`,
    instanceId: activeInstanceId,
    baseUrl: 'https://active-get.example',
    publicKeyPem: activeKeys.publicKeyPem,
  })
  disabled = await Peer.create({
    localAlias: `peer-sig-get-disabled-${Date.now()}`,
    instanceId: disabledInstanceId,
    baseUrl: 'https://disabled-get.example',
    publicKeyPem: disabledKeys.publicKeyPem,
  })
  await Peer.update(disabled.id, { status: 'disabled' })
})

afterAll(async () => {
  await Peer.delete(active.id)
  await Peer.delete(disabled.id)
})

const PATH = '/api/amtp/attachments/a1'

describe('requirePeerSignatureGet', () => {
  for (const prefix of ['/api/amtp', '/proxy/api/amtp']) {
    for (const route of ['/attachments/a1', '/handles']) {
      test(`accepts route-relative signature for ${prefix}${route}`, async () => {
        const ts = Date.now()
        const sig = signEnvelope(
          activeKeys.privateKeyPem,
          new TextEncoder().encode(canonicalPeerGetString('GET', `/amtp${route}`, ts))
        )
        const res = await buildApp(prefix).request(`${prefix}${route}`, {
          headers: {
            'x-amtp-instance': activeInstanceId,
            'x-amtp-signature': sig,
            'x-amtp-timestamp': String(ts),
          },
        })
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ ok: true, peer: activeInstanceId })
      })
    }
  }

  test.each(['/amtp/attachments/OTHER', '/other/amtp/attachments/a1', '/amtp/handles'])(
    'rejects a signature for an unrelated route: %s',
    async (signedPath) => {
      const ts = Date.now()
      const sig = signEnvelope(
        activeKeys.privateKeyPem,
        new TextEncoder().encode(canonicalPeerGetString('GET', signedPath, ts))
      )
      const res = await app.request(PATH, {
        headers: {
          'x-amtp-instance': activeInstanceId,
          'x-amtp-signature': sig,
          'x-amtp-timestamp': String(ts),
        },
      })
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ error: 'Unauthorized' })
    }
  )

  test('valid signature + headers → 200, body.peer === peerInstanceId', async () => {
    const ts = Date.now()
    const canonical = canonicalPeerGetString('GET', PATH, ts)
    const sig = signEnvelope(activeKeys.privateKeyPem, new TextEncoder().encode(canonical))
    const res = await app.request(PATH, {
      method: 'GET',
      headers: {
        'x-amtp-instance': activeInstanceId,
        'x-amtp-signature': sig,
        'x-amtp-timestamp': String(ts),
      },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.peer).toBe(activeInstanceId)
  })

  test('missing x-amtp-instance → 401', async () => {
    const ts = Date.now()
    const canonical = canonicalPeerGetString('GET', PATH, ts)
    const sig = signEnvelope(activeKeys.privateKeyPem, new TextEncoder().encode(canonical))
    const res = await app.request(PATH, {
      method: 'GET',
      headers: {
        'x-amtp-signature': sig,
        'x-amtp-timestamp': String(ts),
      },
    })
    expect(res.status).toBe(401)
  })

  test('missing x-amtp-signature → 401', async () => {
    const ts = Date.now()
    const res = await app.request(PATH, {
      method: 'GET',
      headers: {
        'x-amtp-instance': activeInstanceId,
        'x-amtp-timestamp': String(ts),
      },
    })
    expect(res.status).toBe(401)
  })

  test('missing x-amtp-timestamp → 401', async () => {
    const ts = Date.now()
    const canonical = canonicalPeerGetString('GET', PATH, ts)
    const sig = signEnvelope(activeKeys.privateKeyPem, new TextEncoder().encode(canonical))
    const res = await app.request(PATH, {
      method: 'GET',
      headers: {
        'x-amtp-instance': activeInstanceId,
        'x-amtp-signature': sig,
      },
    })
    expect(res.status).toBe(401)
  })

  test('signature over a different path → 401', async () => {
    const ts = Date.now()
    const canonical = canonicalPeerGetString('GET', '/api/amtp/attachments/OTHER', ts)
    const sig = signEnvelope(activeKeys.privateKeyPem, new TextEncoder().encode(canonical))
    const res = await app.request(PATH, {
      method: 'GET',
      headers: {
        'x-amtp-instance': activeInstanceId,
        'x-amtp-signature': sig,
        'x-amtp-timestamp': String(ts),
      },
    })
    expect(res.status).toBe(401)
  })

  test('stale timestamp → 401', async () => {
    const ts = Date.now() - 400000
    const canonical = canonicalPeerGetString('GET', PATH, ts)
    const sig = signEnvelope(activeKeys.privateKeyPem, new TextEncoder().encode(canonical))
    const res = await app.request(PATH, {
      method: 'GET',
      headers: {
        'x-amtp-instance': activeInstanceId,
        'x-amtp-signature': sig,
        'x-amtp-timestamp': String(ts),
      },
    })
    expect(res.status).toBe(401)
  })

  test('unknown instanceId (no peer row) → 401', async () => {
    const ts = Date.now()
    const canonical = canonicalPeerGetString('GET', PATH, ts)
    const sig = signEnvelope(unknownKeys.privateKeyPem, new TextEncoder().encode(canonical))
    const res = await app.request(PATH, {
      method: 'GET',
      headers: {
        'x-amtp-instance': unknownInstanceId,
        'x-amtp-signature': sig,
        'x-amtp-timestamp': String(ts),
      },
    })
    expect(res.status).toBe(401)
  })

  test('disabled peer → 401', async () => {
    const ts = Date.now()
    const canonical = canonicalPeerGetString('GET', PATH, ts)
    const sig = signEnvelope(disabledKeys.privateKeyPem, new TextEncoder().encode(canonical))
    const res = await app.request(PATH, {
      method: 'GET',
      headers: {
        'x-amtp-instance': disabledInstanceId,
        'x-amtp-signature': sig,
        'x-amtp-timestamp': String(ts),
      },
    })
    expect(res.status).toBe(401)
  })

  test('authzChecked is set — 200 is not rewritten to 500 by authzSentinel', async () => {
    const ts = Date.now()
    const canonical = canonicalPeerGetString('GET', PATH, ts)
    const sig = signEnvelope(activeKeys.privateKeyPem, new TextEncoder().encode(canonical))
    const res = await app.request(PATH, {
      method: 'GET',
      headers: {
        'x-amtp-instance': activeInstanceId,
        'x-amtp-signature': sig,
        'x-amtp-timestamp': String(ts),
      },
    })
    expect(res.status).toBe(200)
  })
})
