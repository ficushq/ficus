import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import type { GlobalActivityPresence, GlobalSquadActivityPage, SquadActivityPage } from '@ficus/shared'
import { squadsRouter } from './squads'
import { activityRouter } from './activity'
import { materializeActivityFixtures } from '../test-utils/activity-fixtures'
import { identityMiddleware } from '../middleware/identity'
import { db } from '../db'
import {
  agents,
  executions,
  inbox,
  messages,
  squadActivity,
  squads,
  workflowBindings,
  workStreamFlowRuns,
  workStreams,
} from '../db/schema'
import {
  assignRole,
  authHeaders,
  cleanupTestRbac,
  createTestAdmin,
  createTestRole,
  createTestUser,
  type TestUser,
} from '../test-utils'

const app = new Hono()
app.use('*', identityMiddleware)
app.route('/api/squads', squadsRouter)
app.route('/api/activity', activityRouter)

const prefix = `activity-context-${crypto.randomUUID()}`
let admin: TestUser
const squadIds: string[] = []
const inboxIds: string[] = []

const fixture = {} as {
  squadId: string
  streamId: string
  streamNumber: number
  managerId: string
  engineerId: string
  engineerExecutionId: string
  managerExecutionId: string
  /** Engineer → manager while the engineer's run is live: the received row names the engineer's chat row. */
  toManagerId: string
  /** Manager → engineer after the manager's run ended: no sender run to name. */
  toEngineerId: string
  ciNoticeId: string
}

beforeAll(async () => {
  admin = await createTestAdmin({ prefix })
  const [squad] = await db
    .insert(squads)
    .values({ name: `${prefix}-squad`, purpose: 'activity context test' })
    .returning()
  squadIds.push(squad.id)
  const [manager, engineer] = await db
    .insert(agents)
    .values([
      { squadId: squad.id, agentTypeId: 'manager', metadata: { purpose: 'Squad coordination' } },
      { squadId: squad.id, agentTypeId: 'engineer', status: 'active' },
    ])
    .returning()
  const [stream] = await db
    .insert(workStreams)
    .values({ squadId: squad.id, title: 'Floating agent windows', ownerAgentId: manager.id, agentIds: [engineer.id] })
    .returning()
  await db.insert(workStreamFlowRuns).values({
    workStreamId: stream.id,
    activated: true,
    createRequestId: crypto.randomUUID(),
    createRequestHash: 'a'.repeat(64),
    source: {} as never,
    createdBy: 'test',
    state: {
      schemaVersion: 1,
      version: 3,
      definition: { steps: [{ id: 'implement', name: 'Implement' }] },
      status: 'running',
      activeAttemptId: 2,
      attempts: [
        { id: 1, stepId: 'plan', status: 'completed', evidence: 'large evidence never leaves the database' },
        { id: 2, stepId: 'implement', status: 'running' },
      ],
      returns: [],
      completedStepIds: ['plan'],
    } as never,
  })
  // The manager owns the stream but is never bound: only the engineer is a participant.
  await db.insert(workflowBindings).values({
    agentId: engineer.id,
    workStreamId: stream.id,
    participantId: 'engineer',
    bindingKey: 'engineer',
    agentSnapshot: {} as never,
  })
  const now = Date.now()
  const [engineerRun, managerRun] = await db
    .insert(executions)
    .values([
      { agentId: engineer.id, status: 'running', runStartedAt: new Date(now - 10 * 60_000) },
      {
        agentId: manager.id,
        status: 'completed',
        runStartedAt: new Date(now - 20 * 60_000),
        endedAt: new Date(now - 15 * 60_000),
      },
    ])
    .returning()
  await db.insert(messages).values([
    {
      agentId: engineer.id,
      role: 'assistant',
      content: 'Building the shared window frame',
      metadata: { executionId: engineerRun.id },
      createdAt: new Date(now - 60_000),
    },
    {
      agentId: manager.id,
      role: 'assistant',
      content: 'Coordinating the squad',
      metadata: { executionId: managerRun.id },
      createdAt: new Date(now - 16 * 60_000),
    },
  ])
  const sent = await db
    .insert(inbox)
    .values([
      {
        recipientType: 'agent',
        recipientId: manager.id,
        senderType: 'agent',
        senderId: engineer.id,
        content: 'Frame is ready for review',
      },
      {
        recipientType: 'agent',
        recipientId: engineer.id,
        senderType: 'agent',
        senderId: manager.id,
        content: 'Please also cover the drag overlay',
      },
      {
        recipientType: 'agent',
        recipientId: engineer.id,
        senderType: 'system',
        subject: 'CI success: acme/app#996 · CI / Core',
        content: 'Workflow run finished.',
        metadata: { source: 'integration-output', workStreamId: stream.id },
      },
    ])
    .returning()
  inboxIds.push(...sent.map((row) => row.id))
  Object.assign(fixture, {
    squadId: squad.id,
    streamId: stream.id,
    streamNumber: stream.number,
    managerId: manager.id,
    engineerId: engineer.id,
    engineerExecutionId: engineerRun.id,
    managerExecutionId: managerRun.id,
    toManagerId: sent[0].id,
    toEngineerId: sent[1].id,
    ciNoticeId: sent[2].id,
  })
  await materializeActivityFixtures(squadIds, inboxIds)
})

afterAll(async () => {
  for (const inboxId of inboxIds) await db.delete(inbox).where(eq(inbox.id, inboxId))
  for (const squadId of squadIds) {
    // No foreign key cascades to the projection; remove it so later repair tests see no orphans.
    await db.delete(squadActivity).where(eq(squadActivity.squadId, squadId))
    await db.delete(squads).where(eq(squads.id, squadId))
  }
  await cleanupTestRbac(prefix)
})

async function scopedUser(permissions: string[]) {
  const user = await createTestUser({ prefix })
  const role = await createTestRole({ prefix, permissions })
  await assignRole({ userId: user.id, roleId: role.id, scope: 'squad', squadId: fixture.squadId })
  return user
}

async function squadPage(user: TestUser, query = '') {
  const response = await app.request(`/api/squads/${fixture.squadId}/activity${query}`, {
    headers: authHeaders(user.token),
  })
  expect(response.status).toBe(200)
  return (await response.json()) as SquadActivityPage
}

async function globalPage(user: TestUser, query = '') {
  const response = await app.request(`/api/activity${query}`, { headers: authHeaders(user.token) })
  expect(response.status).toBe(200)
  const page = (await response.json()) as GlobalSquadActivityPage
  return { ...page, items: page.items.filter((item) => item.squadId === fixture.squadId) }
}

const byId = <T extends { id: string }>(items: T[]) => new Map(items.map((item) => [item.id, item]))

describe('Activity row context (server join)', () => {
  test('bound participants carry their stream; the owner and manager carry only their purpose', async () => {
    for (const page of [await squadPage(admin), await globalPage(admin)]) {
      const rows = byId(page.items)
      const stream = {
        id: fixture.streamId,
        number: fixture.streamNumber,
        title: 'Floating agent windows',
        squadId: fixture.squadId,
        status: 'active' as const,
        step: 'Implement',
      }
      expect(rows.get(`10:${fixture.engineerExecutionId}`)?.context).toEqual({ workStream: stream })
      expect(rows.get(`20:${fixture.toEngineerId}`)?.context).toEqual({ workStream: stream })
      // The manager owns the stream but is not a workflow participant.
      expect(rows.get(`10:${fixture.managerExecutionId}`)?.context).toEqual({ purpose: 'Squad coordination' })
      expect(rows.get(`20:${fixture.toManagerId}`)?.context).toEqual({ purpose: 'Squad coordination' })
      // Rows whose subject is not an agent never carry agent context.
      expect(rows.get(`30:${fixture.streamId}`)?.context).toBeUndefined()
    }
  })

  test("a received row names the sender's chat row for the run that sent it", async () => {
    const rows = byId((await squadPage(admin)).items)
    expect(rows.get(`20:${fixture.toManagerId}`)?.senderActivityId).toBe(`10:${fixture.engineerExecutionId}`)
    // The manager's run had ended before it sent: no sender row to hide.
    expect(rows.get(`20:${fixture.toEngineerId}`)?.senderActivityId).toBeUndefined()
  })

  test('context is permission-filtered like the rest of the feed', async () => {
    const noStreams = await scopedUser(['squads:read', 'agents:read', 'inbox:read'])
    const rows = byId((await squadPage(noStreams)).items)
    expect(rows.get(`10:${fixture.engineerExecutionId}`)?.context).toBeUndefined()
    expect(rows.get(`10:${fixture.managerExecutionId}`)?.context).toEqual({ purpose: 'Squad coordination' })
    expect(rows.get(`20:${fixture.toManagerId}`)?.senderActivityId).toBe(`10:${fixture.engineerExecutionId}`)

    const noAgents = await scopedUser(['squads:read', 'workstreams:read', 'inbox:read'])
    const visible = byId((await globalPage(noAgents)).items)
    expect(visible.has(`10:${fixture.engineerExecutionId}`)).toBe(false)
    expect(visible.get(`20:${fixture.toManagerId}`)?.context).toBeUndefined()
    expect(visible.get(`20:${fixture.toManagerId}`)?.senderActivityId).toBeUndefined()
    expect(visible.get(`20:${fixture.toEngineerId}`)?.context?.workStream?.number).toBe(fixture.streamNumber)
  })
})

describe('Activity work stream filter', () => {
  test("returns the stream's rows and its bound participants' rows on both routes", async () => {
    const query = `?workStreamId=${fixture.streamId}&verbose=true`
    for (const page of [await squadPage(admin, query), await globalPage(admin, query)]) {
      const ids = page.items.map((item) => item.id)
      expect(ids).toContain(`30:${fixture.streamId}`)
      expect(ids).toContain(`10:${fixture.engineerExecutionId}`)
      expect(ids).toContain(`20:${fixture.toEngineerId}`)
      expect(ids).toContain(`21:${fixture.ciNoticeId}`)
      expect(ids).not.toContain(`10:${fixture.managerExecutionId}`)
      expect(ids).not.toContain(`20:${fixture.toManagerId}`)
    }
  })

  test('without workstreams:read the filter matches nothing, and a malformed id is rejected', async () => {
    const noStreams = await scopedUser(['squads:read', 'agents:read', 'inbox:read'])
    expect((await squadPage(noStreams, `?workStreamId=${fixture.streamId}`)).items).toEqual([])
    expect((await globalPage(noStreams, `?workStreamId=${fixture.streamId}`)).items).toEqual([])
    for (const url of [`/api/squads/${fixture.squadId}/activity?workStreamId=nope`, '/api/activity?workStreamId=nope'])
      expect((await app.request(url, { headers: authHeaders(admin.token) })).status).toBe(400)
  })

  test('a filtered cursor cannot be replayed without the filter', async () => {
    const first = await squadPage(admin, `?workStreamId=${fixture.streamId}&verbose=true&limit=1`)
    expect(first.nextCursor).toBeString()
    const replay = await app.request(
      `/api/squads/${fixture.squadId}/activity?verbose=true&limit=1&cursor=${first.nextCursor}`,
      { headers: authHeaders(admin.token) }
    )
    expect(replay.status).toBe(400)
  })
})

describe('folded CI notices', () => {
  test('stay out of the default feed and return with Show everything (verbose)', async () => {
    expect((await squadPage(admin)).items.map((item) => item.id)).not.toContain(`21:${fixture.ciNoticeId}`)
    expect((await squadPage(admin, '?verbose=true')).items.map((item) => item.id)).toContain(`21:${fixture.ciNoticeId}`)
  })
})

describe('Active work cards', () => {
  test('global and squad presence list the stream with step, working participants and last event', async () => {
    const global = (await (
      await app.request('/api/activity/presence', { headers: authHeaders(admin.token) })
    ).json()) as GlobalActivityPresence
    const squad = (await (
      await app.request(`/api/squads/${fixture.squadId}/activity/presence`, { headers: authHeaders(admin.token) })
    ).json()) as GlobalActivityPresence
    for (const presence of [global, squad]) {
      const card = presence.streams?.find((entry) => entry.id === fixture.streamId)
      expect(card).toMatchObject({
        number: fixture.streamNumber,
        squadId: fixture.squadId,
        title: 'Floating agent windows',
        status: 'active',
        step: 'Implement',
        waits: [],
        needsYou: false,
        pullRequest: null,
        ci: null,
        workingAgentIds: [fixture.engineerId],
        derivedState: 'in_progress',
      })
      expect(Date.parse(card!.lastEventAt)).toBeGreaterThan(Date.now() - 5 * 60_000)
    }
    expect(squad.streams?.map((card) => card.id)).toEqual([fixture.streamId])
    expect(squad.streamCount).toBe(1)
  })

  test('cards follow work stream permission, and working dots follow agent permission', async () => {
    const noStreams = await scopedUser(['squads:read', 'agents:read'])
    const hidden = (await (
      await app.request(`/api/squads/${fixture.squadId}/activity/presence`, { headers: authHeaders(noStreams.token) })
    ).json()) as GlobalActivityPresence
    expect(hidden.streams).toEqual([])

    const noAgents = await scopedUser(['squads:read', 'workstreams:read'])
    const presence = (await (
      await app.request(`/api/squads/${fixture.squadId}/activity/presence`, { headers: authHeaders(noAgents.token) })
    ).json()) as GlobalActivityPresence
    expect(presence.streams?.[0]).toMatchObject({ id: fixture.streamId, workingAgentIds: [] })

    const outsider = await createTestUser({ prefix })
    const forbidden = await app.request(`/api/squads/${fixture.squadId}/activity/presence`, {
      headers: authHeaders(outsider.token),
    })
    expect(forbidden.status).toBe(403)
  })
})

describe('live Activity events', () => {
  test('carry the same per-viewer context as the REST projections', async () => {
    const { redactActivityEvent } = await import('../services/squad-activity/access')
    const data = {
      squadId: 'squad',
      operation: 'upsert' as const,
      item: {
        id: '20:message',
        at: new Date().toISOString(),
        agentId: 'agent',
        agentTypeId: 'engineer',
        kind: 'message' as const,
        summary: 'Received message from Manager: hi',
        preview: [],
        ref: { type: 'agent' as const, agentId: 'agent', view: 'inbox' as const },
      },
      quietEligible: true,
      accessScope: 'inbox' as const,
      inboxRecipientId: 'agent',
      agentTypeRequiresAgentsRead: true,
    }
    const facts = {
      workStream: { id: 'ws', number: 7, title: 'Title', squadId: 'squad', status: 'active' as const, step: 'Review' },
      purpose: 'Reviewing',
      senderActivityId: '10:exec',
    }
    const full = { agentsRead: true, workstreamsRead: true, inbox: { mode: 'all' as const } }
    expect(redactActivityEvent(full, data, facts).item).toMatchObject({
      agentTypeId: 'engineer',
      context: { workStream: facts.workStream, purpose: 'Reviewing' },
      senderActivityId: '10:exec',
    })
    const noAgents = redactActivityEvent({ ...full, agentsRead: false }, data, facts).item
    expect(noAgents).toMatchObject({ agentTypeId: null, context: { workStream: facts.workStream } })
    expect(noAgents.context?.purpose).toBeUndefined()
    expect(noAgents.senderActivityId).toBeUndefined()
    const noStreams = redactActivityEvent({ ...full, workstreamsRead: false }, data, facts).item
    expect(noStreams.context).toEqual({ purpose: 'Reviewing' })
    // Without context the event is passed through untouched.
    expect(redactActivityEvent(full, data)).toBe(data)
  })
})

describe('flow step cache', () => {
  test("reads a run's stored state only when its version changes", async () => {
    const { loadWorkStreamSteps, clearWorkStreamStepCache } = await import('../services/squad-activity/row-context')
    clearWorkStreamStepCache()
    const statements: string[] = []
    let version = 3
    const executor = {
      execute: async (query: { queryChunks?: unknown[] }) => {
        const text = JSON.stringify(query)
        statements.push(text.includes("state->>'status'") ? 'state' : 'version')
        if (!text.includes("state->>'status'")) return [{ work_stream_id: 'ws', version, activated: true }] as never
        return [
          {
            work_stream_id: 'ws',
            version,
            activated: true,
            run_status: 'running',
            running_steps: ['implement'],
            step_names: { implement: 'Implement' },
          },
        ] as never
      },
    }
    const stream = [{ id: 'ws', status: 'active' as const }]
    expect((await loadWorkStreamSteps(stream, executor as never)).get('ws')).toBe('Implement')
    expect((await loadWorkStreamSteps(stream, executor as never)).get('ws')).toBe('Implement')
    expect(statements).toEqual(['version', 'state', 'version'])
    version = 4
    await loadWorkStreamSteps(stream, executor as never)
    expect(statements).toEqual(['version', 'state', 'version', 'version', 'state'])
    clearWorkStreamStepCache()
  })
})
