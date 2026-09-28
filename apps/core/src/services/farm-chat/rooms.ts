import { and, desc, eq, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm'
import {
  farmPersonName,
  type FarmChatMessage,
  type FarmChatMessagePage,
  type FarmChatRoom,
  type FarmPerson,
} from '@ficus/shared'
import { db, farmChatMessages, farmChatReads, farmChatRooms, users } from '../../db'

/*
 * The farm's chat rooms and messages (packages/shared farm-chat.ts). There's
 * always exactly one general room, created on first use; public rooms are
 * visible to everyone; a DM is visible to its two people only.
 */

type RoomRow = typeof farmChatRooms.$inferSelect

export class FarmChatError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409
  ) {
    super(message)
  }
}

/** The general room, created the first time anyone needs it (race-safe). */
export async function ensureGeneralRoom(): Promise<RoomRow> {
  await db.insert(farmChatRooms).values({ kind: 'general', name: 'general' }).onConflictDoNothing()
  const [general] = await db.select().from(farmChatRooms).where(eq(farmChatRooms.kind, 'general'))
  return general!
}

/** Everyone who can be on the farm: people with an active account, named the farm's way. */
export async function listPeople(): Promise<FarmPerson[]> {
  const rows = await db
    .select({ id: users.id, displayName: users.displayName, email: users.email })
    .from(users)
    .where(isNull(users.disabledAt))
  return rows.map((row) => ({ id: row.id, name: farmPersonName(row) })).sort((a, b) => a.name.localeCompare(b.name))
}

function canSee(room: RoomRow, userId: string): boolean {
  return room.kind !== 'dm' || room.dmUserA === userId || room.dmUserB === userId
}

/** A room this person may use, or a 404 (a DM that isn't theirs doesn't exist, as far as they know). */
export async function roomFor(roomId: string, userId: string): Promise<RoomRow> {
  const [room] = await db.select().from(farmChatRooms).where(eq(farmChatRooms.id, roomId))
  if (!room || !canSee(room, userId)) throw new FarmChatError('Room not found', 404)
  return room
}

/** Who a room's messages go to: null for everyone, or a DM's two people. */
export function audienceOf(room: RoomRow): string[] | null {
  return room.kind === 'dm' ? [room.dmUserA!, room.dmUserB!] : null
}

/** The rooms someone sees: general first, then public rooms by name, then their DMs by latest message. */
export async function listRooms(userId: string): Promise<FarmChatRoom[]> {
  await ensureGeneralRoom()
  const rows = await db
    .select()
    .from(farmChatRooms)
    .where(or(ne(farmChatRooms.kind, 'dm'), eq(farmChatRooms.dmUserA, userId), eq(farmChatRooms.dmUserB, userId)))
  if (!rows.length) return []
  const ids = rows.map((room) => room.id)
  const stats = await db
    .select({
      roomId: farmChatMessages.roomId,
      lastMessageAt: sql<string | null>`max(${farmChatMessages.createdAt})`,
      unread: sql<number>`count(*) filter (where ${farmChatMessages.createdAt} > coalesce(${farmChatReads.lastReadAt}, 'epoch'::timestamptz) and ${farmChatMessages.senderUserId} is distinct from ${userId})`,
    })
    .from(farmChatMessages)
    .leftJoin(farmChatReads, and(eq(farmChatReads.roomId, farmChatMessages.roomId), eq(farmChatReads.userId, userId)))
    .where(inArray(farmChatMessages.roomId, ids))
    .groupBy(farmChatMessages.roomId)
  const byRoom = new Map(stats.map((stat) => [stat.roomId, stat]))
  const others = rows
    .filter((room) => room.kind === 'dm')
    .map((room) => (room.dmUserA === userId ? room.dmUserB! : room.dmUserA!))
  const names = new Map(
    others.length
      ? (
          await db
            .select({ id: users.id, displayName: users.displayName, email: users.email })
            .from(users)
            .where(inArray(users.id, others))
        ).map((user) => [user.id, farmPersonName(user)])
      : []
  )
  const rooms = rows.map((room): FarmChatRoom => {
    const stat = byRoom.get(room.id)
    const withUserId = room.kind === 'dm' ? (room.dmUserA === userId ? room.dmUserB! : room.dmUserA!) : null
    return {
      id: room.id,
      kind: room.kind,
      name: withUserId ? (names.get(withUserId) ?? 'Someone') : room.name,
      description: room.description,
      withUserId,
      lastMessageAt: stat?.lastMessageAt ? new Date(stat.lastMessageAt).toISOString() : null,
      unread: Number(stat?.unread ?? 0),
    }
  })
  const order = { general: 0, room: 1, dm: 2 } as const
  return rooms.sort(
    (a, b) =>
      order[a.kind] - order[b.kind] ||
      (a.kind === 'dm' ? (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? '') : 0) ||
      a.name.localeCompare(b.name)
  )
}

function isUniqueViolation(error: unknown): boolean {
  const code =
    (error as { code?: string; cause?: { code?: string } } | null)?.code ??
    (error as { cause?: { code?: string } })?.cause?.code
  return code === '23505'
}

/** Room names are unique whatever their case (the index enforces it too, against races). */
async function assertNameFree(name: string, exceptId?: string): Promise<void> {
  const [clash] = await db
    .select({ id: farmChatRooms.id })
    .from(farmChatRooms)
    .where(
      and(
        eq(farmChatRooms.kind, 'room'),
        sql`lower(${farmChatRooms.name}) = lower(${name})`,
        exceptId ? ne(farmChatRooms.id, exceptId) : undefined
      )
    )
  if (clash) throw new FarmChatError('A room with that name already exists', 409)
}

export async function createRoom(userId: string, name: string, description: string | null): Promise<RoomRow> {
  await assertNameFree(name)
  try {
    const [room] = await db
      .insert(farmChatRooms)
      .values({ kind: 'room', name, description, createdByUserId: userId })
      .returning()
    return room!
  } catch (error) {
    if (isUniqueViolation(error)) throw new FarmChatError('A room with that name already exists', 409)
    throw error
  }
}

/** A public room to rename or delete: never the general room, never a DM. */
async function managedRoom(roomId: string): Promise<RoomRow> {
  const [room] = await db.select().from(farmChatRooms).where(eq(farmChatRooms.id, roomId))
  if (!room || room.kind === 'dm') throw new FarmChatError('Room not found', 404)
  if (room.kind === 'general') throw new FarmChatError('The general room always stays as it is', 400)
  return room
}

export async function updateRoom(roomId: string, name: string, description: string | null): Promise<RoomRow> {
  await managedRoom(roomId)
  await assertNameFree(name, roomId)
  try {
    const [room] = await db
      .update(farmChatRooms)
      .set({ name, description, updatedAt: new Date() })
      .where(eq(farmChatRooms.id, roomId))
      .returning()
    return room!
  } catch (error) {
    if (isUniqueViolation(error)) throw new FarmChatError('A room with that name already exists', 409)
    throw error
  }
}

export async function deleteRoom(roomId: string): Promise<void> {
  await managedRoom(roomId)
  await db.delete(farmChatRooms).where(eq(farmChatRooms.id, roomId))
}

/** The DM between two people, created the first time either opens it. */
export async function directRoom(userId: string, otherId: string): Promise<RoomRow> {
  if (otherId === userId) throw new FarmChatError('You can’t message yourself', 400)
  const [other] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, otherId), isNull(users.disabledAt)))
  if (!other) throw new FarmChatError('Person not found', 404)
  const [a, b] = [userId, otherId].sort() as [string, string]
  await db.insert(farmChatRooms).values({ kind: 'dm', dmUserA: a, dmUserB: b }).onConflictDoNothing()
  const [room] = await db
    .select()
    .from(farmChatRooms)
    .where(and(eq(farmChatRooms.kind, 'dm'), eq(farmChatRooms.dmUserA, a), eq(farmChatRooms.dmUserB, b)))
  return room!
}

function serializeMessage(row: typeof farmChatMessages.$inferSelect): FarmChatMessage {
  return {
    id: row.id,
    roomId: row.roomId,
    senderUserId: row.senderUserId,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
  }
}

/** The latest messages in a room (oldest first), or the page before `before`. */
export async function listMessages(roomId: string, before: Date | null, limit: number): Promise<FarmChatMessagePage> {
  const rows = await db
    .select()
    .from(farmChatMessages)
    .where(
      before
        ? and(eq(farmChatMessages.roomId, roomId), lt(farmChatMessages.createdAt, before))
        : eq(farmChatMessages.roomId, roomId)
    )
    .orderBy(desc(farmChatMessages.createdAt), desc(farmChatMessages.id))
    .limit(limit + 1)
  const hasMore = rows.length > limit
  return { messages: rows.slice(0, limit).reverse().map(serializeMessage), hasMore }
}

export async function postMessage(roomId: string, userId: string, body: string): Promise<FarmChatMessage> {
  const [row] = await db.insert(farmChatMessages).values({ roomId, senderUserId: userId, body }).returning()
  await markRead(roomId, userId, row!.createdAt)
  return serializeMessage(row!)
}

/** Marks a room read up to now (or the given moment), never moving backwards. */
export async function markRead(roomId: string, userId: string, at = new Date()): Promise<void> {
  await db
    .insert(farmChatReads)
    .values({ roomId, userId, lastReadAt: at })
    .onConflictDoUpdate({
      target: [farmChatReads.userId, farmChatReads.roomId],
      set: { lastReadAt: sql`greatest(${farmChatReads.lastReadAt}, excluded.last_read_at)` },
    })
}
