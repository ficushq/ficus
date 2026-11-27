import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import type { GlobalActivityPresence } from '@ficus/shared'
import { activityRouter } from './activity'
import { materializeActivityFixtures } from '../test-utils/activity-fixtures'
import { identityMiddleware } from '../middleware/identity'
import { subscribeToSquad } from '../services/squad/subscriptions'
import { db } from '../db'
import { agents, inbox, squads, workStreams, workStreamWaits } from '../db/schema'
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
app.route('/api/activity', activityRouter)

const prefix = `global-activity-route-${crypto.randomUUID()}`
let admin: TestUser
const squadIds: string[] = []
const inboxIds: string[] = []

beforeAll(async () => {
  admin = await createTestAdmin({ prefix })
})

afterAll(async () => {
  for (const inboxId of inboxIds) await db.delete(inbox).where(eq(inbox.id, inboxId))
  for (const squadId of squadIds) await db.delete(squads).where(eq(squads.id, squadId))
  await cleanupTestRbac(prefix)
})

async function activityRequest(url: string, init?: RequestInit) {
  return app.request(url, init)
}

async function repairFixtures() {
  return materializeActivityFixtures(squadIds, inboxIds)
}

async function insertTestInbox(values: Array<typeof inbox.$inferInsert>) {
  const rows = await db.insert(inbox).values(values).returning()
  inboxIds.push(...rows.map((row) => row.id))
  return rows
}

async function seedSquad(label: string) {
  const [squad] = await db
    .insert(squads)
    .values({ name: `${prefix}-${label}`, purpose: 'global activity route test' })
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

describe('GET /api/activity', () => {
  test('requires an authenticated identity', async () => {
    expect((await activityRequest('/api/activity')).status).toBe(401)
  })

  test('strictly parses filters and reports invalid cursors', async () => {
    for (const query of ['limit=0', 'limit=1.5', 'limit=101', 'verbose=yes', 'agentId=not-a-uuid', 'kind=tool'])
      expect((await activityRequest(`/api/activity?${query}`, { headers: authHeaders(admin.token) })).status).toBe(400)

    const empty = await activityRequest('/api/activity?cursor=', { headers: authHeaders(admin.token) })
    expect(empty.status).toBe(400)
    expect(await empty.json()).toMatchObject({ code: 'invalid_cursor' })
  })

  test('a caller with zero accessible squads gets an empty page, not an error', async () => {
    const outsider = await createTestUser({ prefix })
    const response = await activityRequest('/api/activity', { headers: authHeaders(outsider.token) })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ items: [], hasMore: false, nextCursor: null, squads: {} })
  })

  test('merges rows across squads with per-squad RBAC: full access, read-only-no-scope, and no access', async () => {
    const squadA = await seedSquad('full')
    const squadB = await seedSquad('read-only-no-scope')
    const squadC = await seedSquad('no-access')

    const [agentA] = await db.insert(agents).values({ squadId: squadA.id, agentTypeId: 'engineer' }).returning()
    await db.insert(workStreams).values({ squadId: squadA.id, title: 'Squad A work', creatorAgentId: agentA.id })

    const [ownerB, teammateB, senderB] = await db
      .insert(agents)
      .values([
        { squadId: squadB.id, agentTypeId: 'engineer' },
        { squadId: squadB.id, agentTypeId: 'reviewer' },
        { squadId: squadB.id, agentTypeId: 'architect' },
      ])
      .returning()
    await insertTestInbox([
      {
        recipientType: 'agent',
        recipientId: ownerB.id,
        senderType: 'agent',
        senderId: senderB.id,
        content: 'Owner-visible message',
      },
      {
        recipientType: 'agent',
        recipientId: teammateB.id,
        senderType: 'agent',
        senderId: senderB.id,
        content: 'Teammate-only message',
      },
    ])

    const [agentC] = await db.insert(agents).values({ squadId: squadC.id, agentTypeId: 'engineer' }).returning()
    await db
      .insert(workStreams)
      .values({ squadId: squadC.id, title: 'Squad C work (must not leak)', creatorAgentId: agentC.id })

    await repairFixtures()

    // Caller: full read on squad A (agents+workstreams), squads:read-only (no inbox:read) on squad B, and
    // nothing on squad C. A user identity only gets inbox mode 'all' with inbox:read — squads:read alone
    // resolves inbox mode 'none' — so squad B's inbox rows must not leak through even though the squad
    // itself resolves non-null access (agentsRead/workstreamsRead false, inbox 'none').
    const readerA = await scopedUser(squadA.id, ['squads:read', 'agents:read', 'workstreams:read'])
    const roleB = await createTestRole({ prefix, permissions: ['squads:read'] })
    await assignRole({ userId: readerA.id, roleId: roleB.id, scope: 'squad', squadId: squadB.id })

    const response = await activityRequest('/api/activity', { headers: authHeaders(readerA.token) })
    expect(response.status).toBe(200)
    const page = (await response.json()) as {
      items: Array<{ squadId: string; kind: string; summary: string }>
      squads: Record<string, { name: string }>
    }

    // Squad A: workstream row visible (workstreams:read).
    expect(page.items.some((item) => item.squadId === squadA.id && item.kind === 'workstream')).toBe(true)
    // Squad B: readerA has squads:read only (no inbox:read, not an agent identity in squad B) => inbox
    // mode 'none' => zero inbox rows from squad B.
    expect(page.items.some((item) => item.squadId === squadB.id)).toBe(false)
    // Squad C: no access at all => zero rows, and it must not even show up in the lookup map.
    expect(page.items.some((item) => item.squadId === squadC.id)).toBe(false)
    expect(page.squads[squadC.id]).toBeUndefined()
    expect(page.squads[squadA.id]).toEqual({ name: squadA.name })
    expect(page.squads[squadB.id]).toEqual({ name: squadB.name })
  })

  test("an agent identity's own-recipient inbox access is scoped per squad in the merged feed", async () => {
    const squadA = await seedSquad('agent-full')
    const squadB = await seedSquad('agent-own-inbox')

    const [agentA] = await db.insert(agents).values({ squadId: squadA.id, agentTypeId: 'engineer' }).returning()
    await db.insert(workStreams).values({ squadId: squadA.id, title: 'Squad A work', creatorAgentId: agentA.id })

    const [caller, teammate, sender] = await db
      .insert(agents)
      .values([
        { squadId: squadB.id, agentTypeId: 'engineer' },
        { squadId: squadB.id, agentTypeId: 'reviewer' },
        { squadId: squadB.id, agentTypeId: 'architect' },
      ])
      .returning()
    await insertTestInbox([
      {
        recipientType: 'agent',
        recipientId: caller.id,
        senderType: 'agent',
        senderId: sender.id,
        content: 'Own global inbox row',
      },
      {
        recipientType: 'agent',
        recipientId: teammate.id,
        senderType: 'agent',
        senderId: sender.id,
        content: 'Teammate global inbox row',
      },
    ])
    await repairFixtures()

    const { agentExtraScopes } = await import('../db/schema')
    const { createTestAgentToken } = await import('../test-utils')
    await db.insert(agentExtraScopes).values({ agentId: caller.id, permission: 'squads:read' })
    const token = await createTestAgentToken({ agentId: caller.id, squadId: squadB.id })

    const response = await activityRequest('/api/activity?kind=message', { headers: authHeaders(token.token) })
    expect(response.status).toBe(200)
    const page = (await response.json()) as { items: Array<{ squadId: string; summary: string }> }
    // Squad A: this agent identity has no access at all (not a member, no roles there).
    expect(page.items.some((item) => item.squadId === squadA.id)).toBe(false)
    // Squad B: own-recipient inbox only — sees its own row, not the teammate's.
    const squadBSummaries = page.items.filter((item) => item.squadId === squadB.id).map((item) => item.summary)
    expect(squadBSummaries).toHaveLength(1)
    expect(squadBSummaries[0]).toContain('Own global inbox row')
    expect(squadBSummaries.join()).not.toContain('Teammate global inbox row')
  })

  test('orders newest-first across squad boundaries and paginates with a squad-id tiebreaker, rejecting stale-context replay', async () => {
    const squadA = await seedSquad('order-a')
    const squadB = await seedSquad('order-b')
    // Relative, not a literal: repairFixtures() only materializes rows inside a
    // 7-day window ending at now, so a pinned instant ages out of it — this test
    // went red on 2026-09-02 with '2026-08-26T12:00Z' pinned. One day ago keeps
    // the ordering intent (older than the "now"-seeded rows above) and stays
    // inside the window.
    const at = new Date(Date.now() - 24 * 60 * 60 * 1000)
    const [wsA] = await db
      .insert(workStreams)
      .values({ squadId: squadA.id, title: 'Same-instant A', createdAt: at })
      .returning()
    const [wsB] = await db
      .insert(workStreams)
      .values({ squadId: squadB.id, title: 'Same-instant B', createdAt: at })
      .returning()
    await repairFixtures()

    // Scoped to just squadA + squadB (not 'system') so earlier tests' squads — whose rows sort newer,
    // since they were seeded at "now" rather than this day-old instant — can't dominate order.
    const reader = await createTestUser({ prefix })
    const role = await createTestRole({ prefix, permissions: ['squads:read', 'workstreams:read'] })
    await assignRole({ userId: reader.id, roleId: role.id, scope: 'squad', squadId: squadA.id })
    await assignRole({ userId: reader.id, roleId: role.id, scope: 'squad', squadId: squadB.id })

    const first = await activityRequest('/api/activity?limit=1', { headers: authHeaders(reader.token) })
    expect(first.status).toBe(200)
    const firstPage = (await first.json()) as { items: Array<{ squadId: string; id: string }>; nextCursor: string }
    const [higherSquadId, lowerSquadId] = [wsA.squadId, wsB.squadId].sort().reverse()
    expect(firstPage.items[0]?.squadId).toBe(higherSquadId)

    const second = await activityRequest(`/api/activity?limit=1&cursor=${encodeURIComponent(firstPage.nextCursor)}`, {
      headers: authHeaders(reader.token),
    })
    expect(second.status).toBe(200)
    const secondPage = (await second.json()) as { items: Array<{ squadId: string }>; nextCursor: string | null }
    expect(secondPage.items[0]?.squadId).toBe(lowerSquadId)
    expect(secondPage.nextCursor).toBeNull()

    // A cursor minted under one filter context (kinds=[]) is invalid replayed under a different one.
    const replay = await activityRequest(
      `/api/activity?limit=1&kind=pr&cursor=${encodeURIComponent(firstPage.nextCursor)}`,
      { headers: authHeaders(reader.token) }
    )
    expect(replay.status).toBe(400)
    expect(await replay.json()).toMatchObject({ code: 'invalid_cursor' })
  })

  test('kinds filter applies identically to the merged cross-squad feed', async () => {
    const squadA = await seedSquad('kinds-a')
    const squadB = await seedSquad('kinds-b')
    const [agentA] = await db.insert(agents).values({ squadId: squadA.id, agentTypeId: 'engineer' }).returning()
    await db.insert(workStreams).values({ squadId: squadA.id, title: 'Work row', creatorAgentId: agentA.id })
    const [agentB, senderB] = await db
      .insert(agents)
      .values([
        { squadId: squadB.id, agentTypeId: 'engineer' },
        { squadId: squadB.id, agentTypeId: 'reviewer' },
      ])
      .returning()
    await insertTestInbox([
      {
        recipientType: 'agent',
        recipientId: agentB.id,
        senderType: 'agent',
        senderId: senderB.id,
        content: 'Message row',
      },
    ])
    await repairFixtures()

    const reader = await createTestUser({ prefix })
    const role = await createTestRole({ prefix, permissions: ['squads:read', 'workstreams:read', 'inbox:read'] })
    await assignRole({ userId: reader.id, roleId: role.id, scope: 'system' })

    const workOnly = await activityRequest('/api/activity?kind=workstream', { headers: authHeaders(reader.token) })
    expect(
      ((await workOnly.json()) as { items: Array<{ kind: string }> }).items.every((i) => i.kind === 'workstream')
    ).toBe(true)

    const messageOnly = await activityRequest('/api/activity?kind=message', { headers: authHeaders(reader.token) })
    expect(
      ((await messageOnly.json()) as { items: Array<{ kind: string }> }).items.every((i) => i.kind === 'message')
    ).toBe(true)
  })
})

describe('GET /api/activity/presence', () => {
  test('requires an authenticated identity', async () => {
    expect((await activityRequest('/api/activity/presence')).status).toBe(401)
  })

  test('aggregates only squads and resource types readable by the caller', async () => {
    const fullSquad = await seedSquad('presence-full')
    const agentOnlySquad = await seedSquad('presence-agent-only')
    const streamOnlySquad = await seedSquad('presence-stream-only')
    const hiddenSquad = await seedSquad('presence-hidden')

    const [fullWorking, fullIdle, agentOnlyWorking, streamOnlyWorking, hiddenWorking] = await db
      .insert(agents)
      .values([
        { squadId: fullSquad.id, agentTypeId: 'engineer', status: 'active' },
        { squadId: fullSquad.id, agentTypeId: 'reviewer', status: 'idle' },
        { squadId: agentOnlySquad.id, agentTypeId: 'engineer', status: 'active' },
        { squadId: streamOnlySquad.id, agentTypeId: 'engineer', status: 'active' },
        { squadId: hiddenSquad.id, agentTypeId: 'engineer', status: 'active' },
      ])
      .returning()

    const [fullReview, fullDependency, fullDone, agentOnlyReview, streamOnlyManual, hiddenReview] = await db
      .insert(workStreams)
      .values([
        { squadId: fullSquad.id, title: 'Visible review', status: 'active' },
        { squadId: fullSquad.id, title: 'Visible dependency', status: 'queued' },
        { squadId: fullSquad.id, title: 'Done does not count', status: 'done' },
        { squadId: agentOnlySquad.id, title: 'Unreadable stream', status: 'active' },
        { squadId: streamOnlySquad.id, title: 'Visible manual wait', status: 'queued' },
        { squadId: hiddenSquad.id, title: 'Hidden stream', status: 'active' },
      ])
      .returning()
    await db.insert(workStreamWaits).values([
      { workStreamId: fullReview.id, type: 'review' },
      { workStreamId: fullDependency.id, type: 'dependency', referenceId: crypto.randomUUID() },
      { workStreamId: fullDone.id, type: 'review' },
      { workStreamId: agentOnlyReview.id, type: 'review' },
      { workStreamId: streamOnlyManual.id, type: 'manual' },
      { workStreamId: hiddenReview.id, type: 'review' },
    ])

    const reader = await createTestUser({ prefix })
    const fullRole = await createTestRole({
      prefix,
      permissions: ['squads:read', 'agents:read', 'workstreams:read'],
    })
    const agentRole = await createTestRole({ prefix, permissions: ['squads:read', 'agents:read'] })
    const streamRole = await createTestRole({ prefix, permissions: ['squads:read', 'workstreams:read'] })
    await assignRole({ userId: reader.id, roleId: fullRole.id, scope: 'squad', squadId: fullSquad.id })
    await assignRole({ userId: reader.id, roleId: agentRole.id, scope: 'squad', squadId: agentOnlySquad.id })
    await assignRole({ userId: reader.id, roleId: streamRole.id, scope: 'squad', squadId: streamOnlySquad.id })

    const response = await activityRequest('/api/activity/presence', { headers: authHeaders(reader.token) })
    expect(response.status).toBe(200)
    const body = (await response.json()) as GlobalActivityPresence
    const { streams, ...counts } = body
    expect(counts).toEqual({
      workingAgentIds: [fullWorking.id, agentOnlyWorking.id].sort(),
      workingCount: 2,
      needsYouCount: 2,
      streamCount: 3,
    })
    // Active work cards cover exactly the counted streams, the ones needing the caller first.
    expect(
      streams
        ?.map((card) => card.id)
        .slice(0, 2)
        .sort()
    ).toEqual([fullReview.id, streamOnlyManual.id].sort())
    expect(streams?.[2]).toMatchObject({
      id: fullDependency.id,
      status: 'queued',
      needsYou: false,
      waits: [{ type: 'dependency', needsYou: false }],
    })
    expect(streams?.find((card) => card.id === fullReview.id)).toMatchObject({
      needsYou: true,
      waits: [{ type: 'review', needsYou: true }],
    })
    expect(body.workingAgentIds).not.toContain(fullIdle.id)
    expect(body.workingAgentIds).not.toContain(streamOnlyWorking.id)
    expect(body.workingAgentIds).not.toContain(hiddenWorking.id)
  })

  test('muting a squad drops its work from this caller counts only', async () => {
    const muteSquad = await seedSquad('presence-muted')
    const [stream] = await db
      .insert(workStreams)
      .values([{ squadId: muteSquad.id, title: 'Muted review', status: 'active' }])
      .returning()
    await db.insert(workStreamWaits).values([{ workStreamId: stream.id, type: 'review' }])
    const muter = await scopedUser(muteSquad.id, ['squads:read', 'agents:read', 'workstreams:read'])
    const other = await scopedUser(muteSquad.id, ['squads:read', 'agents:read', 'workstreams:read'])

    const readPresence = async (token: string) => {
      const response = await activityRequest('/api/activity/presence', { headers: authHeaders(token) })
      expect(response.status).toBe(200)
      return (await response.json()) as { needsYouCount: number; streamCount: number }
    }

    // With no subscription row at all the default is `show`: the work is already counted.
    expect(await readPresence(muter.token)).toMatchObject({ needsYouCount: 1, streamCount: 1 })

    await subscribeToSquad(muteSquad.id, muter.id, { decisions: 'mute', progress: 'mute' })

    expect(await readPresence(muter.token)).toMatchObject({ needsYouCount: 0, streamCount: 0, streams: [] })
    expect(await readPresence(other.token)).toMatchObject({ needsYouCount: 1, streamCount: 1 })
  })
})

test('presence and native interest queries preserve paused rows without false human attention', async () => {
  const squad = await seedSquad('paused-native-presence')
  const reader = await scopedUser(squad.id, ['squads:read', 'agents:read', 'workstreams:read'])
  const pause = {
    id: crypto.randomUUID(),
    pausedAt: new Date().toISOString(),
    reason: 'private pause reason',
    parkAt: null,
    agentIds: [],
  }
  const [pausedWithWait, pausedWithoutWait, manual] = await db
    .insert(workStreams)
    .values([
      { squadId: squad.id, title: 'Paused with wait', status: 'active', pause },
      { squadId: squad.id, title: 'Paused without wait', status: 'active', pause },
      { squadId: squad.id, title: 'Real manual blocker', status: 'active' },
    ])
    .returning()
  await db.insert(workStreamWaits).values([
    { workStreamId: pausedWithWait!.id, type: 'manual' },
    { workStreamId: manual!.id, type: 'manual' },
  ])
  const response = await activityRequest('/api/activity/presence', { headers: authHeaders(reader.token) })
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ needsYouCount: 1, streamCount: 3 })
  await subscribeToSquad(squad.id, reader.id)
  const { loadWorkInterestSnapshot } = await import('../services/push/work-interest')
  const snapshot = await loadWorkInterestSnapshot(reader.id)
  expect(snapshot.bucketCounts).toMatchObject({ needsYou: 1, paused: 2, running: 0, blocked: 0 })
  expect(snapshot.totalCount).toBe(3)
  expect(snapshot.top.find((row) => row.id === pausedWithoutWait!.id)).toMatchObject({ pause: true, bucket: 'paused' })
  expect(JSON.stringify(snapshot)).not.toContain('private pause reason')
})

describe('GET /api/activity/settled', () => {
  test('validates its query', async () => {
    const future = new Date(Date.now() + 60_000).toISOString()
    for (const query of ['', 'since=yesterday', `since=${future}`, 'since=2026-01-01T00:00:00Z&squadId=nope'])
      expect(
        (await activityRequest(`/api/activity/settled?${query}`, { headers: authHeaders(admin.token) })).status
      ).toBe(400)
    for (const query of [
      'settled=questions',
      'settled=completed&since=2026-01-01T00:00:00Z',
      'squadId=nope',
      // `until` only bounds a settled filter, and must be an instant.
      'until=2026-01-02T00:00:00Z',
      'settled=questions&since=2026-01-01T00:00:00Z&until=later',
    ])
      expect((await activityRequest(`/api/activity?${query}`, { headers: authHeaders(admin.token) })).status).toBe(400)
  })

  test('counts only squads and rows the caller may read, and lists the same rows', async () => {
    const squad = await seedSquad('settled-redaction')
    const [owner, worker] = await db
      .insert(agents)
      .values([
        { squadId: squad.id, agentTypeId: 'manager' },
        { squadId: squad.id, agentTypeId: 'engineer' },
      ])
      .returning()
    const [stream] = await db
      .insert(workStreams)
      .values({ squadId: squad.id, title: 'Settled route fixture', status: 'active', ownerAgentId: owner!.id })
      .returning()
    const request = {
      schemaVersion: 1 as const,
      kind: 'decide' as const,
      purpose: 'task-decision' as const,
      actor: 'owner' as const,
      subject: 'Pick one',
      options: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
      ],
    }
    const [wait] = await db
      .insert(workStreamWaits)
      .values({
        workStreamId: stream!.id,
        type: 'manual',
        actor: 'owner',
        createdBy: 'agent',
        createdByAgentId: worker!.id,
        resolvedByAgentId: owner!.id,
        structured: {
          request,
          summary: { attempted: 'Pick one', attemptCount: 0, lastError: null, text: 'Choose' },
          version: 1,
        },
        openedAt: new Date(Date.now() - 5 * 60_000),
        // Past the margin a count stops short of the clock by (ACTIVITY_SETTLED_MARGIN_MS).
        closedAt: new Date(Date.now() - 2 * 60_000),
        resolution: 'cleared',
      })
      .returning()
    await repairFixtures()
    const since = new Date(Date.now() - 3_600_000).toISOString()
    const settled = async (token: string, extra = '') => {
      const response = await activityRequest(`/api/activity/settled?since=${encodeURIComponent(since)}${extra}`, {
        headers: authHeaders(token),
      })
      expect(response.status).toBe(200)
      return ((await response.json()) as { counts: Record<string, number> }).counts
    }
    const reader = await scopedUser(squad.id, ['squads:read', 'workstreams:read'])
    const blind = await scopedUser(squad.id, ['squads:read'])
    const outsider = await scopedUser((await seedSquad('settled-elsewhere')).id, ['squads:read', 'workstreams:read'])
    expect(await settled(reader.token)).toMatchObject({ questions: 1 })
    expect(await settled(reader.token, `&squadId=${squad.id}`)).toMatchObject({ questions: 1 })
    expect(await settled(reader.token, `&squadId=${crypto.randomUUID()}`)).toMatchObject({ questions: 0 })
    expect(await settled(blind.token)).toEqual({ questions: 0, reviews: 0 })
    expect(await settled(outsider.token)).toEqual({ questions: 0, reviews: 0 })

    const list = async (token: string, until?: Date) => {
      const bound = until ? `&until=${encodeURIComponent(until.toISOString())}` : ''
      const response = await activityRequest(
        `/api/activity?settled=questions&since=${encodeURIComponent(since)}${bound}&squadId=${squad.id}`,
        { headers: authHeaders(token) }
      )
      expect(response.status).toBe(200)
      return ((await response.json()) as { items: Array<{ id: string }> }).items.map((item) => item.id)
    }
    expect(await list(reader.token)).toEqual([`41:${wait!.id}`])
    expect(await list(blind.token)).toEqual([])
    // `until` (the count's `through`) is exclusive: a count that ended before the wait settled lists
    // nothing, one that ended after lists it, and the bound never widens what a viewer may read.
    expect(await list(reader.token, new Date(Date.now() - 3 * 60_000))).toEqual([])
    expect(await list(reader.token, wait!.closedAt!)).toEqual([])
    expect(await list(reader.token, new Date(Date.now() - 60_000))).toEqual([`41:${wait!.id}`])
    expect(await list(blind.token, new Date(Date.now() - 60_000))).toEqual([])
  })
})
