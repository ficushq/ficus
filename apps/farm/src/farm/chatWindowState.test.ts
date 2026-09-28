import { describe, expect, it } from 'bun:test'
import {
  chatKey,
  chatWindowsReducer,
  clampRect,
  frontmost,
  MIN_H,
  MIN_W,
  readRemembered,
  remember,
  snapRect,
  SNAPS,
  type ChatWindowState,
} from './chatWindowState'

const viewport = { width: 1440, height: 900 }
const open = (windows: ChatWindowState[], agentId: string) =>
  chatWindowsReducer(windows, { type: 'open', target: { kind: 'agent', agentId }, viewport })

describe('chat windows', () => {
  it('opens one window per conversation and brings an open one to the front instead of duplicating it', () => {
    let windows = open([], 'a')
    windows = open(windows, 'b')
    expect(windows.map((w) => w.key)).toEqual(['agent:a', 'agent:b'])
    expect(frontmost(windows)?.key).toBe('agent:b')
    windows = open(windows, 'a')
    expect(windows).toHaveLength(2)
    expect(frontmost(windows)?.key).toBe('agent:a')
  })

  it('cascades new windows so they do not open exactly on top of each other', () => {
    const windows = open(open([], 'a'), 'b')
    expect(windows[1]!.x).not.toBe(windows[0]!.x)
    expect(windows[1]!.y).toBeGreaterThan(windows[0]!.y)
  })

  it('closes one window and leaves the rest', () => {
    const windows = chatWindowsReducer(open(open([], 'a'), 'b'), { type: 'close', key: 'agent:a' })
    expect(windows.map((w) => w.key)).toEqual(['agent:b'])
  })

  it('keeps moved and resized windows on screen and at least their minimum size', () => {
    const [win] = open([], 'a')
    const moved = chatWindowsReducer([win!], {
      type: 'rect',
      key: win!.key,
      rect: { x: 5000, y: -200, w: 100, h: 50 },
      viewport,
    })[0]!
    expect(moved.w).toBe(MIN_W)
    expect(moved.h).toBe(MIN_H)
    expect(moved.x + moved.w).toBeLessThanOrEqual(viewport.width)
    expect(moved.y).toBeGreaterThanOrEqual(0)
  })

  it('pulls windows back on screen when the viewport shrinks', () => {
    const windows = open([], 'a')
    const fitted = chatWindowsReducer(windows, { type: 'fit', viewport: { width: 800, height: 600 } })[0]!
    expect(fitted.x + fitted.w).toBeLessThanOrEqual(800)
    expect(fitted.y + fitted.h).toBeLessThanOrEqual(600)
    expect(clampRect({ x: 0, y: 0, w: 2000, h: 2000 }, { width: 800, height: 600 }).w).toBeLessThanOrEqual(800)
  })

  it('opens where the conversation was last left', () => {
    const windows = chatWindowsReducer([], {
      type: 'open',
      target: { kind: 'consultant', squadId: 's1' },
      viewport,
      remembered: { x: 100, y: 120, w: 500, h: 500 },
    })
    expect(windows[0]).toMatchObject({ key: 'consultant:s1', x: 100, y: 120, w: 500, h: 500 })
  })

  it('names conversations stably', () => {
    expect(chatKey({ kind: 'assistant' })).toBe('assistant:latest')
    expect(chatKey({ kind: 'assistant', conversationId: 'c' })).toBe('assistant:c')
  })

  it('remembers geometry under the farm prefix', () => {
    const store = new Map<string, string>()
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    }
    remember('agent:a', { x: 10.4, y: 80, w: 400.6, h: 500 }, storage)
    expect(readRemembered(storage)).toEqual({ 'agent:a': { x: 10, y: 80, w: 401, h: 500 } })
    expect([...store.keys()]).toEqual(['ficus-farm:chat-windows'])
  })

  it('snaps a window to halves, quarters and thirds that tile the space without overlapping, and brings it forward', () => {
    const left = snapRect('left', viewport)
    const right = snapRect('right', viewport)
    expect(left.x + left.w).toBeLessThan(right.x)
    expect(right.x + right.w).toBe(viewport.width - 12)
    const thirds = (['left-third', 'middle-third', 'right-third'] as const).map((s) => snapRect(s, viewport))
    expect(thirds[0]!.x + thirds[0]!.w).toBeLessThan(thirds[1]!.x)
    expect(thirds[1]!.x + thirds[1]!.w).toBeLessThan(thirds[2]!.x)
    expect(thirds.every((t) => Math.abs(t.w - thirds[0]!.w) < 0.01)).toBe(true)
    const quarters = (['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const).map((s) =>
      snapRect(s, viewport)
    )
    expect(quarters[0]!.y + quarters[0]!.h).toBeLessThan(quarters[2]!.y)
    for (const snap of SNAPS) {
      const r = snapRect(snap, viewport)
      expect(r.x).toBeGreaterThanOrEqual(12)
      expect(r.x + r.w).toBeLessThanOrEqual(viewport.width - 12 + 0.01)
    }

    let windows = open(open([], 'a'), 'b')
    windows = chatWindowsReducer(windows, { type: 'snap', key: 'agent:a', snap: 'left', viewport })
    const a = windows.find((w) => w.key === 'agent:a')!
    expect(a).toMatchObject({ ...left, snap: 'left' })
    expect(frontmost(windows)?.key).toBe('agent:a')
  })

  it('keeps a snapped window snapped as the screen resizes, until it is dragged', () => {
    let windows = chatWindowsReducer(open([], 'a'), { type: 'snap', key: 'agent:a', snap: 'right', viewport })
    const smaller = { width: 1200, height: 800 }
    windows = chatWindowsReducer(windows, { type: 'fit', viewport: smaller })
    expect(windows[0]).toMatchObject(snapRect('right', smaller))
    windows = chatWindowsReducer(windows, {
      type: 'rect',
      key: 'agent:a',
      rect: { x: 100, y: 100, w: 400, h: 500 },
      viewport: smaller,
    })
    expect(windows[0]!.snap).toBeUndefined()
  })
})
