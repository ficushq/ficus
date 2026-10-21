import { describe, expect, test } from 'bun:test'
import { createSocketHeartbeat } from './socketHeartbeat'

/**
 * The client half of socket liveness. The server pings at the transport level and
 * Chromium answers those without the page ever seeing them, so a connection whose
 * frames have stopped reaching the page still looks alive to both ends. This
 * heartbeat is the page's own proof of life: after a quiet interval it sends a
 * ping, and if nothing at all comes back within the timeout the socket is dead.
 */

function fakeTimers() {
  let now = 0
  let nextId = 1
  const timers = new Map<number, { at: number; cb: () => void }>()
  return {
    schedule: (cb: () => void, ms: number) => {
      const id = nextId++
      timers.set(id, { at: now + ms, cb })
      return id as unknown as ReturnType<typeof setTimeout>
    },
    cancel: (handle: ReturnType<typeof setTimeout>) => void timers.delete(handle as unknown as number),
    advance(ms: number) {
      const until = now + ms
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        timers.delete(due[0])
        now = due[1].at
        due[1].cb()
      }
      now = until
    },
    pending: () => timers.size,
  }
}

function setup(sendResult = true) {
  const timers = fakeTimers()
  const pings: number[] = []
  let dead = 0
  const heartbeat = createSocketHeartbeat({
    intervalMs: 30_000,
    timeoutMs: 10_000,
    send: () => {
      pings.push(1)
      return sendResult
    },
    onDead: () => void dead++,
    schedule: timers.schedule,
    cancel: timers.cancel,
  })
  return { timers, pings, dead: () => dead, heartbeat }
}

describe('createSocketHeartbeat', () => {
  test('sends one ping after the quiet interval, not before', () => {
    const { timers, pings, heartbeat } = setup()
    heartbeat.start()
    timers.advance(29_999)
    expect(pings).toHaveLength(0)
    timers.advance(1)
    expect(pings).toHaveLength(1)
  })

  test('any inbound frame restarts the quiet interval', () => {
    const { timers, pings, heartbeat } = setup()
    heartbeat.start()
    timers.advance(20_000)
    heartbeat.frame()
    timers.advance(20_000)
    expect(pings).toHaveLength(0)
    timers.advance(10_000)
    expect(pings).toHaveLength(1)
  })

  test('a frame after the ping keeps the socket alive and the cycle going', () => {
    const { timers, pings, dead, heartbeat } = setup()
    heartbeat.start()
    timers.advance(30_000)
    expect(pings).toHaveLength(1)
    timers.advance(5_000)
    heartbeat.frame()
    timers.advance(5_000)
    expect(dead()).toBe(0)
    timers.advance(25_000)
    expect(pings).toHaveLength(2)
  })

  test('silence through the timeout declares the socket dead once', () => {
    const { timers, dead, heartbeat } = setup()
    heartbeat.start()
    timers.advance(30_000)
    timers.advance(9_999)
    expect(dead()).toBe(0)
    timers.advance(1)
    expect(dead()).toBe(1)
    timers.advance(60_000)
    expect(dead()).toBe(1)
  })

  test('stop cancels every pending timer', () => {
    const { timers, pings, dead, heartbeat } = setup()
    heartbeat.start()
    timers.advance(30_000)
    heartbeat.stop()
    expect(timers.pending()).toBe(0)
    timers.advance(60_000)
    expect(pings).toHaveLength(1)
    expect(dead()).toBe(0)
  })

  test('a ping that could not be sent arms no timeout and waits for the next quiet interval', () => {
    const { timers, pings, dead, heartbeat } = setup(false)
    heartbeat.start()
    timers.advance(30_000)
    expect(pings).toHaveLength(1)
    timers.advance(10_000)
    expect(dead()).toBe(0)
    timers.advance(20_000)
    expect(pings).toHaveLength(2)
  })

  test('start twice does not double the timers', () => {
    const { timers, pings, heartbeat } = setup()
    heartbeat.start()
    heartbeat.start()
    timers.advance(30_000)
    expect(pings).toHaveLength(1)
  })
})
