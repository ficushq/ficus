import { afterAll, beforeAll, expect, test, spyOn } from 'bun:test'
import { Hono } from 'hono'
import { eq, inArray, sql } from 'drizzle-orm'
import { db } from '../db'
import { feedCompletionViews, squads, users, workStreams } from '../db/schema'
import { WorkStream } from '../entities/WorkStream'
import { identityMiddleware } from '../middleware/identity'
import { workStreamsRouter } from './work-streams'
import { createTestAdmin, createTestUser, cleanupTestRbac, authHeaders, type TestUser } from '../test-utils'
import { subscribeToWorkStream } from '../services/work-streams/subscriptions'
import { subscribeToSquad } from '../services/squad/subscriptions'

const app = new Hono().use('*', identityMiddleware).route('/api/workstreams', workStreamsRouter)
const prefix = `feed-exposure-${Date.now()}`
let owner: TestUser
let other: TestUser
let denied: TestUser
let squadId: string
let newest: string
let older: string
const at = '2026-01-02T00:00:00.000Z'
const oldAt = '2026-01-01T00:00:00.000Z'
const request = (user: TestUser, path: string, body?: unknown) =>
  app.request(`/api/workstreams${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { ...authHeaders(user.token), 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
const list = async (user: TestUser, extra = '') => {
  const response = await request(user, `?statuses=done&limit=1&feedUpdates=true&squadId=${squadId}${extra}`)
  expect(response.status).toBe(200)
  return response.json() as Promise<{ items: { id: string }[]; totalCount: number; nextCursor: string }>
}
beforeAll(async () => {
  owner = await createTestAdmin({ prefix })
  other = await createTestAdmin({ prefix })
  denied = await createTestUser({ prefix })
  // Existing accounts predate their missed completions; NULL is not an unbounded baseline.
  await db
    .update(users)
    .set({ createdAt: new Date('2025-01-01T00:00:00Z') })
    .where(inArray(users.id, [owner.id, other.id]))
  ;[{ id: squadId }] = await db.insert(squads).values({ name: prefix, purpose: 'Feed exposure tests' }).returning()
  const create = async (title: string, completedAt: string) => {
    const [row] = await db
      .insert(workStreams)
      .values({ squadId, title, status: 'done', metadata: { completion: { completedAt } } })
      .returning()
    return row.id
  }
  newest = await create('Newest', at)
  older = await create('Unseen older completion', oldAt)
})
afterAll(async () => {
  if (squadId) await db.delete(squads).where(eq(squads.id, squadId))
  await cleanupTestRbac(prefix)
})

test('only exact exposed completions disappear; receipts are idempotent and account isolated', async () => {
  const first = await list(owner)
  expect(first.items.map((row) => row.id)).toEqual([newest])
  expect(first.totalCount).toBe(2)
  const seen = () => request(owner, `/${newest}/feed-seen`, { completedAt: at })
  expect((await seen()).status).toBe(200)
  expect((await seen()).status).toBe(200)
  expect((await list(owner)).items.map((row) => row.id)).toEqual([older])
  expect((await list(owner, `&cursor=${encodeURIComponent(first.nextCursor)}`)).items.map((row) => row.id)).toEqual([
    older,
  ])
  expect((await list(other)).totalCount).toBe(2)
  const history = await request(owner, `?statuses=done&limit=20&squadId=${squadId}`)
  expect((await history.json()).totalCount).toBe(2)
})

test('rejects unauthorized, malformed and future/replaced completion acknowledgements', async () => {
  expect((await request(denied, `/${older}/feed-seen`, { completedAt: oldAt })).status).toBe(403)
  expect((await request(owner, `/${older}/feed-seen`, { completedAt: 'not a date' })).status).toBe(400)
  expect((await request(owner, `/${older}/feed-seen`, { completedAt: at })).status).toBe(409)
  expect((await list(owner)).totalCount).toBe(1)
  await db
    .update(workStreams)
    .set({ metadata: { completion: { completedAt: '2026-02-01T00:00:00.000Z' } } })
    .where(eq(workStreams.id, newest))
  expect((await list(owner)).totalCount).toBe(2)
})

test('attention filtering happens before pagination and counting; hidden completions remain unseen', async () => {
  await subscribeToSquad(squadId, other.id, { progress: 'mute', decisions: 'show' })
  expect((await list(other)).totalCount).toBe(0)
  await subscribeToWorkStream(older, other.id, { progress: 'show', decisions: 'show' })
  expect((await list(other)).items.map((row) => row.id)).toEqual([older])
  expect((await list(other)).totalCount).toBe(1)
  await subscribeToSquad(squadId, other.id, { progress: 'show', decisions: 'show' })
  expect((await list(other)).totalCount).toBe(2)
})

test('out-of-order completion older than an exposed row is still new; invalid completion dates stay in history only', async () => {
  const [delayed] = await db
    .insert(workStreams)
    .values({
      squadId,
      title: 'Delayed delivery',
      status: 'done',
      metadata: { completion: { completedAt: '2025-12-01T00:00:00.000Z' } },
    })
    .returning()
  const [invalid] = await db
    .insert(workStreams)
    .values({
      squadId,
      title: 'Invalid legacy date',
      status: 'done',
      metadata: { completion: { completedAt: 'invalid' } },
    })
    .returning()
  expect((await list(owner)).totalCount).toBe(3)
  expect((await request(owner, `/${invalid.id}/feed-seen`, { completedAt: at })).status).toBe(409)
  expect((await request(owner, `/${delayed.id}/feed-seen`, { completedAt: '2025-12-01T00:00:00.000Z' })).status).toBe(
    200
  )
})

test('concurrent receipts are idempotent and cannot advance the frozen legacy boundary', async () => {
  await db
    .update(users)
    .set({ feedUpdatesAfter: new Date(oldAt), lastFeedVisitAt: new Date('2027-01-01T00:00:00Z') })
    .where(eq(users.id, owner.id))
  expect((await list(owner)).items.map((row) => row.id)).toEqual([newest])
  const responses = await Promise.all(
    Array.from({ length: 3 }, () => request(owner, `/${newest}/feed-seen`, { completedAt: '2026-02-01T00:00:00.000Z' }))
  )
  expect(responses.map((response) => response.status)).toEqual([200, 200, 200])
  expect((await list(owner)).totalCount).toBe(0)
  const [account] = await db.select({ boundary: users.feedUpdatesAfter }).from(users).where(eq(users.id, owner.id))
  expect(account.boundary?.toISOString()).toBe(oldAt)
  expect((await list(other)).totalCount).toBe(3)
})

test('feed query and acknowledgement cannot accept active work or bypass authorization', async () => {
  const [active] = await db
    .insert(workStreams)
    .values({ squadId, title: 'Still working', status: 'active' })
    .returning()
  expect((await request(owner, `/${active.id}/feed-seen`, { completedAt: at })).status).toBe(409)
  expect((await request(owner, `?statuses=active&limit=20&feedUpdates=true&squadId=${squadId}`)).status).toBe(400)
  expect((await request(owner, `?statuses=done&feedUpdates=true&squadId=${squadId}`)).status).toBe(400)
  expect((await request(denied, `?statuses=done&limit=20&feedUpdates=true&squadId=${squadId}`)).status).toBe(403)
})

test('a new account sees no historical Updates on its first visit but does see subsequent completions', async () => {
  const newcomer = await createTestAdmin({ prefix })
  expect((await list(newcomer)).totalCount).toBe(0)
  const [live] = await db
    .insert(workStreams)
    .values({
      squadId,
      title: 'After account creation',
      status: 'done',
      metadata: { completion: { completedAt: new Date(Date.now() + 1000).toISOString() } },
    })
    .returning()
  expect((await list(newcomer)).items.map((row) => row.id)).toEqual([live.id])
})

test('undated legacy completions stay in history and cannot replay after metadata edits', async () => {
  const before = (await list(other)).totalCount
  const [legacy] = await db
    .insert(workStreams)
    .values({ squadId, title: 'Legacy completion', status: 'done', updatedAt: new Date() })
    .returning()
  expect((await list(other)).totalCount).toBe(before)
  expect(
    (await request(other, `/${legacy.id}/feed-seen`, { completedAt: legacy.updatedAt.toISOString() })).status
  ).toBe(409)
  await db
    .update(workStreams)
    .set({ title: 'Edited legacy completion', updatedAt: new Date(Date.now() + 1000) })
    .where(eq(workStreams.id, legacy.id))
  expect((await list(other)).totalCount).toBe(before)
  const history = await request(other, `?statuses=done&limit=200&squadId=${squadId}`)
  expect((await history.json()).items.some((row: { id: string }) => row.id === legacy.id)).toBe(true)
})

test('exact receipt timestamps do not depend on the database session time zone', async () => {
  const completedAt = '2026-03-01T12:34:56.789Z'
  const [row] = await db
    .insert(workStreams)
    .values({ squadId, title: 'Timezone invariant', status: 'done', metadata: { completion: { completedAt } } })
    .returning()
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL TIME ZONE 'America/Los_Angeles'`)
    // Route the real entity statement through this real transaction to control only its session setting.
    const execute = spyOn(db, 'execute').mockImplementation(tx.execute.bind(tx))
    try {
      expect(await WorkStream.acknowledgeFeedCompletion(owner.id, row.id, new Date(completedAt))).toBe(true)
    } finally {
      execute.mockRestore()
    }
    const [receipt] = await tx.select().from(feedCompletionViews).where(eq(feedCompletionViews.workStreamId, row.id))
    expect(receipt.completedAt.toISOString()).toBe(completedAt)
  })
  const result = await request(owner, `?statuses=done&limit=200&feedUpdates=true&squadId=${squadId}`)
  expect((await result.json()).items.some((item: { id: string }) => item.id === row.id)).toBe(false)
})
