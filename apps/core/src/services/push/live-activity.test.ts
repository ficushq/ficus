import { describe, expect, test } from 'bun:test'
import type { WorkStream } from '@ficus/shared'
import {
  createLiveActivityFanout,
  endLiveActivitiesForUser,
  FANOUT_DEBOUNCE_MS,
  type LiveActivityFanoutDeps,
} from './live-activity'

/**
 * A hand-driven clock: timers fire only when a test advances them, so the debounce is asserted
 * deterministically instead of by sleeping.
 */
function fakeTimers() {
  let seq = 0
  const pending = new Map<number, () => void>()
  return {
    setTimer: ((fn: () => void) => {
      const id = ++seq
      pending.set(id, fn)
      return id
    }) as unknown as NonNullable<LiveActivityFanoutDeps['setTimer']>,
    clearTimer: ((handle: number) => {
      pending.delete(handle)
    }) as unknown as NonNullable<LiveActivityFanoutDeps['clearTimer']>,
    async run() {
      const fns = [...pending.values()]
      pending.clear()
      for (const fn of fns) fn()
      for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve))
    },
    get size() {
      return pending.size
    },
  }
}

const running = (id: string): WorkStream =>
  ({ id, squadId: 'sq-1', title: id, status: 'active', updatedAt: new Date('2026-08-29T12:00:00Z') }) as WorkStream

const idle = (id: string): WorkStream =>
  ({ id, squadId: 'sq-1', title: id, status: 'queued', updatedAt: new Date('2026-08-29T12:00:00Z') }) as WorkStream

const UPDATE_TOKEN = {
  id: 'r1',
  userId: 'user-1',
  apnsToken: 'tok-update',
  kind: 'update',
  activityId: 'a',
  environment: 'production',
}
const UPDATE_TOKEN_2 = { ...UPDATE_TOKEN, id: 'r3', apnsToken: 'tok-update-2', activityId: 'b' }
const START_TOKEN = {
  id: 'r2',
  userId: 'user-1',
  apnsToken: 'tok-start',
  kind: 'start',
  activityId: null,
  environment: 'production',
}

function harness(options: {
  streams: () => WorkStream[]
  tokens?: unknown[]
  sendResult?: (token: string, event: string) => { ok: boolean; status: number }
}) {
  const sent: { token: string; event: string; attributes?: unknown }[] = []
  const deleted: string[] = []
  let streamLoads = 0
  const timers = fakeTimers()
  const fanout = createLiveActivityFanout({
    resolveUserIds: async () => ['user-1'],
    loadUserStreams: async () => {
      streamLoads += 1
      return options.streams()
    },
    origin: () => 'https://demo.hiretau.ai',
    // Stubbed so delivery is exercised without real APNs settings — otherwise every assertion
    // below would pass vacuously because pushFor() would bail at the config check.
    hasApnsConfig: () => true,
    listTokens: (async () => options.tokens ?? [UPDATE_TOKEN]) as unknown as LiveActivityFanoutDeps['listTokens'],
    send: (async (token: string, payload: { event: string; attributes?: unknown }) => {
      sent.push({ token, event: payload.event, attributes: payload.attributes })
      return options.sendResult?.(token, payload.event) ?? { ok: true, status: 200 }
    }) as unknown as LiveActivityFanoutDeps['send'],
    deleteToken: (async (token: string) => {
      deleted.push(token)
      return true
    }) as unknown as LiveActivityFanoutDeps['deleteToken'],
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  })
  return { fanout, sent, deleted, timers, streamLoads: () => streamLoads }
}

test('user deletion ends update-token activities before token rows can cascade', async () => {
  const sent: string[] = []
  await endLiveActivitiesForUser('user-1', {
    hasApnsConfig: () => true,
    listTokens: (async () => [START_TOKEN, UPDATE_TOKEN]) as unknown as LiveActivityFanoutDeps['listTokens'],
    send: (async (token: string, payload: { event: string }) => {
      sent.push(`${payload.event}:${token}`)
      return { ok: true, status: 200 }
    }) as unknown as LiveActivityFanoutDeps['send'],
  })
  expect(sent).toEqual(['end:tok-update'])
})

describe('live activity fan-out scheduling', () => {
  test('coalesces a burst of events into ONE push', async () => {
    const { fanout, sent, timers } = harness({ streams: () => [running('a')] })
    await fanout.onWorkStreamEvent({ squadId: 'sq-1' })
    await fanout.onWorkStreamEvent({ squadId: 'sq-1' })
    await fanout.onWorkStreamEvent({ squadId: 'sq-1' })
    expect(timers.size).toBe(1) // refreshed, not stacked
    await timers.run()
    expect(sent.filter((s) => s.event === 'update')).toHaveLength(1)
    fanout.stop()
  })

  // No feature flag: the feature gates itself on whether the user actually has an activity to
  // update. This is what keeps it free for instances where nobody uses the widget — the stream
  // query reads every active/queued stream, so it must not run for token-less subscribers.
  test('a user with no Live Activity tokens costs nothing — no stream query, no push', async () => {
    const { fanout, sent, streamLoads } = harness({ streams: () => [running('a')], tokens: [] })
    await fanout.flushUser('user-1')
    expect(streamLoads()).toBe(0)
    expect(sent).toEqual([])
    fanout.stop()
  })

  test('stop() cancels pending work so shutdown cannot fire a push', async () => {
    const { fanout, sent, timers } = harness({ streams: () => [running('a')] })
    await fanout.onWorkStreamEvent({ squadId: 'sq-1' })
    fanout.stop()
    await timers.run()
    expect(sent).toEqual([])
  })

  test('the debounce window is the documented 3s', () => {
    expect(FANOUT_DEBOUNCE_MS).toBe(3_000)
  })
})

describe('live activity fan-out delivery', () => {
  test('a cold process updates an existing activity without creating a duplicate start', async () => {
    const { fanout, sent } = harness({ streams: () => [running('a')], tokens: [START_TOKEN, UPDATE_TOKEN] })
    await fanout.flushUser('user-1')
    expect(sent.map((s) => `${s.event}:${s.token}`)).toEqual(['update:tok-update'])
    fanout.stop()
  })

  test('a cold process starts only after every existing update token is terminal', async () => {
    const { fanout, sent, deleted } = harness({
      streams: () => [running('a')],
      tokens: [START_TOKEN, UPDATE_TOKEN],
      sendResult: (_token, event) => (event === 'update' ? { ok: false, status: 410 } : { ok: true, status: 200 }),
    })
    await fanout.flushUser('user-1')
    expect(sent.map((s) => `${s.event}:${s.token}`)).toEqual(['update:tok-update', 'start:tok-start'])
    expect(sent[1]!.attributes).toEqual({ origin: 'https://demo.hiretau.ai' })
    expect(deleted).toEqual(['tok-update'])
    fanout.stop()
  })

  test('an unchanged state does not spend a push', async () => {
    const { fanout, sent } = harness({ streams: () => [running('a')] })
    await fanout.flushUser('user-1')
    const afterFirst = sent.length
    expect(afterFirst).toBeGreaterThan(0)
    await fanout.flushUser('user-1')
    expect(sent).toHaveLength(afterFirst)
    fanout.stop()
  })

  test('a changed state does send again', async () => {
    let streams = [running('a')]
    const { fanout, sent } = harness({ streams: () => streams })
    await fanout.flushUser('user-1')
    const afterFirst = sent.length
    streams = [running('a'), running('b')]
    await fanout.flushUser('user-1')
    expect(sent.length).toBeGreaterThan(afterFirst)
    fanout.stop()
  })

  test('→ 0 ends the activity rather than leaving a zeroed card', async () => {
    let streams = [running('a')]
    const { fanout, sent } = harness({ streams: () => streams })
    await fanout.flushUser('user-1')
    sent.length = 0
    streams = [idle('a')] // queued only: nothing running, nothing needing the user
    await fanout.flushUser('user-1')
    expect(sent.map((s) => s.event)).toEqual(['end'])
    fanout.stop()
  })

  test('after ending, the next show is a fresh start rather than an update into a dead activity', async () => {
    let streams = [running('a')]
    const { fanout, sent } = harness({ streams: () => streams, tokens: [START_TOKEN, UPDATE_TOKEN] })
    await fanout.flushUser('user-1')
    streams = [idle('a')]
    await fanout.flushUser('user-1')
    sent.length = 0
    streams = [running('a')]
    await fanout.flushUser('user-1')
    expect(sent.map((s) => s.event)).toEqual(['start', 'update'])
    fanout.stop()
  })

  test('a cold fan-out ends an existing update-token activity for authoritative empty interest', async () => {
    const { fanout, sent } = harness({ streams: () => [idle('a')] })
    await fanout.flushUser('user-1')
    expect(sent.map((item) => item.event)).toEqual(['end'])
    await fanout.flushUser('user-1')
    expect(sent.map((item) => item.event)).toEqual(['end'])
    fanout.stop()
  })

  test('nothing is sent to a start-only token when there was never anything to show', async () => {
    const { fanout, sent } = harness({ streams: () => [idle('a')], tokens: [START_TOKEN] })
    await fanout.flushUser('user-1')
    expect(sent).toEqual([])
    fanout.stop()
  })

  test('retries a transient update on its timer without another event', async () => {
    let attempt = 0
    const { fanout, sent, timers } = harness({
      streams: () => [running('a')],
      sendResult: () => (++attempt === 1 ? { ok: false, status: 500 } : { ok: true, status: 200 }),
    })
    await fanout.flushUser('user-1')
    expect(timers.size).toBe(1)
    await timers.run()
    expect(sent.map((item) => item.event)).toEqual(['update', 'update'])
    fanout.stop()
  })

  test('retries a transient end on its timer without another event', async () => {
    let attempt = 0
    const { fanout, sent, timers } = harness({
      streams: () => [idle('a')],
      sendResult: () => (++attempt === 1 ? { ok: false, status: 500 } : { ok: true, status: 200 }),
    })
    await fanout.flushUser('user-1')
    expect(timers.size).toBe(1)
    await timers.run()
    expect(sent.map((item) => item.event)).toEqual(['end', 'end'])
    fanout.stop()
  })

  test('bounds timer-driven retries and does not retry permanent APNs failures', async () => {
    const transient = harness({
      streams: () => [running('a')],
      sendResult: () => ({ ok: false, status: 500 }),
    })
    await transient.fanout.flushUser('user-1')
    await transient.timers.run()
    await transient.timers.run()
    expect(transient.sent).toHaveLength(3)
    expect(transient.timers.size).toBe(0)
    transient.fanout.stop()

    const permanent = harness({
      streams: () => [running('a')],
      sendResult: () => ({ ok: false, status: 400 }),
    })
    await permanent.fanout.flushUser('user-1')
    expect(permanent.sent).toHaveLength(1)
    expect(permanent.timers.size).toBe(0)
    permanent.fanout.stop()
  })

  test('retries only the failed token after a partial delivery', async () => {
    let failedAttempts = 0
    const fixture = harness({
      streams: () => [running('a')],
      tokens: [UPDATE_TOKEN, UPDATE_TOKEN_2],
      sendResult: (token) =>
        token === UPDATE_TOKEN_2.apnsToken && ++failedAttempts === 1
          ? { ok: false, status: 500 }
          : { ok: true, status: 200 },
    })
    await fixture.fanout.flushUser('user-1')
    await fixture.timers.run()
    expect(fixture.sent.map(({ token }) => token)).toEqual(['tok-update', 'tok-update-2', 'tok-update-2'])
    fixture.fanout.stop()
  })

  // 410 is the normal end of a Live Activity token's life, not an incident.
  test('prunes a token APNs reports as gone (410)', async () => {
    const { fanout, deleted } = harness({
      streams: () => [running('a')],
      sendResult: () => ({ ok: false, status: 410 }),
    })
    await fanout.flushUser('user-1')
    expect(deleted).toEqual(['tok-update'])
    fanout.stop()
  })

  test('does not prune on an ordinary failure', async () => {
    const { fanout, deleted } = harness({
      streams: () => [running('a')],
      sendResult: () => ({ ok: false, status: 500 }),
    })
    await fanout.flushUser('user-1')
    expect(deleted).toEqual([])
    fanout.stop()
  })
})
