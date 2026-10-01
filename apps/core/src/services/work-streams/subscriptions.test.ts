import { storedLegacyWorkStream } from '../../test-utils/stored-legacy-work-stream'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { and, eq, inArray } from 'drizzle-orm'
import { db, inbox, squads, workStreams } from '../../db'
import { Squad } from '../../entities/Squad'
import { notifyWorkStreamBlocked, notifyWorkStreamReview } from '../squad/work-stream-notifications'
import {
  subscribeToWorkStream,
  unsubscribeFromWorkStream,
  isSubscribedToWorkStream,
  listWorkStreamSubscriberIds,
  listSquadWorkStreamSubscriberIds,
  getWorkStreamAttention,
} from './subscriptions'
import { assignRole, cleanupTestRbac, createTestRole, createTestUser, type TestUser } from '../../test-utils'

const prefix = `wssub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

let squad: Squad
let user: TestUser

beforeAll(async () => {
  user = await createTestUser({ prefix })
  squad = await Squad.create({ name: `${prefix} Squad`, purpose: 'work-stream subscription test' })
  // Notices are permission-gated before attention: without a reader role the subscriber hears nothing.
  const role = await createTestRole({ prefix, permissions: ['workstreams:read'] })
  await assignRole({ userId: user.id, roleId: role.id, scope: 'squad', squadId: squad.id })
})

afterAll(async () => {
  await db.delete(inbox).where(inArray(inbox.recipientId, [user.id]))
  await db.delete(workStreams).where(eq(workStreams.squadId, squad.id))
  await db.delete(squads).where(eq(squads.id, squad.id))
  await cleanupTestRbac(prefix)
})

describe('work-stream subscriptions', () => {
  it('slot refresh finds direct nonterminal stream subscribers only in the affected squad', async () => {
    const other = await Squad.create({ name: `${prefix} unrelated`, purpose: 'unrelated squad' })
    try {
      const active = await storedLegacyWorkStream({ squadId: squad.id, title: 'slot affected' })
      const duplicate = await storedLegacyWorkStream({ squadId: squad.id, title: 'second stream' })
      const unrelated = await storedLegacyWorkStream({ squadId: other.id, title: 'unrelated' })
      await subscribeToWorkStream(active.id, user.id)
      await subscribeToWorkStream(duplicate.id, user.id)
      expect(await listSquadWorkStreamSubscriberIds(squad.id)).toEqual([user.id])
      expect(await listSquadWorkStreamSubscriberIds(other.id)).toEqual([])
      await subscribeToWorkStream(unrelated.id, user.id)
      await db
        .update(workStreams)
        .set({ status: 'done' })
        .where(inArray(workStreams.id, [active.id, duplicate.id]))
      expect(await listSquadWorkStreamSubscriberIds(squad.id)).toEqual([])
      expect(await listSquadWorkStreamSubscriberIds(other.id)).toEqual([user.id])
    } finally {
      await db.delete(workStreams).where(eq(workStreams.squadId, other.id))
      await db.delete(squads).where(eq(squads.id, other.id))
    }
  })

  it('subscribe / isSubscribed / list / unsubscribe (idempotent)', async () => {
    const ws = await storedLegacyWorkStream({ squadId: squad.id, title: `${prefix} ws1` })
    expect(await isSubscribedToWorkStream(ws.id, user.id)).toBe(false)

    await subscribeToWorkStream(ws.id, user.id)
    await subscribeToWorkStream(ws.id, user.id) // idempotent
    expect(await isSubscribedToWorkStream(ws.id, user.id)).toBe(true)
    expect(await listWorkStreamSubscriberIds(ws.id)).toEqual([user.id])

    await subscribeToWorkStream(ws.id, user.id, { decisions: 'show', progress: 'mute' })
    expect(await getWorkStreamAttention(ws.id, user.id)).toEqual({ decisions: 'show', progress: 'mute' })

    await unsubscribeFromWorkStream(ws.id, user.id)
    expect(await isSubscribedToWorkStream(ws.id, user.id)).toBe(false)
    expect(await getWorkStreamAttention(ws.id, user.id)).toBeNull()
  })

  it("delivers decision and completion updates to a subscriber's personal inbox", async () => {
    const ws = await storedLegacyWorkStream({ squadId: squad.id, title: `${prefix} ws2` })
    await subscribeToWorkStream(ws.id, user.id)

    await notifyWorkStreamBlocked(ws)
    await notifyWorkStreamReview(ws)

    const msgs = await db
      .select()
      .from(inbox)
      .where(and(eq(inbox.recipientType, 'user'), eq(inbox.recipientId, user.id)))
    expect(
      msgs.some(
        (m) =>
          (m.metadata as Record<string, unknown>)?.workStreamId === ws.id &&
          (m.metadata as Record<string, unknown>)?.event === 'blocked'
      )
    ).toBe(true)
    expect(
      msgs.some(
        (m) =>
          (m.metadata as Record<string, unknown>)?.workStreamId === ws.id &&
          (m.metadata as Record<string, unknown>)?.event === 'review'
      )
    ).toBe(true)
  })
})
