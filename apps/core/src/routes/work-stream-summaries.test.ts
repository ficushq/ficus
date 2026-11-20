import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import type { GlobalActivityPresence, WorkStream as WorkStreamJson } from '@ficus/shared'
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
import { eventEmitter } from '../lib/infra/event-emitter'
import { identityMiddleware } from '../middleware/identity'
import { invalidatePermissionCache } from '../services/rbac/permissions'
import { getSettingsStore } from '../services/settings'
import { clearWorkStreamStepCache } from '../services/squad-activity/row-context'
import { refreshStreamSummary } from '../services/stream-summaries/service'
import { saveStreamSummary, streamSummaryRuntimeDeps } from '../services/stream-summaries/runtime'
import { materializeActivityFixtures } from '../test-utils/activity-fixtures'
import {
  assignRole,
  authHeaders,
  cleanupTestRbac,
  createTestAdmin,
  createTestRole,
  createTestUser,
  type TestUser,
} from '../test-utils'
import { activityRouter } from './activity'
import { workStreamsRouter } from './work-streams'

const app = new Hono()
  .use('*', identityMiddleware)
  .route('/api/workstreams', workStreamsRouter)
  .route('/api/activity', activityRouter)

const prefix = `stream-summaries-${crypto.randomUUID()}`
let admin: TestUser
const fixture = {} as {
  squadId: string
  streamId: string
  managerId: string
  engineerId: string
  reviewerId: string
  consultantId: string
  updatedAt: Date
}
const inboxIds: string[] = []

function runState(stepId: string, version: number) {
  return {
    schemaVersion: 1,
    version,
    definition: {
      steps: [
        { id: 'implement', name: 'Implement' },
        { id: 'review', name: 'Code review' },
      ],
    },
    status: 'running',
    activeAttemptId: 1,
    attempts: [{ id: 1, stepId, status: 'running' }],
    returns: [],
    completedStepIds: [],
  } as never
}

beforeAll(async () => {
  admin = await createTestAdmin({ prefix })
  const [squad] = await db
    .insert(squads)
    .values({ name: `${prefix}-squad`, purpose: 'stream summary test' })
    .returning()
  const [manager, engineer, reviewer, consultant] = await db
    .insert(agents)
    .values([
      { squadId: squad.id, agentTypeId: 'manager' },
      { squadId: squad.id, agentTypeId: 'engineer', status: 'active' },
      { squadId: squad.id, agentTypeId: 'reviewer' },
      { squadId: squad.id, agentTypeId: 'consultant' },
    ])
    .returning()
  const [stream] = await db
    .insert(workStreams)
    .values({
      squadId: squad.id,
      title: 'Work stream summaries',
      ownerAgentId: manager.id,
      agentIds: [engineer.id, reviewer.id],
      metadata: { git: { branch: 'work/summaries' } },
    })
    .returning()
  await db.insert(workStreamFlowRuns).values({
    workStreamId: stream.id,
    activated: true,
    createRequestId: crypto.randomUUID(),
    createRequestHash: 'b'.repeat(64),
    source: {} as never,
    createdBy: 'test',
    state: runState('implement', 2),
    version: 2,
  })
  // A consultant bound by mistake is still never read; the manager owns the stream and is never bound.
  await db.insert(workflowBindings).values(
    [engineer, reviewer, consultant].map((agent) => ({
      agentId: agent.id,
      workStreamId: stream.id,
      participantId: agent.agentTypeId,
      bindingKey: agent.agentTypeId,
      agentSnapshot: {} as never,
    }))
  )
  const now = Date.now()
  const runs = await db
    .insert(executions)
    .values(
      [engineer, reviewer, consultant, manager].map((agent) => ({
        agentId: agent.id,
        status: 'completed' as const,
        runStartedAt: new Date(now - 10 * 60_000),
        endedAt: new Date(now - 60_000),
      }))
    )
    .returning()
  await db.insert(messages).values(
    runs.map((run, index) => ({
      agentId: run.agentId,
      role: 'assistant' as const,
      content: ['Engineer: wiring the peek card', 'Reviewer: checking the throttle', 'Consultant chat', 'Manager chat'][
        index
      ]!,
      metadata: { executionId: run.id },
      createdAt: new Date(now - (5 - index) * 60_000),
    }))
  )
  const sent = await db
    .insert(inbox)
    .values([
      {
        recipientType: 'agent',
        recipientId: engineer.id,
        senderType: 'agent',
        senderId: manager.id,
        content: 'Relay from the manager',
      },
      {
        recipientType: 'agent',
        recipientId: engineer.id,
        senderType: 'system',
        subject: 'Scheduled reminder',
        content: 'System notice',
      },
    ])
    .returning()
  inboxIds.push(...sent.map((row) => row.id))
  await materializeActivityFixtures([squad.id], inboxIds)
  Object.assign(fixture, {
    squadId: squad.id,
    streamId: stream.id,
    managerId: manager.id,
    engineerId: engineer.id,
    reviewerId: reviewer.id,
    consultantId: consultant.id,
    updatedAt: stream.updatedAt,
  })
})

afterAll(async () => {
  for (const inboxId of inboxIds) await db.delete(inbox).where(eq(inbox.id, inboxId))
  await db.delete(squadActivity).where(eq(squadActivity.squadId, fixture.squadId))
  await db.delete(squads).where(eq(squads.id, fixture.squadId))
  await getSettingsStore().delete('STREAM_SUMMARIES_ENABLED')
  await cleanupTestRbac(prefix)
})

async function detail(user: TestUser = admin): Promise<WorkStreamJson> {
  const response = await app.request(`/api/workstreams/${fixture.streamId}`, { headers: authHeaders(user.token) })
  expect(response.status).toBe(200)
  return (await response.json()) as WorkStreamJson
}

async function listed(user: TestUser = admin): Promise<WorkStreamJson | undefined> {
  const response = await app.request(`/api/workstreams?squadId=${fixture.squadId}&statuses=active`, {
    headers: authHeaders(user.token),
  })
  expect(response.status).toBe(200)
  const body = (await response.json()) as WorkStreamJson[] | { items: WorkStreamJson[] }
  return (Array.isArray(body) ? body : body.items).find((stream) => stream.id === fixture.streamId)
}

async function card(user: TestUser = admin) {
  const response = await app.request('/api/activity/presence', { headers: authHeaders(user.token) })
  expect(response.status).toBe(200)
  return ((await response.json()) as GlobalActivityPresence).streams?.find((entry) => entry.id === fixture.streamId)
}

describe('work stream summaries', () => {
  test('reads only the messages participants sent', async () => {
    const stream = (await streamSummaryRuntimeDeps.loadStream(fixture.streamId))!
    const rows = await streamSummaryRuntimeDeps.loadParticipantRows(stream, null, 18)
    expect(rows.map((row) => row.text).sort()).toEqual([
      'Engineer: wiring the peek card',
      'Reviewer: checking the throttle',
    ])
    expect(new Set(rows.map((row) => row.lane))).toEqual(new Set([10]))
    // Rows at or before the cursor are not new.
    const newest = rows.reduce((max, row) => (row.at > max ? row.at : max), new Date(0))
    expect(await streamSummaryRuntimeDeps.loadParticipantRows(stream, newest, 18)).toEqual([])
  })

  test('stores the summary on the stream, pushes it live and shows it for the current step', async () => {
    await getSettingsStore().set('STREAM_SUMMARIES_ENABLED', 'true')
    const pushed: string[] = []
    const unsubscribe = eventEmitter.on('workStream.summaryUpdated', ({ workStreamId }) => pushed.push(workStreamId))
    try {
      const prompts: string[] = []
      const result = await refreshStreamSummary(fixture.streamId, 0, {
        ...streamSummaryRuntimeDeps,
        complete: async (request) => {
          prompts.push(request.prompt)
          return { text: 'Wiring the peek card and checking the throttle', model: 'lite' }
        },
      })
      expect(result).toEqual({ outcome: 'saved' })
      expect(prompts[0]).not.toContain('Relay from the manager')
      expect(prompts[0]).not.toContain('Manager chat')
      expect(prompts[0]).not.toContain('Consultant chat')
    } finally {
      unsubscribe()
    }
    expect(pushed).toEqual([fixture.streamId])

    const [row] = await db
      .select({ metadata: workStreams.metadata, updatedAt: workStreams.updatedAt })
      .from(workStreams)
      .where(eq(workStreams.id, fixture.streamId))
    // Other metadata is kept, and a summary is not a change to the stream's work.
    expect(row!.metadata).toMatchObject({ git: { branch: 'work/summaries' }, streamSummary: { step: 'Implement' } })
    expect(row!.updatedAt.toISOString()).toBe(fixture.updatedAt.toISOString())

    const expected = { text: 'Wiring the peek card and checking the throttle', step: 'Implement' }
    const shown = await detail()
    expect(shown.step).toBe('Implement')
    expect(shown.summary).toMatchObject(expected)
    expect(shown.metadata).not.toHaveProperty('streamSummary')
    expect((await listed())?.summary).toMatchObject(expected)
    expect(await card()).toMatchObject({ summary: expected.text, summaryGeneratedAt: shown.summary!.generatedAt })

    // A second save against a stale read does nothing.
    expect(
      await saveStreamSummary(
        { id: fixture.streamId, squadId: fixture.squadId },
        { text: 'Racing save', generatedAt: new Date().toISOString(), step: 'Implement', through: null },
        null
      )
    ).toBe(false)
  })

  test('a viewer who can read the stream but not agents gets the step without the summary', async () => {
    const user = await createTestUser({ prefix })
    const role = await createTestRole({ prefix, permissions: ['squads:read', 'workstreams:read'] })
    await assignRole({ userId: user.id, roleId: role.id, scope: 'squad', squadId: fixture.squadId })
    const shown = await detail(user)
    expect(shown.step).toBe('Implement')
    expect(shown.summary).toBeUndefined()
    expect(shown.metadata).not.toHaveProperty('streamSummary')
    const row = await listed(user)
    expect(row?.step).toBe('Implement')
    expect(row?.summary).toBeUndefined()
    const shownCard = await card(user)
    expect(shownCard?.step).toBe('Implement')
    expect(shownCard?.summary).toBeUndefined()
    expect(shownCard?.summaryGeneratedAt).toBeUndefined()

    // With agents:read as well, the same viewer sees it.
    const reader = await createTestRole({ prefix, permissions: ['agents:read'] })
    await assignRole({ userId: user.id, roleId: reader.id, scope: 'squad', squadId: fixture.squadId })
    invalidatePermissionCache()
    expect((await detail(user)).summary?.text).toBe('Wiring the peek card and checking the throttle')
    expect((await card(user))?.summary).toBe('Wiring the peek card and checking the throttle')
  })

  test('clients cannot write or delete the stored summary through metadata', async () => {
    for (const metadata of [
      { streamSummary: { text: 'Forged', generatedAt: new Date().toISOString(), step: 'Implement', through: null } },
      { streamSummary: null },
    ]) {
      const response = await app.request(`/api/workstreams/${fixture.streamId}`, {
        method: 'PATCH',
        headers: { ...authHeaders(admin.token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ metadata }),
      })
      expect(response.status).toBe(400)
    }
    expect((await detail()).summary?.text).toBe('Wiring the peek card and checking the throttle')
  })

  test('hides the summary when the switch is off', async () => {
    await getSettingsStore().set('STREAM_SUMMARIES_ENABLED', 'false')
    try {
      expect((await detail()).summary).toBeUndefined()
      expect((await listed())?.summary).toBeUndefined()
      expect((await card())?.summary).toBeUndefined()
      const result = await refreshStreamSummary(fixture.streamId, 10, {
        ...streamSummaryRuntimeDeps,
        complete: async () => {
          throw new Error('no model call while off')
        },
      })
      expect(result).toEqual({ outcome: 'disabled' })
    } finally {
      await getSettingsStore().set('STREAM_SUMMARIES_ENABLED', 'true')
    }
  })

  test('hides a summary generated for an older step until a fresh one arrives', async () => {
    await db
      .update(workStreamFlowRuns)
      .set({ state: runState('review', 3), version: 3 })
      .where(eq(workStreamFlowRuns.workStreamId, fixture.streamId))
    clearWorkStreamStepCache()
    const shown = await detail()
    expect(shown.step).toBe('Code review')
    expect(shown.summary).toBeUndefined()
    expect((await listed())?.summary).toBeUndefined()
    expect((await card())?.summary).toBeUndefined()
    // Still stored, so the next generation updates it rather than starting over.
    const [row] = await db
      .select({ text: sql<string>`${workStreams.metadata}->'streamSummary'->>'text'` })
      .from(workStreams)
      .where(eq(workStreams.id, fixture.streamId))
    expect(row!.text).toBe('Wiring the peek card and checking the throttle')
  })
})
