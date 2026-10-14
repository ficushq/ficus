import { describe, expect, test } from 'bun:test'
import type { DecisionRequest } from '@ficus/shared'
import type { DecideOptions, DecisionOutcome } from '../decisions/service'
import { StreamBuffer } from '../streaming/buffer'
import { StreamEventCollector } from '../streaming/events'
import {
  MAX_TRACKED_ROBOTS,
  MOOD_MODEL_INTERVAL_MS,
  MOOD_TEXT_TAIL,
  MOOD_WINDOW_CALLS,
  moodRequest,
  RobotMoodTracker,
  type MoodEvent,
  type RobotMoodEvent,
  type RobotMoodTrackerDeps,
} from './tracker'

const AGENT = 'agent-1'

interface Asked {
  request: DecisionRequest
  options: DecideOptions
}

/** A tracker with an owned clock and a recorded, scripted decision model. */
function harness(overrides: Partial<RobotMoodTrackerDeps> & { answer?: string | null } = {}) {
  let now = 1_000_000
  const asked: Asked[] = []
  const emitted: RobotMoodEvent[] = []
  const errors: unknown[] = []
  const pending: Array<(outcome: DecisionOutcome) => void> = []
  const answer = overrides.answer === undefined ? 'exploring' : overrides.answer
  const tracker = new RobotMoodTracker({
    decide: async (_purpose, request, options) => {
      asked.push({ request, options })
      if (answer === null) return new Promise<DecisionOutcome>((resolve) => pending.push(resolve))
      return {
        ok: true,
        result: {
          answers: { mood: { type: 'choice', choice: answer, probabilities: { [answer]: 0.9 } } },
          providerId: 'p',
          model: 'm',
          latencyMs: 1,
        },
      }
    },
    isEnabled: () => true,
    isWatched: () => true,
    emit: (event) => emitted.push(event),
    now: () => now,
    onError: (error) => errors.push(error),
    ...overrides,
  })
  const feed = (...events: MoodEvent[]) => {
    for (const event of events) tracker.observe(AGENT, 'squad-1', event)
  }
  return {
    tracker,
    asked,
    emitted,
    errors,
    pending,
    feed,
    advance: (ms: number) => (now += ms),
    moods: () => emitted.map((event) => `${event.mood}:${event.source}`),
    last: () => emitted.at(-1),
  }
}

/** Lets queued microtasks (the background question) and its answer run. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

let callId = 0
function call(toolName: string, args: unknown, isError = false): MoodEvent[] {
  const toolCallId = `call-${++callId}`
  return [
    { type: 'tool_execution_start', toolCallId, toolName, args },
    { type: 'tool_execution_end', toolCallId, toolName, result: isError ? 'boom' : 'ok', isError },
  ]
}
const text = (delta: string): MoodEvent => ({
  type: 'message_update',
  message: { role: 'assistant' },
  assistantMessageEvent: { type: 'text_delta', delta },
})
const messageEnd: MoodEvent = { type: 'message_end', message: { role: 'assistant' } }
const start: MoodEvent = { type: 'agent_start' }
const endOk: MoodEvent = { type: 'agent_end', messages: [{ role: 'assistant', stopReason: 'stop' }], willRetry: false }

describe('cheap signals', () => {
  test('looping: the same tool with the same arguments three times in a row', async () => {
    const h = harness({ decide: async () => ({ ok: false, reason: 'unavailable', errors: [] }) })
    h.feed(start, ...call('read', { path: 'a.ts' }), ...call('read', { path: 'a.ts' }))
    expect(h.last()?.mood).not.toBe('looping')
    h.feed(...call('read', { path: 'a.ts' }))
    expect(h.last()).toMatchObject({ mood: 'looping', source: 'signal', agentId: AGENT, squadId: 'squad-1' })
    // Different arguments break the run.
    h.feed(...call('read', { path: 'b.ts' }))
    expect(h.last()?.mood).toBe('focused')
  })

  test('stuck: two tool errors in a row, but one error alone is not', () => {
    const h = harness()
    h.feed(start, ...call('bash', { command: 'bun test' }, true))
    expect(h.moods()).not.toContain('stuck:signal')
    h.feed(...call('bash', { command: 'bun test --bail' }, true))
    expect(h.last()).toMatchObject({ mood: 'stuck', source: 'signal' })
    // A call that works clears it.
    h.feed(...call('bash', { command: 'ls' }))
    expect(h.last()?.mood).not.toBe('stuck')
  })

  test('stuck: provider retries count as failures, and a successful retry clears them', () => {
    const h = harness()
    h.feed(start, { type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 1, errorMessage: 'x' })
    h.feed({ type: 'auto_retry_start', attempt: 2, maxAttempts: 3, delayMs: 1, errorMessage: 'x' })
    expect(h.last()?.mood).toBe('stuck')
    h.feed({ type: 'auto_retry_end', success: true, attempt: 2 })
    expect(h.last()?.mood).toBe('focused')
  })

  test('waiting: a blocking ask_human, through the end of the turn', () => {
    const h = harness()
    h.feed(start, ...call('ask_human', { question: 'Which?', blocking: true }))
    expect(h.last()).toMatchObject({ mood: 'waiting', source: 'signal' })
    h.feed(endOk, { type: 'agent_settled' })
    expect(h.last()?.mood).toBe('waiting')
  })

  test('a non-blocking question is not waiting', () => {
    const h = harness()
    h.feed(start, ...call('ask_human', { question: 'FYI?' }))
    expect(h.moods()).not.toContain('waiting:signal')
  })

  test('wrapping-up: the turn ended well; idle: it ended badly or not at all', () => {
    const ok = harness()
    ok.feed(start, ...call('edit', { path: 'a.ts' }), endOk, { type: 'agent_settled' })
    expect(ok.last()).toMatchObject({ mood: 'wrapping-up', source: 'signal' })

    const failed = harness()
    failed.feed(start, { type: 'agent_end', messages: [{ role: 'assistant', stopReason: 'error' }], willRetry: false })
    expect(failed.last()).toMatchObject({ mood: 'idle', source: 'signal' })

    const aborted = harness()
    aborted.feed(start, { type: 'agent_settled' })
    expect(aborted.last()?.mood).toBe('idle')

    // A turn about to be retried hasn't ended.
    const retrying = harness()
    retrying.feed(start, { type: 'agent_end', messages: [], willRetry: true })
    expect(retrying.moods()).not.toContain('wrapping-up:signal')
  })

  test('a new run starts fresh', () => {
    const h = harness()
    h.feed(start, ...call('edit', { path: 'a.ts' }), endOk)
    expect(h.last()?.mood).toBe('wrapping-up')
    h.feed(start)
    expect(h.last()?.mood).toBe('focused')
  })

  test('publishes only changes', () => {
    const h = harness()
    h.feed(start, ...call('read', { path: 'a' }), ...call('read', { path: 'a' }), ...call('read', { path: 'a' }))
    h.feed(...call('read', { path: 'a' }), ...call('read', { path: 'a' }))
    expect(h.moods().filter((m) => m === 'looping:signal')).toHaveLength(1)
  })
})

describe('the decision model', () => {
  test('is asked at a boundary when nothing simpler tells, and its answer becomes the mood', async () => {
    const h = harness({ answer: 'exploring' })
    h.feed(start, text('Let me look at how the farm draws robots.'), ...call('grep', { pattern: 'RobotAvatar' }))
    await settle()
    expect(h.asked).toHaveLength(1)
    expect(h.asked[0]!.options).toEqual({ timeoutMs: 2000, source: { kind: 'robot-mood', agentId: AGENT } })
    expect(h.last()).toMatchObject({ mood: 'exploring', source: 'model' })
  })

  test('is never asked between boundaries (a tool starting, text streaming)', async () => {
    const h = harness()
    h.feed(start, { type: 'tool_execution_start', toolCallId: 'x', toolName: 'bash', args: { command: 'ls' } })
    h.feed(text('working on it'))
    await settle()
    expect(h.asked).toHaveLength(0)
    h.feed(messageEnd)
    await settle()
    expect(h.asked).toHaveLength(1)
  })

  test('is asked at most once per robot every 30s', async () => {
    const h = harness()
    h.feed(start, ...call('read', { path: 'a' }))
    await settle()
    h.feed(...call('read', { path: 'b' }), messageEnd)
    h.advance(MOOD_MODEL_INTERVAL_MS - 1)
    h.feed(...call('read', { path: 'c' }))
    await settle()
    expect(h.asked).toHaveLength(1)
    h.advance(1)
    h.feed(...call('read', { path: 'd' }))
    await settle()
    expect(h.asked).toHaveLength(2)
  })

  test('one question at a time per robot', async () => {
    const h = harness({ answer: null })
    h.feed(start, ...call('read', { path: 'a' }))
    await settle()
    h.advance(MOOD_MODEL_INTERVAL_MS * 2)
    h.feed(...call('read', { path: 'b' }))
    await settle()
    expect(h.asked).toHaveLength(1)
  })

  test('is not asked when a cheap signal applies', async () => {
    const h = harness()
    h.feed(start, ...call('bash', { command: 'make' }, true), ...call('bash', { command: 'make' }, true))
    await settle()
    // The first error alone was unclear, so the model was asked once; the stuck robot isn't asked again.
    const before = h.asked.length
    h.advance(MOOD_MODEL_INTERVAL_MS)
    h.feed(...call('bash', { command: 'make' }, true))
    await settle()
    expect(h.asked).toHaveLength(before)
    expect(h.last()?.mood).toBe('stuck')
  })

  test('a late answer does not cover a signal that appeared meanwhile', async () => {
    const h = harness({ answer: null })
    h.feed(start, ...call('read', { path: 'a' }))
    await settle()
    h.feed(...call('bash', { command: 'x' }, true), ...call('bash', { command: 'y' }, true))
    h.pending[0]!({
      ok: true,
      result: {
        answers: { mood: { type: 'choice', choice: 'focused', probabilities: {} } },
        providerId: 'p',
        model: 'm',
        latencyMs: 1,
      },
    })
    await settle()
    expect(h.last()?.mood).toBe('stuck')
  })

  test('is not asked when nobody watches, and nothing is kept or published', async () => {
    const h = harness({ isWatched: () => false })
    h.feed(start, ...call('read', { path: 'a' }), ...call('bash', { command: 'x' }, true), messageEnd)
    await settle()
    expect(h.asked).toHaveLength(0)
    expect(h.emitted).toHaveLength(0)
    expect(h.tracker.size()).toBe(0)
  })

  test('is not asked when the feature is off, and nothing is kept or published', async () => {
    const h = harness({ isEnabled: () => false })
    h.feed(start, ...call('read', { path: 'a' }), messageEnd)
    await settle()
    expect(h.asked).toHaveLength(0)
    expect(h.emitted).toHaveLength(0)
    expect(h.tracker.size()).toBe(0)
  })

  test('an answer outside the model moods is ignored', async () => {
    const h = harness({ answer: 'looping' })
    h.feed(start, ...call('read', { path: 'a' }))
    await settle()
    expect(h.moods()).toEqual(['focused:signal'])
  })
})

describe('state', () => {
  test('a robot that stops being watched is forgotten, and its answer goes nowhere', async () => {
    let watched = true
    const h = harness({ isWatched: () => watched, answer: null })
    h.feed(start, ...call('read', { path: 'a' }))
    await settle()
    expect(h.tracker.size()).toBe(1)
    watched = false
    h.tracker.prune()
    expect(h.tracker.size()).toBe(0)
    h.pending[0]!({
      ok: true,
      result: {
        answers: { mood: { type: 'choice', choice: 'risky', probabilities: {} } },
        providerId: 'p',
        model: 'm',
        latencyMs: 1,
      },
    })
    await settle()
    expect(h.moods()).not.toContain('risky:model')
  })

  test('each window keeps a few calls and a few hundred characters, however long the run', () => {
    const h = harness({ decide: async () => ({ ok: false, reason: 'unconfigured', errors: [] }) })
    h.feed(start)
    for (let i = 0; i < 500; i++)
      h.feed(text('x'.repeat(97)), ...call('write', { path: `f${i}`, content: 'y'.repeat(10_000) }))
    const window = h.tracker.windowOf(AGENT)!
    expect(window.calls).toHaveLength(MOOD_WINDOW_CALLS)
    expect(window.text.length).toBe(MOOD_TEXT_TAIL)
    // Arguments are never kept: only a hash and a short target.
    expect(JSON.stringify(window).length).toBeLessThan(1_000)
  })

  test('tracks a bounded number of robots', () => {
    const h = harness()
    for (let i = 0; i < MAX_TRACKED_ROBOTS + 50; i++) h.tracker.observe(`agent-${i}`, null, start)
    expect(h.tracker.size()).toBe(MAX_TRACKED_ROBOTS)
  })

  test('stream content goes only in the question state, redacted and short', () => {
    const h = harness()
    const secretText = 'I will now run zebracorn with token ghp_abcdefghijklmnopqrstuvwxyz0123 and push.'
    h.feed(start, text(secretText), ...call('bash', { command: 'git push --force origin zebrabranch' }))
    h.feed(...call('read', { path: '/workspace/src/very/long/' + 'x'.repeat(200) + '.ts' }))
    const request = moodRequest(h.tracker.windowOf(AGENT)!)
    const questions = JSON.stringify(request.questions)
    expect(questions).not.toContain('zebracorn')
    expect(questions).not.toContain('zebrabranch')
    const state = request.state as { recentTools: Array<Record<string, string>>; latestText: string }
    expect(state.recentTools[0]).toEqual({ tool: 'bash', target: 'git push --force origin zebrabranch', result: 'ok' })
    expect(state.recentTools[1]!.target.length).toBeLessThanOrEqual(80)
    expect(state.latestText).toContain('zebracorn')
    expect(state.latestText).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123')
    expect(Object.keys(request.questions)).toEqual(['mood'])
    expect(request.questions.mood).toMatchObject({ type: 'choice' })
    expect(Object.keys((request.questions.mood as { options: object }).options)).toEqual([
      'focused',
      'exploring',
      'struggling',
      'risky',
    ])
  })

  test('a full question is about 300 to 400 tokens', () => {
    const h = harness()
    h.feed(start, text('y'.repeat(MOOD_TEXT_TAIL)))
    h.feed(...call('bash', { command: 'bun test apps/core/src/services/robot-moods/tracker.test.ts --timeout 5000' }))
    h.feed(...call('read', { path: '/workspace/apps/farm/src/farm/RobotAvatar.tsx' }))
    h.feed(...call('grep', { pattern: 'faceFor\\(agent, halted\\)', path: '/workspace/apps/farm/src' }, true))
    // Decision cost's own estimate when a provider reports no usage: about four characters a token.
    const tokens = Math.ceil(JSON.stringify(moodRequest(h.tracker.windowOf(AGENT)!)).length / 4)
    expect(tokens).toBeGreaterThan(250)
    expect(tokens).toBeLessThan(450)
  })
})

describe('never affects the stream', () => {
  const throwing = () => {
    throw new Error('tracker dependency failed')
  }

  test.each([
    ['isWatched', { isWatched: throwing }],
    ['isEnabled', { isEnabled: throwing }],
    ['emit', { emit: throwing }],
    ['decide (throws)', { decide: throwing as unknown as RobotMoodTrackerDeps['decide'] }],
    ['decide (rejects)', { decide: async () => throwing() }],
  ] as const)('a failing %s is swallowed', async (_name, deps) => {
    const h = harness(deps as Partial<RobotMoodTrackerDeps>)
    expect(() => h.feed(start, text('hi'), ...call('read', { path: 'a' }), messageEnd, endOk)).not.toThrow()
    await settle()
    expect(h.errors.length).toBeGreaterThan(0)
  })

  test('malformed events are swallowed', () => {
    const h = harness()
    const weird = [
      { type: 'tool_execution_start', toolCallId: 1, toolName: null, args: { toJSON: throwing } },
      { type: 'tool_execution_end' },
      { type: 'agent_end', messages: 'nope' },
      { type: 'message_update', assistantMessageEvent: null },
    ] as unknown as MoodEvent[]
    expect(() => h.feed(...weird)).not.toThrow()
  })

  test('the stream buffer gets exactly the same events with a broken tracker', () => {
    const run = (tracker: RobotMoodTracker | null) => {
      const buffer = new StreamBuffer()
      const collector = new StreamEventCollector(buffer)
      const events = [
        start,
        text('hello'),
        ...call('read', { path: 'a' }),
        ...call('bash', { command: 'x' }, true),
        messageEnd,
        endOk,
      ]
      for (const event of events) {
        // As the runner's subscription does: the collector first, then the tracker.
        collector.handleEvent(event as never)
        tracker?.observe(AGENT, null, event)
      }
      return buffer.subscribe(() => {}).map((event) => event.type)
    }
    const broken = new RobotMoodTracker({
      decide: () => {
        throw new Error('x')
      },
      isEnabled: () => true,
      isWatched: () => true,
      emit: () => {
        throw new Error('x')
      },
    })
    expect(run(broken)).toEqual(run(null))
  })
})
