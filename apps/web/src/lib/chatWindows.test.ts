import { describe, expect, test } from 'bun:test'
import {
  ASSISTANT_WINDOW_KEY,
  EMPTY_CHAT_WINDOWS,
  chatWindowsReducer,
  chatWindowsStorageKey,
  frontmostWindow,
  parseChatWindows,
  readChatWindows,
  saveChatWindows,
  stackOrder,
  windowRect,
  type ChatWindowsAction,
  type ChatWindowsState,
} from './chatWindows'
import { snapRect } from './floatingWindow'

const screen = { width: 1400, height: 900 }
const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const C = '33333333-3333-4333-8333-333333333333'

function run(...actions: ChatWindowsAction[]): ChatWindowsState {
  return actions.reduce(chatWindowsReducer, EMPTY_CHAT_WINDOWS)
}
const open = (agentId: string): ChatWindowsAction => ({ type: 'open', agentId, viewport: screen })
const ids = (state: ChatWindowsState) => state.windows.map((w) => w.agentId)

describe('opening and closing', () => {
  test('each agent gets one window, cascading from the top right, in front of the ones before it', () => {
    const state = run(open(A), open(B))
    expect(ids(state)).toEqual([A, B])
    const [a, b] = state.windows
    expect(b!.z).toBeGreaterThan(a!.z)
    expect(b!.rect.x).toBeLessThan(a!.rect.x)
    expect(b!.rect.y).toBeGreaterThan(a!.rect.y)
    expect(frontmostWindow(state, false)).toBe(B)
  })

  test('opening an agent that already floats brings its window forward, restored, instead of a duplicate', () => {
    const state = run(open(A), open(B), { type: 'minimize', agentId: A }, open(A))
    expect(ids(state)).toEqual([A, B])
    expect(state.windows[0]!.minimized).toBe(false)
    expect(frontmostWindow(state, false)).toBe(A)
  })

  test('a closed window reopens where it was left, snap included', () => {
    const moved = { type: 'rect', agentId: A, rect: { x: 40, y: 50, w: 500, h: 600 }, viewport: screen } as const
    const reopened = run(open(A), moved, { type: 'close', agentId: A }, open(B), open(A))
    expect(ids(reopened)).toEqual([B, A])
    expect(reopened.windows[1]!.rect).toEqual({ x: 40, y: 50, w: 500, h: 600 })
    const snapped = chatWindowsReducer(
      chatWindowsReducer(chatWindowsReducer(reopened, { type: 'snap', agentId: A, snap: 'right' }), {
        type: 'close',
        agentId: A,
      }),
      open(A)
    )
    expect(snapped.windows.find((w) => w.agentId === A)!.snap).toBe('right')
  })

  test('close all closes every window and remembers each; discarding forgets one entirely', () => {
    const all = run(open(A), open(B), { type: 'closeAll' })
    expect(all.windows).toEqual([])
    expect(Object.keys(all.remembered).sort()).toEqual([A, B])
    const discarded = chatWindowsReducer(run(open(A), open(C)), { type: 'discard', agentId: C })
    expect(ids(discarded)).toEqual([A])
    expect(discarded.remembered[C]).toBeUndefined()
  })
})

describe('stacking with the assistant', () => {
  test('the last window used, of either kind, is on top', () => {
    let state = run(open(A), open(B))
    state = chatWindowsReducer(state, { type: 'focus', key: ASSISTANT_WINDOW_KEY })
    expect(frontmostWindow(state, true)).toBe(ASSISTANT_WINDOW_KEY)
    expect([...stackOrder(state).entries()].sort((x, y) => x[1] - y[1]).map(([key]) => key)).toEqual([
      A,
      B,
      ASSISTANT_WINDOW_KEY,
    ])
    state = chatWindowsReducer(state, { type: 'focus', key: A })
    expect(frontmostWindow(state, true)).toBe(A)
    expect(stackOrder(state).get(A)).toBe(2)
    // A closed assistant does not count as in front.
    state = chatWindowsReducer(state, { type: 'focus', key: ASSISTANT_WINDOW_KEY })
    expect(frontmostWindow(state, false)).toBe(A)
  })

  test('focusing the frontmost window changes nothing', () => {
    const state = run(open(A))
    expect(chatWindowsReducer(state, { type: 'focus', key: A })).toBe(state)
  })

  test('a minimized window leaves the front to the next one, and restoring brings it back on top', () => {
    let state = run(open(A), open(B), { type: 'minimize', agentId: B })
    expect(state.windows[1]!.minimized).toBe(true)
    expect(frontmostWindow(state, false)).toBe(A)
    state = chatWindowsReducer(state, { type: 'restore', agentId: B })
    expect(state.windows[1]!.minimized).toBe(false)
    expect(frontmostWindow(state, false)).toBe(B)
  })
})

describe('placement', () => {
  test('a snap fills its region and refits with the screen; its free rectangle is kept to return to', () => {
    let state = run(open(A))
    const free = state.windows[0]!.rect
    state = chatWindowsReducer(state, { type: 'snap', agentId: A, snap: 'left' })
    expect(windowRect(state.windows[0]!, screen)).toEqual(snapRect('left', screen))
    expect(windowRect(state.windows[0]!, { width: 1000, height: 700 })).toEqual(
      snapRect('left', { width: 1000, height: 700 })
    )
    expect(state.windows[0]!.rect).toEqual(free)
    // Dragged out of it: free again where it was dropped.
    state = chatWindowsReducer(state, {
      type: 'rect',
      agentId: A,
      rect: { x: 200, y: 100, ...free },
      viewport: screen,
    })
    expect(state.windows[0]!.snap).toBeUndefined()
  })

  test('a drag that ends in a snap records the free rectangle it returns to', () => {
    const state = run(open(A), {
      type: 'snap',
      agentId: A,
      snap: 'bottom-right',
      rect: { x: 500, y: 300, w: 420, h: 500 },
    })
    expect(state.windows[0]!.snap).toBe('bottom-right')
    expect(state.windows[0]!.rect).toEqual({ x: 500, y: 300, w: 420, h: 500 })
  })

  test('double-click toggles filling the screen and back; center keeps the size', () => {
    let state = run(open(A), { type: 'toggleFull', agentId: A })
    expect(state.windows[0]!.snap).toBe('full')
    state = chatWindowsReducer(state, { type: 'toggleFull', agentId: A })
    expect(state.windows[0]!.snap).toBeUndefined()
    const size = state.windows[0]!.rect
    state = chatWindowsReducer(state, { type: 'center', agentId: A, viewport: screen })
    expect(state.windows[0]!.rect).toEqual({
      x: Math.round((1400 - size.w) / 2),
      y: Math.round((900 - size.h) / 2),
      w: size.w,
      h: size.h,
    })
  })

  test('free windows are kept on a smaller screen, and fit puts the stored rectangle back on screen', () => {
    const state = run(open(A), {
      type: 'rect',
      agentId: A,
      rect: { x: 1000, y: 500, w: 380, h: 380 },
      viewport: screen,
    })
    const small = { width: 800, height: 600 }
    expect(windowRect(state.windows[0]!, small)).toEqual({ x: 412, y: 212, w: 380, h: 380 })
    // Not destructive: the screen growing back restores the window where it was.
    expect(windowRect(state.windows[0]!, screen)).toEqual({ x: 1000, y: 500, w: 380, h: 380 })
    expect(chatWindowsReducer(state, { type: 'fit', viewport: small }).windows[0]!.rect).toEqual({
      x: 412,
      y: 212,
      w: 380,
      h: 380,
    })
  })
})

describe('storage', () => {
  const memory = () => {
    const values = new Map<string, string>()
    return {
      values,
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
      removeItem: (key: string) => void values.delete(key),
    }
  }

  test('round-trips the open windows, their geometry, stacking and minimized state', () => {
    const storage = memory()
    const state = run(
      open(A),
      open(B),
      { type: 'snap', agentId: A, snap: 'left' },
      { type: 'minimize', agentId: B },
      { type: 'focus', key: ASSISTANT_WINDOW_KEY }
    )
    saveChatWindows('user:1', state, storage)
    expect(readChatWindows('user:1', storage)).toEqual(state)
  })

  test('is kept per signed-in identity, so accounts sharing a browser never mix', () => {
    const storage = memory()
    saveChatWindows('user:1', run(open(A)), storage)
    saveChatWindows('user:2', run(open(B)), storage)
    expect(ids(readChatWindows('user:1', storage))).toEqual([A])
    expect(ids(readChatWindows('user:2', storage))).toEqual([B])
    expect([...storage.values.keys()].sort()).toEqual([
      chatWindowsStorageKey('user:1'),
      chatWindowsStorageKey('user:2'),
    ])
    expect(chatWindowsStorageKey('user:1')).toBe('ficus-chat-windows:user:1')
    // Nothing left to keep: the entry goes.
    saveChatWindows('user:1', EMPTY_CHAT_WINDOWS, storage)
    expect(storage.values.has(chatWindowsStorageKey('user:1'))).toBe(false)
  })

  test('malformed data is skipped piece by piece, never thrown', () => {
    for (const raw of [null, '', 'not json', '42', '[]', '{"windows":"nope"}'])
      expect(parseChatWindows(raw)).toEqual(EMPTY_CHAT_WINDOWS)
    const parsed = parseChatWindows(
      JSON.stringify({
        assistantZ: 'high',
        windows: [
          { agentId: A, rect: { x: 1, y: 2, w: 400, h: 500 }, snap: 'sideways', z: 3, minimized: 'yes' },
          { agentId: A, rect: { x: 9, y: 9, w: 400, h: 500 }, z: 4 },
          { agentId: '../../etc', rect: { x: 1, y: 2, w: 400, h: 500 }, z: 1 },
          { agentId: B, rect: { x: 1, y: 2, w: -5, h: 500 }, z: 1 },
          { agentId: C, rect: { x: 1, y: 2, w: 400, h: 500 } },
          null,
          'window',
        ],
        remembered: { [B]: { rect: { x: 0, y: 0, w: 400, h: 400 }, snap: 'full' }, bogus: { rect: {} } },
      })
    )
    expect(parsed).toEqual({
      assistantZ: 0,
      windows: [
        { agentId: A, rect: { x: 1, y: 2, w: 400, h: 500 }, z: 3 },
        { agentId: C, rect: { x: 1, y: 2, w: 400, h: 500 }, z: 0 },
      ],
      remembered: { [B]: { rect: { x: 0, y: 0, w: 400, h: 400 }, snap: 'full' } },
    })
    const broken = {
      getItem: () => {
        throw new Error('Unavailable')
      },
      setItem: () => {
        throw new Error('Unavailable')
      },
      removeItem: () => {
        throw new Error('Unavailable')
      },
    }
    expect(readChatWindows('user:1', broken)).toEqual(EMPTY_CHAT_WINDOWS)
    expect(() => saveChatWindows('user:1', run(open(A)), broken)).not.toThrow()
  })
})
