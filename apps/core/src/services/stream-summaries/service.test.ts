import { describe, expect, test } from 'bun:test'
import type { StoredWorkStreamSummary } from '@ficus/shared'
import type { LightCompletionRequest } from '../model-tiers/light-completion'
import {
  decideSummaryRefresh,
  refreshStreamSummary,
  selectSummaryInputRows,
  STREAM_SUMMARY_MAX_ROWS,
  STREAM_SUMMARY_MIN_INTERVAL_MS,
  StreamSummaryScheduler,
  type StreamSummaryDeps,
  type StreamSummaryResult,
  type SummaryActivityRow,
  type SummaryStream,
} from './service'

const NOW = new Date(Date.UTC(2026, 10, 20, 12, 0, 0))
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000)

const row = (overrides: Partial<SummaryActivityRow> = {}): SummaryActivityRow => ({
  agentId: 'engineer-1',
  agentTypeId: 'engineer',
  lane: 10,
  text: 'Added the summary column and its migration test.',
  at: minutesAgo(1),
  ...overrides,
})

const stored = (overrides: Partial<StoredWorkStreamSummary> = {}): StoredWorkStreamSummary => ({
  text: 'Building the summary service',
  generatedAt: minutesAgo(20).toISOString(),
  step: 'Implement',
  through: minutesAgo(30).toISOString(),
  ...overrides,
})

const stream = (overrides: Partial<SummaryStream> = {}): SummaryStream => ({
  id: 'ws-1',
  squadId: 'squad-1',
  title: 'Work stream summaries',
  status: 'active',
  ownerAgentId: 'manager-1',
  stored: stored(),
  ...overrides,
})

function fakeDeps(overrides: Partial<StreamSummaryDeps> = {}, rows: SummaryActivityRow[] = [row(), row(), row()]) {
  const requests: LightCompletionRequest[] = []
  const saved: Array<{ summary: StoredWorkStreamSummary; previous: string | null }> = []
  const loads: Array<{ since: Date | null; limit: number }> = []
  let reads = 0
  const deps: StreamSummaryDeps = {
    isEnabled: () => true,
    loadStream: async () => {
      reads++
      return stream()
    },
    loadStep: async () => 'Implement',
    loadParticipantRows: async (_stream, since, limit) => {
      reads++
      loads.push({ since, limit })
      return rows
    },
    complete: async (request) => {
      requests.push(request)
      return { text: 'Wiring the peek card into the Feed rows', model: 'anthropic/claude-haiku-4-5' }
    },
    save: async (_stream, summary, previous) => {
      saved.push({ summary, previous })
      return true
    },
    now: () => NOW,
    ...overrides,
  }
  return { deps, requests, saved, loads, reads: () => reads }
}

describe('selectSummaryInputRows', () => {
  test('keeps only messages participants sent themselves', () => {
    const rows = [
      row({ text: 'engineer chat' }),
      row({ lane: 20, text: 'Received message from Reviewer: looks good' }),
      row({ lane: 21, text: 'Received system notification: CI success' }),
      row({ lane: 22, text: 'Received report from Subagent' }),
      row({ lane: 60, text: 'Subagent spawned.' }),
      row({ agentId: 'manager-1', agentTypeId: 'manager', text: 'manager chat' }),
      row({ agentId: 'consultant-1', agentTypeId: 'consultant', text: 'consultant chat' }),
      // The owner is never a participant, whatever its type.
      row({ agentId: 'owner-1', agentTypeId: 'engineer', text: 'owner chat' }),
      row({ text: '   ' }),
      row({ agentId: 'reviewer-1', agentTypeId: 'reviewer', text: 'reviewer chat' }),
    ]
    expect(selectSummaryInputRows(rows, { ownerAgentId: 'owner-1' }).map((r) => r.text)).toEqual([
      'engineer chat',
      'reviewer chat',
    ])
  })

  test('orders oldest first and keeps only the newest rows', () => {
    const rows = Array.from({ length: 25 }, (_, index) => row({ text: `step ${index}`, at: minutesAgo(index) }))
    const selected = selectSummaryInputRows(rows, { ownerAgentId: null })
    expect(selected).toHaveLength(STREAM_SUMMARY_MAX_ROWS)
    expect(selected[0]!.text).toBe(`step ${STREAM_SUMMARY_MAX_ROWS - 1}`)
    expect(selected.at(-1)!.text).toBe('step 0')
  })
})

describe('decideSummaryRefresh', () => {
  const base = { step: 'Implement', newRows: 3, pendingMessages: 0, now: NOW }

  test('is throttled within the interval of the stored summary', () => {
    expect(decideSummaryRefresh({ ...base, stored: stored({ generatedAt: minutesAgo(4).toISOString() }) })).toBe(
      'throttled'
    )
    expect(decideSummaryRefresh({ ...base, stored: stored({ generatedAt: minutesAgo(6).toISOString() }) })).toBe(
      'refresh'
    )
  })

  test('a step change is due on its own; a first summary needs at least one message', () => {
    expect(decideSummaryRefresh({ ...base, newRows: 0, stored: stored({ step: 'Plan' }) })).toBe('refresh')
    expect(decideSummaryRefresh({ ...base, newRows: 1, stored: null })).toBe('refresh')
    expect(decideSummaryRefresh({ ...base, newRows: 0, stored: null })).toBe('no-input')
  })

  test('without a step change, a few new messages are needed', () => {
    expect(decideSummaryRefresh({ ...base, newRows: 2, stored: stored() })).toBe('not-due')
    expect(decideSummaryRefresh({ ...base, newRows: 3, stored: stored() })).toBe('refresh')
    // One chat row is updated in place per message of a run: live message counts make it due.
    expect(decideSummaryRefresh({ ...base, newRows: 1, pendingMessages: 4, stored: stored() })).toBe('refresh')
    expect(decideSummaryRefresh({ ...base, newRows: 0, pendingMessages: 4, stored: stored() })).toBe('no-input')
  })
})

describe('refreshStreamSummary', () => {
  test('summarizes new participant rows on the Lite tier and stores the line for the current step', async () => {
    const { deps, requests, saved, loads } = fakeDeps({}, [
      row({ text: 'Newest engineer message', at: minutesAgo(1) }),
      row({ lane: 20, text: 'Received message from Reviewer: nit', at: minutesAgo(2) }),
      row({ text: 'Older engineer message', at: minutesAgo(3) }),
      row({ text: 'Third engineer message', at: minutesAgo(4) }),
    ])
    expect(await refreshStreamSummary('ws-1', 0, deps)).toEqual({ outcome: 'saved' })
    expect(loads[0]!.since?.toISOString()).toBe(minutesAgo(30).toISOString())
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ tier: 'lite', purpose: 'stream-summary', source: { workStreamId: 'ws-1' } })
    expect(requests[0]!.prompt).toContain('Building the summary service')
    expect(requests[0]!.prompt).toContain('Current step: Implement')
    expect(requests[0]!.prompt).not.toContain('Received message')
    expect(requests[0]!.prompt.indexOf('Third engineer')).toBeLessThan(requests[0]!.prompt.indexOf('Newest engineer'))
    expect(saved).toEqual([
      {
        summary: {
          text: 'Wiring the peek card into the Feed rows',
          generatedAt: NOW.toISOString(),
          step: 'Implement',
          through: minutesAgo(1).toISOString(),
        },
        previous: minutesAgo(20).toISOString(),
      },
    ])
  })

  test('caps each row and never sends more than the row limit', async () => {
    const long = 'x'.repeat(2_000)
    const rows = Array.from({ length: 30 }, (_, index) => row({ text: `${index} ${long}`, at: minutesAgo(index) }))
    const { deps, requests } = fakeDeps({}, rows)
    await refreshStreamSummary('ws-1', 0, deps)
    const activity = requests[0]!.prompt.split('<new_activity>')[1]!
    const lines = activity.split('\n').filter((line) => line.startsWith('[engineer]'))
    expect(lines).toHaveLength(STREAM_SUMMARY_MAX_ROWS)
    for (const line of lines) expect(line.length).toBeLessThan(320)
  })

  test('discards invalid model output and keeps the previous summary', async () => {
    for (const text of [
      'Line one\nLine two',
      'See https://example.com for details',
      '**Bold** progress',
      'x'.repeat(121),
      '',
    ]) {
      const { deps, saved } = fakeDeps({ complete: async () => ({ text, model: 'lite' }) })
      expect((await refreshStreamSummary('ws-1', 0, deps)).outcome).toBe('invalid')
      expect(saved).toEqual([])
    }
  })

  test('makes no reads and no model call while the switch is off', async () => {
    const { deps, requests, reads } = fakeDeps({ isEnabled: () => false })
    expect(await refreshStreamSummary('ws-1', 5, deps)).toEqual({ outcome: 'disabled' })
    expect(reads()).toBe(0)
    expect(requests).toEqual([])
  })

  test('drops the answer when the switch is turned off while the model answers', async () => {
    let enabled = true
    const { deps, saved } = fakeDeps({
      isEnabled: () => enabled,
      complete: async () => {
        enabled = false
        return { text: 'A fine summary', model: 'lite' }
      },
    })
    expect((await refreshStreamSummary('ws-1', 0, deps)).outcome).toBe('disabled')
    expect(saved).toEqual([])
  })

  test('skips streams that are not active and summaries still within the interval', async () => {
    const queued = fakeDeps({ loadStream: async () => stream({ status: 'queued' }) })
    expect((await refreshStreamSummary('ws-1', 0, queued.deps)).outcome).toBe('not-active')
    const recent = fakeDeps({
      loadStream: async () => stream({ stored: stored({ generatedAt: minutesAgo(2).toISOString() }) }),
    })
    expect(await refreshStreamSummary('ws-1', 0, recent.deps)).toEqual({
      outcome: 'throttled',
      retryAt: new Date(minutesAgo(2).getTime() + STREAM_SUMMARY_MIN_INTERVAL_MS),
    })
    expect(recent.requests).toEqual([])
  })

  test('rewrites for a new step even without new messages', async () => {
    const { deps, requests, saved } = fakeDeps({ loadStep: async () => 'Review' }, [])
    expect((await refreshStreamSummary('ws-1', 0, deps)).outcome).toBe('saved')
    expect(requests[0]!.prompt).toContain('(no new messages)')
    expect(saved[0]!.summary).toMatchObject({ step: 'Review', through: minutesAgo(30).toISOString() })
  })

  test('never throws', async () => {
    const errors: unknown[] = []
    const { deps } = fakeDeps({
      loadStream: async () => {
        throw new Error('db down')
      },
      onError: (error) => errors.push(error),
    })
    expect((await refreshStreamSummary('ws-1', 0, deps)).outcome).toBe('error')
    expect(errors).toHaveLength(1)
  })
})

describe('StreamSummaryScheduler', () => {
  function harness(results: StreamSummaryResult[] = []) {
    let clock = 0
    const timers: Array<{ at: number; fire: () => void; canceled: boolean }> = []
    const runs: Array<{ streamId: string; pending: number }> = []
    const scheduler = new StreamSummaryScheduler({
      run: async (streamId, pending) => {
        runs.push({ streamId, pending })
        return results.shift() ?? { outcome: 'saved' }
      },
      minIntervalMs: 300_000,
      rowTrigger: 3,
      maxInFlight: 1,
      busyRetryMs: 30_000,
      now: () => clock,
      setTimer: (fire, ms) => {
        const timer = { at: clock + ms, fire, canceled: false }
        timers.push(timer)
        return () => {
          timer.canceled = true
        }
      },
    })
    const flush = async () => {
      for (let i = 0; i < 5; i++) await Promise.resolve()
    }
    const advance = async (ms: number) => {
      clock += ms
      for (const timer of timers.filter((t) => !t.canceled && t.at <= clock)) {
        timer.canceled = true
        timer.fire()
      }
      await flush()
    }
    return { scheduler, runs, timers, flush, advance }
  }

  test('runs after a few messages, not after each one', async () => {
    const { scheduler, runs, flush } = harness()
    scheduler.noteMessage('ws-1')
    scheduler.noteMessage('ws-1')
    await flush()
    expect(runs).toEqual([])
    scheduler.noteMessage('ws-1')
    await flush()
    expect(runs).toEqual([{ streamId: 'ws-1', pending: 3 }])
  })

  test('runs at most once per interval per stream, then catches up', async () => {
    const { scheduler, runs, flush, advance } = harness()
    scheduler.noteStreamChanged('ws-1')
    await flush()
    expect(runs).toHaveLength(1)
    for (let i = 0; i < 6; i++) scheduler.noteMessage('ws-1')
    scheduler.noteStreamChanged('ws-1')
    await flush()
    expect(runs).toHaveLength(1)
    await advance(299_000)
    expect(runs).toHaveLength(1)
    await advance(1_000)
    expect(runs).toEqual([
      { streamId: 'ws-1', pending: 0 },
      { streamId: 'ws-1', pending: 6 },
    ])
  })

  test('a look that did not reach the model does not use up the interval', async () => {
    const { scheduler, runs, flush, advance } = harness([{ outcome: 'not-due' }])
    scheduler.noteStreamChanged('ws-1')
    await flush()
    expect(runs).toHaveLength(1)
    // Three messages make it due again; it waits only the short check delay, not the interval.
    for (let i = 0; i < 3; i++) scheduler.noteMessage('ws-1')
    await flush()
    expect(runs).toHaveLength(1)
    await advance(30_000)
    expect(runs).toHaveLength(2)
  })

  test('limits attempts in flight and forgets finished streams', async () => {
    let release!: () => void
    const pending = new Promise<StreamSummaryResult>((resolve) => {
      release = () => resolve({ outcome: 'saved' })
    })
    const runs: string[] = []
    let clock = 0
    const timers: Array<() => void> = []
    const scheduler = new StreamSummaryScheduler({
      run: (streamId) => {
        runs.push(streamId)
        return streamId === 'ws-1' ? pending : Promise.resolve({ outcome: 'saved' as const })
      },
      maxInFlight: 1,
      now: () => clock,
      setTimer: (fire) => {
        timers.push(fire)
        return () => {}
      },
    })
    scheduler.noteStreamChanged('ws-1')
    scheduler.noteStreamChanged('ws-2')
    await Promise.resolve()
    expect(runs).toEqual(['ws-1'])
    release()
    for (let i = 0; i < 5; i++) await Promise.resolve()
    clock = 30_000
    timers.shift()?.()
    await Promise.resolve()
    expect(runs).toEqual(['ws-1', 'ws-2'])
    scheduler.forget('ws-1')
    scheduler.forget('ws-2')
    expect(scheduler.size).toBe(0)
  })

  test('drops a stream that is no longer active', async () => {
    const { scheduler, flush } = harness([{ outcome: 'not-active' }])
    scheduler.noteStreamChanged('ws-1')
    await flush()
    expect(scheduler.size).toBe(0)
  })
})
