import { createBlankWorkflow, type WorkflowSource } from '@ficus/shared'
import { AgentType } from '../entities/AgentType'
import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test'
import { Hono } from 'hono'
import { schedulesRouter } from './schedules'
import { randomUUID } from 'crypto'
import { Schedule } from '../entities/Schedule'
import { InboxMessage } from '../entities/InboxMessage'
import { identityMiddleware } from '../middleware/identity'
import { authHeaders, cleanupTestRbac, createTestAdmin, createTestAgentToken, type TestUser } from '../test-utils'
import { db, agents, schedules, squads, roles, systemTokens } from '../db'
import { createSystemToken } from '../services/auth/system-tokens'
import { eq, inArray } from 'drizzle-orm'

const app = new Hono()
app.use('*', identityMiddleware)
app.route('/api/schedules', schedulesRouter)

const rbacPrefix = `schedules-kind-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
let admin: TestUser

beforeAll(async () => {
  admin = await createTestAdmin({ prefix: rbacPrefix, canonicalAdmin: true })
})

afterAll(async () => {
  await cleanupTestRbac(rbacPrefix)
})

async function createLiveAgentScope(prefix: string) {
  const [squad] = await db
    .insert(squads)
    .values({ name: `${prefix}-${randomUUID()}`, purpose: 'test' })
    .returning()
  const [agent] = await db.insert(agents).values({ agentTypeId: 'engineer', squadId: squad.id }).returning()
  return { squad, agent }
}

describe('schedules agent-scope cross-squad authorization', () => {
  it('POST /api/schedules agent-scope → 403 when the target agent is in another squad', async () => {
    const prefix = `${rbacPrefix}-xsquad`
    await db
      .insert(roles)
      .values({
        name: 'Default Worker',
        slug: 'default-worker',
        isSystem: true,
        permissions: [
          'schedules:create',
          'schedules:read',
          'schedules:update',
          'schedules:delete',
          'schedules:trigger',
        ],
      })
      .onConflictDoUpdate({
        target: roles.slug,
        set: {
          permissions: [
            'schedules:create',
            'schedules:read',
            'schedules:update',
            'schedules:delete',
            'schedules:trigger',
          ],
        },
      })

    const [squadA] = await db
      .insert(squads)
      .values({ name: `${prefix} A`, purpose: 't' })
      .returning()
    const [squadB] = await db
      .insert(squads)
      .values({ name: `${prefix} B`, purpose: 't' })
      .returning()
    const [workerA] = await db.insert(agents).values({ agentTypeId: 'engineer', squadId: squadA.id }).returning()
    const [targetB] = await db.insert(agents).values({ agentTypeId: 'engineer', squadId: squadB.id }).returning()
    const tok = await createTestAgentToken({ agentId: workerA.id, squadId: squadA.id })

    try {
      const res = await app.request('/api/schedules', {
        method: 'POST',
        headers: { ...authHeaders(tok.token), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scopeType: 'agent',
          scopeId: targetB.id,
          name: 'x',
          schedule: { interval: '1h' },
          action: { type: 'inbox_message', target: { type: 'agent', agentId: targetB.id }, content: 'hi' },
        }),
      })
      // Worker bound to squad A must not manage a schedule targeting squad B's agent.
      // Pre-fix this passed via an unscoped schedules:create check.
      expect(res.status).toBe(403)
    } finally {
      await db.delete(agents).where(inArray(agents.id, [workerA.id, targetB.id]))
      await db.delete(squads).where(inArray(squads.id, [squadA.id, squadB.id]))
      await db.delete(roles).where(eq(roles.slug, 'default-worker'))
    }
  })

  it('GET list exposes agent-scoped health to an identity with access to the owning squad', async () => {
    await db
      .insert(roles)
      .values({
        name: 'Default Worker',
        slug: 'default-worker',
        isSystem: true,
        permissions: ['schedules:read'],
      })
      .onConflictDoUpdate({ target: roles.slug, set: { permissions: ['schedules:read'] } })
    const { squad, agent: worker } = await createLiveAgentScope(`${rbacPrefix}-list-owner`)
    const [target] = await db.insert(agents).values({ agentTypeId: 'engineer', squadId: squad.id }).returning()
    const token = await createTestAgentToken({ agentId: worker.id, squadId: squad.id })
    const created = []
    for (const [name, scopedAgent] of [
      ['Agent health one', target],
      ['Agent health two', target],
      ['Worker health', worker],
    ] as const) {
      created.push(
        await Schedule.create({
          scopeType: 'agent',
          scopeId: scopedAgent.id,
          name,
          schedule: { interval: '1h' },
          action: { type: 'inbox_message', target: { type: 'agent', agentId: scopedAgent.id }, content: 'x' },
        })
      )
    }
    try {
      const response = await app.request('/api/schedules?scopeType=agent', { headers: authHeaders(token.token) })
      expect(response.status).toBe(200)
      const ids = (await response.json()).map((row: { id: string }) => row.id)
      expect(created.every((schedule) => ids.includes(schedule.id))).toBe(true)
    } finally {
      await db.delete(schedules).where(
        inArray(
          schedules.id,
          created.map((schedule) => schedule.id)
        )
      )
      await db.delete(squads).where(eq(squads.id, squad.id))
      await db.delete(roles).where(eq(roles.slug, 'default-worker'))
    }
  })
})

describe('schedule list read authorization', () => {
  it('filters all schedules from an all-visible system identity without schedules:read', async () => {
    const { squad, agent } = await createLiveAgentScope(`${rbacPrefix}-system-no-read`)
    const schedule = await Schedule.create({
      scopeType: 'agent',
      scopeId: agent.id,
      name: 'Secret health',
      schedule: { interval: '1h' },
      action: { type: 'inbox_message', target: { type: 'agent', agentId: agent.id }, content: 'x' },
    })
    const { token, record } = await createSystemToken({ name: `${rbacPrefix}-no-read`, scopes: ['agents:read'] })
    try {
      const response = await app.request('/api/schedules', { headers: authHeaders(token) })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual([])
    } finally {
      await db.delete(systemTokens).where(eq(systemTokens.id, record.id))
      await db.delete(schedules).where(eq(schedules.id, schedule.id))
      await db.delete(squads).where(eq(squads.id, squad.id))
    }
  })

  it('filters schedules from a visible squad identity whose role lacks schedules:read', async () => {
    await db
      .insert(roles)
      .values({
        name: 'Default Worker',
        slug: 'default-worker',
        isSystem: true,
        permissions: ['agents:read'],
      })
      .onConflictDoUpdate({ target: roles.slug, set: { permissions: ['agents:read'] } })
    const { squad, agent: worker } = await createLiveAgentScope(`${rbacPrefix}-visible-no-read`)
    const [target] = await db.insert(agents).values({ agentTypeId: 'engineer', squadId: squad.id }).returning()
    const token = await createTestAgentToken({ agentId: worker.id, squadId: squad.id })
    const schedule = await Schedule.create({
      scopeType: 'agent',
      scopeId: target.id,
      name: 'Hidden health',
      schedule: { interval: '1h' },
      action: { type: 'inbox_message', target: { type: 'agent', agentId: target.id }, content: 'x' },
    })
    try {
      const response = await app.request('/api/schedules', { headers: authHeaders(token.token) })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual([])
    } finally {
      await db.delete(schedules).where(eq(schedules.id, schedule.id))
      await db.delete(squads).where(eq(squads.id, squad.id))
      await db.delete(roles).where(eq(roles.slug, 'default-worker'))
    }
  })
})

describe('schedule completion modes', () => {
  it('creates, updates, and returns a flow delivery policy', async () => {
    const [squad] = await db
      .insert(squads)
      .values({ name: `${rbacPrefix} completion`, purpose: 't' })
      .returning()

    const definition = createBlankWorkflow()
    definition.participants.worker!.agentTypeId = `${rbacPrefix}-worker`
    await AgentType.upsert({ id: `${rbacPrefix}-worker`, name: 'Worker', model: 'test:model', systemPrompt: 'test' })
    definition.completion.mode = 'review-approval'
    try {
      const create = await app.request('/api/schedules', {
        method: 'POST',
        headers: { ...authHeaders(admin.token), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scopeType: 'squad',
          scopeId: squad.id,
          name: 'Daily health',
          schedule: { interval: '1h' },
          action: { type: 'create_work_stream', title: 'Health check', workflow: { kind: 'inline', definition } },
        }),
      })
      expect(create.status).toBe(201)
      const created = (await create.json()) as { id: string; action: { workflow: WorkflowSource } }
      expect(created.action.workflow).toMatchObject({ definition: { completion: { mode: 'review-approval' } } })
      definition.completion.mode = 'direct-merge'

      const update = await app.request(`/api/schedules/${created.id}`, {
        method: 'PATCH',
        headers: { ...authHeaders(admin.token), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: { type: 'create_work_stream', title: 'Health check', workflow: { kind: 'inline', definition } },
        }),
      })
      expect(update.status).toBe(200)
      expect((await update.json()).action.workflow).toMatchObject({
        definition: { completion: { mode: 'direct-merge' } },
      })
    } finally {
      await db.delete(squads).where(eq(squads.id, squad.id))
    }
  })

  it('rejects an unsupported completion mode', async () => {
    const [squad] = await db
      .insert(squads)
      .values({ name: `${rbacPrefix} invalid`, purpose: 't' })
      .returning()
    try {
      const response = await app.request('/api/schedules', {
        method: 'POST',
        headers: { ...authHeaders(admin.token), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scopeType: 'squad',
          scopeId: squad.id,
          name: 'Daily health',
          schedule: { interval: '1h' },
          action: { type: 'create_work_stream', title: 'Health check', completionMode: 'bogus' },
        }),
      })
      expect(response.status).toBe(400)
    } finally {
      await db.delete(squads).where(eq(squads.id, squad.id))
    }
  })
})

describe('schedule reference validation routes', () => {
  it('rejects nonexistent and terminated action targets with controlled 400 responses', async () => {
    const { squad, agent } = await createLiveAgentScope(`${rbacPrefix}-references`)
    const request = async (agentId: string) =>
      app.request('/api/schedules', {
        method: 'POST',
        headers: { ...authHeaders(admin.token), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scopeType: 'agent',
          scopeId: agent.id,
          name: 'Reference validation',
          schedule: { interval: '1h' },
          action: { type: 'inbox_message', target: { type: 'agent', agentId }, content: 'hello' },
        }),
      })

    const missing = await request(randomUUID())
    expect(missing.status).toBe(400)
    expect(await missing.json()).toEqual({ error: 'Target agent does not exist.' })

    const [terminated] = await db
      .insert(agents)
      .values({ agentTypeId: 'engineer', squadId: squad.id, status: 'terminated', terminatedAt: new Date() })
      .returning()
    const dead = await request(terminated.id)
    expect(dead.status).toBe(400)
    expect(await dead.json()).toEqual({ error: 'Target agent is terminated.' })
  })
})

describe('schedule PATCH re-enable references', () => {
  it('atomically replaces the target while clearing breaker state', async () => {
    const { agent: oldTarget } = await createLiveAgentScope(`${rbacPrefix}-old-target`)
    const { agent: newTarget } = await createLiveAgentScope(`${rbacPrefix}-new-target`)
    const schedule = await Schedule.create({
      scopeType: 'agent',
      scopeId: oldTarget.id,
      name: 'Replace target',
      enabled: false,
      schedule: { interval: '1h' },
      action: { type: 'inbox_message', target: { type: 'agent', agentId: oldTarget.id }, content: 'old' },
    })
    await db
      .update(schedules)
      .set({
        automaticallyDisabledAt: new Date(),
        automaticDisableReason: 'Circuit breaker opened.',
        consecutiveFailureCount: 10,
      })
      .where(eq(schedules.id, schedule.id))
    const response = await app.request(`/api/schedules/${schedule.id}`, {
      method: 'PATCH',
      headers: { ...authHeaders(admin.token), 'content-type': 'application/json' },
      body: JSON.stringify({
        enabled: true,
        name: 'Replaced target',
        action: { type: 'inbox_message', target: { type: 'agent', agentId: newTarget.id }, content: 'new' },
      }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      name: 'Replaced target',
      enabled: true,
      consecutiveFailureCount: 0,
      automaticallyDisabledAt: null,
      action: { target: { agentId: newTarget.id } },
    })
  })
})

describe('schedule health route lifecycle', () => {
  it('returns a controlled 400 when enable races an active attempt', async () => {
    const { agent } = await createLiveAgentScope(`${rbacPrefix}-enable-race`)
    const schedule = await Schedule.create({
      scopeType: 'agent',
      scopeId: agent.id,
      name: 'Enable race',
      schedule: { interval: '1h' },
      action: { type: 'inbox_message', target: { type: 'agent', agentId: agent.id }, content: 'hello' },
    })
    await db
      .update(schedules)
      .set({
        activeAttemptId: randomUUID(),
        activeAttemptSource: 'manual',
        activeAttemptStartedAt: new Date(),
        activeAttemptLeaseUntil: new Date(Date.now() + 60_000),
      })
      .where(eq(schedules.id, schedule.id))
    const response = await app.request(`/api/schedules/${schedule.id}/enable`, {
      method: 'POST',
      headers: authHeaders(admin.token),
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Schedule has an active execution attempt.' })
  })

  it('exposes a fail, repair, enable, and recover lifecycle through the API', async () => {
    const { agent } = await createLiveAgentScope(`${rbacPrefix}-recover`)
    const schedule = await Schedule.create({
      scopeType: 'agent',
      scopeId: agent.id,
      name: 'Recover lifecycle',
      schedule: { interval: '1h' },
      action: { type: 'inbox_message', target: { type: 'agent', agentId: agent.id }, content: 'hello' },
    })
    const send = spyOn(InboxMessage, 'send').mockRejectedValue(new Error('temporary provider failure'))
    try {
      for (let failure = 1; failure <= 3; failure++) {
        const response = await app.request(`/api/schedules/${schedule.id}/trigger`, {
          method: 'POST',
          headers: authHeaders(admin.token),
        })
        expect(response.status).toBe(500)
      }
    } finally {
      send.mockRestore()
    }
    let detail = await app.request(`/api/schedules/${schedule.id}`, { headers: authHeaders(admin.token) })
    expect(await detail.json()).toMatchObject({ healthStatus: 'failing', failureCount: 3, consecutiveFailureCount: 3 })

    const enabled = await app.request(`/api/schedules/${schedule.id}/enable`, {
      method: 'POST',
      headers: authHeaders(admin.token),
    })
    expect(enabled.status).toBe(200)
    expect(await enabled.json()).toMatchObject({ consecutiveFailureCount: 0 })
    const recovered = await app.request(`/api/schedules/${schedule.id}/trigger`, {
      method: 'POST',
      headers: authHeaders(admin.token),
    })
    expect(recovered.status).toBe(200)
    detail = await app.request(`/api/schedules/${schedule.id}`, { headers: authHeaders(admin.token) })
    expect(await detail.json()).toMatchObject({
      healthStatus: 'healthy',
      failureCount: 3,
      consecutiveFailureCount: 0,
      lastErrorCode: 'action_failed',
    })
  })

  it('returns only a safe error while persisting the failed manual attempt', async () => {
    const { agent } = await createLiveAgentScope(`${rbacPrefix}-health`)
    const schedule = await Schedule.create({
      scopeType: 'agent',
      scopeId: agent.id,
      name: 'Safe failure',
      schedule: { interval: '1h' },
      action: { type: 'inbox_message', target: { type: 'agent', agentId: agent.id }, content: 'hello' },
    })
    const send = spyOn(InboxMessage, 'send').mockRejectedValueOnce(
      new Error('Bearer super-secret postgres://user:password@database/internal')
    )
    try {
      const response = await app.request(`/api/schedules/${schedule.id}/trigger`, {
        method: 'POST',
        headers: authHeaders(admin.token),
      })
      expect(response.status).toBe(500)
      expect(await response.json()).toEqual({ error: 'Scheduled action failed. Inspect Core logs for details.' })
    } finally {
      send.mockRestore()
    }
    const detail = await app.request(`/api/schedules/${schedule.id}`, { headers: authHeaders(admin.token) })
    const body = (await detail.json()) as { failureCount: number; lastErrorSummary: string }
    expect(body.failureCount).toBe(1)
    expect(JSON.stringify(body)).not.toContain('super-secret')
    expect(JSON.stringify(body)).not.toContain('password')
  })
})

describe('GET /api/schedules kind/excludeKind', () => {
  it('excludeKind hides schedules whose metadata.kind matches', async () => {
    const { agent } = await createLiveAgentScope(`${rbacPrefix}-exclude`)
    const scopeId = agent.id
    const normal = await Schedule.create({
      scopeType: 'agent',
      scopeId,
      name: 'Daily',
      schedule: { interval: '1h' },
      action: { type: 'inbox_message', target: { type: 'agent', agentId: scopeId }, content: 'hi' },
    })
    const watchdog = await Schedule.create({
      scopeType: 'agent',
      scopeId,
      name: 'Watchdog',
      schedule: { interval: '15m' },
      action: { type: 'inbox_message', target: { type: 'agent', agentId: scopeId }, content: 'check' },
      metadata: { kind: 'subagent-watchdog' },
    })

    const res = await app.request(`/api/schedules?scopeType=agent&scopeId=${scopeId}&excludeKind=subagent-watchdog`, {
      headers: authHeaders(admin.token),
    })
    expect(res.status).toBe(200)
    const ids = ((await res.json()) as Array<{ id: string }>).map((s) => s.id)
    expect(ids).toContain(normal.id)
    expect(ids).not.toContain(watchdog.id)
  })

  it('kind includes only schedules whose metadata.kind matches', async () => {
    const { agent } = await createLiveAgentScope(`${rbacPrefix}-kind`)
    const scopeId = agent.id
    await Schedule.create({
      scopeType: 'agent',
      scopeId,
      name: 'Daily',
      schedule: { interval: '1h' },
      action: { type: 'inbox_message', target: { type: 'agent', agentId: scopeId }, content: 'hi' },
    })
    await Schedule.create({
      scopeType: 'agent',
      scopeId,
      name: 'Watchdog',
      schedule: { interval: '15m' },
      action: { type: 'inbox_message', target: { type: 'agent', agentId: scopeId }, content: 'check' },
      metadata: { kind: 'subagent-watchdog' },
    })

    const res = await app.request(`/api/schedules?scopeType=agent&scopeId=${scopeId}&kind=subagent-watchdog`, {
      headers: authHeaders(admin.token),
    })
    expect(res.status).toBe(200)
    const kinds = ((await res.json()) as Array<{ metadata?: { kind?: string } }>).map((s) => s.metadata?.kind)
    expect(kinds).toHaveLength(1)
    expect(kinds.every((k) => k === 'subagent-watchdog')).toBe(true)
  })
})
