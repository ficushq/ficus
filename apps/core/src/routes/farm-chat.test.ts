import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { eq, inArray } from 'drizzle-orm'
import { farmChatRouter } from './farm-chat'
import { identityMiddleware } from '../middleware/identity'
import { jsonBodyErrorHandler, jsonBodyErrorMiddleware } from '../middleware/json-body-errors'
import { assignRole, authHeaders, cleanupTestRbac, createTestRole, createTestUser, type TestUser } from '../test-utils'
import { db, farmChatMessages, farmChatRooms } from '../db'
import { pruneFarmChat } from '../services/farm-chat'

const prefix = `farm-chat-${crypto.randomUUID()}`
let alice: TestUser
let bob: TestUser
let carol: TestUser
let manager: TestUser
const createdRooms: string[] = []

const app = new Hono()
app.use('*', jsonBodyErrorMiddleware)
app.onError(jsonBodyErrorHandler)
app.use('*', identityMiddleware)
app.route('/farm-chat', farmChatRouter)

const call = (user: TestUser | null, method: string, path: string, body?: unknown) =>
  app.request(`/farm-chat${path}`, {
    method,
    headers: {
      ...(user ? authHeaders(user.token) : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
const json = async (response: Response) => response.json() as Promise<any>
const rooms = async (user: TestUser) => (await json(await call(user, 'GET', '/rooms'))).rooms as any[]
const general = async (user: TestUser) => (await rooms(user)).find((room) => room.kind === 'general')!

beforeAll(async () => {
  alice = await createTestUser({ prefix, displayName: 'Alice' })
  bob = await createTestUser({ prefix, displayName: 'Bob' })
  carol = await createTestUser({ prefix, displayName: '' })
  manager = await createTestUser({ prefix, displayName: 'Manager' })
  const role = await createTestRole({ prefix, permissions: ['chat:manage-rooms'] })
  await assignRole({ userId: manager.id, roleId: role.id, scope: 'system' })
})

afterAll(async () => {
  if (createdRooms.length) await db.delete(farmChatRooms).where(inArray(farmChatRooms.id, createdRooms))
  await cleanupTestRbac(prefix)
})

describe('farm chat', () => {
  test('is for signed-in people only', async () => {
    for (const [method, path] of [
      ['GET', '/people'],
      ['GET', '/rooms'],
      ['POST', '/rooms'],
      ['POST', '/dms'],
    ] as const)
      expect((await call(null, method, path)).status).toBe(401)
  })

  test('lists everyone by display name, else email', async () => {
    const people = (await json(await call(alice, 'GET', '/people'))) as Array<{ id: string; name: string }>
    expect(people.find((p) => p.id === bob.id)?.name).toBe('Bob')
    expect(people.find((p) => p.id === carol.id)?.name).toBe(carol.email)
  })

  test('everyone has the general room, can post in it, and sees unread counts', async () => {
    const room = await general(alice)
    expect(room).toMatchObject({ kind: 'general', name: 'general', withUserId: null })
    const sent = await call(alice, 'POST', `/rooms/${room.id}/messages`, { body: '  hello farm  ' })
    expect(sent.status).toBe(201)
    expect(await json(sent)).toMatchObject({ roomId: room.id, senderUserId: alice.id, body: 'hello farm' })
    // Your own messages don't count as unread; others' do until you read the room.
    expect((await general(alice)).unread).toBe(0)
    expect((await general(bob)).unread).toBeGreaterThanOrEqual(1)
    expect((await call(bob, 'POST', `/rooms/${room.id}/read`)).status).toBe(204)
    expect((await general(bob)).unread).toBe(0)
    const page = await json(await call(bob, 'GET', `/rooms/${room.id}/messages`))
    expect(page.messages.at(-1)).toMatchObject({ body: 'hello farm', senderUserId: alice.id })
  })

  test('rejects empty or oversized messages, and pages older ones', async () => {
    const room = await general(alice)
    expect((await call(alice, 'POST', `/rooms/${room.id}/messages`, { body: '   ' })).status).toBe(400)
    expect((await call(alice, 'POST', `/rooms/${room.id}/messages`, { body: 'x'.repeat(4001) })).status).toBe(400)
    const first = await json(await call(alice, 'GET', `/rooms/${room.id}/messages`))
    const oldest = first.messages[0].createdAt
    const before = await json(
      await call(alice, 'GET', `/rooms/${room.id}/messages?before=${encodeURIComponent(oldest)}`)
    )
    for (const message of before.messages) expect(message.createdAt < oldest).toBe(true)
    expect((await call(alice, 'GET', `/rooms/${room.id}/messages?before=soon`)).status).toBe(400)
  })

  test('managing rooms needs chat:manage-rooms; the general room always stays', async () => {
    expect((await json(await call(alice, 'GET', '/rooms'))).canManageRooms).toBe(false)
    expect((await json(await call(manager, 'GET', '/rooms'))).canManageRooms).toBe(true)
    const name = `design-${prefix.slice(-6)}`
    expect((await call(alice, 'POST', '/rooms', { name })).status).toBe(403)
    const created = await call(manager, 'POST', '/rooms', { name, description: 'pixels' })
    expect(created.status).toBe(201)
    const room = await json(created)
    createdRooms.push(room.id)
    expect(room).toMatchObject({ kind: 'room', name, description: 'pixels' })
    // Everyone sees it and can talk in it.
    expect((await rooms(bob)).some((entry) => entry.id === room.id)).toBe(true)
    expect((await call(bob, 'POST', `/rooms/${room.id}/messages`, { body: 'hi' })).status).toBe(201)
    // Names are unique, whatever the case.
    expect((await call(manager, 'POST', '/rooms', { name: name.toUpperCase() })).status).toBe(409)
    expect((await call(alice, 'PATCH', `/rooms/${room.id}`, { name: 'x' })).status).toBe(403)
    const renamed = await call(manager, 'PATCH', `/rooms/${room.id}`, { name: `${name}-2` })
    expect(await json(renamed)).toMatchObject({ name: `${name}-2`, description: null })
    const generalRoom = await general(manager)
    expect((await call(manager, 'PATCH', `/rooms/${generalRoom.id}`, { name: 'lobby' })).status).toBe(400)
    expect((await call(manager, 'DELETE', `/rooms/${generalRoom.id}`)).status).toBe(400)
    expect((await call(alice, 'DELETE', `/rooms/${room.id}`)).status).toBe(403)
    expect((await call(manager, 'DELETE', `/rooms/${room.id}`)).status).toBe(204)
    expect((await rooms(bob)).some((entry) => entry.id === room.id)).toBe(false)
    expect((await call(bob, 'GET', `/rooms/${room.id}/messages`)).status).toBe(404)
  })

  test('DMs are between two people only', async () => {
    const opened = await json(await call(alice, 'POST', '/dms', { userId: bob.id }))
    createdRooms.push(opened.id)
    expect(opened).toMatchObject({ kind: 'dm', name: 'Bob', withUserId: bob.id })
    // Either side opens the same DM.
    const fromBob = await json(await call(bob, 'POST', '/dms', { userId: alice.id }))
    expect(fromBob).toMatchObject({ id: opened.id, name: 'Alice', withUserId: alice.id })
    expect((await call(alice, 'POST', `/rooms/${opened.id}/messages`, { body: 'psst' })).status).toBe(201)
    expect((await rooms(bob)).find((room) => room.id === opened.id)?.unread).toBe(1)
    // Nobody else can see it, read it or post in it.
    expect((await rooms(carol)).some((room) => room.id === opened.id)).toBe(false)
    expect((await call(carol, 'GET', `/rooms/${opened.id}/messages`)).status).toBe(404)
    expect((await call(carol, 'POST', `/rooms/${opened.id}/messages`, { body: 'hi' })).status).toBe(404)
    // A DM isn't a room to manage.
    expect((await call(manager, 'DELETE', `/rooms/${opened.id}`)).status).toBe(404)
    expect((await call(alice, 'POST', '/dms', { userId: alice.id })).status).toBe(400)
    expect((await call(alice, 'POST', '/dms', { userId: crypto.randomUUID() })).status).toBe(404)
    expect((await call(alice, 'POST', '/dms', { userId: 'nope' })).status).toBe(404)
  })

  test('a malformed room id is a 404', async () => {
    expect((await call(alice, 'GET', '/rooms/nope/messages')).status).toBe(404)
  })
})

describe('farm chat retention', () => {
  test('deletes messages older than 30 days and keeps newer ones', async () => {
    const room = await general(alice)
    const now = new Date('2026-09-27T12:00:00Z')
    const days = (n: number) => new Date(now.getTime() - n * 86_400_000)
    const [old] = await db
      .insert(farmChatMessages)
      .values({ roomId: room.id, senderUserId: alice.id, body: 'old', createdAt: days(31) })
      .returning()
    const [recent] = await db
      .insert(farmChatMessages)
      .values({ roomId: room.id, senderUserId: alice.id, body: 'recent', createdAt: days(29) })
      .returning()
    expect(await pruneFarmChat({ now })).toBeGreaterThanOrEqual(1)
    expect(await db.select().from(farmChatMessages).where(eq(farmChatMessages.id, old!.id))).toHaveLength(0)
    expect(await db.select().from(farmChatMessages).where(eq(farmChatMessages.id, recent!.id))).toHaveLength(1)
    await db.delete(farmChatMessages).where(eq(farmChatMessages.id, recent!.id))
  })
})
