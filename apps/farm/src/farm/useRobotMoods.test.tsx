import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { FARM_WATCHING_HEARTBEAT_MS, type FarmWatchingResponse } from '@ficus/shared'
import { layoutFarm } from './layout'
import { createMoodStore } from './moods'
import { makeAgent, makeSquad, makeStream } from './testFixtures'
import { useRobotMoodWatching, VIEW_SETTLE_MS, type WatchingTimers } from './useRobotMoods'
import type { Camera } from './useCamera'

const ROBOT = '00000000-0000-4000-8000-000000000001'
const layout = layoutFarm({
  squads: [makeSquad()],
  streams: [makeStream({ id: 'ws', agentIds: [ROBOT], ownerAgentId: ROBOT, status: 'active' })],
  doneCount: 0,
  canceledCount: 0,
  agents: [makeAgent({ id: ROBOT })],
  assistants: [],
  pendingActions: [],
  now: 0,
})
const WIDE: Camera = { x: 0, y: 0, zoom: 0.1 }
const AWAY: Camera = { x: 100_000, y: 100_000, zoom: 1 }
const SIZE = { width: 1000, height: 800 }

/** A scheduler the test drives: pending one-shots and repeating timers, run on demand. */
function manualTimers() {
  const once = new Map<number, { ms: number; run: () => void }>()
  const repeating = new Map<number, { ms: number; run: () => void }>()
  let next = 0
  const timers: WatchingTimers = {
    after: (ms, run) => {
      const id = ++next
      once.set(id, { ms, run })
      return () => void once.delete(id)
    },
    every: (ms, run) => {
      const id = ++next
      repeating.set(id, { ms, run })
      return () => void repeating.delete(id)
    },
  }
  return {
    timers,
    pendingDelays: () => [...once.values()].map((t) => t.ms),
    intervals: () => [...repeating.values()].map((t) => t.ms),
    fireOnce: () => {
      const due = [...once.values()]
      once.clear()
      for (const t of due) t.run()
    },
    beat: () => {
      for (const t of repeating.values()) t.run()
    },
  }
}

let visibility: DocumentVisibilityState = 'visible'
// The page's visibility, owned by this file: an own property shadowing happy-dom's, removed afterwards.
beforeAll(() => Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility }))
afterAll(() => Reflect.deleteProperty(document, 'visibilityState'))

const mounted: Array<() => void> = []
afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount()
  visibility = 'visible'
})

async function mount(camera: Camera, options: { response?: FarmWatchingResponse } = {}) {
  const sent: string[][] = []
  const store = createMoodStore()
  const scheduler = manualTimers()
  const report = async (ids: string[]) => {
    sent.push(ids)
    return options.response ?? { enabled: true, moods: {} }
  }
  function Probe({ cam }: { cam: Camera }) {
    useRobotMoodWatching(layout, cam, SIZE, { report, store, timers: scheduler.timers, enabled: true })
    return null
  }
  const container = document.createElement('div')
  const root = createRoot(container)
  await act(async () => root.render(<Probe cam={camera} />))
  mounted.push(() => act(() => root.unmount()))
  return {
    sent,
    store,
    scheduler,
    move: (cam: Camera) => act(async () => root.render(<Probe cam={cam} />)),
    flush: () => act(async () => {}),
  }
}

describe('reporting the robots on screen', () => {
  it('reports once the view settles, then on every heartbeat', async () => {
    const view = await mount(WIDE)
    expect(view.scheduler.pendingDelays()).toEqual([VIEW_SETTLE_MS])
    expect(view.scheduler.intervals()).toEqual([FARM_WATCHING_HEARTBEAT_MS])
    view.scheduler.fireOnce()
    view.scheduler.beat()
    await view.flush()
    expect(view.sent).toEqual([[ROBOT], [ROBOT]])
  })

  it('reports a changed set when the view moves, and nothing for an unchanged one', async () => {
    const view = await mount(WIDE)
    view.scheduler.fireOnce()
    await view.move({ ...WIDE, x: 1 })
    expect(view.scheduler.pendingDelays()).toEqual([])
    await view.move(AWAY)
    view.scheduler.fireOnce()
    await view.flush()
    expect(view.sent).toEqual([[ROBOT], []])
  })

  it('a hidden tab stops reporting, and reports straight away when it comes back', async () => {
    const view = await mount(WIDE)
    visibility = 'hidden'
    view.scheduler.beat()
    await view.flush()
    expect(view.sent).toEqual([])
    visibility = 'visible'
    await act(async () => void document.dispatchEvent(new window.Event('visibilitychange')))
    expect(view.sent).toEqual([[ROBOT]])
  })

  it('stores what Core answers', async () => {
    const view = await mount(WIDE, {
      response: { enabled: true, moods: { [ROBOT]: { mood: 'exploring', source: 'model', at: 1 } } },
    })
    view.scheduler.fireOnce()
    await view.flush()
    expect(view.store.get().enabled).toBe(true)
    expect(view.store.get().moods.get(ROBOT)?.mood).toBe('exploring')
  })
})
