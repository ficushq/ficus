import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import { SYSTEM_RECIPIENT_ID } from '@ficus/shared'
import { inboxRouter } from './inbox'
import { identityMiddleware } from '../middleware/identity'
import { db, inbox } from '../db'
import { InboxMessage } from '../entities/InboxMessage'
import { authHeaders, cleanupTestRbac, createTestAdmin, createTestUser, type TestUser } from '../test-utils'

const prefix = `inbox-peruser-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

function buildApp() {
  const app = new Hono()
  app.use('*', identityMiddleware)
  app.route('/api/inbox', inboxRouter)
  return app
}
const app = buildApp()

let userA: TestUser
let userB: TestUser
let admin: TestUser

beforeAll(async () => {
  userA = await createTestUser({ prefix })
  userB = await createTestUser({ prefix })
  admin = await createTestAdmin({ prefix })

  // A personal message for user A, and a shared system message.
  await InboxMessage.send({ recipientType: 'user', recipientId: userA.id, senderType: 'system', content: 'hello A' })
  await InboxMessage.send({
    recipientType: 'system',
    recipientId: SYSTEM_RECIPIENT_ID,
    senderType: 'system',
    content: 'system announce',
  })
})

afterAll(async () => {
  await db.delete(inbox).where(inArray(inbox.recipientId, [userA.id, userB.id, SYSTEM_RECIPIENT_ID]))
  await cleanupTestRbac(prefix)
})

describe('per-user inbox isolation (closes the cross-user leak)', () => {
  it("serves a user their own inbox via the 'me' shorthand", async () => {
    const res = await app.request('/api/inbox/user/me', { headers: authHeaders(userA.token) })
    expect(res.status).toBe(200)
    const msgs = (await res.json()) as Array<{ content: string }>
    expect(msgs.map((m) => m.content)).toContain('hello A')
  })

  it("forbids reading another user's inbox by id", async () => {
    const res = await app.request(`/api/inbox/user/${userA.id}`, { headers: authHeaders(userB.token) })
    expect(res.status).toBe(403)
  })

  it("does not leak user A's messages into user B's own inbox", async () => {
    const res = await app.request('/api/inbox/user/me', { headers: authHeaders(userB.token) })
    expect(res.status).toBe(200)
    const msgs = (await res.json()) as Array<{ content: string }>
    expect(msgs.map((m) => m.content)).not.toContain('hello A')
  })

  it('requires inbox:system to read the shared system inbox', async () => {
    const denied = await app.request('/api/inbox/system/system', { headers: authHeaders(userA.token) })
    expect(denied.status).toBe(403)

    const allowed = await app.request('/api/inbox/system/system', { headers: authHeaders(admin.token) })
    expect(allowed.status).toBe(200)
    const msgs = (await allowed.json()) as Array<{ content: string }>
    expect(msgs.map((m) => m.content)).toContain('system announce')
  })

  it('tracks system inbox read state per reader', async () => {
    const countOf = async (token: string) =>
      (await (await app.request('/api/inbox/system/system/count', { headers: authHeaders(token) })).json()).count

    expect(await countOf(admin.token)).toBeGreaterThanOrEqual(1)
    await app.request('/api/inbox/system/system/read-all', { method: 'POST', headers: authHeaders(admin.token) })
    expect(await countOf(admin.token)).toBe(0)
  })
})
