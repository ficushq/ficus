import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import {
  FARM_CHAT_MESSAGE_MAX,
  validateFarmChatBody,
  validateFarmChatRoom,
  type FarmChatRoom,
  type FarmChatRooms,
} from '@ficus/shared'
import { hasPermission, type Identity } from '../services/rbac'
import { parseOptionalJsonObjectBody } from '../middleware/json-body-errors'
import {
  audienceOf,
  createRoom,
  deleteRoom,
  directRoom,
  FarmChatError,
  listMessages,
  listPeople,
  listRooms,
  markRead,
  postMessage,
  roomFor,
  updateRoom,
} from '../services/farm-chat'
import { wsManager } from '../services/ws/manager'

/*
 * The farm's chat (packages/shared farm-chat.ts). People only: every signed-in
 * person may read and post in the general room and public rooms, and use
 * their own DMs; creating, renaming and deleting public rooms needs
 * chat:manage-rooms (Operators hold it through chat:*). Live updates go out on
 * the `farmChat` WebSocket topic.
 */

const uuidParam = z.string().uuid()
const MESSAGE_PAGE = 50

export const farmChatRouter = new Hono()
farmChatRouter.use('*', bodyLimit({ maxSize: FARM_CHAT_MESSAGE_MAX * 4 + 1024 }))
farmChatRouter.onError((error, c) => {
  if (error instanceof FarmChatError) return c.json({ error: error.message }, error.status)
  throw error
})
// A malformed id is the same 404 as a missing one (and never reaches postgres).
farmChatRouter.use('/rooms/:id/*', async (c, next) => {
  if (!uuidParam.safeParse(c.req.param('id')).success) return c.json({ error: 'Room not found' }, 404)
  await next()
})

/** The signed-in person (never an agent or token), or null. */
function person(c: Context): { identity: Identity; userId: string } | null {
  const identity: Identity | undefined = c.get('identity')
  if (!identity || identity.type !== 'user') return null
  return { identity, userId: identity.userId }
}

function roomJson(room: Awaited<ReturnType<typeof roomFor>>, rooms: FarmChatRoom[]): FarmChatRoom | undefined {
  return rooms.find((entry) => entry.id === room.id)
}

farmChatRouter.get('/people', async (c) => {
  const me = person(c)
  if (!me) return c.json({ error: 'Unauthorized' }, 401)
  c.set('authzChecked', true)
  return c.json(await listPeople())
})

farmChatRouter.get('/rooms', async (c) => {
  const me = person(c)
  if (!me) return c.json({ error: 'Unauthorized' }, 401)
  c.set('authzChecked', true)
  const body: FarmChatRooms = {
    rooms: await listRooms(me.userId),
    canManageRooms: await hasPermission(me.identity, 'chat:manage-rooms'),
  }
  return c.json(body)
})

farmChatRouter.post('/rooms', async (c) => {
  const me = person(c)
  if (!me) return c.json({ error: 'Unauthorized' }, 401)
  c.set('authzChecked', true)
  if (!(await hasPermission(me.identity, 'chat:manage-rooms'))) return c.json({ error: 'Forbidden' }, 403)
  const input = validateFarmChatRoom(await parseOptionalJsonObjectBody(c, {}))
  if (!input.ok) return c.json({ error: input.error }, 400)
  const room = await createRoom(me.userId, input.name, input.description)
  wsManager.sendFarmChat('farmChat.roomsChanged', {})
  return c.json(roomJson(room, await listRooms(me.userId)), 201)
})

farmChatRouter.patch('/rooms/:id', async (c) => {
  const me = person(c)
  if (!me) return c.json({ error: 'Unauthorized' }, 401)
  c.set('authzChecked', true)
  if (!uuidParam.safeParse(c.req.param('id')).success) return c.json({ error: 'Room not found' }, 404)
  if (!(await hasPermission(me.identity, 'chat:manage-rooms'))) return c.json({ error: 'Forbidden' }, 403)
  const input = validateFarmChatRoom(await parseOptionalJsonObjectBody(c, {}))
  if (!input.ok) return c.json({ error: input.error }, 400)
  const room = await updateRoom(c.req.param('id'), input.name, input.description)
  wsManager.sendFarmChat('farmChat.roomsChanged', {})
  return c.json(roomJson(room, await listRooms(me.userId)))
})

farmChatRouter.delete('/rooms/:id', async (c) => {
  const me = person(c)
  if (!me) return c.json({ error: 'Unauthorized' }, 401)
  c.set('authzChecked', true)
  if (!uuidParam.safeParse(c.req.param('id')).success) return c.json({ error: 'Room not found' }, 404)
  if (!(await hasPermission(me.identity, 'chat:manage-rooms'))) return c.json({ error: 'Forbidden' }, 403)
  await deleteRoom(c.req.param('id'))
  wsManager.sendFarmChat('farmChat.roomsChanged', {})
  return c.body(null, 204)
})

farmChatRouter.post('/dms', async (c) => {
  const me = person(c)
  if (!me) return c.json({ error: 'Unauthorized' }, 401)
  c.set('authzChecked', true)
  const { userId } = await parseOptionalJsonObjectBody(c, {} as { userId?: unknown })
  if (typeof userId !== 'string' || !uuidParam.safeParse(userId).success)
    return c.json({ error: 'Person not found' }, 404)
  const room = await directRoom(me.userId, userId)
  return c.json(roomJson(room, await listRooms(me.userId)))
})

farmChatRouter.get('/rooms/:id/messages', async (c) => {
  const me = person(c)
  if (!me) return c.json({ error: 'Unauthorized' }, 401)
  c.set('authzChecked', true)
  const room = await roomFor(c.req.param('id'), me.userId)
  const beforeParam = c.req.query('before')
  const before = beforeParam ? new Date(beforeParam) : null
  if (before && Number.isNaN(before.getTime())) return c.json({ error: 'Invalid before' }, 400)
  return c.json(await listMessages(room.id, before, MESSAGE_PAGE))
})

farmChatRouter.post('/rooms/:id/messages', async (c) => {
  const me = person(c)
  if (!me) return c.json({ error: 'Unauthorized' }, 401)
  c.set('authzChecked', true)
  const room = await roomFor(c.req.param('id'), me.userId)
  const { body } = await parseOptionalJsonObjectBody(c, {} as { body?: unknown })
  const input = validateFarmChatBody(body)
  if (!input.ok) return c.json({ error: input.error }, 400)
  const message = await postMessage(room.id, me.userId, input.body)
  wsManager.sendFarmChat('farmChat.messageCreated', { message }, audienceOf(room) ?? undefined)
  return c.json(message, 201)
})

farmChatRouter.post('/rooms/:id/read', async (c) => {
  const me = person(c)
  if (!me) return c.json({ error: 'Unauthorized' }, 401)
  c.set('authzChecked', true)
  const room = await roomFor(c.req.param('id'), me.userId)
  await markRead(room.id, me.userId)
  return c.body(null, 204)
})
