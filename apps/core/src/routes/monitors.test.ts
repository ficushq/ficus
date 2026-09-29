import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'bun:test'
import { eq, like } from 'drizzle-orm'
import { Hono } from 'hono'
import { monitorsRouter } from './monitors'
import { Agent } from '../entities/Agent'
import { AgentType } from '../entities/AgentType'
import { Monitor } from '../entities/Monitor'
import { Squad } from '../entities/Squad'
import { db } from '../db'
import { agents, agentTypes, monitors, squads } from '../db/schema'
import { identityMiddleware } from '../middleware/identity'
import {
  createTestAdmin,
  createTestUser,
  createTestRole,
  assignRole,
  authHeaders,
  cleanupTestRbac,
  type TestUser,
} from '../test-utils'

// ── Unauthed app (legacy tests) ───────────────────────────────────────────────

const unauthApp = new Hono()
unauthApp.route('/api/monitors', monitorsRouter)

// ── Authed app (RBAC tests) ───────────────────────────────────────────────────

const app = new Hono()
app.use('*', identityMiddleware)
app.route('/api/monitors', monitorsRouter)

// ── Legacy tests (updated to use admin auth where required by guards) ─────────

const legacyPrefix = `mon-legacy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
let legacyAdmin: TestUser

describe('monitor routes', () => {
  let agentId: string
  let agentTypeId: string

  beforeAll(async () => {
    legacyAdmin = await createTestAdmin({ prefix: legacyPrefix })
  })

  afterAll(async () => {
    await cleanupTestRbac(legacyPrefix)
  })

  beforeEach(async () => {
    agentTypeId = `monitor-route-${Date.now()}-${Math.random().toString(36).slice(2)}`
    await AgentType.create({
      id: agentTypeId,
      name: 'Monitor Route Test',
      model: 'anthropic:claude-sonnet-4-5',
      systemPrompt: 'test',
    })
    const agent = await Agent.create({ agentTypeId })
    agentId = agent.id
  })

  afterEach(async () => {
    await db.delete(monitors).where(eq(monitors.agentId, agentId))
    await db.delete(agents).where(eq(agents.id, agentId))
    await db.delete(agentTypes).where(eq(agentTypes.id, agentTypeId))
  })

  async function adminFetch(url: string): Promise<Response> {
    return app.fetch(new Request(`http://localhost${url}`, { headers: authHeaders(legacyAdmin.token) }))
  }

  it('lists monitors with validated status filters', async () => {
    const monitor = await Monitor.create({
      agentId,
      sandboxId: 'sandbox-1',
      label: 'watch',
      command: 'bun test --watch',
      processId: 'ficus-monitor-test',
      timeoutMs: 30_000,
      maxBatchLines: 20,
      maxBatchBytes: 4096,
      batchDebounceMs: 750,
    })

    // GET / requires auth — use admin credentials
    const res = await adminFetch(`/api/monitors?agentId=${agentId}&status=starting,running`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.map((row: any) => row.id)).toContain(monitor.id)
  })

  it('rejects invalid list query parameters', async () => {
    // GET / requires auth — input validation occurs after identity check
    expect((await adminFetch('/api/monitors?status=bogus')).status).toBe(400)
    expect((await adminFetch('/api/monitors?agentId=agent/../bad')).status).toBe(400)
    expect((await adminFetch('/api/monitors?agentId=a&squadId=s')).status).toBe(400)
  })

  it('accepts overload as a valid status filter', async () => {
    const res = await adminFetch(`/api/monitors?agentId=${agentId}&status=overload`)
    expect(res.status).toBe(200)
  })

  it('rejects invalid path and log tail inputs', async () => {
    // /:id and /:id/logs are guarded — use admin credentials for input validation tests
    expect((await adminFetch('/api/monitors/bad%20id')).status).toBe(400)
    expect((await adminFetch('/api/monitors/bad%20id/logs')).status).toBe(400)
    expect((await adminFetch('/api/monitors/missing/logs?tail=abc')).status).toBe(400)
    expect((await adminFetch('/api/monitors/missing/logs?tail=501')).status).toBe(400)
  })
})

// ── RBAC guard tests ──────────────────────────────────────────────────────────

describe('monitors RBAC guards', () => {
  const rbacPrefix = `mon-guard-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  let guardAdmin: TestUser
  let unprivileged: TestUser
  let agentTypeId: string
  let agentId: string
  let squadId: string
  let monitorId: string

  beforeAll(async () => {
    guardAdmin = await createTestAdmin({ prefix: rbacPrefix })
    unprivileged = await createTestUser({ prefix: rbacPrefix })

    agentTypeId = `${rbacPrefix}-at`
    await AgentType.create({
      id: agentTypeId,
      name: 'Monitor RBAC Test',
      model: 'anthropic:claude-sonnet-4-5',
      systemPrompt: 'test',
    })

    const squad = await Squad.create({ name: `${rbacPrefix} Squad`, purpose: 'Monitor RBAC testing' })
    squadId = squad.id

    const agent = await Agent.create({ agentTypeId, squadId })
    agentId = agent.id

    const monitor = await Monitor.create({
      agentId,
      sandboxId: 'sandbox-rbac',
      label: 'rbac-test',
      command: 'echo test',
      processId: 'ficus-monitor-rbac',
      timeoutMs: 30_000,
      maxBatchLines: 20,
      maxBatchBytes: 4096,
      batchDebounceMs: 750,
    })
    monitorId = monitor.id
  })

  afterAll(async () => {
    await db.delete(monitors).where(eq(monitors.agentId, agentId))
    await db.delete(agents).where(eq(agents.id, agentId))
    await db.delete(agentTypes).where(eq(agentTypes.id, agentTypeId))
    await db.delete(squads).where(like(squads.name, `${rbacPrefix}%`))
    await cleanupTestRbac(rbacPrefix)
  })

  async function guardFetch(
    token: string,
    url: string,
    init?: { method?: string; body?: string; headers?: Record<string, string> }
  ): Promise<Response> {
    return app.fetch(
      new Request(`http://localhost${url}`, {
        method: init?.method ?? 'GET',
        body: init?.body,
        headers: { ...authHeaders(token), ...(init?.headers ?? {}) },
      })
    )
  }

  // GET / — filtered-list

  it('GET /api/monitors → 401 without identity', async () => {
    const res = await app.fetch(new Request('http://localhost/api/monitors'))
    expect(res.status).toBe(401)
  })

  it('GET /api/monitors → 403 for unprivileged user (no accessible squads)', async () => {
    const res = await guardFetch(unprivileged.token, '/api/monitors')
    expect(res.status).toBe(403)
  })

  it('GET /api/monitors → 200 for admin, filtered to all squads', async () => {
    const res = await guardFetch(guardAdmin.token, '/api/monitors')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body)).toBe(true)
  })

  it('GET /api/monitors → 200 for squad-scoped user, only returns accessible monitors', async () => {
    const limitedUser = await createTestUser({ prefix: rbacPrefix })
    const role = await createTestRole({ permissions: ['monitors:read'], prefix: rbacPrefix })
    await assignRole({ userId: limitedUser.id, roleId: role.id, scope: 'squad', squadId })

    const res = await guardFetch(limitedUser.token, '/api/monitors')
    expect(res.status).toBe(200)
    const body = await res.json()
    // The monitor for our squad should be visible
    const ids = body.map((m: any) => m.id)
    expect(ids).toContain(monitorId)
  })

  // GET /:id — handler-scope

  it('GET /api/monitors/:id → 401 without identity', async () => {
    const res = await app.fetch(new Request(`http://localhost/api/monitors/${monitorId}`))
    expect(res.status).toBe(401)
  })

  it('GET /api/monitors/:id → 403 for unprivileged user', async () => {
    const res = await guardFetch(unprivileged.token, `/api/monitors/${monitorId}`)
    expect(res.status).toBe(403)
  })

  it('GET /api/monitors/:id → 200 for admin', async () => {
    const res = await guardFetch(guardAdmin.token, `/api/monitors/${monitorId}`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.id).toBe(monitorId)
  })

  it('GET /api/monitors/:id → 403 for user with permission on different squad', async () => {
    const otherSquad = await Squad.create({ name: `${rbacPrefix} Other`, purpose: 'cross-squad' })
    const limitedUser = await createTestUser({ prefix: rbacPrefix })
    const role = await createTestRole({ permissions: ['monitors:read'], prefix: rbacPrefix })
    await assignRole({ userId: limitedUser.id, roleId: role.id, scope: 'squad', squadId: otherSquad.id })

    const res = await guardFetch(limitedUser.token, `/api/monitors/${monitorId}`)
    expect(res.status).toBe(403)

    await db.delete(squads).where(eq(squads.id, otherSquad.id))
  })

  // GET /:id/logs — handler-scope

  it('GET /api/monitors/:id/logs → 401 without identity', async () => {
    const res = await app.fetch(new Request(`http://localhost/api/monitors/${monitorId}/logs`))
    expect(res.status).toBe(401)
  })

  it('GET /api/monitors/:id/logs → 403 for unprivileged user', async () => {
    const res = await guardFetch(unprivileged.token, `/api/monitors/${monitorId}/logs`)
    expect(res.status).toBe(403)
  })

  // POST /:id/cancel — handler-scope

  it('POST /api/monitors/:id/cancel → 401 without identity', async () => {
    const res = await app.fetch(new Request(`http://localhost/api/monitors/${monitorId}/cancel`, { method: 'POST' }))
    expect(res.status).toBe(401)
  })

  it('POST /api/monitors/:id/cancel → 403 for unprivileged user', async () => {
    const res = await guardFetch(unprivileged.token, `/api/monitors/${monitorId}/cancel`, { method: 'POST' })
    expect(res.status).toBe(403)
  })

  it('POST /api/monitors/:id/cancel → 403 for user with monitors:read but not monitors:write', async () => {
    const readOnlyUser = await createTestUser({ prefix: rbacPrefix })
    const role = await createTestRole({ permissions: ['monitors:read'], prefix: rbacPrefix })
    await assignRole({ userId: readOnlyUser.id, roleId: role.id, scope: 'squad', squadId })

    const res = await guardFetch(readOnlyUser.token, `/api/monitors/${monitorId}/cancel`, { method: 'POST' })
    expect(res.status).toBe(403)
  })
})
