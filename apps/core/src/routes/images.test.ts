import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'bun:test'
import { Hono } from 'hono'
import { imagesRouter } from './images'
import { identityMiddleware, jsonBodyErrorHandler, jsonBodyErrorMiddleware } from '../middleware'
import { __resetSigningKeyForTests, signImageUrl } from '../services/images/signing'
import { Image } from '../entities/Image'
import {
  assignRole,
  authHeaders,
  cleanupTestRbac,
  createTestAdmin,
  createTestAgentToken,
  createTestRole,
  createTestUser,
  type TestUser,
} from '../test-utils'
import { db, squads, agents, roles, images } from '../db'
import { eq, inArray } from 'drizzle-orm'
import { MAX_IMAGE_ATTACHMENTS_PER_MESSAGE } from '@ficus/shared'
import { deflateSync } from 'node:zlib'

const PASSWORD = 'test-password-xyz'

function crc32(input: Buffer): number {
  let crc = 0xffffffff
  for (const byte of input) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type, 'ascii')
  const chunk = Buffer.alloc(data.length + 12)
  chunk.writeUInt32BE(data.length, 0)
  name.copy(chunk, 4)
  data.copy(chunk, 8)
  chunk.writeUInt32BE(crc32(Buffer.concat([name, data])), data.length + 8)
  return chunk
}

/** Build the reported dimensions and approximate byte size at runtime without a large fixture. */
function reportedLargeDimensionPng(): Buffer {
  const width = 3824
  const height = 2474
  const targetBytes = Math.floor(1.5 * 1024 * 1024)
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 0 // grayscale
  const signature = Buffer.from('89504e470d0a1a0a', 'hex')
  const header = pngChunk('IHDR', ihdr)
  const pixels = Buffer.alloc((width + 1) * height) // one filter byte plus one grayscale byte per pixel
  const imageData = pngChunk('IDAT', deflateSync(pixels))
  const end = pngChunk('IEND', Buffer.alloc(0))
  const textLength = targetBytes - signature.length - header.length - imageData.length - end.length - 12
  const metadata = pngChunk('tEXt', Buffer.concat([Buffer.from('reported\0'), Buffer.alloc(textLength - 9, 'x')]))
  return Buffer.concat([signature, header, imageData, metadata, end])
}

function buildApp() {
  const app = new Hono()
  app.use('*', jsonBodyErrorMiddleware)
  app.onError(jsonBodyErrorHandler)
  app.use('/api/*', identityMiddleware)
  app.route('/api/images', imagesRouter)
  return app
}

describe('GET /api/images/:id', () => {
  const origEnc = process.env.FICUS_ENCRYPTION_KEY
  const origPw = process.env.FICUS_PASSWORD

  beforeEach(() => {
    process.env.FICUS_PASSWORD = PASSWORD
    process.env.FICUS_ENCRYPTION_KEY = 'b'.repeat(64)
    __resetSigningKeyForTests()
  })

  afterEach(() => {
    if (origEnc === undefined) delete process.env.FICUS_ENCRYPTION_KEY
    else process.env.FICUS_ENCRYPTION_KEY = origEnc
    if (origPw === undefined) delete process.env.FICUS_PASSWORD
    else process.env.FICUS_PASSWORD = origPw
    __resetSigningKeyForTests()
  })

  async function requestSignedImage() {
    const [id] = await Image.createMany([
      {
        type: 'image',
        data: Buffer.from('test image bytes').toString('base64'),
        mimeType: 'image/png',
      },
    ]).then((images) => images.map((image) => image.id))
    const signed = signImageUrl(id)
    expect(signed).not.toBeNull()

    return buildApp().request(`/api/images/${id}?exp=${signed!.exp}&sig=${signed!.sig}`)
  }

  it('caches signed image responses per-user, bounded by the signature expiry', async () => {
    const res = await requestSignedImage()

    expect(res.status).toBe(200)
    const cacheControl = res.headers.get('Cache-Control') ?? ''
    // Per-user only (no shared/proxy caches), immutable bytes, and never cached past the signature.
    expect(cacheControl).toContain('private')
    expect(cacheControl).toContain('immutable')
    expect(cacheControl).not.toContain('no-store')
    const maxAge = Number(cacheControl.match(/max-age=(\d+)/)?.[1])
    expect(maxAge).toBeGreaterThan(0)
    expect(maxAge).toBeLessThanOrEqual(24 * 60 * 60)
  })

  it('still serves cacheable headers when FICUS_PASSWORD is not configured', async () => {
    delete process.env.FICUS_PASSWORD

    const res = await requestSignedImage()

    expect(res.status).toBe(200)
    const cacheControl = res.headers.get('Cache-Control') ?? ''
    expect(cacheControl).toContain('private')
    expect(cacheControl).toContain('immutable')
    expect(cacheControl).not.toContain('no-store')
  })
})

describe('POST /api/images', () => {
  const prefix = 'images-squad-upload'
  const image = {
    type: 'image' as const,
    data: Buffer.from('image').toString('base64'),
    mimeType: 'image/png',
  }
  let user: TestUser
  let otherUser: TestUser
  let squadA: typeof squads.$inferSelect
  let squadB: typeof squads.$inferSelect
  let agentA: typeof agents.$inferSelect
  const createdImageIds: string[] = []

  beforeAll(async () => {
    user = await createTestUser({ prefix })
    otherUser = await createTestUser({ prefix })
    const role = await createTestRole({ prefix, permissions: ['agents:read', 'agents:write'] })
    ;[squadA, squadB] = await db
      .insert(squads)
      .values([
        { name: `${prefix} A`, purpose: 'test' },
        { name: `${prefix} B`, purpose: 'test' },
      ])
      .returning()
    ;[agentA] = await db.insert(agents).values({ agentTypeId: 'engineer', squadId: squadA.id }).returning()
    await assignRole({ userId: user.id, roleId: role.id, scope: 'squad', squadId: squadA.id })
    await assignRole({ userId: otherUser.id, roleId: role.id, scope: 'squad', squadId: squadA.id })
  })

  afterAll(async () => {
    await Image.deleteMany(createdImageIds)
    await db.delete(agents).where(eq(agents.id, agentA.id))
    await db.delete(squads).where(inArray(squads.id, [squadA.id, squadB.id]))
    await cleanupTestRbac(prefix)
  })

  async function upload(token: string, target: { agentId?: string; squadId?: string }) {
    return buildApp().request('/api/images', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(token) },
      body: JSON.stringify({ images: [image], ...target }),
    })
  }

  it('stages an image for its uploader in an authorized squad', async () => {
    const res = await upload(user.token, { squadId: squadA.id })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { imageIds: string[] }
    createdImageIds.push(...body.imageIds)
    expect(await Image.find(body.imageIds[0]!)).toMatchObject({
      squadId: squadA.id,
      uploadedByUserId: user.id,
      agentId: null,
    })
  })

  it('accepts the reported 1.5 MB 3824×2474 PNG without a dimension-only rejection', async () => {
    const png = reportedLargeDimensionPng()
    expect(png.length).toBe(Math.floor(1.5 * 1024 * 1024))
    expect(png.readUInt32BE(16)).toBe(3824)
    expect(png.readUInt32BE(20)).toBe(2474)

    const res = await buildApp().request('/api/images', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(user.token) },
      body: JSON.stringify({
        images: [{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' }],
        agentId: agentA.id,
      }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { imageIds: string[] }
    createdImageIds.push(...body.imageIds)
    expect(await Image.find(body.imageIds[0]!)).toMatchObject({
      agentId: agentA.id,
      mimeType: 'image/png',
      size: png.length,
    })
  })

  it('rejects staging into another squad', async () => {
    const res = await upload(user.token, { squadId: squadB.id })
    expect(res.status).toBe(403)
  })

  it('rejects mutually exclusive agent and squad targets', async () => {
    const res = await upload(user.token, { agentId: agentA.id, squadId: squadA.id })
    expect(res.status).toBe(400)
  })

  it('rejects an over-limit upload batch without creating image rows', async () => {
    const before = await db.select().from(images)
    const res = await buildApp().request('/api/images', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(user.token) },
      body: JSON.stringify({
        images: Array.from({ length: MAX_IMAGE_ATTACHMENTS_PER_MESSAGE + 1 }, () => image),
        squadId: squadA.id,
      }),
    })

    if (res.status === 200) {
      const body = (await res.json()) as { imageIds: string[] }
      await Image.deleteMany(body.imageIds)
    }
    expect(res.status).toBe(400)
    expect((await db.select().from(images)).length).toBe(before.length)
  })

  it('returns 404 for a nonexistent agent owner without creating an image', async () => {
    const before = await db.select().from(images)
    const res = await upload(user.token, { agentId: '11111111-1111-4111-8111-111111111111' })
    expect(res.status).toBe(404)
    expect((await db.select().from(images)).length).toBe(before.length)
  })

  it('signs a staged image only for its uploader', async () => {
    const uploadRes = await upload(user.token, { squadId: squadA.id })
    const { imageIds } = (await uploadRes.json()) as { imageIds: string[] }
    createdImageIds.push(...imageIds)

    const sign = (token: string) =>
      buildApp().request('/api/images/sign-urls', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(token) },
        body: JSON.stringify({ ids: imageIds }),
      })
    const ownerBody = (await (await sign(user.token)).json()) as { urls: Record<string, string> }
    const otherBody = (await (await sign(otherUser.token)).json()) as { urls: Record<string, string> }
    expect(ownerBody.urls[imageIds[0]!]).toBeDefined()
    expect(otherBody.urls[imageIds[0]!]).toBeUndefined()
  })

  it('continues signing used squad assets for squad readers', async () => {
    const [asset] = await Image.createMany([image], { squadId: squadA.id })
    createdImageIds.push(asset.id)
    await Image.markManyUsed([asset.id])

    const res = await buildApp().request('/api/images/sign-urls', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(otherUser.token) },
      body: JSON.stringify({ ids: [asset.id] }),
    })
    const body = (await res.json()) as { urls: Record<string, string> }
    expect(body.urls[asset.id]).toBeDefined()
  })
})

describe('POST /api/images/sign-urls', () => {
  const origEnc = process.env.FICUS_ENCRYPTION_KEY
  const origPw = process.env.FICUS_PASSWORD
  const userPrefix = 'images-sign-urls'
  let user: TestUser

  // Authenticate with a real session token rather than the legacy FICUS_PASSWORD.
  // identityMiddleware disables legacy password auth once an admin user exists,
  // and the full suite runs other files concurrently that may have a canonical
  // admin in the shared DB — so a session token is the stable way to authenticate.
  beforeAll(async () => {
    user = await createTestAdmin({ prefix: userPrefix, canonicalAdmin: true })
  })

  afterAll(async () => {
    await cleanupTestRbac(userPrefix)
  })

  beforeEach(() => {
    process.env.FICUS_PASSWORD = PASSWORD
    process.env.FICUS_ENCRYPTION_KEY = 'b'.repeat(64)
    __resetSigningKeyForTests()
  })

  afterEach(() => {
    if (origEnc === undefined) delete process.env.FICUS_ENCRYPTION_KEY
    else process.env.FICUS_ENCRYPTION_KEY = origEnc
    if (origPw === undefined) delete process.env.FICUS_PASSWORD
    else process.env.FICUS_PASSWORD = origPw
    __resetSigningKeyForTests()
  })

  it('requires auth', async () => {
    const res = await buildApp().request('/api/images/sign-urls', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: ['11111111-1111-1111-1111-111111111111'] }),
    })

    expect(res.status).toBe(401)
  })

  it('accepts an absent optional body and rejects malformed non-empty JSON', async () => {
    const absent = await buildApp().request('/api/images/sign-urls', {
      method: 'POST',
      headers: authHeaders(user.token),
    })
    expect(absent.status).toBe(200)
    expect(await absent.json()).toEqual({ urls: {} })

    const malformed = await buildApp().request('/api/images/sign-urls', {
      method: 'POST',
      headers: authHeaders(user.token),
      body: '{',
    })
    expect(malformed.status).toBe(400)
    expect(await malformed.json()).toEqual({ error: 'Invalid JSON body' })
  })

  it('returns signed URLs for accessible images', async () => {
    const [squad] = await db
      .insert(squads)
      .values({ name: `${userPrefix} sign`, purpose: 't' })
      .returning()
    const [agent] = await db.insert(agents).values({ agentTypeId: 'engineer', squadId: squad.id }).returning()
    const imgs = await Image.createMany(
      [
        { type: 'image', data: Buffer.from('1').toString('base64'), mimeType: 'image/png' },
        { type: 'image', data: Buffer.from('2').toString('base64'), mimeType: 'image/png' },
      ],
      { agentId: agent.id }
    )
    const ids = imgs.map((i) => i.id)
    try {
      const res = await buildApp().request('/api/images/sign-urls', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(user.token) },
        body: JSON.stringify({ ids }),
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      for (const id of ids) {
        expect(body.urls[id]).toMatch(new RegExp(`^/api/images/${id}\\?exp=\\d+&sig=[A-Za-z0-9_-]+$`))
      }
    } finally {
      await db.delete(images).where(inArray(images.id, ids))
      await db.delete(agents).where(eq(agents.id, agent.id))
      await db.delete(squads).where(eq(squads.id, squad.id))
    }
  })

  it('only signs images the caller can read via agents:read on the owning squad', async () => {
    await db
      .insert(roles)
      .values({ name: 'Default Worker', slug: 'default-worker', isSystem: true, permissions: ['agents:read'] })
      .onConflictDoUpdate({ target: roles.slug, set: { permissions: ['agents:read'] } })
    const [squadA] = await db
      .insert(squads)
      .values({ name: `${userPrefix} A`, purpose: 't' })
      .returning()
    const [squadB] = await db
      .insert(squads)
      .values({ name: `${userPrefix} B`, purpose: 't' })
      .returning()
    const [agentA] = await db.insert(agents).values({ agentTypeId: 'engineer', squadId: squadA.id }).returning()
    const [agentB] = await db.insert(agents).values({ agentTypeId: 'engineer', squadId: squadB.id }).returning()
    const [imgA] = await Image.createMany(
      [{ type: 'image', data: Buffer.from('a').toString('base64'), mimeType: 'image/png' }],
      { agentId: agentA.id }
    )
    const [imgB] = await Image.createMany(
      [{ type: 'image', data: Buffer.from('b').toString('base64'), mimeType: 'image/png' }],
      { agentId: agentB.id }
    )
    const [imgNull] = await Image.createMany([
      { type: 'image', data: Buffer.from('n').toString('base64'), mimeType: 'image/png' },
    ])
    const workerTok = await createTestAgentToken({ agentId: agentA.id, squadId: squadA.id })
    const bogus = '99999999-9999-9999-9999-999999999999'
    try {
      const res = await buildApp().request('/api/images/sign-urls', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(workerTok.token) },
        body: JSON.stringify({ ids: [imgA.id, imgB.id, imgNull.id, bogus] }),
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.urls[imgA.id]).toBeDefined() // own squad
      expect(body.urls[imgB.id]).toBeUndefined() // other squad
      expect(body.urls[imgNull.id]).toBeUndefined() // squad-less: not for a squad-bound agent
      expect(body.urls[bogus]).toBeUndefined() // non-existent id never signed

      // admin ('*') signs the squad-less and the cross-squad image.
      const adminRes = await buildApp().request('/api/images/sign-urls', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(user.token) },
        body: JSON.stringify({ ids: [imgNull.id, imgB.id] }),
      })
      const adminBody = await adminRes.json()
      expect(adminBody.urls[imgNull.id]).toBeDefined()
      expect(adminBody.urls[imgB.id]).toBeDefined()
    } finally {
      await db.delete(images).where(inArray(images.id, [imgA.id, imgB.id, imgNull.id]))
      await db.delete(agents).where(inArray(agents.id, [agentA.id, agentB.id]))
      await db.delete(squads).where(inArray(squads.id, [squadA.id, squadB.id]))
      await db.delete(roles).where(eq(roles.slug, 'default-worker'))
    }
  })

  it('caps batch size', async () => {
    const ids = Array.from({ length: 101 }, (_, i) => `id-${i}`)

    const res = await buildApp().request('/api/images/sign-urls', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(user.token) },
      body: JSON.stringify({ ids }),
    })

    expect(res.status).toBe(400)
  })
})
