import { afterEach, describe, expect, test } from 'bun:test'
import { acquireDomHarness } from '../test/domHarness'
import { SocketLivenessTracker, watchSocketLiveness } from './socketLiveness'

/**
 * The client half of the live-update stall record: what the page believes about
 * its socket at the moments a stalled app usually comes back (focus, visibility,
 * network), so a stall leaves a timestamped trail in the console.
 */

describe('SocketLivenessTracker', () => {
  test('knows nothing before a connection opens', () => {
    const tracker = new SocketLivenessTracker(() => 5_000)
    expect(tracker.snapshot(undefined)).toEqual({ readyState: 'none', openForMs: null, sinceLastMessageMs: null })
  })

  test('measures the open connection and the quiet time since its last frame', () => {
    let now = 1_000
    const tracker = new SocketLivenessTracker(() => now)
    tracker.opened()
    now = 1_500
    tracker.message()
    now = 4_000
    expect(tracker.snapshot(WebSocket.OPEN)).toEqual({
      readyState: 'open',
      openForMs: 3_000,
      sinceLastMessageMs: 2_500,
    })
  })

  test('a connection that has never received a frame has no quiet time, only an age', () => {
    let now = 1_000
    const tracker = new SocketLivenessTracker(() => now)
    tracker.opened()
    now = 2_000
    expect(tracker.snapshot(WebSocket.OPEN)).toEqual({ readyState: 'open', openForMs: 1_000, sinceLastMessageMs: null })
  })

  test("a reopened connection does not inherit the previous connection's frames", () => {
    let now = 1_000
    const tracker = new SocketLivenessTracker(() => now)
    tracker.opened()
    tracker.message()
    now = 2_000
    tracker.closed()
    expect(tracker.snapshot(WebSocket.CLOSED)).toEqual({
      readyState: 'closed',
      openForMs: null,
      sinceLastMessageMs: null,
    })
    now = 3_000
    tracker.opened()
    expect(tracker.snapshot(WebSocket.OPEN)).toEqual({ readyState: 'open', openForMs: 0, sinceLastMessageMs: null })
  })

  test('remembers when the page last saw life: the last frame, else the open, else nothing', () => {
    let now = 1_000
    const tracker = new SocketLivenessTracker(() => now)
    expect(tracker.lastSeenAt()).toBeNull()
    tracker.opened()
    expect(tracker.lastSeenAt()).toBe(1_000)
    now = 1_500
    tracker.message()
    expect(tracker.lastSeenAt()).toBe(1_500)
    tracker.closed()
    expect(tracker.lastSeenAt()).toBeNull()
  })

  test('names every ready state', () => {
    const tracker = new SocketLivenessTracker(() => 0)
    expect(tracker.snapshot(WebSocket.CONNECTING).readyState).toBe('connecting')
    expect(tracker.snapshot(WebSocket.CLOSING).readyState).toBe('closing')
    expect(tracker.snapshot(WebSocket.CLOSED).readyState).toBe('closed')
  })
})

describe('watchSocketLiveness', () => {
  let dom: Awaited<ReturnType<typeof acquireDomHarness>> | undefined

  afterEach(async () => {
    await dom?.cleanup()
    dom = undefined
  })

  test('reports each signal that usually brings a stalled app back', async () => {
    dom = await acquireDomHarness({ url: 'http://localhost/' })
    const { window } = dom
    const { document } = window
    const reported: string[] = []
    const stop = watchSocketLiveness((trigger) => reported.push(trigger), { window, document })

    document.dispatchEvent(new window.Event('visibilitychange'))
    window.dispatchEvent(new window.Event('focus'))
    window.dispatchEvent(new window.Event('online'))
    window.dispatchEvent(new window.Event('pageshow'))

    expect(reported).toEqual(['visibilitychange', 'focus', 'online', 'pageshow'])
    stop()
  })

  test('stops reporting once disposed', async () => {
    dom = await acquireDomHarness({ url: 'http://localhost/' })
    const { window } = dom
    const { document } = window
    const reported: string[] = []
    const stop = watchSocketLiveness((trigger) => reported.push(trigger), { window, document })
    stop()

    document.dispatchEvent(new window.Event('visibilitychange'))
    window.dispatchEvent(new window.Event('focus'))
    window.dispatchEvent(new window.Event('online'))
    window.dispatchEvent(new window.Event('pageshow'))

    expect(reported).toEqual([])
  })
})
