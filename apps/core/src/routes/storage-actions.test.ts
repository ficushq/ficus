import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { randomUUID } from 'crypto'
import { eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import { db, agents, squads } from '../db'
import { Agent } from '../entities/Agent'
import { Squad } from '../entities/Squad'
import { identityMiddleware } from '../middleware'
import { makeDormant } from '../services/agent/lifecycle'
import { storageMonitorService } from '../services/storage/monitor'
import { assignRole, authHeaders, cleanupTestRbac, createTestRole, createTestUser } from '../test-utils'
import { squadsRouter } from './squads'
import systemRouter from './system'

const app = new Hono()
app.use('*', identityMiddleware)
app.route('/api/system', systemRouter)
app.route('/api/squads', squadsRouter)

const DAY = 24 * 60 * 60 * 1000
const json = (token: string, method: string, body?: unknown) => ({
  method,
  headers: { ...authHeaders(token), 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})

describe('storage cleanup routes', () => {
  let prefix: string
  let own: Squad
  let other: Squad
  let agentIds: string[]

  beforeEach(async () => {
    prefix = `storage-actions-${randomUUID()}`
    agentIds = []
    own = await Squad.create({ name: `${prefix}-own`, purpose: 'storage fixture' })
    other = await Squad.create({ name: `${prefix}-other`, purpose: 'storage fixture' })
  })

  afterEach(async () => {
    // Own every fixture: never sweep another test's agents, squads or roles.
    if (agentIds.length) await db.delete(agents).where(inArray(agents.id, agentIds))
    await db.delete(squads).where(inArray(squads.id, [own.id, other.id]))
    await cleanupTestRbac(prefix)
  })

  async function user(permissions: string[], scope: { squadId?: string } = {}) {
    const created = await createTestUser({ prefix })
    const role = await createTestRole({ prefix, permissions })
    await assignRole({
      userId: created.id,
      roleId: role.id,
      ...(scope.squadId ? { scope: 'squad', squadId: scope.squadId } : { scope: 'system' }),
    })
    return created.token
  }

  async function agent(squad: Squad, agentTypeId = 'consultant', lastMessageDaysAgo: number | null = 120) {
    const created = await Agent.create({ agentTypeId, squadId: squad.id, persist: false })
    agentIds.push(created.id)
    await db
      .update(agents)
      .set({
        createdAt: new Date(Date.now() - 400 * DAY),
        lastMessageAt: lastMessageDaysAgo === null ? null : new Date(Date.now() - lastMessageDaysAgo * DAY),
      })
      .where(eq(agents.id, created.id))
    return created
  }

  async function status(id: string) {
    return (await Agent.mustFind(id, { eager: false })).status
  }

  it('serves stored-file totals to system log readers only', async () => {
    const reader = await user(['system:logs'])
    const nobody = await user(['squads:read'])
    expect((await app.request('/api/system/storage/files')).status).toBe(401)
    expect((await app.request('/api/system/storage/files', { headers: authHeaders(nobody) })).status).toBe(403)
    const response = await app.request('/api/system/storage/files', { headers: authHeaders(reader) })
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toMatchObject({ sources: expect.any(Array), quotaBytes: expect.any(Number) })
  })

  it('queues only dormant agents for background removal, and only for system:cleanup', async () => {
    const dormant = await agent(own)
    await makeDormant(dormant)
    const live = await agent(own)
    const reader = await user(['system:logs', 'agents:terminate'])
    const cleaner = await user(['system:cleanup'])

    const body = { agentIds: [dormant.id, live.id] }
    expect((await app.request('/api/system/storage/dormant-agents/remove', json(reader, 'POST', body))).status).toBe(
      403
    )
    expect(
      (await app.request('/api/system/storage/dormant-agents/remove', json(cleaner, 'POST', { agentIds: ['x'] })))
        .status
    ).toBe(400)
    const tooMany = Array.from({ length: 501 }, () => randomUUID())
    expect(
      (await app.request('/api/system/storage/dormant-agents/remove', json(cleaner, 'POST', { agentIds: tooMany })))
        .status
    ).toBe(400)

    const response = await app.request('/api/system/storage/dormant-agents/remove', json(cleaner, 'POST', body))
    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({
      accepted: [dormant.id],
      skipped: [{ id: live.id, reason: 'Only dormant agents can be removed now.' }],
    })
    // Nothing slow ran in the request: the agent is still dormant until the sweep reclaims it.
    expect(await status(dormant.id)).toBe('dormant')
    expect(await status(live.id)).toBe('idle')
  })

  it('previews and applies idle-consultant dormancy against the server-computed set', async () => {
    const idle = await agent(own)
    const neverMessaged = await agent(own, 'consultant', null)
    const recent = await agent(own, 'consultant', 3)
    const manager = await agent(own, 'manager')
    const foreign = await agent(other)
    const token = await user(['agents:terminate'], { squadId: own.id })
    const read = spyOn(storageMonitorService, 'read').mockResolvedValue({
      supported: true,
      scanning: false,
      scannedAt: new Date().toISOString(),
      error: null,
      machines: [
        {
          id: 'm',
          name: 'Worker',
          status: 'available',
          usedBytes: 1,
          totalBytes: 2,
          unattributedBytes: 0,
          squads: [
            {
              id: own.id,
              name: own.name,
              bytes: 4096,
              status: 'available',
              folders: [
                {
                  name: 'idle',
                  path: '/home/box_a',
                  bytes: 4096,
                  status: 'available',
                  children: [],
                  kind: 'agent',
                  agent: {
                    id: idle.id,
                    label: 'idle',
                    agentTypeId: 'consultant',
                    status: 'idle',
                    lastMessageAt: null,
                    dormantAt: null,
                    createdAt: null,
                  },
                },
              ],
            },
          ],
        },
      ],
    })
    try {
      const preview = await app.request(`/api/squads/${own.id}/idle-consultants?days=90`, {
        headers: authHeaders(token),
      })
      expect(preview.status).toBe(200)
      const body = (await preview.json()) as { days: number; agents: Array<{ id: string; bytes: number | null }> }
      expect(body.days).toBe(90)
      expect(body.agents.map((item) => item.id).sort()).toEqual([idle.id, neverMessaged.id].sort())
      expect(body.agents.find((item) => item.id === idle.id)?.bytes).toBe(4096)
      expect(body.agents.find((item) => item.id === neverMessaged.id)?.bytes).toBeNull()
      expect(read).toHaveBeenCalled()
    } finally {
      read.mockRestore()
    }

    expect(
      (await app.request(`/api/squads/${own.id}/idle-consultants?days=0`, { headers: authHeaders(token) })).status
    ).toBe(400)

    // The ids previewed are required; a blanket apply is refused.
    const tooManyIds = Array.from({ length: 101 }, () => randomUUID())
    for (const body of [{ days: 90 }, { days: 90, agentIds: [] }, { days: 90, agentIds: tooManyIds }])
      expect(
        (await app.request(`/api/squads/${own.id}/idle-consultants/dormant`, json(token, 'POST', body))).status
      ).toBe(400)

    // The client sends what it previewed plus ids that are not idle consultants; only the intersection is applied.
    const response = await app.request(
      `/api/squads/${own.id}/idle-consultants/dormant`,
      json(token, 'POST', { days: 90, agentIds: [idle.id, recent.id, manager.id, foreign.id] })
    )
    expect(response.status).toBe(200)
    const result = (await response.json()) as { dormant: string[]; skipped: Array<{ id: string }> }
    expect(result.dormant).toEqual([idle.id])
    expect(result.skipped.map((item) => item.id).sort()).toEqual([recent.id, manager.id, foreign.id].sort())
    expect(await status(idle.id)).toBe('dormant')
    expect(await status(neverMessaged.id)).toBe('idle')
    expect(await status(recent.id)).toBe('idle')
    expect(await status(manager.id)).toBe('idle')
    expect(await status(foreign.id)).toBe('idle')
  })

  it('refuses idle-consultant previews and changes without agents:terminate on that squad', async () => {
    const idle = await agent(other)
    const ownOnly = await user(['agents:terminate'], { squadId: own.id })
    const reader = await user(['squads:read'], { squadId: other.id })
    for (const token of [ownOnly, reader]) {
      expect(
        (await app.request(`/api/squads/${other.id}/idle-consultants?days=90`, { headers: authHeaders(token) })).status
      ).toBe(403)
      expect(
        (
          await app.request(
            `/api/squads/${other.id}/idle-consultants/dormant`,
            json(token, 'POST', { days: 90, agentIds: [idle.id] })
          )
        ).status
      ).toBe(403)
    }
    expect((await app.request(`/api/squads/${other.id}/idle-consultants?days=90`)).status).toBe(401)
    expect(await status(idle.id)).toBe('idle')
  })

  it('validates the squad idle-consultant dormancy setting on PATCH', async () => {
    const token = await user(['squads:update'], { squadId: own.id })
    const patch = (value: unknown) =>
      app.request(`/api/squads/${own.id}`, json(token, 'PATCH', { consultantIdleDormancyDays: value }))
    // Every squad starts on at the default.
    expect((await Squad.find(own.id))?.consultantIdleDormancyDays).toBe(30)
    for (const value of [0, -1, 1.5, 3651, '90']) expect((await patch(value)).status).toBe(400)
    const on = await patch(90)
    expect(on.status).toBe(200)
    expect(((await on.json()) as { consultantIdleDormancyDays: number }).consultantIdleDormancyDays).toBe(90)
    expect((await Squad.find(own.id))?.consultantIdleDormancyDays).toBe(90)
    // Turning it off persists as an explicit null; an unrelated update does not restore the default.
    const off = await patch(null)
    expect(off.status).toBe(200)
    expect((await Squad.find(own.id))?.consultantIdleDormancyDays).toBeNull()
    expect((await app.request(`/api/squads/${own.id}`, json(token, 'PATCH', { purpose: 'still off' }))).status).toBe(
      200
    )
    expect((await Squad.find(own.id))?.consultantIdleDormancyDays).toBeNull()
  })
})
