import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { eq, inArray, like } from 'drizzle-orm'
import { Permissions } from '@ficus/shared'
import { db } from '../../db'
import { agents, agentTokens, agentTypes, monitors, roles, squads } from '../../db/schema'
import { Agent } from '../../entities/Agent'
import { AgentType } from '../../entities/AgentType'
import { Monitor } from '../../entities/Monitor'
import { identityMiddleware } from '../../middleware/identity'
import { hasAnySlotCleanupPermission, hasPermission, resolveActingUser, resolvePermissions } from '../rbac'
import { isMonitorTokenRequestAllowed, isReadPermission, narrowToMonitorPermissions } from './monitor-tokens'
import { resolveTokenContext } from './resolve-token'
import { cleanupTestRbac, createTestRole, createTestUser } from '../../test-utils/rbac'

describe('narrowToMonitorPermissions', () => {
  test('keeps only read permissions and integration use', () => {
    expect(
      narrowToMonitorPermissions([
        'workstreams:read',
        'workstreams:respond',
        'inbox:read-squad',
        'inbox:write',
        'agents:scopes:read',
        'agents:scopes:manage',
        'integrations:use',
        'integrations:write',
        'slots:use',
      ]).sort()
    ).toEqual(['agents:scopes:read', 'inbox:read-squad', 'integrations:use', 'workstreams:read'])
  })

  test('expands wildcards to the read permissions they cover, never keeping the wildcard', () => {
    const fromStar = narrowToMonitorPermissions(['*'])
    expect(fromStar).not.toContain('*')
    expect(fromStar).toContain(Permissions.WORKSTREAMS_READ)
    expect(fromStar).toContain(Permissions.INTEGRATIONS_USE)
    expect(fromStar.every((permission) => isReadPermission(permission) || permission === 'integrations:use')).toBe(true)
    const fromResource = narrowToMonitorPermissions(['workstreams:*'])
    expect(fromResource).toEqual(['workstreams:read'])
  })

  test('read permissions are recognized by their action only', () => {
    expect(isReadPermission('squads:read')).toBe(true)
    expect(isReadPermission('inbox:read-squad')).toBe(true)
    expect(isReadPermission('read')).toBe(false)
    expect(isReadPermission('readers:write')).toBe(false)
    expect(isReadPermission('memory:write')).toBe(false)
  })
})

describe('isMonitorTokenRequestAllowed', () => {
  test('allows reads and the integration credential exchange only', () => {
    expect(isMonitorTokenRequestAllowed('GET', '/api/work-streams/1')).toBe(true)
    expect(isMonitorTokenRequestAllowed('head', '/api/anything')).toBe(true)
    expect(isMonitorTokenRequestAllowed('POST', '/api/squads/abc/integrations/github/execute-environment')).toBe(true)
    expect(isMonitorTokenRequestAllowed('POST', '/api/squads/abc/integrations/github/sign')).toBe(false)
    expect(isMonitorTokenRequestAllowed('POST', '/api/inbox/send')).toBe(false)
    expect(isMonitorTokenRequestAllowed('POST', '/api/auth/ws-ticket')).toBe(false)
    expect(isMonitorTokenRequestAllowed('PUT', '/api/squads/abc/integrations/github/execute-environment')).toBe(false)
    expect(isMonitorTokenRequestAllowed('DELETE', '/api/monitors/x')).toBe(false)
    expect(isMonitorTokenRequestAllowed('POST', '/api/squads/a/b/integrations/github/execute-environment')).toBe(false)
  })
})

const PREFIX = 'monitor-token-test'

async function cleanup() {
  const rows = await db
    .select({ id: agents.id })
    .from(agents)
    .where(like(agents.agentTypeId, `${PREFIX}%`))
  const ids = rows.map((row) => row.id)
  if (ids.length) {
    await db.delete(agentTokens).where(inArray(agentTokens.agentId, ids))
    await db.delete(monitors).where(inArray(monitors.agentId, ids))
  }
  await db.delete(agents).where(like(agents.agentTypeId, `${PREFIX}%`))
  await db.delete(agentTypes).where(like(agentTypes.id, `${PREFIX}%`))
  await db.delete(squads).where(like(squads.name, `${PREFIX}%`))
  await db.delete(roles).where(eq(roles.slug, 'default-worker'))
  await cleanupTestRbac(PREFIX)
}

async function fixture() {
  const suffix = crypto.randomUUID().slice(0, 8)
  const [squad] = await db
    .insert(squads)
    .values({ name: `${PREFIX}-squad-${suffix}`, purpose: 'Monitor token test squad' })
    .returning()
  const agentTypeId = `${PREFIX}-type-${suffix}`
  await AgentType.create({ id: agentTypeId, model: 'anthropic:claude-sonnet-4-5', name: 'Monitor', systemPrompt: 'T' })
  const agent = await Agent.create({ agentTypeId, squadId: squad.id })
  const monitor = await Monitor.create({
    agentId: agent.id,
    sandboxId: `squad_${squad.id}`,
    label: 'watch',
    command: 'true',
    processId: 'p',
    timeoutMs: 60_000,
    maxBatchLines: 20,
    maxBatchBytes: 4096,
    batchDebounceMs: 750,
    logOffset: 0,
  })
  const expiresAt = new Date(Date.now() + 60_000)
  const token = await agent.createMonitorToken({ id: monitor.id, expiresAt })
  if (!token) throw new Error('expected a monitor token')
  return { agent, squad, monitor, token }
}

beforeEach(cleanup)
afterEach(cleanup)

describe('monitor tokens', () => {
  test('resolve to a read-only agent identity only where monitor tokens are allowed', async () => {
    const { agent, squad, monitor, token } = await fixture()
    // The default, which WebSockets, terminals, log streams and every other caller use, refuses them.
    expect(await resolveTokenContext(token)).toBeNull()
    expect(await resolveTokenContext(token, { allowMonitorTokens: true })).toEqual({
      identity: { type: 'agent', agentId: agent.id, squadId: squad.id, monitorId: monitor.id },
      deviceTokenId: null,
    })
  })

  test('hold the agent read permissions and integration use, never its writes', async () => {
    await createTestRole({
      prefix: PREFIX,
      slug: 'default-worker',
      permissions: ['workstreams:read', 'workstreams:respond', 'inbox:write', 'integrations:use', 'slots:use'],
    })
    const { token, squad } = await fixture()
    const identity = (await resolveTokenContext(token, { allowMonitorTokens: true }))!.identity
    const held = await resolvePermissions(identity, squad.id)
    expect(held).toContain('workstreams:read')
    expect(held).toContain('integrations:use')
    expect(held).not.toContain('inbox:write')
    expect(held).not.toContain('slots:use')
    expect(await hasPermission(identity, 'integrations:use', squad.id)).toBe(true)
    expect(await hasPermission(identity, 'workstreams:respond', squad.id)).toBe(false)
    expect(await hasAnySlotCleanupPermission(identity, ['slots:use'], squad.id)).toBe(false)
  })

  test('never act as the owning user, which would restore the full read authority', async () => {
    const owner = await createTestUser({ prefix: PREFIX })
    const assistant = await Agent.create({ agentTypeId: 'system-manager', ownerUserId: owner.id, context: {} })
    try {
      const identity = { type: 'agent' as const, agentId: assistant.id, squadId: null }
      // The assistant's own token acts as its owner; its monitor's token does not.
      expect(await resolveActingUser(identity)).toEqual({ type: 'user', userId: owner.id })
      expect(await resolveActingUser({ ...identity, monitorId: crypto.randomUUID() })).toBeNull()
    } finally {
      await db.delete(agents).where(eq(agents.id, assistant.id))
    }
  })

  test('stop authenticating when the monitor ends, and are revoked', async () => {
    const { monitor, token } = await fixture()
    await monitor.markEnded('exited', 0)
    expect(await resolveTokenContext(token, { allowMonitorTokens: true })).toBeNull()
    const rows = await db.select().from(agentTokens).where(eq(agentTokens.monitorId, monitor.id))
    expect(rows).toHaveLength(1)
    expect(rows[0].revokedAt).not.toBeNull()
  })

  test('stop authenticating once expired, even while the monitor is still active', async () => {
    const { monitor, token } = await fixture()
    await db
      .update(agentTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(agentTokens.monitorId, monitor.id))
    expect(await resolveTokenContext(token, { allowMonitorTokens: true })).toBeNull()
  })

  test('an expired ordinary agent token is rejected too', async () => {
    const { agent } = await fixture()
    const { token } = await agent.createAgentToken()
    expect(await resolveTokenContext(token)).not.toBeNull()
    await db
      .update(agentTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(agentTokens.agentId, agent.id))
    expect(await resolveTokenContext(token)).toBeNull()
  })

  test('over HTTP may read and exchange integration credentials, and nothing else', async () => {
    const { token } = await fixture()
    const app = new Hono()
    app.use('*', identityMiddleware)
    app.all('*', (c) => c.json({ reached: true }))
    const call = (method: string, path: string) =>
      app.request(path, { method, headers: { Authorization: `Bearer ${token}` } })
    expect((await call('GET', '/api/work-streams/x')).status).toBe(200)
    expect((await call('POST', '/api/squads/s/integrations/github/execute-environment')).status).toBe(200)
    const refused = await call('POST', '/api/inbox/send')
    expect(refused.status).toBe(403)
    expect(await refused.json()).toEqual({ error: 'Background monitor credentials are read-only' })
    expect((await call('PATCH', '/api/work-streams/x')).status).toBe(403)
    expect((await call('DELETE', '/api/monitors/x')).status).toBe(403)
  })
})
