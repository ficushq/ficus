import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import {
  FARM_CHAT_MESSAGE_MAX,
  validateFarmChatBody,
  validateFarmChatReaction,
  validateFarmChatRoom,
  type FarmChatRoom,
  type FarmChatRooms,
} from '@ficus/shared'
import { hasPermission, type Identity } from '../services/rbac'
import { parseOptionalJsonObjectBody } from '../middleware/json-body-errors'
import {
  audienceOf,
  createRoom,
  deleteMessage,
  deleteRoom,
  directRoom,
  editMessage,
  reactToMessage,
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
 * The farm's chat (packages/shared farm-chat.ts). People only (never agents or
 * tokens), by the instance-wide farm: permissions: reading rooms, messages and
 * the people list needs farm:read; posting, editing, reacting and DMs need
 * farm:chat (and only a message's sender can edit or delete it); creating,
 * renaming and deleting public rooms need farm:manage-rooms (Operators hold
 * farm:*). People's emails are only shown to callers with users:read. Live
 * updates go out on the `farmChat` WebSocket topic.
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

type Person = { identity: Identity; userId: string }

/** The signed-in person (never an agent or token), or null. */
function person(c: Context): Person | null {
  const identity: Identity | undefined = c.get('identity')
  if (!identity || identity.type !== 'user') return null
  return { identity, userId: identity.userId }
}

/** The signed-in person if they hold `permission`; otherwise the 401/403 to answer with. */
async function allowed(c: Context, permission: string): Promise<Person | Response> {
  const me = person(c)
  if (!me) return c.json({ error: 'Unauthorized' }, 401)
  c.set('authzChecked', true)
  if (!(await hasPermission(me.identity, permission))) return c.json({ error: 'Forbidden' }, 403)
  return me
}

const reader = (c: Context) => allowed(c, 'farm:read')
const chatter = (c: Context) => allowed(c, 'farm:chat')
const roomManager = (c: Context) => allowed(c, 'farm:manage-rooms')
/** Whether this caller may see people's emails (as the user directory needs users:read). */
const seesEmails = (me: Person) => hasPermission(me.identity, 'users:read')

function roomJson(room: Awaited<ReturnType<typeof roomFor>>, rooms: FarmChatRoom[]): FarmChatRoom | undefined {
  return rooms.find((entry) => entry.id === room.id)
}

farmChatRouter.get('/people', async (c) => {
  const me = await reader(c)
  if (me instanceof Response) return me
  return c.json(await listPeople(await seesEmails(me)))
})

farmChatRouter.get('/rooms', async (c) => {
  const me = await reader(c)
  if (me instanceof Response) return me
  const body: FarmChatRooms = {
    rooms: await listRooms(me.userId, await seesEmails(me)),
    canChat: await hasPermission(me.identity, 'farm:chat'),
    canManageRooms: await hasPermission(me.identity, 'farm:manage-rooms'),
  }
  return c.json(body)
})

farmChatRouter.post('/rooms', async (c) => {
  const me = await roomManager(c)
  if (me instanceof Response) return me
  const input = validateFarmChatRoom(await parseOptionalJsonObjectBody(c, {}))
  if (!input.ok) return c.json({ error: input.error }, 400)
  const room = await createRoom(me.userId, input.name, input.description)
  wsManager.sendFarmChat('farmChat.roomsChanged', {})
  return c.json(roomJson(room, await listRooms(me.userId, await seesEmails(me))), 201)
})

farmChatRouter.patch('/rooms/:id', async (c) => {
  const me = await roomManager(c)
  if (me instanceof Response) return me
  if (!uuidParam.safeParse(c.req.param('id')).success) return c.json({ error: 'Room not found' }, 404)
  const input = validateFarmChatRoom(await parseOptionalJsonObjectBody(c, {}))
  if (!input.ok) return c.json({ error: input.error }, 400)
  const room = await updateRoom(c.req.param('id'), input.name, input.description)
  wsManager.sendFarmChat('farmChat.roomsChanged', {})
  return c.json(roomJson(room, await listRooms(me.userId, await seesEmails(me))))
})

farmChatRouter.delete('/rooms/:id', async (c) => {
  const me = await roomManager(c)
  if (me instanceof Response) return me
  if (!uuidParam.safeParse(c.req.param('id')).success) return c.json({ error: 'Room not found' }, 404)
  await deleteRoom(c.req.param('id'))
  wsManager.sendFarmChat('farmChat.roomsChanged', {})
  return c.body(null, 204)
})

farmChatRouter.post('/dms', async (c) => {
  const me = await chatter(c)
  if (me instanceof Response) return me
  const { userId } = await parseOptionalJsonObjectBody(c, {} as { userId?: unknown })
  if (typeof userId !== 'string' || !uuidParam.safeParse(userId).success)
    return c.json({ error: 'Person not found' }, 404)
  const room = await directRoom(me.userId, userId)
  return c.json(roomJson(room, await listRooms(me.userId, await seesEmails(me))))
})

farmChatRouter.get('/rooms/:id/messages', async (c) => {
  const me = await reader(c)
  if (me instanceof Response) return me
  const room = await roomFor(c.req.param('id'), me.userId)
  // The page before a message (its id): see listMessages.
  const before = c.req.query('before') ?? null
  if (before && !uuidParam.safeParse(before).success) return c.json({ error: 'Invalid before' }, 400)
  return c.json(await listMessages(room.id, before, MESSAGE_PAGE))
})

farmChatRouter.post('/rooms/:id/messages', async (c) => {
  const me = await chatter(c)
  if (me instanceof Response) return me
  const room = await roomFor(c.req.param('id'), me.userId)
  const { body } = await parseOptionalJsonObjectBody(c, {} as { body?: unknown })
  const input = validateFarmChatBody(body)
  if (!input.ok) return c.json({ error: input.error }, 400)
  const message = await postMessage(room.id, me.userId, input.body)
  wsManager.sendFarmChat('farmChat.messageCreated', { message }, audienceOf(room) ?? undefined)
  return c.json(message, 201)
})

/** Edits a message; only its sender may. */
farmChatRouter.patch('/rooms/:id/messages/:messageId', async (c) => {
  const me = await chatter(c)
  if (me instanceof Response) return me
  if (!uuidParam.safeParse(c.req.param('messageId')).success) return c.json({ error: 'Message not found' }, 404)
  const room = await roomFor(c.req.param('id'), me.userId)
  const { body } = await parseOptionalJsonObjectBody(c, {} as { body?: unknown })
  const input = validateFarmChatBody(body)
  if (!input.ok) return c.json({ error: input.error }, 400)
  const message = await editMessage(room.id, c.req.param('messageId'), me.userId, input.body)
  wsManager.sendFarmChat('farmChat.messageUpdated', { message }, audienceOf(room) ?? undefined)
  return c.json(message)
})

/** Deletes one of your own messages for everyone. */
farmChatRouter.delete('/rooms/:id/messages/:messageId', async (c) => {
  const me = await chatter(c)
  if (me instanceof Response) return me
  if (!uuidParam.safeParse(c.req.param('messageId')).success) return c.json({ error: 'Message not found' }, 404)
  const room = await roomFor(c.req.param('id'), me.userId)
  const messageId = c.req.param('messageId')
  await deleteMessage(room.id, messageId, me.userId)
  wsManager.sendFarmChat('farmChat.messageDeleted', { roomId: room.id, messageId }, audienceOf(room) ?? undefined)
  return c.body(null, 204)
})

/** Adds (`on: true`) or takes back your emoji reaction to a message. */
farmChatRouter.post('/rooms/:id/messages/:messageId/reactions', async (c) => {
  const me = await chatter(c)
  if (me instanceof Response) return me
  if (!uuidParam.safeParse(c.req.param('messageId')).success) return c.json({ error: 'Message not found' }, 404)
  const room = await roomFor(c.req.param('id'), me.userId)
  const { emoji, on } = await parseOptionalJsonObjectBody(c, {} as { emoji?: unknown; on?: unknown })
  const input = validateFarmChatReaction(emoji)
  if (!input.ok) return c.json({ error: input.error }, 400)
  if (typeof on !== 'boolean') return c.json({ error: 'Say whether the reaction is on or off.' }, 400)
  const message = await reactToMessage(room.id, c.req.param('messageId'), me.userId, input.emoji, on)
  wsManager.sendFarmChat('farmChat.messageUpdated', { message }, audienceOf(room) ?? undefined)
  return c.json(message)
})

farmChatRouter.post('/rooms/:id/read', async (c) => {
  const me = await reader(c)
  if (me instanceof Response) return me
  const room = await roomFor(c.req.param('id'), me.userId)
  await markRead(room.id, me.userId)
  return c.body(null, 204)
})
