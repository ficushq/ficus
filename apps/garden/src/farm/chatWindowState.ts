import type { ChatTarget } from './cards/ChatSlot'

/**
 * Floating chat windows: any number open at once, one per conversation,
 * dragged by their title bar and resized from the corner. Pure state here;
 * ChatWindow draws the frame.
 */
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface ChatWindowState extends Rect {
  key: string
  target: ChatTarget
  /** Stacking order: higher is in front. */
  z: number
}

export interface Viewport {
  width: number
  height: number
}

export const MIN_W = 320
export const MIN_H = 360
const DEFAULT_W = 420
const MARGIN = 12
/** Space the HUD keeps at the top and the tools at the bottom right. */
const TOP = 72
const CASCADE = 28
/** New windows stop above the tool buttons along the bottom right. */
const TOOLS_CLEARANCE = 96

export function chatKey(target: ChatTarget): string {
  switch (target.kind) {
    case 'agent':
      return `agent:${target.agentId}`
    case 'consultant':
      return `consultant:${target.squadId}`
    case 'assistant':
      return target.fresh ? `assistant:new:${target.fresh}` : `assistant:${target.conversationId ?? 'latest'}`
  }
}

/** Keeps a window on screen and at least its minimum size (shrinking it on small screens). */
export function clampRect(rect: Rect, viewport: Viewport): Rect {
  const maxW = Math.max(MIN_W, viewport.width - MARGIN * 2)
  const maxH = Math.max(MIN_H, viewport.height - TOP - MARGIN)
  const w = Math.min(maxW, Math.max(MIN_W, rect.w))
  const h = Math.min(maxH, Math.max(MIN_H, rect.h))
  const x = Math.min(Math.max(MARGIN, rect.x), Math.max(MARGIN, viewport.width - w - MARGIN))
  const y = Math.min(Math.max(TOP, rect.y), Math.max(TOP, viewport.height - h - MARGIN))
  return { x, y, w, h }
}

/** Where a new window opens: its remembered spot, else stacked down-left of the right edge, cascading. */
export function placeNew(windows: ChatWindowState[], viewport: Viewport, remembered?: Rect): Rect {
  if (remembered) return clampRect(remembered, viewport)
  const n = windows.length
  const w = DEFAULT_W
  const h = viewport.height - TOP - TOOLS_CLEARANCE - n * CASCADE
  return clampRect({ x: viewport.width - w - MARGIN - n * CASCADE, y: TOP + n * CASCADE, w, h }, viewport)
}

export type ChatWindowAction =
  | { type: 'open'; target: ChatTarget; viewport: Viewport; remembered?: Rect }
  | { type: 'close'; key: string }
  | { type: 'focus'; key: string }
  | { type: 'rect'; key: string; rect: Rect; viewport: Viewport }
  | { type: 'fit'; viewport: Viewport }

const topZ = (windows: ChatWindowState[]) => windows.reduce((z, w) => Math.max(z, w.z), 0)

export function chatWindowsReducer(windows: ChatWindowState[], action: ChatWindowAction): ChatWindowState[] {
  switch (action.type) {
    case 'open': {
      const key = chatKey(action.target)
      if (windows.some((w) => w.key === key)) return chatWindowsReducer(windows, { type: 'focus', key })
      const rect = placeNew(windows, action.viewport, action.remembered)
      return [...windows, { key, target: action.target, z: topZ(windows) + 1, ...rect }]
    }
    case 'close':
      return windows.filter((w) => w.key !== action.key)
    case 'focus': {
      const win = windows.find((w) => w.key === action.key)
      if (!win || win.z === topZ(windows)) return windows
      const z = topZ(windows) + 1
      return windows.map((w) => (w.key === action.key ? { ...w, z } : w))
    }
    case 'rect':
      return windows.map((w) => (w.key === action.key ? { ...w, ...clampRect(action.rect, action.viewport) } : w))
    case 'fit':
      return windows.map((w) => ({ ...w, ...clampRect(w, action.viewport) }))
  }
}

/** The frontmost window (what a phone shows as its one sheet). */
export function frontmost(windows: ChatWindowState[]): ChatWindowState | undefined {
  return windows.reduce<ChatWindowState | undefined>((top, w) => (!top || w.z > top.z ? w : top), undefined)
}

const STORAGE_KEY = 'ficus-garden:chat-windows'

/** Remembered window geometry per conversation, under the garden's own storage prefix. */
export function readRemembered(storage: Pick<Storage, 'getItem'> | undefined = safeStorage()): Record<string, Rect> {
  try {
    const raw = storage?.getItem(STORAGE_KEY)
    const parsed = raw ? (JSON.parse(raw) as unknown) : {}
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, Rect>) : {}
  } catch {
    return {}
  }
}

export function remember(
  key: string,
  rect: Rect,
  storage: Pick<Storage, 'getItem' | 'setItem'> | undefined = safeStorage()
) {
  try {
    const all = readRemembered(storage)
    all[key] = { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.w), h: Math.round(rect.h) }
    // Keep the most recent 30 conversations' spots.
    const keys = Object.keys(all)
    for (const old of keys.slice(0, Math.max(0, keys.length - 30))) delete all[old]
    storage?.setItem(STORAGE_KEY, JSON.stringify(all))
  } catch {
    // Storage unavailable: windows just open in their default spot.
  }
}

function safeStorage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage
  } catch {
    return undefined
  }
}
