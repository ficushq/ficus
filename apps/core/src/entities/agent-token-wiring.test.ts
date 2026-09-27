import { describe, it, expect, afterEach } from 'bun:test'
import { inArray } from 'drizzle-orm'
import { db, squads, agents, roles } from '../db'
import { Agent } from './Agent'
import { resolveToken } from '../services/auth/resolve-token'
import { hasPermission } from '../services/rbac'
import { createTestUser, createTestRole, assignRole, cleanupTestRbac } from '../test-utils'

// Verifies the per-agent token wiring: an agent gets a scoped tau_agent_* token
// (injected into its sandbox as FICUS_TOKEN) that resolves to its squad-scoped
// identity, and the default roles grant the CLI-driven permissions agents need.

const PREFIX = 'agent-token-wiring'
const squadIds: string[] = []
const agentIds: string[] = []

async function makeSquad(name: string): Promise<string> {
  const [s] = await db.insert(squads).values({ name, purpose: 't' }).returning()
  squadIds.push(s.id)
  return s.id
}

async function makeAgent(squadId: string, agentTypeId: string): Promise<Agent> {
  const [row] = await db.insert(agents).values({ agentTypeId, squadId }).returning()
  agentIds.push(row.id)
  return Agent.mustFind(row.id)
}

async function seedRole(slug: string, name: string, permissions: string[]): Promise<void> {
  await db
    .insert(roles)
    .values({ name, slug, isSystem: true, permissions })
    .onConflictDoUpdate({ target: roles.slug, set: { permissions } })
}

afterEach(async () => {
  if (agentIds.length) await db.delete(agents).where(inArray(agents.id, agentIds))
  if (squadIds.length) await db.delete(squads).where(inArray(squads.id, squadIds))
  await db.delete(roles).where(inArray(roles.slug, ['default-worker', 'default-manager']))
  await cleanupTestRbac(PREFIX)
  agentIds.length = 0
  squadIds.length = 0
})

describe('per-agent token wiring', () => {
  it('mints a scoped token, reuses the cached one, and resolves to the agent identity', async () => {
    const squadId = await makeSquad('agent-token-wiring A')
    const agent = await makeAgent(squadId, 'engineer')

    const token = await agent.getOrCreateToken()
    expect(token).toBeDefined()
    expect(token).toMatch(/^tau_agent_/)

    // resolves (as the sandbox CLI's Bearer would) to the scoped agent identity
    expect(await resolveToken(token!)).toMatchObject({ type: 'agent', agentId: agent.id, squadId })

    // a second call reuses the cached plaintext (single stable token per run)
    expect(await agent.getOrCreateToken()).toBe(token)
  })

  it('scopes a worker token to its own squad for CLI-driven permissions', async () => {
    await seedRole('default-worker', 'Squad Worker', ['memory:read', 'memory:write', 'workspace:read', 'agents:read'])
    const ownSquad = await makeSquad('agent-token-wiring own')
    const otherSquad = await makeSquad('agent-token-wiring other')
    const agent = await makeAgent(ownSquad, 'engineer')
    const identity = await resolveToken((await agent.getOrCreateToken())!)
    expect(identity).not.toBeNull()

    // workspace:read is now granted (ficus squad workspace/file) — own squad only
    expect(await hasPermission(identity!, 'workspace:read', ownSquad)).toBe(true)
    expect(await hasPermission(identity!, 'memory:write', ownSquad)).toBe(true)
    // cross-squad is denied (ROOT squad gate)
    expect(await hasPermission(identity!, 'workspace:read', otherSquad)).toBe(false)
    expect(await hasPermission(identity!, 'memory:write', otherSquad)).toBe(false)
  })

  it('grants a manager token agents:terminate + env:write, but NOT agents:delete', async () => {
    await seedRole('default-manager', 'Squad Manager', [
      'agents:read',
      'agents:terminate',
      'env:read',
      'env:write',
      'workspace:read',
    ])
    const squadId = await makeSquad('agent-token-wiring mgr')
    const manager = await makeAgent(squadId, 'manager')
    const identity = await resolveToken((await manager.getOrCreateToken())!)
    expect(identity).not.toBeNull()

    // can unspawn (ficus squad unspawn) + manage squad env (expose-secrets)...
    expect(await hasPermission(identity!, 'agents:terminate', squadId)).toBe(true)
    expect(await hasPermission(identity!, 'env:write', squadId)).toBe(true)
    expect(await hasPermission(identity!, 'workspace:read', squadId)).toBe(true)
    // ...but cannot HARD-DELETE agent records (admin/system only).
    expect(await hasPermission(identity!, 'agents:delete', squadId)).toBe(false)
  })

  it('scopes a consultant token to its single squad via the default-manager role', async () => {
    await seedRole('default-manager', 'Default Manager', [
      'chat:send',
      'inbox:read',
      'inbox:write',
      'memory:read',
      'squads:read',
      'agents:read',
      'agents:create',
      'workspace:read',
      'routing:read',
      'workstreams:read',
      'workstreams:create',
      'workstreams:update',
      'workstreams:respond',
      'workstreams:manage-agents',
    ])
    const ownSquad = await makeSquad('agent-token-wiring consultant own')
    const otherSquad = await makeSquad('agent-token-wiring consultant other')
    const consultant = await makeAgent(ownSquad, 'consultant')
    const identity = await resolveToken((await consultant.getOrCreateToken())!)
    expect(identity).not.toBeNull()
    // resolves the default-manager role via the agent's own squadId (no channelId
    // on the token); includes chat access + manager-like work-stream ownership.
    expect(await hasPermission(identity!, 'chat:send', ownSquad)).toBe(true)
    expect(await hasPermission(identity!, 'workstreams:create', ownSquad)).toBe(true)
    // cross-squad is denied (ROOT squad gate)
    expect(await hasPermission(identity!, 'chat:send', otherSquad)).toBe(false)
    expect(await hasPermission(identity!, 'workstreams:create', otherSquad)).toBe(false)
  })

  it('mints a squad-less system-manager token that inherits the owning user permissions', async () => {
    const user = await createTestUser({ prefix: PREFIX })
    const role = await createTestRole({ prefix: PREFIX, permissions: ['squads:read', 'agents:create'] })
    await assignRole({ userId: user.id, roleId: role.id, scope: 'system' })

    const [row] = await db
      .insert(agents)
      .values({ agentTypeId: 'system-manager', squadId: null, ownerUserId: user.id })
      .returning()
    agentIds.push(row.id)
    const sm = await Agent.mustFind(row.id)

    const token = await sm.getOrCreateToken()
    expect(token).toMatch(/^tau_agent_/)
    const identity = await resolveToken(token!)
    expect(identity).toMatchObject({ type: 'agent', agentId: row.id, userId: user.id })
    // inherits the owning user's system-scoped permissions (not a squad-agent role)
    expect(await hasPermission(identity!, 'squads:read')).toBe(true)
    expect(await hasPermission(identity!, 'secrets:write')).toBe(false)
  })

  it('returns no token for an agent without a squad or owner', async () => {
    const [row] = await db.insert(agents).values({ agentTypeId: 'engineer', squadId: null }).returning()
    agentIds.push(row.id)
    const agent = await Agent.mustFind(row.id)
    expect(await agent.getOrCreateToken()).toBeUndefined()
  })
})
