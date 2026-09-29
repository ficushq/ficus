/**
 * The farm's chat: people talking to each other (not to agents). A general
 * room everyone is always in, public rooms that anyone holding
 * `farm:manage-rooms` can create, rename and delete, and private DMs between
 * two people. Messages are kept for FARM_CHAT_RETENTION_DAYS; their senders
 * can edit them, anyone in the room can react, and typing shows live.
 */

export const FARM_CHAT_RETENTION_DAYS = 30
export const FARM_CHAT_MESSAGE_MAX = 4000
export const FARM_CHAT_ROOM_NAME_MAX = 40
export const FARM_CHAT_ROOM_DESCRIPTION_MAX = 200
/** How often (ms) a client may say someone is typing, and how long the indicator lasts without another. */
export const FARM_CHAT_TYPING_EVERY_MS = 3000
export const FARM_CHAT_TYPING_SHOWS_MS = 6000
/** The quick-pick reactions; any single emoji is accepted. */
export const FARM_CHAT_REACTIONS = ['👍', '❤️', '😂', '🔥', '🎉', '🌱', '👀', '❓', '🙏', '✅'] as const

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

export interface FarmChatReaction {
  emoji: string
  /** Who reacted with it, in the order they did. */
  userIds: string[]
}

export interface FarmChatMessage {
  id: string
  roomId: string
  /** Null once the sender's account is gone. */
  senderUserId: string | null
  body: string
  createdAt: string
  /** When the sender last edited it; null if never. */
  editedAt: string | null
  /** Reactions in the order they were first used. */
  reactions: FarmChatReaction[]
}

/** Someone on the instance, as the farm names them. */
export interface FarmPerson {
  id: string
  /** Their display name, or their email when they haven't set one. */
  name: string
}

export interface FarmChatRooms {
  rooms: FarmChatRoom[]
  /** May post, react, DM and appear on the farm (farm:chat); without it, farm chat is read-only. */
  canChat: boolean
  canManageRooms: boolean
}

export interface FarmChatMessagePage {
  messages: FarmChatMessage[]
  /** Older messages exist before the first one here. */
  hasMore: boolean
}

/** What the farm calls someone who hasn't set a display name, for people who may not see emails. */
export const UNNAMED_PERSON = 'Unnamed teammate'

/**
 * What the farm calls someone: their display name, else their email for a
 * viewer who may see it (users:read), else UNNAMED_PERSON, so the farm never
 * shows the user directory's emails to everyone.
 */
export function farmPersonName(
  user: { displayName?: string | null; email: string },
  { showEmail }: { showEmail: boolean }
): string {
  return user.displayName?.trim() || (showEmail ? user.email : UNNAMED_PERSON)
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

/** A reaction is one emoji (a single grapheme, emoji presentation), nothing else. */
export function validateFarmChatReaction(input: unknown): { ok: true; emoji: string } | { ok: false; error: string } {
  if (typeof input !== 'string' || !input || input.length > 16)
    return { ok: false, error: 'A reaction is a single emoji.' }
  const graphemes = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(input)]
  if (graphemes.length !== 1 || !/\p{Extended_Pictographic}/u.test(input))
    return { ok: false, error: 'A reaction is a single emoji.' }
  return { ok: true, emoji: input }
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
