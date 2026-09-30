/**
 * Manual wait actors (human | owner): creation through the
 * request-input route, serialization, the migration default, the audited
 * relabel route and its authorization, and the Action Center filter. The
 * actor changes who is asked to act, never whether the stream is blocked.
 */
import { storedLegacyWorkStream } from '../test-utils/stored-legacy-work-stream'
import {
  selectWorkStreamPresentationState,
  workStreamNeedsHumanAttention,
  type CreateWorkStreamInput,
  type WorkStream as WorkStreamJson,
  type WorkStreamWait,
} from '@ficus/shared'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { workStreamsRouter } from './work-streams'
import { identityMiddleware } from '../middleware/identity'
import { db } from '../db'
import { agents, agentTypes, inbox, roles, squads, workStreams, workStreamWaits } from '../db/schema'
import { AgentType } from '../entities/AgentType'
import { Agent } from '../entities/Agent'
import { Squad } from '../entities/Squad'
import { openWait } from '../services/work-streams/waits'
import { listPendingActions } from '../services/agents/actions'
import { invalidatePermissionCache } from '../services/rbac/permissions'
import { createTestAdmin, authHeaders, cleanupTestRbac, type TestUser } from '../test-utils'

const app = new Hono()
app.use('*', identityMiddleware)
app.route('/api/workstreams', workStreamsRouter)

const prefix = `ws-wait-actor-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const agentTypeId = `${prefix}-agent-type`
let admin: TestUser
let squadId: string
let managerId: string
const seededRoles: string[] = []

type StreamBody = WorkStreamJson & { wait?: WorkStreamWait; changed?: boolean; waitHistory?: WorkStreamWait[] }

async function request(token: string, method: string, url: string, body?: unknown): Promise<Response> {
  return app.fetch(
    new Request(`http://localhost${url}`, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
    })
  )
}

const asAdmin = (method: string, url: string, body?: unknown) => request(admin.token, method, url, body)

async function stream(title: string, extra: Partial<CreateWorkStreamInput> = {}) {
  return storedLegacyWorkStream({ squadId, title: `${prefix} ${title}`, ...extra })
}

async function requestInput(id: string, body: Record<string, unknown>): Promise<StreamBody> {
  const res = await asAdmin('POST', `/api/workstreams/${id}/request-input`, body)
  expect(res.status).toBe(200)
  return (await res.json()) as StreamBody
}

async function detail(id: string): Promise<StreamBody> {
  const res = await asAdmin('GET', `/api/workstreams/${id}`)
  expect(res.status).toBe(200)
  return (await res.json()) as StreamBody
}

/** Agent roles resolve by slug; seed the ones this file needs only when absent. */
async function seedRole(slug: string, permissions: string[]) {
  const inserted = await db
    .insert(roles)
    .values({ slug, name: slug, permissions })
    .onConflictDoNothing()
    .returning({ slug: roles.slug })
  if (inserted.length) seededRoles.push(slug)
  invalidatePermissionCache()
}

beforeAll(async () => {
  admin = await createTestAdmin({ prefix })
})

afterAll(async () => {
  await cleanupTestRbac(prefix)
})

beforeEach(async () => {
  await AgentType.upsert({
    id: agentTypeId,
    model: 'anthropic:claude-sonnet-4-5',
    name: 'Wait actor',
    systemPrompt: 'x',
  })
  const squad = await Squad.create({ name: `${prefix} squad ${Math.random().toString(36).slice(2, 6)}`, purpose: 'x' })
  squadId = squad.id
  managerId = squad.managerAgentId!
})

afterEach(async () => {
  const streamIds = (
    await db.select({ id: workStreams.id }).from(workStreams).where(eq(workStreams.squadId, squadId))
  ).map((row) => row.id)
  for (const id of streamIds) await db.delete(inbox).where(sql`${inbox.metadata}->>'workStreamId' = ${id}`)
  await db.delete(workStreams).where(eq(workStreams.squadId, squadId))
  await db.delete(agents).where(eq(agents.agentTypeId, agentTypeId))
  await db.delete(agents).where(eq(agents.id, managerId))
  await db.delete(squads).where(eq(squads.id, squadId))
  await db.delete(agentTypes).where(eq(agentTypes.id, agentTypeId))
  if (seededRoles.length) await db.delete(roles).where(inArray(roles.slug, seededRoles.splice(0)))
  invalidatePermissionCache()
})

describe('request-input actor', () => {
  it('records the actor, defaults to human, and exposes it in wait JSON, detail and history', async () => {
    const ownerHold = await stream('owner hold')
    const humanHold = await stream('human hold')

    const created = await requestInput(ownerHold.id, { message: 'Hold for #353 review', actor: 'owner' })
    expect(created.wait).toMatchObject({ type: 'manual', actor: 'owner', message: 'Hold for #353 review' })
    expect(created.wait?.actorChanges).toBeUndefined()

    const legacy = await requestInput(humanHold.id, { message: 'Need the API key' })
    expect(legacy.wait?.actor).toBe('human')

    const body = await detail(ownerHold.id)
    expect(body.openWaits?.map((wait) => wait.actor)).toEqual(['owner'])
    expect(body.waitHistory?.map((wait) => wait.actor)).toEqual(['owner'])
  })

  it('rejects an unknown actor (including the pre-rename manager) without opening a wait', async () => {
    const ws = await stream('bad actor')
    for (const actor of ['robot', 'manager', 'external']) {
      const res = await asAdmin('POST', `/api/workstreams/${ws.id}/request-input`, { message: 'x', actor })
      expect({ actor, status: res.status }).toEqual({ actor, status: 400 })
    }
    expect(await db.select().from(workStreamWaits).where(eq(workStreamWaits.workStreamId, ws.id))).toHaveLength(0)
  })

  it('presents owner waits without human attention, while every actor still blocks completion', async () => {
    const expectations = [
      ['human', 'blocked', true],
      ['owner', 'waiting_on_owner', false],
    ] as const
    for (const [actor, state, attention] of expectations) {
      const ws = await stream(`presentation ${actor}`)
      await requestInput(ws.id, { message: `hold (${actor})`, actor })
      const body = await detail(ws.id)
      // Core's derived vocabulary is unchanged for older consumers.
      expect(body.derivedState).toBe('blocked')
      expect({ actor, state: selectWorkStreamPresentationState(body) }).toEqual({ actor, state })
      expect({ actor, attention: workStreamNeedsHumanAttention(body) }).toEqual({ actor, attention })

      const done = await asAdmin('PATCH', `/api/workstreams/${ws.id}`, { status: 'done' })
      expect({ actor, status: done.status }).toEqual({ actor, status: 409 })
    }
  })

  it('only human manual waits become Action Center items', async () => {
    const human = await stream('action human')
    const owner = await stream('action owner')
    await requestInput(human.id, { message: 'human', actor: 'human' })
    await requestInput(owner.id, { message: 'owner', actor: 'owner' })

    const ids = new Set([human.id, owner.id])
    const actions = (await listPendingActions()).filter(
      (action) =>
        action.type === 'workstream-blocked' && ids.has(String((action.data as { workStreamId: string }).workStreamId))
    )
    expect(actions.map((action) => (action.data as { workStreamId: string }).workStreamId)).toEqual([human.id])
  })
})

describe('migration default', () => {
  it('stores actor as a non-null text column defaulting to human for writers that omit it', async () => {
    const [column] = await db.execute<{ is_nullable: string; column_default: string; data_type: string }>(sql`
      select is_nullable, column_default, data_type from information_schema.columns
      where table_name = 'work_stream_waits' and column_name = 'actor'
    `)
    expect(column).toMatchObject({ is_nullable: 'NO', data_type: 'text' })
    expect(column!.column_default).toContain("'human'")

    const ws = await stream('raw insert')
    // An older writer that does not know the column.
    await db.execute(
      sql`insert into work_stream_waits (work_stream_id, type, message) values (${ws.id}, 'manual', 'legacy')`
    )
    const [row] = await db.select().from(workStreamWaits).where(eq(workStreamWaits.workStreamId, ws.id))
    expect(row).toMatchObject({ actor: 'human', actorChanges: null })
    expect((await detail(ws.id)).openWaits?.[0]?.actor).toBe('human')
  })
})

describe('POST /:id/waits/:waitId/actor', () => {
  it('relabels an open manual wait with an audit entry and leaves it open and blocking', async () => {
    const ws = await stream('relabel')
    const created = await requestInput(ws.id, { message: 'Hold', actor: 'human' })
    const waitId = created.wait!.id

    const res = await asAdmin('POST', `/api/workstreams/${ws.id}/waits/${waitId}/actor`, {
      actor: 'owner',
      note: 'Owner-held launch hold',
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as StreamBody
    expect(body.changed).toBe(true)
    expect(body.wait).toMatchObject({ id: waitId, actor: 'owner', closedAt: null, resolution: null })
    expect(body.wait?.actorChanges).toEqual([
      {
        from: 'human',
        to: 'owner',
        changedAt: expect.any(String),
        changedByAgentId: null,
        changedByUserId: admin.id,
        note: 'Owner-held launch hold',
      },
    ])

    const after = await detail(ws.id)
    expect(after.openWaits?.map((wait) => [wait.id, wait.actor])).toEqual([[waitId, 'owner']])
    expect(selectWorkStreamPresentationState(after)).toBe('waiting_on_owner')

    // Same actor again is a no-op and adds no audit entry.
    const again = await asAdmin('POST', `/api/workstreams/${ws.id}/waits/${waitId}/actor`, { actor: 'owner' })
    expect(((await again.json()) as StreamBody).changed).toBe(false)
    const [row] = await db.select().from(workStreamWaits).where(eq(workStreamWaits.id, waitId))
    expect(row?.actorChanges).toHaveLength(1)
  })

  it('refuses review, workflow-owned, closed and foreign waits', async () => {
    const ws = await stream('immutable')
    const other = await stream('other')
    const { wait: review } = await openWait(db, { workStreamId: ws.id, type: 'review', message: 'r' })
    const { wait: gate } = await openWait(db, {
      workStreamId: ws.id,
      type: 'manual',
      resolutionHandler: 'workflow',
      referenceId: crypto.randomUUID(),
      message: 'approval gate',
    })
    const { wait: foreign } = await openWait(db, { workStreamId: other.id, type: 'manual', message: 'f' })
    const closed = (await requestInput(ws.id, { message: 'c' })).wait!
    await asAdmin('POST', `/api/workstreams/${ws.id}/waits/${closed.id}/resolve`, { resolution: 'cleared' })

    const relabel = (waitId: string) =>
      asAdmin('POST', `/api/workstreams/${ws.id}/waits/${waitId}/actor`, { actor: 'owner' })
    expect((await relabel(review.id)).status).toBe(400)
    expect((await relabel(gate.id)).status).toBe(400)
    expect((await relabel(closed.id)).status).toBe(409)
    expect((await relabel(foreign.id)).status).toBe(404)
    const invalid = await asAdmin('POST', `/api/workstreams/${ws.id}/waits/${gate.id}/actor`, { actor: 'robot' })
    expect(invalid.status).toBe(400)
  })

  it('allows the owner agent and squad manager but not an assigned worker', async () => {
    await seedRole('default-worker', ['workstreams:read', 'workstreams:update', 'workstreams:respond'])
    await seedRole('default-manager', ['workstreams:read', 'workstreams:update', 'workstreams:respond'])
    const worker = await Agent.create({ agentTypeId, squadId })
    const owner = await Agent.create({ agentTypeId, squadId })
    const manager = (await Agent.find(managerId))!
    const ws = await stream('authz', { assigneeAgentId: worker.id, agentIds: [worker.id], ownerAgentId: owner.id })
    const waitId = (await requestInput(ws.id, { message: 'hold' })).wait!.id
    const relabelAs = async (agent: Agent, actor: string) =>
      request((await agent.getOrCreateToken())!, 'POST', `/api/workstreams/${ws.id}/waits/${waitId}/actor`, { actor })

    expect((await relabelAs(worker, 'owner')).status).toBe(403)
    expect((await relabelAs(owner, 'owner')).status).toBe(200)
    expect((await relabelAs(manager, 'human')).status).toBe(200)

    const [row] = await db.select().from(workStreamWaits).where(eq(workStreamWaits.id, waitId))
    expect(row?.actor).toBe('human')
    expect(row?.actorChanges?.map((change) => [change.from, change.to, change.changedByAgentId])).toEqual([
      ['human', 'owner', owner.id],
      ['owner', 'human', manager.id],
    ])
  })

  it('relabeling to human notifies the owner like a newly opened human wait', async () => {
    const owner = await Agent.create({ agentTypeId, squadId })
    const ws = await stream('to human', { ownerAgentId: owner.id })
    const waitId = (await requestInput(ws.id, { message: 'Needs a person after all', actor: 'owner' })).wait!.id
    const blockedFor = async () =>
      db
        .select({ content: inbox.content })
        .from(inbox)
        .where(
          and(
            eq(inbox.recipientId, owner.id),
            sql`${inbox.metadata}->>'workStreamId' = ${ws.id}`,
            sql`${inbox.metadata}->>'event' = 'blocked'`
          )
        )
    // The owner-actor wait woke the owner with owner wording.
    expect((await blockedFor()).map((row) => row.content)).toEqual([expect.stringContaining('waiting on owner action')])

    await asAdmin('POST', `/api/workstreams/${ws.id}/waits/${waitId}/actor`, { actor: 'human' })
    expect((await blockedFor()).map((row) => row.content)).toContainEqual(
      expect.stringContaining('is blocked and needs attention')
    )
  })
})
