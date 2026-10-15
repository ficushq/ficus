import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { Hono } from 'hono'
import { agents, db, squads } from '../db'
import { inArray } from 'drizzle-orm'
import { identityMiddleware } from '../middleware/identity'
import { terminalRouter } from './terminal'
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

const app = new Hono()
app.use('*', identityMiddleware)
app.route('/api/terminal', terminalRouter)

const rbacPrefix = `terminal-rbac-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const squadId = crypto.randomUUID()
const otherSquadId = crypto.randomUUID()
const sandboxId = `squad_${squadId}`
let admin: TestUser

beforeAll(async () => {
  await db
    .insert(squads)
    .values([squadId, otherSquadId].map((id) => ({ id, name: `${rbacPrefix}-${id}`, purpose: 'RBAC scope' })))
  admin = await createTestAdmin({ prefix: rbacPrefix, canonicalAdmin: true })
})

afterAll(async () => {
  await db.delete(agents).where(inArray(agents.squadId, [squadId, otherSquadId]))
  await cleanupTestRbac(rbacPrefix)
  await db.delete(squads).where(inArray(squads.id, [squadId, otherSquadId]))
})

describe('terminal routes', () => {
  it('returns 401 without identity', async () => {
    const res = await app.request(`/api/terminal/sessions?sandboxId=${sandboxId}`)
    expect(res.status).toBe(401)
  })

  it('returns 401 for deleting a session without identity before revealing existence', async () => {
    const res = await app.request('/api/terminal/sessions/missing-session', { method: 'DELETE' })
    expect(res.status).toBe(401)
  })

  it('denies unresolved sessions for authenticated callers', async () => {
    const res = await app.request('/api/terminal/sessions/missing-session', {
      method: 'DELETE',
      headers: authHeaders(admin.token),
    })
    expect(res.status).toBe(403)
  })

  it('denies users without terminal access', async () => {
    const user = await createTestUser({ prefix: rbacPrefix })
    const res = await app.request(`/api/terminal/sessions?sandboxId=${sandboxId}`, {
      headers: authHeaders(user.token),
    })
    expect(res.status).toBe(403)
  })

  it('denies terminal access outside the assigned squad scope', async () => {
    const user = await createTestUser({ prefix: rbacPrefix })
    const role = await createTestRole({ prefix: rbacPrefix, permissions: ['terminal:access'] })
    await assignRole({ userId: user.id, roleId: role.id, scope: 'squad', squadId: otherSquadId })

    const res = await app.request(`/api/terminal/sessions?sandboxId=${sandboxId}`, {
      headers: authHeaders(user.token),
    })
    expect(res.status).toBe(403)
  })

  it('allows admins to list sessions for a squad sandbox', async () => {
    const res = await app.request(`/api/terminal/sessions?sandboxId=${sandboxId}`, {
      headers: authHeaders(admin.token),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })
})

describe('terminal routes for an agent’s own box', () => {
  async function agentIn(squad: string) {
    const [row] = await db.insert(agents).values({ agentTypeId: 'engineer', squadId: squad }).returning()
    return row!
  }
  async function userWith(permissions: string[], squad = squadId) {
    const user = await createTestUser({ prefix: rbacPrefix })
    const role = await createTestRole({ prefix: rbacPrefix, permissions })
    await assignRole({ userId: user.id, roleId: role.id, scope: 'squad', squadId: squad })
    return user
  }
  const list = (sandbox: string, token: string) =>
    app.request(`/api/terminal/sessions?sandboxId=${sandbox}`, { headers: authHeaders(token) })

  it('needs private-area access and terminal access in the agent’s squad', async () => {
    const agent = await agentIn(squadId)
    const sandbox = `agent_${agent.id}`
    expect((await list(sandbox, admin.token)).status).toBe(200)
    expect((await list(sandbox, (await userWith(['agents:private-access', 'terminal:access'])).token)).status).toBe(200)
    expect((await list(sandbox, (await userWith(['terminal:access'])).token)).status).toBe(403)
    expect((await list(sandbox, (await userWith(['agents:private-access'])).token)).status).toBe(403)
    expect(
      (await list(sandbox, (await userWith(['agents:private-access', 'terminal:access'], otherSquadId)).token)).status
    ).toBe(403)
  })

  it('refuses agent identities, unknown agents and malformed agent sandbox ids', async () => {
    const agent = await agentIn(squadId)
    const token = await createTestAgentToken({ agentId: agent.id, squadId })
    expect((await list(`agent_${agent.id}`, token.token)).status).toBe(403)
    expect((await list(`agent_${crypto.randomUUID()}`, admin.token)).status).toBe(403)
    expect((await list('agent_not-a-uuid', admin.token)).status).toBe(403)
    expect((await list(`agent_${agent.id}/../squad_${squadId}`, admin.token)).status).toBe(403)
  })
})
