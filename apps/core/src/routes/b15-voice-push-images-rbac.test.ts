import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { voiceSessionRouter } from './voice-session'
import { pushRouter } from './push'
import { imagesRouter } from './images'
import { identityMiddleware } from '../middleware'
import { authHeaders, cleanupTestRbac, createTestAdmin, createTestUser, type TestUser } from '../test-utils'
import { apnsDevices, db, pushSubscriptions } from '../db'
import { Image } from '../entities/Image'
import { __resetSigningKeyForTests, signImageUrl } from '../services/images/signing'

function buildApp() {
  const app = new Hono()
  app.use('/api/*', identityMiddleware)
  app.route('/api/voice-session', voiceSessionRouter)
  app.route('/api/push', pushRouter)
  app.route('/api/images', imagesRouter)
  return app
}

function jsonReq(method: string, token?: string, body?: unknown) {
  return {
    method,
    headers: { ...(token ? authHeaders(token) : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }
}

const prefix = `b15-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
let admin: TestUser
let unprivileged: TestUser
let otherUser: TestUser

beforeAll(async () => {
  admin = await createTestAdmin({ prefix, canonicalAdmin: true })
  unprivileged = await createTestUser({ prefix })
  otherUser = await createTestUser({ prefix })
})

afterAll(async () => {
  await cleanupTestRbac(prefix)
})

beforeEach(async () => {
  await db.delete(pushSubscriptions)
  await db.delete(apnsDevices)
})

describe('B15 voice session RBAC', () => {
  test('denies missing and unprivileged identities before proxying to OpenAI', async () => {
    const form = new FormData()
    form.set('sdp', 'v=0')

    expect((await buildApp().request('/api/voice-session', { method: 'POST', body: form })).status).toBe(401)
    expect(
      (
        await buildApp().request('/api/voice-session', {
          method: 'POST',
          headers: authHeaders(unprivileged.token),
          body: form,
        })
      ).status
    ).toBe(403)
  })

  test('allows admin with ai:voice permission to reach handler validation', async () => {
    const res = await buildApp().request('/api/voice-session', {
      method: 'POST',
      headers: authHeaders(admin.token),
      body: new FormData(),
    })

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Missing required "sdp" field in form data' })
  })
})

describe('B15 push self scoping', () => {
  test('requires identity for all push routes', async () => {
    expect((await buildApp().request('/api/push/vapid-public-key')).status).toBe(401)
    expect((await buildApp().request('/api/push/subscriptions')).status).toBe(401)
    expect((await buildApp().request('/api/push/device')).status).toBe(401)
    expect((await buildApp().request('/api/push/subscribe', jsonReq('POST', undefined, {}))).status).toBe(401)
    expect(
      (await buildApp().request('/api/push/subscribe/00000000-0000-0000-0000-000000000000', jsonReq('DELETE'))).status
    ).toBe(401)
  })

  test('stores subscriptions for authenticated user and ignores forged userId', async () => {
    const res = await buildApp().request(
      '/api/push/subscribe',
      jsonReq('POST', admin.token, {
        endpoint: `https://push.example/${prefix}/admin`,
        keys: { p256dh: 'p256dh', auth: 'auth' },
        userId: otherUser.id,
      })
    )

    expect(res.status).toBe(201)
    const [row] = await db.select().from(pushSubscriptions)
    expect(row.userId).toBe(admin.id)
  })

  test('lists only caller APNs devices without exposing raw tokens', async () => {
    const [adminDevice, otherDevice] = await db
      .insert(apnsDevices)
      .values([
        { apnsToken: `apns-${prefix}-admin`, platform: 'ios', environment: 'sandbox', userId: admin.id },
        { apnsToken: `apns-${prefix}-other`, platform: 'ios', environment: 'production', userId: otherUser.id },
      ])
      .returning()

    const list = await buildApp().request('/api/push/device', jsonReq('GET', admin.token))

    expect(list.status).toBe(200)
    expect(await list.json()).toEqual([
      {
        id: adminDevice.id,
        platform: 'ios',
        environment: 'sandbox',
        createdAt: adminDevice.createdAt.toISOString(),
      },
    ])
    expect((await db.select().from(apnsDevices)).map((device) => device.id).sort()).toEqual(
      [adminDevice.id, otherDevice.id].sort()
    )
  })

  test('transfers an endpoint and prevents the former owner from unregistering it', async () => {
    const endpoint = `https://push.example/${prefix}/transfer`
    const first = await buildApp().request(
      '/api/push/subscribe',
      jsonReq('POST', admin.token, {
        endpoint,
        keys: { p256dh: 'admin-key', auth: 'admin-auth' },
        userAgent: 'admin-agent',
      })
    )
    expect(first.status).toBe(201)
    const firstSubscription = (await first.json()) as { id: string }

    const second = await buildApp().request(
      '/api/push/subscribe',
      jsonReq('POST', otherUser.token, {
        endpoint,
        keys: { p256dh: 'other-key', auth: 'other-auth' },
        userAgent: 'other-agent',
      })
    )
    expect(second.status).toBe(201)
    const secondSubscription = (await second.json()) as { id: string }
    expect(secondSubscription.id).toBe(firstSubscription.id)

    const [row] = await db.select().from(pushSubscriptions)
    expect(row).toMatchObject({
      id: firstSubscription.id,
      userId: otherUser.id,
      p256dh: 'other-key',
      auth: 'other-auth',
      userAgent: 'other-agent',
    })

    const staleDelete = await buildApp().request(
      `/api/push/subscribe/${firstSubscription.id}`,
      jsonReq('DELETE', admin.token)
    )
    expect(staleDelete.status).toBe(403)
    expect(await db.select().from(pushSubscriptions)).toEqual([row])
  })

  test('lists only caller subscriptions and deletes only the requested caller subscription', async () => {
    const [adminSub, secondAdminSub, otherSub] = await db
      .insert(pushSubscriptions)
      .values([
        { endpoint: `https://push.example/${prefix}/admin`, p256dh: 'a', auth: 'a', userId: admin.id },
        { endpoint: `https://push.example/${prefix}/admin-2`, p256dh: 'a2', auth: 'a2', userId: admin.id },
        { endpoint: `https://push.example/${prefix}/other`, p256dh: 'b', auth: 'b', userId: otherUser.id },
      ])
      .returning()

    const list = await buildApp().request('/api/push/subscriptions', jsonReq('GET', admin.token))
    expect(list.status).toBe(200)
    expect((await list.json()).map((sub: { id: string }) => sub.id).sort()).toEqual(
      [adminSub.id, secondAdminSub.id].sort()
    )

    expect(
      (await buildApp().request(`/api/push/subscribe/${otherSub.id}`, jsonReq('DELETE', admin.token))).status
    ).toBe(403)
    expect(
      (await buildApp().request(`/api/push/subscribe/${adminSub.id}`, jsonReq('DELETE', admin.token))).status
    ).toBe(200)
    expect((await db.select().from(pushSubscriptions)).map(({ id }) => id).sort()).toEqual(
      [secondAdminSub.id, otherSub.id].sort()
    )
  })
})

describe('B15 images RBAC', () => {
  beforeEach(() => {
    process.env.FICUS_ENCRYPTION_KEY = 'c'.repeat(64)
    __resetSigningKeyForTests()
  })

  test('sign-urls is access-controlled per owning agent; uploads require agents:write', async () => {
    // Unauthenticated sign-urls is rejected outright.
    expect((await buildApp().request('/api/images/sign-urls', jsonReq('POST', undefined, { ids: [] }))).status).toBe(
      401
    )

    // Upload an image as admin (no agent context -> squad-less).
    const upload = await buildApp().request(
      '/api/images',
      jsonReq('POST', admin.token, {
        images: [{ type: 'image', data: Buffer.from('png').toString('base64'), mimeType: 'image/png' }],
      })
    )
    expect(upload.status).toBe(200)
    const { imageIds } = await upload.json()

    // An unprivileged user (no agents:read anywhere) cannot sign that image: it
    // is omitted from the result rather than signed (access mirrors agents:read
    // on the owning agent's squad; squad-less images are admin-only).
    const unprivSign = await buildApp().request(
      '/api/images/sign-urls',
      jsonReq('POST', unprivileged.token, { ids: imageIds })
    )
    expect(unprivSign.status).toBe(200)
    expect((await unprivSign.json()).urls[imageIds[0]]).toBeUndefined()

    // Uploads still require agents:write (folded from images:write).
    expect((await buildApp().request('/api/images', jsonReq('POST', unprivileged.token, { images: [] }))).status).toBe(
      403
    )
  })

  test('allows signed public image reads and admin image writes/signing', async () => {
    const upload = await buildApp().request(
      '/api/images',
      jsonReq('POST', admin.token, {
        images: [{ type: 'image', data: Buffer.from('png').toString('base64'), mimeType: 'image/png' }],
      })
    )
    expect(upload.status).toBe(200)
    const { imageIds } = await upload.json()

    const sign = await buildApp().request('/api/images/sign-urls', jsonReq('POST', admin.token, { ids: imageIds }))
    expect(sign.status).toBe(200)

    const signed = signImageUrl(imageIds[0])!
    const read = await buildApp().request(`/api/images/${imageIds[0]}?exp=${signed.exp}&sig=${signed.sig}`)
    expect(read.status).toBe(200)
    expect(await read.text()).toBe('png')

    const unsigned = await buildApp().request(`/api/images/${imageIds[0]}`)
    expect(unsigned.status).toBe(401)
  })

  test('denies authenticated image reads without a valid signature', async () => {
    const [image] = await Image.createMany([
      { type: 'image', data: Buffer.from('secret').toString('base64'), mimeType: 'image/png' },
    ])

    const res = await buildApp().request(`/api/images/${image.id}`, {
      headers: authHeaders(unprivileged.token),
    })

    expect(res.status).toBe(403)
  })
})
