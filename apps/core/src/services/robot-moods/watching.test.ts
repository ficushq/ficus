import { afterEach, describe, expect, test } from 'bun:test'
import { FARM_WATCHING_MAX_AGENTS, FARM_WATCHING_TTL_MS } from '@ficus/shared'
import { eventEmitter } from '../../lib/infra/event-emitter'
import { INTERNAL_EVENTS_PATH, LocalEventTransport } from '../../lib/infra/local-events'
import { reportWatching, startRobotMoodCache, startRobotMoodWatchingListener } from '.'
import {
  decodeWatching,
  encodeWatching,
  FARM_WATCHING_CHANNEL,
  moodCache,
  MoodCache,
  WatchedSet,
  watchedRobots,
} from './watching'

function clock(start = 5_000_000) {
  let now = start
  return { now: () => now, advance: (ms: number) => (now += ms) }
}

describe('WatchedSet', () => {
  test('a report keeps robots watched for 45s, and each heartbeat pushes that out', () => {
    const time = clock()
    const watched = new WatchedSet(time.now)
    watched.watch(['a', 'b'])
    time.advance(FARM_WATCHING_TTL_MS - 1)
    expect(watched.has('a')).toBe(true)
    watched.watch(['a'])
    time.advance(1)
    expect(watched.has('a')).toBe(true)
    expect(watched.has('b')).toBe(false)
    time.advance(FARM_WATCHING_TTL_MS)
    expect(watched.has('a')).toBe(false)
    expect(watched.size()).toBe(0)
  })

  test('a report cannot ask for longer than the TTL', () => {
    const time = clock()
    const watched = new WatchedSet(time.now)
    watched.watch(['a'], 10 * 60_000)
    time.advance(FARM_WATCHING_TTL_MS)
    expect(watched.has('a')).toBe(false)
  })

  test('is bounded: past its size the oldest reports lapse first', () => {
    const time = clock()
    const watched = new WatchedSet(time.now, 3)
    watched.watch(['a', 'b'])
    time.advance(10)
    watched.watch(['c', 'd'])
    expect(watched.size()).toBe(3)
    expect(watched.has('a')).toBe(false)
    expect(watched.has('d')).toBe(true)
  })
})

describe('farm_watching payloads', () => {
  test('round-trip, capped to the most one report may name', () => {
    const ids = Array.from({ length: FARM_WATCHING_MAX_AGENTS + 5 }, (_, i) => `agent-${i}`)
    const decoded = decodeWatching(encodeWatching(ids))!
    expect(decoded.agentIds).toHaveLength(FARM_WATCHING_MAX_AGENTS)
    expect(decoded.ttlMs).toBe(FARM_WATCHING_TTL_MS)
  })

  test('anything else is ignored', () => {
    expect(decodeWatching('not json')).toBeNull()
    expect(decodeWatching(JSON.stringify({ agentIds: 'a', ttlMs: 1 }))).toBeNull()
    expect(decodeWatching(JSON.stringify({ agentIds: ['a', 7, ''], ttlMs: 1 }))!.agentIds).toEqual(['a'])
  })
})

describe('handing the watched set from the API to the worker', () => {
  const open: LocalEventTransport[] = []
  afterEach(async () => {
    for (const transport of open) await transport.close()
    open.length = 0
  })

  test('over the real local-events transport, and the worker forgets unwatched robots', async () => {
    const token = 'robot-moods-test-token'
    const worker = new LocalEventTransport({ token })
    open.push(worker)
    const server = worker.serve({ port: 0 })
    const api = new LocalEventTransport({ token, peerUrl: `http://127.0.0.1:${server.port}${INTERNAL_EVENTS_PATH}` })
    open.push(api)

    const time = clock()
    const apiWatched = new WatchedSet(time.now)
    const workerWatched = new WatchedSet(time.now)
    let prunes = 0
    let received!: () => void
    const arrived = new Promise<void>((resolve) => (received = resolve))
    await startRobotMoodWatchingListener({
      watched: workerWatched,
      tracker: {
        prune: () => {
          prunes++
          received()
        },
      },
      listen: (channel, callback) => worker.listen(channel, callback),
    })

    reportWatching(['agent-1', 'agent-2'], { watched: apiWatched, notify: (c, p) => api.notify(c, p) })
    await arrived

    expect(apiWatched.has('agent-1')).toBe(true)
    expect(workerWatched.has('agent-1')).toBe(true)
    expect(workerWatched.has('agent-2')).toBe(true)
    expect(prunes).toBe(1)
    time.advance(FARM_WATCHING_TTL_MS)
    expect(workerWatched.has('agent-1')).toBe(false)
  })

  test('an empty report sends nothing', () => {
    const sent: string[] = []
    reportWatching([], {
      watched: new WatchedSet(),
      notify: async (channel) => void sent.push(channel),
    })
    expect(sent).toEqual([])
  })

  test('a report the worker cannot reach is only logged', async () => {
    const watched = new WatchedSet()
    expect(() => reportWatching(['a'], { watched, notify: () => Promise.reject(new Error('peer down')) })).not.toThrow()
    expect(watched.has('a')).toBe(true)
    expect(FARM_WATCHING_CHANNEL).toBe('farm_watching')
  })
})

describe('the API mood cache', () => {
  afterEach(() => {
    moodCache.clear()
    watchedRobots.clear()
  })

  test('keeps the latest mood of watched robots only', () => {
    const time = clock()
    const watched = new WatchedSet(time.now)
    const cache = new MoodCache(watched)
    watched.watch(['a', 'b'])
    cache.record('a', { mood: 'exploring', source: 'model', at: 1 })
    cache.record('a', { mood: 'risky', source: 'model', at: 2 })
    cache.record('b', { mood: 'stuck', source: 'signal', at: 3 })
    cache.record('c', { mood: 'focused', source: 'signal', at: 4 })
    expect(cache.get(['a', 'b', 'c'])).toEqual({
      a: { mood: 'risky', source: 'model', at: 2 },
      b: { mood: 'stuck', source: 'signal', at: 3 },
    })
    time.advance(FARM_WATCHING_TTL_MS)
    expect(cache.get(['a', 'b'])).toEqual({})
  })

  test('ignores anything that is not a mood', () => {
    const watched = new WatchedSet()
    watched.watch(['a'])
    const cache = new MoodCache(watched)
    cache.record('a', { mood: 'ecstatic' as never, source: 'model', at: 1 })
    expect(cache.get(['a'])).toEqual({})
  })

  test("is filled from the worker's agent.mood events", () => {
    const stop = startRobotMoodCache()
    try {
      reportWatching(['mood-agent'], { notify: async () => {} })
      eventEmitter.emit('agent.mood', {
        agentId: 'mood-agent',
        squadId: null,
        mood: 'struggling',
        source: 'model',
        at: 9,
      })
      expect(moodCache.get(['mood-agent'])).toEqual({ 'mood-agent': { mood: 'struggling', source: 'model', at: 9 } })
    } finally {
      stop()
    }
  })
})
