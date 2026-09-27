import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { Hono } from 'hono'
import { sessionsRouter } from './sessions'
import { identityMiddleware } from '../middleware/identity'
import { createTestAdmin, createTestUser, authHeaders, cleanupTestRbac } from '../test-utils'
import type { TestUser } from '../test-utils/rbac'

const app = new Hono()
app.use('*', identityMiddleware)
app.route('/api/sessions', sessionsRouter)

const prefix = `sess-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

let admin: TestUser

beforeAll(async () => {
  admin = await createTestAdmin({ prefix })
})

afterAll(async () => {
  await cleanupTestRbac(prefix)
})

describe('GET /api/sessions', () => {
  it('lists own sessions', async () => {
    const res = await app.request('/api/sessions', {
      headers: authHeaders(admin.token),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body)).toBe(true)
    expect(body.length).toBeGreaterThanOrEqual(1)
    expect(body.some((s: any) => s.id === admin.sessionId)).toBe(true)
  })

  it('rejects unauthenticated requests', async () => {
    const res = await app.request('/api/sessions')
    expect(res.status).toBe(401)
  })
})

describe('DELETE /api/sessions/:id', () => {
  it('revokes a specific session', async () => {
    // Create a second user with its own session to revoke
    const user = await createTestUser({ prefix })

    const res = await app.request(`/api/sessions/${user.sessionId}`, {
      method: 'DELETE',
      headers: authHeaders(user.token),
    })
    expect(res.status).toBe(204)

    // Session should be gone — listing should fail (token revoked)
    const listRes = await app.request('/api/sessions', {
      headers: authHeaders(user.token),
    })
    expect(listRes.status).toBe(401)
  })

  it("cannot revoke another user's session", async () => {
    const other = await createTestUser({ prefix })

    // Admin tries to delete other's session via the sessions endpoint
    const res = await app.request(`/api/sessions/${other.sessionId}`, {
      method: 'DELETE',
      headers: authHeaders(admin.token),
    })
    expect(res.status).toBe(204)

    // Other's session should still work (delete was scoped to admin's userId)
    const listRes = await app.request('/api/sessions', {
      headers: authHeaders(other.token),
    })
    expect(listRes.status).toBe(200)
  })
})

describe('DELETE /api/sessions', () => {
  it('revokes all own sessions', async () => {
    const user = await createTestUser({ prefix })

    const res = await app.request('/api/sessions', {
      method: 'DELETE',
      headers: authHeaders(user.token),
    })
    expect(res.status).toBe(204)

    // Token should now be invalid
    const listRes = await app.request('/api/sessions', {
      headers: authHeaders(user.token),
    })
    expect(listRes.status).toBe(401)
  })

  it('bulk revokes ALL caller sessions and leaves another user sessions intact', async () => {
    // Create user with 2 sessions
    const userA = await createTestUser({ prefix })
    // Create a second session for userA by creating another user object with same userId
    // We do this by directly importing and using createTestUser's internals — simpler: import db
    const { db } = await import('../db')
    const { sessions } = await import('../db/schema')
    const { randomUUID } = await import('crypto')
    const { createHash } = await import('crypto')

    const token2 = `ficus_sess_${randomUUID()}`
    const tokenHash2 = createHash('sha256').update(token2).digest('hex')
    await db.insert(sessions).values({
      userId: userA.id,
      tokenHash: tokenHash2,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    })

    // Create user B with their own session
    const userB = await createTestUser({ prefix })

    // Verify userA has 2 sessions
    const listBefore = await app.request('/api/sessions', { headers: authHeaders(userA.token) })
    const sessionsBefore = await listBefore.json()
    expect(sessionsBefore.length).toBe(2)

    // Bulk delete all of userA's sessions
    const res = await app.request('/api/sessions', {
      method: 'DELETE',
      headers: authHeaders(userA.token),
    })
    expect(res.status).toBe(204)

    // userA's token is now invalid
    const listAfterA = await app.request('/api/sessions', { headers: authHeaders(userA.token) })
    expect(listAfterA.status).toBe(401)

    // userB's session is still intact
    const listAfterB = await app.request('/api/sessions', { headers: authHeaders(userB.token) })
    expect(listAfterB.status).toBe(200)
    const sessionsB = await listAfterB.json()
    expect(sessionsB.some((s: any) => s.id === userB.sessionId)).toBe(true)
  })
})

describe('GET /api/sessions cross-user isolation', () => {
  it("user A's sessions are not visible in user B's session list", async () => {
    const userA = await createTestUser({ prefix })
    const userB = await createTestUser({ prefix })

    // userA lists sessions — only sees their own
    const resA = await app.request('/api/sessions', { headers: authHeaders(userA.token) })
    expect(resA.status).toBe(200)
    const sessionsA = await resA.json()
    expect(sessionsA.some((s: any) => s.id === userA.sessionId)).toBe(true)
    expect(sessionsA.every((s: any) => s.id !== userB.sessionId)).toBe(true)

    // userB lists sessions — only sees their own
    const resB = await app.request('/api/sessions', { headers: authHeaders(userB.token) })
    expect(resB.status).toBe(200)
    const sessionsB = await resB.json()
    expect(sessionsB.some((s: any) => s.id === userB.sessionId)).toBe(true)
    expect(sessionsB.every((s: any) => s.id !== userA.sessionId)).toBe(true)
  })
})
