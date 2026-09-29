import type { ChatTarget } from './cards/ChatSlot'
import { chatKey, SNAPS, type ChatWindowState, type Rect, type Snap } from './chatWindowState'
import type { Selection } from './selection'
import type { Camera } from './useCamera'

/*
 * What you were looking at, so a refresh brings it back: where the camera
 * was, the card you had open and your chat windows (where they sat, which was
 * in front). Kept in this browser (localStorage, under the farm's prefix);
 * anything unreadable is ignored, and the farm simply opens fitted and clear.
 */

export interface SavedView {
  camera: Camera | null
  selection: Selection | null
  chats: ChatWindowState[]
}

const EMPTY: SavedView = { camera: null, selection: null, chats: [] }

/** One view for the real farm and one for the demo, so they don't restore into each other. */
export const viewKey = (demo: boolean) => (demo ? 'ficus-farm:view:demo' : 'ficus-farm:view')

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const isString = (value: unknown): value is string => typeof value === 'string' && value.length > 0

function readCamera(value: unknown): Camera | null {
  if (!isObject(value) || !isNumber(value.x) || !isNumber(value.y) || !isNumber(value.zoom) || value.zoom <= 0)
    return null
  return { x: value.x, y: value.y, zoom: value.zoom }
}

/** The card kinds worth reopening (someone's person card isn't: they may well have gone). */
const BY_ID: Record<string, 'streamId' | 'agentId' | 'squadId'> = {
  plot: 'streamId',
  robot: 'agentId',
  yard: 'squadId',
  hut: 'squadId',
  stand: 'squadId',
  rack: 'squadId',
}
const PLAIN = new Set(['assistant', 'mailbox', 'farmhouse', 'seedShed', 'crates', 'compost'])

function readSelection(value: unknown): Selection | null {
  if (!isObject(value) || typeof value.kind !== 'string') return null
  if (PLAIN.has(value.kind)) return { kind: value.kind } as Selection
  const field = BY_ID[value.kind]
  if (!field || !isString(value[field])) return null
  return { kind: value.kind, [field]: value[field] } as Selection
}

function readTarget(value: unknown): ChatTarget | null {
  if (!isObject(value)) return null
  if (value.kind === 'agent' && isString(value.agentId)) return { kind: 'agent', agentId: value.agentId }
  if (value.kind === 'consultant' && isString(value.squadId)) return { kind: 'consultant', squadId: value.squadId }
  // An Assistant conversation (a given one, or your latest); a fresh one that was never started has nothing to reopen.
  if (value.kind === 'assistant' && !value.fresh)
    return isString(value.conversationId)
      ? { kind: 'assistant', conversationId: value.conversationId }
      : { kind: 'assistant' }
  return null
}

function readChat(value: unknown): ChatWindowState | null {
  if (!isObject(value)) return null
  const target = readTarget(value.target)
  if (!target || !isNumber(value.x) || !isNumber(value.y) || !isNumber(value.w) || !isNumber(value.h)) return null
  const rect: Rect = { x: value.x, y: value.y, w: value.w, h: value.h }
  const snap = (SNAPS as readonly string[]).includes(value.snap as string) ? (value.snap as Snap) : undefined
  return { ...rect, key: chatKey(target), target, z: isNumber(value.z) ? value.z : 1, ...(snap ? { snap } : {}) }
}

export function readView(key: string, storage: Pick<Storage, 'getItem'> | undefined = safeStorage()): SavedView {
  try {
    const raw = storage?.getItem(key)
    if (!raw) return EMPTY
    const parsed = JSON.parse(raw) as unknown
    if (!isObject(parsed)) return EMPTY
    const chats = Array.isArray(parsed.chats)
      ? parsed.chats.map(readChat).filter((chat): chat is ChatWindowState => !!chat)
      : []
    const seen = new Set<string>()
    return {
      camera: readCamera(parsed.camera),
      selection: readSelection(parsed.selection),
      // At most one window per conversation, as the farm keeps them.
      chats: chats.filter((chat) => !seen.has(chat.key) && !!seen.add(chat.key)).slice(0, 12),
    }
  } catch {
    return EMPTY
  }
}

export function writeView(
  key: string,
  view: SavedView,
  storage: Pick<Storage, 'setItem'> | undefined = safeStorage()
): void {
  try {
    const camera = view.camera && {
      x: Math.round(view.camera.x),
      y: Math.round(view.camera.y),
      zoom: Math.round(view.camera.zoom * 1000) / 1000,
    }
    const chats = view.chats
      .map(readChat)
      .filter((chat): chat is ChatWindowState => !!chat)
      .map(({ target, x, y, w, h, z, snap }) => ({
        target,
        x: Math.round(x),
        y: Math.round(y),
        w: Math.round(w),
        h: Math.round(h),
        z,
        ...(snap ? { snap } : {}),
      }))
    storage?.setItem(key, JSON.stringify({ camera, selection: readSelection(view.selection), chats }))
  } catch {
    // Storage unavailable or full: the farm just won't come back to this view.
  }
}

function safeStorage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage
  } catch {
    return undefined
  }
}
