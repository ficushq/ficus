import { describe, expect, test } from 'bun:test'
import {
  computeWorkStreamElapsedMs,
  formatWaitedDuration,
  formatWorkStreamDuration,
  workStreamTimeDisplay,
  workStreamTimeTickMs,
  workStreamWaitingOnPersonSince,
} from './workStreamRuntime'
import type { WorkStream, WorkStreamWait } from '@ficus/shared'

const baseWs = {
  id: 'ws-1',
  squadId: 's',
  title: 't',
  description: '',
  status: 'active',
  derivedState: 'in_progress',
  assigneeAgentId: null,
  ownerAgentId: null,
  agentIds: ['a'],
  dependsOn: [],
  handoffMessage: null,
  files: [],
  response: null,
  metadata: {},
  completionMode: 'pr-merge',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
} as unknown as WorkStream

describe('computeWorkStreamElapsedMs', () => {
  test('returns 0 when there is no runtime field', () => {
    expect(computeWorkStreamElapsedMs(baseWs, Date.now())).toBe(0)
  })

  test('returns settled totalMs when activeCount is zero', () => {
    const ws: WorkStream = {
      ...baseWs,
      runtime: { totalMs: 12_345, activeCount: 0, computedAt: '2026-01-01T00:00:00Z' },
    }
    expect(computeWorkStreamElapsedMs(ws, Date.parse('2026-01-01T00:01:00Z'))).toBe(12_345)
  })

  test('adds activeCount * (now - computedAt) when there are active executions', () => {
    const ws: WorkStream = {
      ...baseWs,
      runtime: { totalMs: 1000, activeCount: 2, computedAt: '2026-01-01T00:00:00Z' },
    }
    const now = Date.parse('2026-01-01T00:00:05Z')
    expect(computeWorkStreamElapsedMs(ws, now)).toBe(1000 + 2 * 5_000)
  })

  test('clamps negative deltas (clock skew) to zero', () => {
    const ws: WorkStream = {
      ...baseWs,
      runtime: { totalMs: 7_000, activeCount: 1, computedAt: '2026-01-01T00:01:00Z' },
    }
    const now = Date.parse('2026-01-01T00:00:00Z')
    expect(computeWorkStreamElapsedMs(ws, now)).toBe(7_000)
  })
})

describe('time worked extrapolation', () => {
  test('ticks only for working executions, not for ones waiting on a sandbox or left stale', () => {
    const ws: WorkStream = {
      ...baseWs,
      runtime: { totalMs: 1000, activeCount: 2, workingCount: 0, computedAt: '2026-01-01T00:00:00Z' },
    }
    expect(computeWorkStreamElapsedMs(ws, Date.parse('2026-01-01T01:00:00Z'))).toBe(1000)
    expect(workStreamTimeTickMs(ws)).toBeNull()
  })

  test('extrapolates from workingCount when the server sends it', () => {
    const ws: WorkStream = {
      ...baseWs,
      runtime: { totalMs: 1000, activeCount: 2, workingCount: 1, computedAt: '2026-01-01T00:00:00Z' },
    }
    expect(computeWorkStreamElapsedMs(ws, Date.parse('2026-01-01T00:00:05Z'))).toBe(6000)
    expect(workStreamTimeTickMs(ws)).toBe(1000)
  })
})

describe('formatting', () => {
  test('time worked keeps two units', () => {
    expect(formatWorkStreamDuration(45_000)).toBe('45s')
    expect(formatWorkStreamDuration(3 * 3_600_000 + 5 * 60_000)).toBe('3h 5m')
    expect(formatWorkStreamDuration((7 * 24 + 2) * 3_600_000)).toBe('7d 2h')
  })

  test('waiting time keeps one coarse unit', () => {
    expect(formatWaitedDuration(30_000)).toBe('<1m')
    expect(formatWaitedDuration(12 * 60_000)).toBe('12m')
    expect(formatWaitedDuration(5 * 3_600_000 + 59 * 60_000)).toBe('5h')
    expect(formatWaitedDuration((7 * 24 + 2) * 3_600_000)).toBe('7d')
    expect(formatWaitedDuration(-5)).toBe('<1m')
  })
})

describe('waiting on a person', () => {
  const now = Date.parse('2026-01-08T02:00:00Z')
  const wait = (overrides: Partial<WorkStreamWait>): WorkStreamWait =>
    ({
      id: 'w',
      workStreamId: 'ws-1',
      type: 'review',
      referenceId: null,
      message: null,
      createdBy: 'agent',
      createdByAgentId: null,
      createdByUserId: null,
      completesOnApproval: true,
      openedAt: '2026-01-01T00:00:00Z',
      closedAt: null,
      resolution: null,
      resolutionNote: null,
      ...overrides,
    }) as WorkStreamWait
  const waiting = (openWaits: WorkStreamWait[], overrides: Partial<WorkStream> = {}): WorkStream => ({
    ...baseWs,
    derivedState: 'in_review',
    openWaits,
    runtime: { totalMs: 2 * 3_600_000, activeCount: 0, workingCount: 0, computedAt: '2026-01-01T00:00:00Z' },
    ...overrides,
  })

  test('dates from the oldest open wait that asks a person to act', () => {
    const ws = waiting([
      wait({ id: 'newer', type: 'manual', actor: 'human', openedAt: '2026-01-05T00:00:00Z' }),
      wait({ id: 'older', type: 'question', referenceId: 'q', openedAt: '2026-01-01T00:00:00Z' }),
      wait({ id: 'agent', type: 'dependency', referenceId: 'x', openedAt: '2025-12-01T00:00:00Z' }),
    ])
    expect(workStreamWaitingOnPersonSince(ws)?.toISOString()).toBe('2026-01-01T00:00:00.000Z')
  })

  test('replaces time worked in the row, which moves to the tooltip', () => {
    const display = workStreamTimeDisplay(waiting([wait({})]), now)
    expect(display?.kind).toBe('waiting')
    expect(display?.text).toBe('Waiting on you 7d')
    expect(display?.title).toContain('Time worked: 2h')
    expect(workStreamTimeTickMs(waiting([wait({})]))).toBe(60_000)
  })

  test('a dependency, an owner hold, a paused or a finished stream is not waiting on you', () => {
    const dependency = waiting([wait({ type: 'dependency', referenceId: 'x' })], {
      derivedState: 'waiting_on_dependency',
    })
    const ownerHold = waiting([wait({ type: 'manual', actor: 'owner' })], { derivedState: 'blocked' })
    const paused = waiting([wait({})], { pause: { pausedAt: '2026-01-02T00:00:00Z' } as WorkStream['pause'] })
    const done = waiting([wait({})], { status: 'done', derivedState: 'done' })
    for (const ws of [dependency, ownerHold, paused, done]) {
      expect(workStreamWaitingOnPersonSince(ws)).toBeNull()
      expect(workStreamTimeDisplay(ws, now)).toEqual({
        kind: 'worked',
        text: '2h',
        title: expect.stringContaining('Time worked'),
        workedMs: 2 * 3_600_000,
      })
    }
  })

  test('shows nothing before a second of work when nobody is waited on', () => {
    expect(workStreamTimeDisplay(baseWs, now)).toBeNull()
  })
})
