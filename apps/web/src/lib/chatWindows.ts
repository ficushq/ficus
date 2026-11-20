import { CHAT_WINDOWS_STORAGE_KEY } from '@ficus/shared/browser-keys'
import {
  centerRect,
  clampRect,
  isRect,
  isSnap,
  snapRect,
  type Rect,
  type Size,
  type Snap,
  type ViewportSize,
} from './floatingWindow'

/*
 * Floating agent chat windows: any number open at once, one per agent, stacked by last interaction
 * together with the assistant. Pure state and storage here; components/FloatingWindows draws them.
 */

/** The assistant's key in the shared stack. Agent windows use their agent id. */
export const ASSISTANT_WINDOW_KEY = 'assistant'

export interface AgentWindow {
  agentId: string
  /** The free rectangle: where it is when not snapped, and what it returns to when dragged out of a snap. */
  rect: Rect
  snap?: Snap
  /** Stacking order: higher is in front. Shared with the assistant's `assistantZ`. */
  z: number
  minimized?: boolean
}

/** Where an agent's window was when it was last closed. */
export interface RememberedPlacement {
  rect: Rect
  snap?: Snap
}

export interface ChatWindowsState {
  windows: AgentWindow[]
  /** The assistant's place in the same stack (0 until it is first used). */
  assistantZ: number
  /** Last geometry per agent, so reopening a closed window puts it back; the most recent few only. */
  remembered: Record<string, RememberedPlacement>
}

export const EMPTY_CHAT_WINDOWS: ChatWindowsState = { windows: [], assistantZ: 0, remembered: {} }

export const CHAT_WINDOW_MIN: Size = { w: 340, h: 300 }
const DEFAULT_SIZE: Size = { w: 460, h: 620 }
/** Below the app header. */
const FIRST_TOP = 72
const CASCADE = 28
const MAX_WINDOWS = 24
const MAX_REMEMBERED = 30

export type ChatWindowsAction =
  | { type: 'open'; agentId: string; viewport: ViewportSize }
  | { type: 'close'; agentId: string }
  /** A window for an agent that no longer exists or is not accessible: gone, and not remembered. */
  | { type: 'discard'; agentId: string }
  | { type: 'closeAll' }
  | { type: 'focus'; key: string }
  | { type: 'minimize'; agentId: string }
  | { type: 'restore'; agentId: string }
  /** Dragged or resized freely: unsnaps it. */
  | { type: 'rect'; agentId: string; rect: Rect; viewport: ViewportSize }
  /** Snapped, optionally with the free rectangle it should return to (a drag that ended in a snap). */
  | { type: 'snap'; agentId: string; snap: Snap; rect?: Rect }
  | { type: 'center'; agentId: string; viewport: ViewportSize }
  /** Double-click on the title bar: fill the screen, and back. */
  | { type: 'toggleFull'; agentId: string }
  /** Keeps every free rectangle on this screen (after restoring from storage). */
  | { type: 'fit'; viewport: ViewportSize }

function topZ(state: ChatWindowsState) {
  return state.windows.reduce((z, w) => Math.max(z, w.z), state.assistantZ)
}

/** The frontmost key in the stack, assistant included. */
function frontKey(state: ChatWindowsState, assistantShown = true) {
  let front: [string, number] | undefined = assistantShown ? [ASSISTANT_WINDOW_KEY, state.assistantZ] : undefined
  for (const w of state.windows) if (!w.minimized && (!front || w.z > front[1])) front = [w.agentId, w.z]
  return front?.[0]
}

/** Where a new window opens: its remembered place, else cascading down-left from the top right. */
export function placeNewWindow(state: ChatWindowsState, agentId: string, viewport: ViewportSize): RememberedPlacement {
  const remembered = state.remembered[agentId]
  if (remembered) return { rect: clampRect(remembered.rect, viewport, CHAT_WINDOW_MIN), snap: remembered.snap }
  const n = state.windows.length % 8
  const h = Math.min(DEFAULT_SIZE.h, viewport.height - FIRST_TOP - 24)
  return {
    rect: clampRect(
      { x: viewport.width - DEFAULT_SIZE.w - 24 - n * CASCADE, y: FIRST_TOP + n * CASCADE, w: DEFAULT_SIZE.w, h },
      viewport,
      CHAT_WINDOW_MIN
    ),
  }
}

function remember(state: ChatWindowsState, closing: AgentWindow[]): Record<string, RememberedPlacement> {
  const next = { ...state.remembered }
  for (const w of closing) {
    delete next[w.agentId]
    next[w.agentId] = { rect: w.rect, ...(w.snap ? { snap: w.snap } : {}) }
  }
  const keys = Object.keys(next)
  for (const old of keys.slice(0, Math.max(0, keys.length - MAX_REMEMBERED))) delete next[old]
  return next
}

function update(state: ChatWindowsState, agentId: string, change: (w: AgentWindow) => AgentWindow) {
  if (!state.windows.some((w) => w.agentId === agentId)) return state
  return { ...state, windows: state.windows.map((w) => (w.agentId === agentId ? change(w) : w)) }
}

export function chatWindowsReducer(state: ChatWindowsState, action: ChatWindowsAction): ChatWindowsState {
  switch (action.type) {
    case 'open': {
      // One window per agent: opening it again brings it forward, restored if minimized.
      if (state.windows.some((w) => w.agentId === action.agentId))
        return chatWindowsReducer(state, { type: 'restore', agentId: action.agentId })
      const placement = placeNewWindow(state, action.agentId, action.viewport)
      const windows = [...state.windows, { agentId: action.agentId, ...placement, z: topZ(state) + 1 }]
      // Past the cap, the window furthest back closes.
      const overflow = windows.length - MAX_WINDOWS
      const dropped = overflow > 0 ? [...windows].sort((a, b) => a.z - b.z).slice(0, overflow) : []
      return {
        ...state,
        windows: windows.filter((w) => !dropped.includes(w)),
        remembered: dropped.length ? remember(state, dropped) : state.remembered,
      }
    }
    case 'close': {
      const closing = state.windows.filter((w) => w.agentId === action.agentId)
      if (!closing.length) return state
      return {
        ...state,
        windows: state.windows.filter((w) => w.agentId !== action.agentId),
        remembered: remember(state, closing),
      }
    }
    case 'discard': {
      if (!state.windows.some((w) => w.agentId === action.agentId) && !state.remembered[action.agentId]) return state
      const remembered = { ...state.remembered }
      delete remembered[action.agentId]
      return { ...state, windows: state.windows.filter((w) => w.agentId !== action.agentId), remembered }
    }
    case 'closeAll':
      return state.windows.length ? { ...state, windows: [], remembered: remember(state, state.windows) } : state
    case 'focus': {
      if (frontKey(state) === action.key) return state
      const z = topZ(state) + 1
      if (action.key === ASSISTANT_WINDOW_KEY) return { ...state, assistantZ: z }
      return update(state, action.key, (w) => ({ ...w, z }))
    }
    case 'minimize':
      return update(state, action.agentId, (w) => (w.minimized ? w : { ...w, minimized: true }))
    case 'restore': {
      const win = state.windows.find((w) => w.agentId === action.agentId)
      if (!win || (!win.minimized && frontKey(state) === action.agentId)) return state
      const z = frontKey(state) === action.agentId ? win.z : topZ(state) + 1
      return update(state, action.agentId, (w) => ({ ...w, minimized: false, z }))
    }
    case 'rect':
      return update(state, action.agentId, (w) => ({
        ...w,
        rect: clampRect(action.rect, action.viewport, CHAT_WINDOW_MIN),
        snap: undefined,
      }))
    case 'snap': {
      // Snapping brings it to the front, too.
      const z = frontKey(state) === action.agentId ? undefined : topZ(state) + 1
      return update(state, action.agentId, (w) => ({
        ...w,
        snap: action.snap,
        ...(action.rect ? { rect: action.rect } : {}),
        ...(z ? { z } : {}),
      }))
    }
    case 'center':
      return update(state, action.agentId, (w) => ({
        ...w,
        rect: centerRect(w.rect, action.viewport, CHAT_WINDOW_MIN),
        snap: undefined,
      }))
    case 'toggleFull':
      return update(state, action.agentId, (w) => ({ ...w, snap: w.snap === 'full' ? undefined : 'full' }))
    case 'fit':
      return {
        ...state,
        windows: state.windows.map((w) => ({ ...w, rect: clampRect(w.rect, action.viewport, CHAT_WINDOW_MIN) })),
      }
  }
}

/** Where a window is drawn on this screen: its snap's region, or its free rectangle kept on screen. */
export function windowRect(win: Pick<AgentWindow, 'rect' | 'snap'>, viewport: ViewportSize): Rect {
  return win.snap ? snapRect(win.snap, viewport) : clampRect(win.rect, viewport, CHAT_WINDOW_MIN)
}

/**
 * The frontmost shown window (or the assistant, when `assistantShown`), which keyboard shortcuts and
 * unread tracking treat as the one in use.
 */
export function frontmostWindow(state: ChatWindowsState, assistantShown: boolean): string | undefined {
  return frontKey(state, assistantShown)
}

/** Each key's rank in the stack, back to front (0 is furthest back), assistant included. */
export function stackOrder(state: ChatWindowsState): Map<string, number> {
  const rows: [string, number][] = [
    [ASSISTANT_WINDOW_KEY, state.assistantZ],
    ...state.windows.map((w): [string, number] => [w.agentId, w.z]),
  ]
  rows.sort((a, b) => a[1] - b[1])
  return new Map(rows.map(([key], index) => [key, index]))
}

// --- Storage -----------------------------------------------------------------

/** Browser storage key for one signed-in identity, so accounts sharing a browser never mix windows. */
export function chatWindowsStorageKey(scope: string): string {
  return `${CHAT_WINDOWS_STORAGE_KEY}:${scope}`
}

const AGENT_ID = /^[0-9a-f-]{8,64}$/i

function readPlacement(value: unknown): RememberedPlacement | undefined {
  const row = value as { rect?: unknown; snap?: unknown } | null
  if (!row || typeof row !== 'object' || !isRect(row.rect)) return undefined
  return { rect: row.rect, ...(isSnap(row.snap) ? { snap: row.snap } : {}) }
}

/** Reads the stored windows defensively: anything malformed is skipped, never thrown. */
export function parseChatWindows(raw: string | null | undefined): ChatWindowsState {
  if (!raw) return EMPTY_CHAT_WINDOWS
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return EMPTY_CHAT_WINDOWS
  }
  if (!value || typeof value !== 'object') return EMPTY_CHAT_WINDOWS
  const stored = value as { windows?: unknown; assistantZ?: unknown; remembered?: unknown }
  const windows: AgentWindow[] = []
  for (const row of Array.isArray(stored.windows) ? stored.windows.slice(0, MAX_WINDOWS) : []) {
    const item = row as Partial<Record<keyof AgentWindow, unknown>> | null
    if (!item || typeof item !== 'object') continue
    const placement = readPlacement(item)
    if (typeof item.agentId !== 'string' || !AGENT_ID.test(item.agentId) || !placement) continue
    if (windows.some((w) => w.agentId === item.agentId)) continue
    windows.push({
      agentId: item.agentId,
      ...placement,
      z: typeof item.z === 'number' && Number.isFinite(item.z) ? item.z : 0,
      ...(item.minimized === true ? { minimized: true } : {}),
    })
  }
  const remembered: Record<string, RememberedPlacement> = {}
  if (stored.remembered && typeof stored.remembered === 'object' && !Array.isArray(stored.remembered)) {
    for (const [agentId, row] of Object.entries(stored.remembered).slice(-MAX_REMEMBERED)) {
      const placement = readPlacement(row)
      if (AGENT_ID.test(agentId) && placement) remembered[agentId] = placement
    }
  }
  const assistantZ = typeof stored.assistantZ === 'number' && Number.isFinite(stored.assistantZ) ? stored.assistantZ : 0
  return { windows, assistantZ, remembered }
}

export function readChatWindows(
  scope: string,
  storage: Pick<Storage, 'getItem'> | undefined = safeStorage()
): ChatWindowsState {
  try {
    return parseChatWindows(storage?.getItem(chatWindowsStorageKey(scope)))
  } catch {
    return EMPTY_CHAT_WINDOWS
  }
}

export function saveChatWindows(
  scope: string,
  state: ChatWindowsState,
  storage: Pick<Storage, 'setItem' | 'removeItem'> | undefined = safeStorage()
): void {
  try {
    const key = chatWindowsStorageKey(scope)
    if (!state.windows.length && !Object.keys(state.remembered).length) storage?.removeItem(key)
    else storage?.setItem(key, JSON.stringify(state))
  } catch {
    // Storage unavailable or full: windows just do not survive a refresh.
  }
}

function safeStorage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage
  } catch {
    return undefined
  }
}
