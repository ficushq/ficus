import { afterAll, beforeAll, expect, test } from 'bun:test'
import { eq, inArray, sql } from 'drizzle-orm'
import { db, desktopNotifications } from '../../db'
import { deviceTokens } from '../../db/schema'
import { cleanupTestRbac, createTestUser, type TestUser } from '../../test-utils'
import { UserNotificationPreferences } from '../../entities/UserNotificationPreferences'
import { enqueueDesktopNotifications, listDesktopNotifications } from './desktop'
import { createDeviceToken, revokeDeviceToken } from '../auth/device-tokens'
import { Hono } from 'hono'
import { pushRouter } from '../../routes/push'

const prefix = `desktop-notifications-${crypto.randomUUID()}`
let user: TestUser, other: TestUser
beforeAll(async () => {
  user = await createTestUser({ prefix })
  other = await createTestUser({ prefix })
})
afterAll(async () => {
  await db.delete(desktopNotifications).where(inArray(desktopNotifications.userId, [user.id, other.id]))
  await cleanupTestRbac(prefix)
})
test('desktop alerts are user scoped, bounded by retention, and obey current privacy and mute preferences', async () => {
  const item = {
    eventKey: 'one',
    eventType: 'inbox.messageReceived',
    category: 'message',
    title: 'Private title',
    body: 'Private body',
    url: '/inbox',
  }
  await db.insert(desktopNotifications).values([
    { ...item, userId: user.id },
    { ...item, userId: other.id },
    { ...item, userId: user.id, eventKey: 'old', createdAt: sql`now() - interval '8 days'` },
  ])
  expect(await listDesktopNotifications(user.id)).toHaveLength(1)
  await UserNotificationPreferences.upsert(user.id, { showPreviews: false })
  expect((await listDesktopNotifications(user.id))[0]).toMatchObject({
    title: 'Ficus update',
    body: 'Open Ficus to see your update.',
  })
  await UserNotificationPreferences.upsert(user.id, { mutedEvents: ['message'] })
  expect(await listDesktopNotifications(user.id)).toEqual([])
  await UserNotificationPreferences.upsert(user.id, { mutedEvents: [], pushEnabled: false })
  expect(await listDesktopNotifications(user.id)).toEqual([])
  expect(await listDesktopNotifications(other.id)).toHaveLength(1)
  expect(await db.select().from(desktopNotifications).where(eq(desktopNotifications.userId, user.id))).toHaveLength(2)
})
test('enqueue targets managed desktop homes and users with a paired desktop device, once per event', async () => {
  const previous = process.env.FICUS_DESKTOP_MANAGED
  const event = (title: string) => ({
    type: 'inbox',
    messageId: crypto.randomUUID(),
    title,
    body: 'An update',
    timestamp: new Date(),
  })
  const titles = async (id: string) => (await listDesktopNotifications(id)).map((row) => row.title)
  try {
    // The previous test left user.id's push preferences disabled; restore defaults so
    // listDesktopNotifications actually reflects what this test enqueues.
    await UserNotificationPreferences.upsert(user.id, { pushEnabled: true, mutedEvents: [], showPreviews: true })
    delete process.env.FICUS_DESKTOP_MANAGED
    await enqueueDesktopNotifications([user.id, other.id], event('Unpaired'), 'inbox.messageReceived', 'message')
    expect(await titles(user.id)).not.toContain('Unpaired')

    const paired = await createDeviceToken({ userId: user.id, name: 'Mac', platform: 'desktop' })
    await createDeviceToken({ userId: other.id, name: 'CLI', platform: 'cli' })
    const once = event('Paired')
    await enqueueDesktopNotifications([user.id, other.id], once, 'inbox.messageReceived', 'message')
    await enqueueDesktopNotifications([user.id], once, 'inbox.messageReceived', 'message')
    expect((await titles(user.id)).filter((t) => t === 'Paired')).toHaveLength(1)
    expect(await titles(other.id)).not.toContain('Paired')

    await revokeDeviceToken(user.id, paired.id)
    await enqueueDesktopNotifications([user.id], event('Revoked'), 'inbox.messageReceived', 'message')
    expect(await titles(user.id)).not.toContain('Revoked')

    process.env.FICUS_DESKTOP_MANAGED = '1'
    await enqueueDesktopNotifications([other.id], event('Managed'), 'inbox.messageReceived', 'message')
    expect(await titles(other.id)).toContain('Managed')
  } finally {
    if (previous === undefined) delete process.env.FICUS_DESKTOP_MANAGED
    else process.env.FICUS_DESKTOP_MANAGED = previous
    await db.delete(deviceTokens).where(inArray(deviceTokens.userId, [user.id, other.id]))
  }
})
test('desktop notification endpoint derives its user from the human session, never query parameters', async () => {
  const app = new Hono()
  app.use('*', async (c, next) => {
    c.set('identity', { type: 'user', userId: other.id })
    await next()
  })
  app.route('/push', pushRouter)
  const response = await app.request(`/push/desktop?userId=${user.id}`)
  expect(response.status).toBe(200)
  expect((await response.json()).userId).toBe(other.id)
  const unauthenticated = new Hono().route('/push', pushRouter)
  expect((await unauthenticated.request('/push/desktop')).status).toBe(401)
})
