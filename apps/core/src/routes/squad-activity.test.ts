import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { squadsRouter } from './squads'
import { activityRouter } from './activity'
import type { SquadActivityItem } from '@ficus/shared'
import { materializeActivityFixtures } from '../test-utils/activity-fixtures'
import { githubPrLogicalRowId } from '../services/squad-activity/github-pr-fact'
import { identityMiddleware } from '../middleware/identity'
import { db } from '../db'
import {
  agentExtraScopes,
  agents,
  executions,
  inbox,
  integrationEventPollingDispatches,
  messages,
  squads,
  workStreams,
  workStreamWaits,
} from '../db/schema'
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
app.route('/api/squads', squadsRouter)
app.route('/api/activity', activityRouter)

const prefix = `activity-route-${crypto.randomUUID()}`
let admin: TestUser
const squadIds: string[] = []
const inboxIds: string[] = []
const dispatchKeys: string[] = []

beforeAll(async () => {
  admin = await createTestAdmin({ prefix })
})

afterAll(async () => {
  for (const eventKey of dispatchKeys)
    await db.delete(integrationEventPollingDispatches).where(eq(integrationEventPollingDispatches.eventKey, eventKey))
  for (const inboxId of inboxIds) await db.delete(inbox).where(eq(inbox.id, inboxId))
  for (const squadId of squadIds) await db.delete(squads).where(eq(squads.id, squadId))
  await cleanupTestRbac(prefix)
})

async function activityRequest(url: string, init?: RequestInit) {
  return app.request(url, init)
}

async function repairFixtures() {
  return materializeActivityFixtures(squadIds, inboxIds, dispatchKeys)
}

async function insertTestInbox(values: Array<typeof inbox.$inferInsert>) {
  const rows = await db.insert(inbox).values(values).returning()
  inboxIds.push(...rows.map((row) => row.id))
  return rows
}

async function seedSquad(label: string) {
  const [squad] = await db
    .insert(squads)
    .values({ name: `${prefix}-${label}`, purpose: 'activity route test' })
    .returning()
  squadIds.push(squad.id)
  return squad
}

async function scopedUser(squadId: string, permissions: string[]) {
  const user = await createTestUser({ prefix })
  const role = await createTestRole({ prefix, permissions })
  await assignRole({ userId: user.id, roleId: role.id, scope: 'squad', squadId })
  return user
}

describe('GET /api/squads/:id/activity', () => {
  test('enforces identity, squad visibility, not-found, and archived behavior', async () => {
    const squad = await seedSquad('status')
    expect((await activityRequest(`/api/squads/${squad.id}/activity`)).status).toBe(401)

    const denied = await createTestUser({ prefix })
    expect(
      (await activityRequest(`/api/squads/${squad.id}/activity`, { headers: authHeaders(denied.token) })).status
    ).toBe(403)

    const reader = await scopedUser(squad.id, ['squads:read'])
    expect(
      (await activityRequest(`/api/squads/${crypto.randomUUID()}/activity`, { headers: authHeaders(admin.token) }))
        .status
    ).toBe(404)
    expect(
      (await activityRequest(`/api/squads/${squad.id}/activity`, { headers: authHeaders(reader.token) })).status
    ).toBe(200)

    await db.update(squads).set({ archivedAt: new Date() }).where(eq(squads.id, squad.id))
    expect(
      (await activityRequest(`/api/squads/${squad.id}/activity`, { headers: authHeaders(reader.token) })).status
    ).toBe(404)
  })

  test('strictly parses filters and reports empty or context-invalid cursors', async () => {
    const squad = await seedSquad('query')
    for (const query of ['limit=0', 'limit=1.5', 'limit=101', 'verbose=yes', 'agentId=not-a-uuid', 'kind=tool'])
      expect(
        (await activityRequest(`/api/squads/${squad.id}/activity?${query}`, { headers: authHeaders(admin.token) }))
          .status
      ).toBe(400)

    const empty = await activityRequest(`/api/squads/${squad.id}/activity?cursor=`, {
      headers: authHeaders(admin.token),
    })
    expect(empty.status).toBe(400)
    expect(await empty.json()).toMatchObject({ code: 'invalid_cursor' })

    await db.insert(workStreams).values([
      { squadId: squad.id, title: 'Cursor one' },
      { squadId: squad.id, title: 'Cursor two' },
    ])
    await repairFixtures()
    const first = await activityRequest(`/api/squads/${squad.id}/activity?limit=1`, {
      headers: authHeaders(admin.token),
    })
    expect(first.status).toBe(200)
    const firstPage = (await first.json()) as { nextCursor: string }
    const reused = await activityRequest(
      `/api/squads/${squad.id}/activity?limit=1&verbose=true&cursor=${firstPage.nextCursor}`,
      { headers: authHeaders(admin.token) }
    )
    expect(reused.status).toBe(400)
    expect(await reused.json()).toMatchObject({ code: 'invalid_cursor' })
  })

  test('omits forbidden source lanes and redacts joined actor detail', async () => {
    const squad = await seedSquad('permissions')
    const [agent] = await db.insert(agents).values({ squadId: squad.id, agentTypeId: 'engineer' }).returning()
    const [execution] = await db
      .insert(executions)
      .values({ agentId: agent.id, status: 'completed', runStartedAt: new Date(), endedAt: new Date() })
      .returning()
    await db.insert(messages).values({
      agentId: agent.id,
      role: 'assistant',
      content: 'Hidden chat',
      metadata: { executionId: execution.id },
    })
    await db.insert(workStreams).values({ squadId: squad.id, title: 'Visible work', creatorAgentId: agent.id })
    await repairFixtures()

    const reader = await scopedUser(squad.id, ['squads:read', 'workstreams:read'])
    const response = await activityRequest(`/api/squads/${squad.id}/activity`, { headers: authHeaders(reader.token) })
    expect(response.status).toBe(200)
    const page = (await response.json()) as { items: Array<{ kind: string; agentTypeId: string | null }> }
    expect(page.items.map((item) => item.kind)).toEqual(['workstream'])
    expect(page.items[0]?.agentTypeId).toBeNull()
  })

  test('resolves agent own-recipient versus squad-wide inbox access at the route', async () => {
    const squad = await seedSquad('agent-inbox-access')
    const [caller, teammate, sender] = await db
      .insert(agents)
      .values([
        { squadId: squad.id, agentTypeId: 'engineer' },
        { squadId: squad.id, agentTypeId: 'reviewer' },
        { squadId: squad.id, agentTypeId: 'architect' },
      ])
      .returning()
    await insertTestInbox([
      {
        recipientType: 'agent',
        recipientId: caller.id,
        senderType: 'agent',
        senderId: sender.id,
        content: 'Own route row',
      },
      {
        recipientType: 'agent',
        recipientId: teammate.id,
        senderType: 'agent',
        senderId: sender.id,
        content: 'Squad route row',
      },
    ])
    await repairFixtures()
    await db.insert(agentExtraScopes).values({ agentId: caller.id, permission: 'squads:read' })
    const token = await createTestAgentToken({ agentId: caller.id, squadId: squad.id })
    const read = async () => {
      const response = await activityRequest(`/api/squads/${squad.id}/activity?kind=message`, {
        headers: authHeaders(token.token),
      })
      expect(response.status).toBe(200)
      return (await response.json()) as { items: Array<{ summary: string }> }
    }

    expect((await read()).items.map((item) => item.summary)).toEqual(['Sent message to Engineer: Own route row'])
    await db.insert(agentExtraScopes).values({ agentId: caller.id, permission: 'inbox:read-squad' })
    expect((await read()).items.map((item) => item.summary).sort()).toEqual([
      'Sent message to Engineer: Own route row',
      'Sent message to Reviewer: Squad route row',
    ])
  })

  test('does not promote workflow notifications without access or trust foreign/squadless recipients', async () => {
    const squad = await seedSquad('workflow-promotion')
    const foreign = await seedSquad('workflow-foreign')
    const [recipient, sender, foreignRecipient, squadlessRecipient] = await db
      .insert(agents)
      .values([
        { squadId: squad.id, agentTypeId: 'reviewer' },
        { squadId: squad.id, agentTypeId: 'engineer' },
        { squadId: foreign.id, agentTypeId: 'reviewer' },
        { squadId: null, agentTypeId: 'reviewer' },
      ])
      .returning()
    const [workStream] = await db
      .insert(workStreams)
      .values({ squadId: squad.id, title: 'Hidden workflow' })
      .returning()
    const insertedInboxRows = await insertTestInbox([
      {
        recipientType: 'agent',
        recipientId: recipient.id,
        senderType: 'agent',
        senderId: sender.id,
        content: 'Readable inbox row',
      },
      {
        recipientType: 'agent',
        recipientId: recipient.id,
        senderType: 'system',
        content: 'Must not promote',
        metadata: { event: 'assigned', workStreamId: workStream.id },
      },
      {
        recipientType: 'agent',
        recipientId: foreignRecipient.id,
        senderType: 'agent',
        senderId: sender.id,
        content: 'Foreign metadata spoof',
        metadata: { squadId: squad.id },
      },
      {
        recipientType: 'agent',
        recipientId: foreignRecipient.id,
        senderType: 'system',
        content: 'Foreign assigned row',
        metadata: { event: 'assigned', workStreamId: workStream.id },
      },
      {
        recipientType: 'agent',
        recipientId: foreignRecipient.id,
        senderType: 'system',
        content: 'Foreign terminal row',
        metadata: { event: 'done', workStreamId: workStream.id, ownerAgentId: foreignRecipient.id },
      },
      {
        recipientType: 'agent',
        recipientId: foreignRecipient.id,
        senderType: 'system',
        content: 'Foreign reopened row',
        metadata: { event: 'reopened', workStreamId: workStream.id, ownerAgentId: foreignRecipient.id },
      },
      {
        recipientType: 'agent',
        recipientId: squadlessRecipient.id,
        senderType: 'system',
        content: 'Squadless assigned row',
        metadata: { event: 'assigned', workStreamId: workStream.id },
      },
      {
        recipientType: 'agent',
        recipientId: squadlessRecipient.id,
        senderType: 'system',
        content: 'Squadless terminal row',
        metadata: { event: 'done', workStreamId: workStream.id, ownerAgentId: squadlessRecipient.id },
      },
      {
        recipientType: 'agent',
        recipientId: squadlessRecipient.id,
        senderType: 'system',
        content: 'Squadless reopened row',
        metadata: { event: 'reopened', workStreamId: workStream.id, ownerAgentId: squadlessRecipient.id },
      },
    ])
    await repairFixtures()
    const reader = await scopedUser(squad.id, ['squads:read', 'agents:read', 'inbox:read'])
    const response = await activityRequest(`/api/squads/${squad.id}/activity`, { headers: authHeaders(reader.token) })
    expect(response.status).toBe(200)
    const page = (await response.json()) as { items: Array<{ kind: string; summary: string }> }
    expect(page.items).toEqual([
      expect.objectContaining({ kind: 'message', summary: 'Sent message to Reviewer: Readable inbox row' }),
    ])

    const foreignActivityIds = [
      `50:${insertedInboxRows[3].id}`,
      `31:${insertedInboxRows[4].id}`,
      `31:${insertedInboxRows[5].id}`,
      `50:${insertedInboxRows[6].id}`,
      `31:${insertedInboxRows[7].id}`,
      `31:${insertedInboxRows[8].id}`,
    ]
    const expectNoForeignActivity = (actualIds: string[]) => {
      for (const forbiddenId of foreignActivityIds) expect(actualIds).not.toContain(forbiddenId)
    }
    const adminResponse = await activityRequest(`/api/squads/${squad.id}/activity`, {
      headers: authHeaders(admin.token),
    })
    const adminIds = ((await adminResponse.json()) as { items: Array<{ id: string }> }).items.map((item) => item.id)
    expectNoForeignActivity(adminIds)

    await db.insert(agentExtraScopes).values([
      { agentId: foreignRecipient.id, permission: 'squads:read' },
      { agentId: foreignRecipient.id, permission: 'workstreams:read' },
      { agentId: squadlessRecipient.id, permission: 'squads:read' },
      { agentId: squadlessRecipient.id, permission: 'workstreams:read' },
    ])
    const foreignToken = await createTestAgentToken({ agentId: foreignRecipient.id, squadId: squad.id })
    const ownResponse = await activityRequest(`/api/squads/${squad.id}/activity`, {
      headers: authHeaders(foreignToken.token),
    })
    expect(ownResponse.status).toBe(403)

    const squadlessToken = await createTestAgentToken({ agentId: squadlessRecipient.id, squadId: squad.id })
    const squadlessResponse = await activityRequest(`/api/squads/${squad.id}/activity`, {
      headers: authHeaders(squadlessToken.token),
    })
    expect(squadlessResponse.status).toBe(403)
  })

  test('traverses every source once, isolates cursor snapshots, and rejects cross-squad replay', async () => {
    const squad = await seedSquad('pagination')
    const otherSquad = await seedSquad('pagination-other')
    const [agent] = await db.insert(agents).values({ squadId: squad.id, agentTypeId: 'engineer' }).returning()
    await db.update(squads).set({ managerAgentId: agent.id }).where(eq(squads.id, squad.id))
    // Relative anchor (never goes stale): a whole-second instant two days ago;
    // the sub-second parts are appended explicitly where microsecond ordering
    // is under test.
    const baseIso = new Date(Math.floor((Date.now() - 2 * 24 * 60 * 60 * 1000) / 1000) * 1000)
      .toISOString()
      .slice(0, 19)
    const at = new Date(`${baseIso}.123Z`)
    const [execution] = await db
      .insert(executions)
      .values({ agentId: agent.id, status: 'completed', runStartedAt: at, endedAt: at })
      .returning()
    const [message] = await db
      .insert(messages)
      .values({
        agentId: agent.id,
        role: 'assistant',
        content: 'Same instant',
        metadata: { executionId: execution.id },
        createdAt: at,
      })
      .returning()
    const [workStream, secondWorkStream] = await db
      .insert(workStreams)
      .values([
        {
          squadId: squad.id,
          title: 'Same instant one',
          creatorAgentId: agent.id,
          ownerAgentId: agent.id,
          createdAt: at,
        },
        { squadId: squad.id, title: 'Same instant two', creatorAgentId: agent.id, createdAt: at },
      ])
      .returning()
    const [wait] = await db
      .insert(workStreamWaits)
      .values({
        workStreamId: workStream.id,
        type: 'review',
        createdBy: 'agent',
        createdByAgentId: agent.id,
        openedAt: at,
        closedAt: at,
        resolution: 'approved',
      })
      .returning()
    const inboxRows = await insertTestInbox([
      {
        recipientType: 'agent',
        recipientId: agent.id,
        senderType: 'agent',
        senderId: agent.id,
        content: 'Same instant inbox',
        createdAt: at,
      },
      {
        recipientType: 'agent',
        recipientId: agent.id,
        senderType: 'system',
        content: 'Same instant handoff',
        metadata: { event: 'assigned', workStreamId: workStream.id },
        createdAt: at,
      },
      {
        recipientType: 'agent',
        recipientId: agent.id,
        senderType: 'system',
        content: 'Same instant done',
        metadata: { event: 'done', workStreamId: workStream.id, ownerAgentId: agent.id },
        createdAt: at,
      },
    ])
    await db.execute(
      sql`UPDATE messages SET created_at = ${`${baseIso}.123456Z`}::timestamptz WHERE id = ${message.id}::uuid`
    )
    await db.execute(
      sql`UPDATE work_streams SET created_at = ${`${baseIso}.123456Z`}::timestamptz WHERE id = ${workStream.id}::uuid`
    )
    await db.execute(
      sql`UPDATE work_streams SET created_at = ${`${baseIso}.123789Z`}::timestamptz WHERE id = ${secondWorkStream.id}::uuid`
    )
    await repairFixtures()

    const firstResponse = await activityRequest(`/api/squads/${squad.id}/activity?limit=1`, {
      headers: authHeaders(admin.token),
    })
    const firstPage = (await firstResponse.json()) as { items: Array<{ id: string }>; nextCursor: string }
    const seen = firstPage.items.map((item) => item.id)
    const frozenCursor = firstPage.nextCursor
    const [newer] = await db
      .insert(workStreams)
      .values({ squadId: squad.id, title: 'Newer after page one', createdAt: new Date(at.valueOf() + 1000) })
      .returning()
    await repairFixtures()

    let cursor: string | null = frozenCursor
    while (cursor) {
      const response = await activityRequest(
        `/api/squads/${squad.id}/activity?limit=1&cursor=${encodeURIComponent(cursor)}`,
        { headers: authHeaders(admin.token) }
      )
      expect(response.status).toBe(200)
      const page = (await response.json()) as { items: Array<{ id: string }>; nextCursor: string | null }
      seen.push(...page.items.map((item) => item.id))
      cursor = page.nextCursor
    }

    const orderedWorkStreams = [workStream.id, secondWorkStream.id]
      .sort()
      .reverse()
      .map((id) => `30:${id}`)
    // Top-level execution lifecycle rows retired 2026-08-27: no 60/61 lanes.
    expect(seen).toEqual([
      `50:${inboxRows[1].id}`,
      `41:${wait.id}`,
      `40:${wait.id}`,
      `31:${inboxRows[2].id}`,
      ...orderedWorkStreams,
      `20:${inboxRows[0].id}`,
      // A chat row is keyed by its execution.
      `10:${execution.id}`,
    ])
    expect(new Set(seen).size).toBe(seen.length)
    expect(seen).not.toContain(`30:${newer.id}`)

    const head = await activityRequest(`/api/squads/${squad.id}/activity?limit=1`, {
      headers: authHeaders(admin.token),
    })
    expect(((await head.json()) as { items: Array<{ id: string }> }).items[0]?.id).toBe(`30:${newer.id}`)
    const replay = await activityRequest(
      `/api/squads/${otherSquad.id}/activity?limit=1&cursor=${encodeURIComponent(frozenCursor)}`,
      { headers: authHeaders(admin.token) }
    )
    expect(replay.status).toBe(400)
    expect(await replay.json()).toMatchObject({ code: 'invalid_cursor' })
  })
  test('materializes authoritative PR facts with exact work-stream permission and deep link', async () => {
    // Relative anchor: pinned calendar dates go stale once the repair window
    // (now-7d) slides past them.
    const prBaseIso = new Date(Math.floor((Date.now() - 2 * 24 * 60 * 60 * 1000) / 1000) * 1000)
      .toISOString()
      .slice(0, 19)
    const squad = await seedSquad('pr-fact')
    await db.insert(workStreams).values({
      squadId: squad.id,
      title: 'PR activity',
      metadata: {
        github: { repo: 'acme/widgets', pr: { number: 42, url: 'https://github.com/acme/widgets/pull/42' } },
      },
    })
    const eventKey = crypto.randomUUID()
    dispatchKeys.push(eventKey)
    await db.insert(integrationEventPollingDispatches).values({
      providerKey: 'github',
      eventKey,
      activityId: crypto.randomUUID(),
      activitySquadIds: [squad.id],
      completedAt: new Date(new Date(`${prBaseIso}.000Z`).getTime() + 1000),
      eventOccurredAt: new Date(`${prBaseIso}.000Z`),
      eventFact: {
        eventType: 'pull_request',
        action: 'closed',
        occurredAt: `${prBaseIso}.000Z`,
        actorLogin: null,
        repository: 'acme/widgets',
        prNumber: 42,
        nativeId: '4200',
        providerDeliveryId: null,
        logicalRowId: githubPrLogicalRowId({
          eventType: 'pull_request',
          action: 'closed',
          occurredAt: `${prBaseIso}.000Z`,
          repository: 'acme/widgets',
          prNumber: 42,
          nativeId: '4200',
        }),
        url: 'https://github.com/acme/widgets/pull/42',
      },
    })
    await repairFixtures()
    const response = await activityRequest(`/api/squads/${squad.id}/activity?kind=pr`, {
      headers: authHeaders(admin.token),
    })
    expect(response.status).toBe(200)
    expect((await response.json()).items).toEqual([
      expect.objectContaining({
        kind: 'pr',
        summary: '[PR #42 closed]',
        ref: { type: 'pr', url: 'https://github.com/acme/widgets/pull/42' },
      }),
    ])
    const hidden = await scopedUser(squad.id, ['squads:read'])
    const denied = await activityRequest(`/api/squads/${squad.id}/activity?kind=pr`, {
      headers: authHeaders(hidden.token),
    })
    expect((await denied.json()).items).toEqual([])
  })

  test('does not attribute PR Activity through legacy-only watch metadata', async () => {
    // Relative anchor — see the PR-facts test above.
    const prBaseIso = new Date(Math.floor((Date.now() - 2 * 24 * 60 * 60 * 1000) / 1000) * 1000)
      .toISOString()
      .slice(0, 19)
    const squad = await seedSquad('legacy-pr-fact')
    await db.insert(workStreams).values({
      squadId: squad.id,
      title: 'Legacy PR watch',
      metadata: { nested: { prUrl: 'https://github.com/acme/widgets/pull/43' } },
    })
    const eventKey = crypto.randomUUID()
    dispatchKeys.push(eventKey)
    await db.insert(integrationEventPollingDispatches).values({
      providerKey: 'github',
      eventKey,
      activityId: crypto.randomUUID(),
      completedAt: new Date(new Date(`${prBaseIso}.000Z`).getTime() + 1000),
      eventOccurredAt: new Date(`${prBaseIso}.000Z`),
      eventFact: {
        eventType: 'pull_request',
        action: 'closed',
        occurredAt: `${prBaseIso}.000Z`,
        actorLogin: null,
        repository: 'acme/widgets',
        prNumber: 43,
        nativeId: '4300',
        providerDeliveryId: null,
        logicalRowId: githubPrLogicalRowId({
          eventType: 'pull_request',
          action: 'closed',
          occurredAt: `${prBaseIso}.000Z`,
          repository: 'acme/widgets',
          prNumber: 43,
          nativeId: '4300',
        }),
        url: 'https://github.com/acme/widgets/pull/43',
      },
    })
    await repairFixtures()
    const response = await activityRequest(`/api/squads/${squad.id}/activity?kind=pr`, {
      headers: authHeaders(admin.token),
    })
    expect(response.status).toBe(200)
    expect((await response.json()).items).toEqual([])
  })
})

test('global and squad APIs serve the same source-generated preview and literal numbered marker', async () => {
  const squad = await seedSquad('inline-preview')
  const [stream] = await db
    .insert(workStreams)
    .values({ squadId: squad.id, title: 'See [**#241**](ficus:ws:241)' })
    .returning()
  await repairFixtures()
  for (const url of [`/api/squads/${squad.id}/activity`, '/api/activity']) {
    const response = await activityRequest(url, { headers: authHeaders(admin.token) })
    expect(response.status).toBe(200)
    const page = (await response.json()) as { items: SquadActivityItem[] }
    const item = page.items.find((item) => item.id === `30:${stream.id}`)!
    expect(item.summary).toBe(`[#${stream.number} created] See #241`)
    expect(item.preview).toEqual([
      { text: `[#${stream.number} created] See ` },
      { text: '#241', bold: true, href: 'ficus:ws:241' },
    ])
  }
})
