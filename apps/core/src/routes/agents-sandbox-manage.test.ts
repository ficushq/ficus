/**
 * GET /api/agents/:id/sandbox/status reports `canManage`: whether the caller
 * passes the guard on the agent box controls (stop, restart, processes and
 * containers), so clients offer those controls only to callers who may use
 * them. The guard is agents:update in the agent's squad, or ownership of a
 * private squad-less agent.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import { agents, db, squads } from '../db'
import { identityMiddleware } from '../middleware/identity'
import { agentsRouter } from './agents'
import {
  assignRole,
  authHeaders,
  cleanupTestRbac,
  createTestAdmin,
  createTestRole,
  createTestUser,
  type TestUser,
} from '../test-utils'

const prefix = `agent-sandbox-manage-${crypto.randomUUID()}`
const squadId = crypto.randomUUID()
const agentIds: string[] = []
let squadAgentId: string
let subagentId: string
let privateAgentId: string
let admin: TestUser
let reader: TestUser
let updater: TestUser
let owner: TestUser

const app = new Hono()
app.use('*', identityMiddleware)
app.route('/api/agents', agentsRouter)

async function insertAgent(values: Partial<typeof agents.$inferInsert>): Promise<string> {
  const [agent] = await db
    .insert(agents)
    .values({ agentTypeId: 'engineer', ...values })
    .returning()
  agentIds.push(agent!.id)
  return agent!.id
}

async function userWith(permissions: string[]): Promise<TestUser> {
  const role = await createTestRole({ prefix, permissions })
  const user = await createTestUser({ prefix })
  await assignRole({ userId: user.id, roleId: role.id, scope: 'squad', squadId })
  return user
}

beforeAll(async () => {
  await db.insert(squads).values({ id: squadId, name: `${prefix}-squad`, purpose: 'RBAC scope' })
  admin = await createTestAdmin({ prefix })
  reader = await userWith(['agents:read', 'agents:run'])
  updater = await userWith(['agents:read', 'agents:update'])
  owner = await createTestUser({ prefix })
  squadAgentId = await insertAgent({ squadId })
  subagentId = await insertAgent({ squadId, parentAgentId: squadAgentId })
  privateAgentId = await insertAgent({ ownerUserId: owner.id })
})

afterAll(async () => {
  await db.delete(agents).where(inArray(agents.id, agentIds.toReversed()))
  await cleanupTestRbac(prefix)
  await db.delete(squads).where(inArray(squads.id, [squadId]))
})

async function status(agentId: string, user: TestUser): Promise<{ controllable?: boolean; canManage?: boolean }> {
  const res = await app.request(`/api/agents/${agentId}/sandbox/status`, { headers: authHeaders(user.token) })
  expect(res.status).toBe(200)
  return res.json()
}

describe('agent sandbox status canManage', () => {
  it('is true for callers holding agents:update on the agent', async () => {
    expect(await status(squadAgentId, updater)).toMatchObject({ controllable: true, canManage: true })
    expect(await status(squadAgentId, admin)).toMatchObject({ controllable: true, canManage: true })
  })

  it('is false for callers who can read and run the agent but lack agents:update', async () => {
    expect(await status(squadAgentId, reader)).toMatchObject({ controllable: true, canManage: false })
    const stop = await app.request(`/api/agents/${squadAgentId}/sandbox/stop`, {
      method: 'POST',
      headers: authHeaders(reader.token),
    })
    expect(stop.status).toBe(403)
  })

  it('is true for the owner of a private agent without any role', async () => {
    expect(await status(privateAgentId, owner)).toMatchObject({ controllable: true, canManage: true })
  })

  it('is false for a box shared with a parent agent, whatever the caller holds', async () => {
    expect(await status(subagentId, admin)).toMatchObject({ controllable: false, canManage: false })
  })
})
