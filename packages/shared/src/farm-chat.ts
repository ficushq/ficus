/**
 * The farm's chat: people talking to each other (not to agents). A general
 * room everyone is always in, public rooms that anyone holding
 * `chat:manage-rooms` can create, rename and delete, and private DMs between
 * two people. Messages are kept for FARM_CHAT_RETENTION_DAYS.
 */

export const FARM_CHAT_RETENTION_DAYS = 30
export const FARM_CHAT_MESSAGE_MAX = 4000
export const FARM_CHAT_ROOM_NAME_MAX = 40
export const FARM_CHAT_ROOM_DESCRIPTION_MAX = 200

export type FarmChatRoomKind = 'general' | 'room' | 'dm'

export interface FarmChatRoom {
  id: string
  kind: FarmChatRoomKind
  /** A DM's name is the other person's. */
  name: string
  description: string | null
  /** For a DM, the other person; otherwise null. */
  withUserId: string | null
  lastMessageAt: string | null
  /** Messages since you last read the room (yours don't count). */
  unread: number
}

export interface FarmChatMessage {
  id: string
  roomId: string
  /** Null once the sender's account is gone. */
  senderUserId: string | null
  body: string
  createdAt: string
}

/** Someone on the instance, as the farm names them. */
export interface FarmPerson {
  id: string
  /** Their display name, or their email when they haven't set one. */
  name: string
}

export interface FarmChatRooms {
  rooms: FarmChatRoom[]
  canManageRooms: boolean
}

export interface FarmChatMessagePage {
  messages: FarmChatMessage[]
  /** Older messages exist before the first one here. */
  hasMore: boolean
}

/** What the farm calls someone: their display name, else their email. */
export function farmPersonName(user: { displayName?: string | null; email: string }): string {
  return user.displayName?.trim() || user.email
}

/** One or two letters for someone's badge: from the words of their name, or the start of an email. */
export function farmPersonInitials(name: string): string {
  const local = name.includes('@') ? name.split('@')[0]! : name
  const words = local.split(/[\s._-]+/).filter(Boolean)
  if (!words.length) return '?'
  const letters = words.length > 1 ? words[0]![0]! + words[1]![0]! : words[0]!.slice(0, 2)
  return letters.toUpperCase()
}

export function validateFarmChatBody(input: unknown): { ok: true; body: string } | { ok: false; error: string } {
  if (typeof input !== 'string') return { ok: false, error: 'Expected a message.' }
  const body = input.trim()
  if (!body) return { ok: false, error: 'A message can’t be empty.' }
  if (body.length > FARM_CHAT_MESSAGE_MAX) return { ok: false, error: 'That message is too long.' }
  return { ok: true, body }
}

export function validateFarmChatRoom(
  input: unknown
): { ok: true; name: string; description: string | null } | { ok: false; error: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'Expected a room.' }
  const { name, description } = input as { name?: unknown; description?: unknown }
  if (typeof name !== 'string' || !name.trim()) return { ok: false, error: 'A room needs a name.' }
  if (name.trim().length > FARM_CHAT_ROOM_NAME_MAX) return { ok: false, error: 'That name is too long.' }
  if (description !== undefined && description !== null && typeof description !== 'string')
    return { ok: false, error: 'Expected a description.' }
  const text = typeof description === 'string' ? description.trim() : ''
  if (text.length > FARM_CHAT_ROOM_DESCRIPTION_MAX) return { ok: false, error: 'That description is too long.' }
  return { ok: true, name: name.trim(), description: text || null }
}
