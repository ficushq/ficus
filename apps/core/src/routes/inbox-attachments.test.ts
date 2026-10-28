import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test'
import { eq } from 'drizzle-orm'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { Hono } from 'hono'
import { db, inbox } from '../db'
import { identityMiddleware } from '../middleware/identity'
import { authzSentinel } from '../middleware/authz-sentinel'
import { inboxRouter } from './inbox'
import { getSettingsStore } from '../services/settings'
import { authHeaders, cleanupTestRbac, createTestAdmin, type TestUser } from '../test-utils'

const app = new Hono()
app.use('*', identityMiddleware)
app.route('/api/inbox', inboxRouter)

// Production-like app: sentinel wired exactly as in apps/core/src/index.ts
const appWithSentinel = new Hono()
appWithSentinel.use('/api/*', identityMiddleware)
appWithSentinel.use('/api/*', authzSentinel)
appWithSentinel.route('/api/inbox', inboxRouter)

const prefix = `inbox-att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
let admin: TestUser

beforeAll(async () => {
  admin = await createTestAdmin({ prefix, canonicalAdmin: true })
})

afterAll(async () => {
  await cleanupTestRbac(prefix)
})

let home: string
const orig = process.env.HOME_DIR

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'inbox-att-route-'))
  process.env.HOME_DIR = home
  const store = getSettingsStore()
  await store.initialize()
  await store.set('INBOX_MAX_ATTACHMENT_BYTES', '10485760')
  await store.set('INBOX_MAX_TOTAL_STORAGE_BYTES', '10737418240')
})

afterEach(async () => {
  if (orig === undefined) delete process.env.HOME_DIR
  else process.env.HOME_DIR = orig
  await rm(home, { recursive: true, force: true })
  await db.delete(inbox).where(eq(inbox.recipientId, admin.id))
})

describe('inbox attachment routes', () => {
  test('upload → message includes it → download returns bytes → delete removes it', async () => {
    const [row] = await db
      .insert(inbox)
      .values({ recipientType: 'user', recipientId: admin.id, senderType: 'system', content: 'hi' })
      .returning()

    const form = new FormData()
    form.set('file', new File([new TextEncoder().encode('hello')], 'note.txt', { type: 'text/plain' }))
    const up = await app.request(`/api/inbox/${row.id}/attachments`, {
      method: 'POST',
      body: form,
      headers: authHeaders(admin.token),
    })
    expect(up.status).toBe(201)
    const att = await up.json()
    expect(att.filename).toBe('note.txt')
    expect(att.byteSize).toBe(5)

    const msg = await app.request(`/api/inbox/message/${row.id}`, { headers: authHeaders(admin.token) })
    expect((await msg.json()).attachments.map((a: { id: string }) => a.id)).toEqual([att.id])

    const dl = await app.request(`/api/inbox/attachments/${att.id}`, { headers: authHeaders(admin.token) })
    expect(dl.status).toBe(200)
    expect(await dl.text()).toBe('hello')

    const del = await app.request(`/api/inbox/attachments/${att.id}`, {
      method: 'DELETE',
      headers: authHeaders(admin.token),
    })
    expect(del.status).toBe(200)
    const after = await app.request(`/api/inbox/attachments/${att.id}`, { headers: authHeaders(admin.token) })
    expect(after.status).toBe(403)
  })

  test('over-cap upload returns 413', async () => {
    await getSettingsStore().set('INBOX_MAX_ATTACHMENT_BYTES', '4')
    const [row] = await db
      .insert(inbox)
      .values({ recipientType: 'user', recipientId: admin.id, senderType: 'system', content: 'hi' })
      .returning()
    const form = new FormData()
    form.set('file', new File([new TextEncoder().encode('hello')], 'big.txt', { type: 'text/plain' }))
    const up = await app.request(`/api/inbox/${row.id}/attachments`, {
      method: 'POST',
      body: form,
      headers: authHeaders(admin.token),
    })
    expect(up.status).toBe(413)
  })
})

describe('inbox attachment routes — sentinel regression', () => {
  test('GET /attachments/:id and GET /message/:id return 200 (not 500) through the authz sentinel', async () => {
    // Seed a message
    const [row] = await db
      .insert(inbox)
      .values({ recipientType: 'user', recipientId: admin.id, senderType: 'system', content: 'sentinel-test' })
      .returning()

    // Upload an attachment via the sentinel-wired app
    const form = new FormData()
    form.set('file', new File([new TextEncoder().encode('bytes')], 'sentinel.txt', { type: 'text/plain' }))
    const up = await appWithSentinel.request(`/api/inbox/${row.id}/attachments`, {
      method: 'POST',
      body: form,
      headers: authHeaders(admin.token),
    })
    expect(up.status).toBe(201)
    const att = await up.json()

    // GET /api/inbox/attachments/:id must be 200 through the sentinel
    const dl = await appWithSentinel.request(`/api/inbox/attachments/${att.id}`, {
      headers: authHeaders(admin.token),
    })
    expect(dl.status).toBe(200)
    expect(await dl.text()).toBe('bytes')

    // GET /api/inbox/message/:id must be 200 through the sentinel
    const msg = await appWithSentinel.request(`/api/inbox/message/${row.id}`, {
      headers: authHeaders(admin.token),
    })
    expect(msg.status).toBe(200)
  })
})

test('unknown-length oversize multipart is rejected before parsing', async () => {
  await getSettingsStore().set('INBOX_MAX_ATTACHMENT_BYTES', '4')
  const [row] = await db
    .insert(inbox)
    .values({ recipientType: 'user', recipientId: admin.id, senderType: 'system', content: 'hi' })
    .returning()
  const response = await app.request(`/api/inbox/${row.id}/attachments`, {
    method: 'POST',
    headers: { ...authHeaders(admin.token), 'content-type': 'multipart/form-data; boundary=test' },
    body: new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array(65541))
        c.close()
      },
    }),
  })
  expect(response.status).toBe(413)
  expect(await response.json()).toEqual({ error: 'ATTACHMENT_TOO_LARGE' })
})
