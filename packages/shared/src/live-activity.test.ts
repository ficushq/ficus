import { describe, expect, test } from 'bun:test'
import type { WorkStream } from './types'
import {
  buildLiveActivityState,
  buildWorkInterestSnapshot,
  LIVE_ACTIVITY_TOP_LIMIT,
  WIDGET_TOP_LIMIT,
  serializeLiveActivityState,
  shouldShowLiveActivity,
  workBucket,
} from './live-activity'

function stream(overrides: Partial<WorkStream> = {}): WorkStream {
  return {
    id: 'ws-1',
    squadId: 'sq-1',
    title: 'Ship the widget',
    description: 'Operator-sensitive prose that must never leave the app',
    status: 'active',
    priority: 'normal',
    assigneeAgentId: 'ag-1',
    ownerAgentId: null,
    creatorAgentId: null,
    requestingUserId: null,
    updatedAt: new Date('2026-08-29T12:00:00.000Z'),
    createdAt: new Date('2026-08-29T11:00:00.000Z'),
    ...overrides,
  } as WorkStream
}

const wait = (type: string) => [{ id: 'w-1', type, message: 'secret' }] as WorkStream['openWaits']

// This table is the contract with `bucket(for:)` in targets/widget/FicusWorkWidget.swift. If Swift's
// rules change, these cases must change with them or the Live Activity and the widget will
// disagree about the same stream.
describe('workBucket mirrors the widget’s Swift case table', () => {
  test('1. an open manual/question/review wait wins over everything else', () => {
    for (const type of ['manual', 'question', 'review']) {
      expect(workBucket(stream({ openWaits: wait(type), derivedState: 'blocked' }))).toBe('needsYou')
    }
  })

  test('2. in_review / waiting_on_answer count as needs-you without an open wait row', () => {
    expect(workBucket(stream({ derivedState: 'in_review' } as Partial<WorkStream>))).toBe('needsYou')
    expect(workBucket(stream({ derivedState: 'waiting_on_answer' } as Partial<WorkStream>))).toBe('needsYou')
  })

  test('3. legacy blocked without waits retains shared manual-attention fallback', () => {
    expect(workBucket(stream({ derivedState: 'blocked' } as Partial<WorkStream>))).toBe('needsYou')
  })

  test('4. active status with nothing pending is running', () => {
    expect(workBucket(stream({ status: 'active', derivedState: undefined }))).toBe('running')
  })

  test('5. everything else is queued', () => {
    expect(workBucket(stream({ status: 'queued', derivedState: undefined }))).toBe('queued')
  })

  test('dependency waits are external while alarming idle remains blocked', () => {
    expect(workBucket(stream({ openWaits: wait('dependency'), status: 'active' }))).toBe('externalWait')
    expect(workBucket(stream({ derivedState: 'waiting_on_dependency', status: 'active' }))).toBe('externalWait')
    expect(workBucket(stream({ derivedState: 'idle', status: 'active' }))).toBe('blocked')
  })

  test('an explicit empty wait list overrides stale wait-derived state', () => {
    expect(workBucket(stream({ status: 'queued', derivedState: 'in_review', openWaits: [] }))).toBe('queued')
    expect(workBucket(stream({ status: 'active', derivedState: 'in_review', openWaits: [] }))).toBe('blocked')
  })
})

describe('buildLiveActivityState', () => {
  test('counts running and needs-you separately so the two never double-count', () => {
    const state = buildLiveActivityState([
      stream({ id: 'a', status: 'active' }),
      stream({ id: 'b', status: 'active' }),
      stream({ id: 'c', openWaits: wait('review') }),
      stream({ id: 'd', status: 'queued', derivedState: undefined }),
    ])
    expect(state.activeCount).toBe(2)
    expect(state.needsYouCount).toBe(1)
  })

  test('orders needs-you first, then most recently updated', () => {
    const state = buildLiveActivityState([
      stream({ id: 'old-running', updatedAt: new Date('2026-08-29T10:00:00.000Z') }),
      stream({ id: 'new-running', updatedAt: new Date('2026-08-29T13:00:00.000Z') }),
      stream({ id: 'needs-you', updatedAt: new Date('2026-08-29T09:00:00.000Z'), openWaits: wait('manual') }),
    ])
    expect(state.top.map((row) => row.id)).toEqual(['needs-you', 'new-running', 'old-running'])
  })

  test('caps the top list at what the views can render', () => {
    const many = Array.from({ length: LIVE_ACTIVITY_TOP_LIMIT + 5 }, (_, index) => stream({ id: `ws-${index}` }))
    expect(buildLiveActivityState(many).top).toHaveLength(LIVE_ACTIVITY_TOP_LIMIT)
  })

  test('omits agentId when a stream is unassigned (the view falls back to a work-tab link)', () => {
    const [row] = buildLiveActivityState([stream({ assigneeAgentId: null })]).top
    expect(row!.agentId).toBeUndefined()
    expect(Object.keys(row!).sort()).toEqual(['bucket', 'id', 'squadId', 'title'])
  })
})

describe('buildWorkInterestSnapshot', () => {
  test('computes full counts before capping presentation rows', () => {
    const many = Array.from({ length: 30 }, (_, index) =>
      stream({ id: `run-${index}`, updatedAt: new Date(`2026-08-29T12:${String(index).padStart(2, '0')}:00Z`) })
    )
    many[29] = stream({
      id: 'late-review',
      updatedAt: new Date('2026-08-29T11:00:00Z'),
      derivedState: 'in_review',
      openWaits: wait('review'),
    })

    const snapshot = buildWorkInterestSnapshot(many, new Date('2026-08-30T00:00:00Z'))
    expect(snapshot.totalCount).toBe(30)
    expect(snapshot.bucketCounts).toEqual({
      needsYou: 1,
      running: 29,
      blocked: 0,
      queued: 0,
      paused: 0,
      externalWait: 0,
    })
    expect(snapshot.top).toHaveLength(WIDGET_TOP_LIMIT)
    expect(snapshot.top[0]!.id).toBe('late-review')
    expect(snapshot.liveActivity.needsYouCount).toBe(1)
    expect(snapshot.liveActivity.top).toHaveLength(LIVE_ACTIVITY_TOP_LIMIT)
  })

  test('projects only safe fields and wait types', () => {
    const snapshot = buildWorkInterestSnapshot([stream({ openWaits: wait('manual') })])
    expect(snapshot.top[0]).toEqual({
      bucket: 'needsYou',
      id: 'ws-1',
      squadId: 'sq-1',
      title: 'Ship the widget',
      status: 'active',
      assigneeAgentId: 'ag-1',
      openWaitTypes: ['manual'],
      updatedAt: '2026-08-29T12:00:00.000Z',
    })
    expect(JSON.stringify(snapshot)).not.toContain('secret')
    expect(JSON.stringify(snapshot)).not.toContain('description')
  })
})

describe('shouldShowLiveActivity', () => {
  test('shows while work is running or waiting on the user', () => {
    expect(shouldShowLiveActivity({ activeCount: 1, needsYouCount: 0, top: [] })).toBe(true)
    expect(shouldShowLiveActivity({ activeCount: 0, needsYouCount: 1, top: [] })).toBe(true)
  })

  test('ends rather than lingering as a zeroed-out card', () => {
    expect(shouldShowLiveActivity({ activeCount: 0, needsYouCount: 0, top: [] })).toBe(false)
  })
})

describe('serializeLiveActivityState — rendered outside the app sandbox', () => {
  test('never carries auth material, wait messages, or stream descriptions', () => {
    const json = serializeLiveActivityState([stream({ openWaits: wait('manual') })])
    for (const forbidden of [
      'token',
      'serverUrl',
      'Bearer',
      'description',
      'Operator-sensitive',
      'secret',
      'message',
    ]) {
      expect(json).not.toContain(forbidden)
    }
  })
})

test('widget and live activity preserve pause/delivery, safe fields and omitted-wait legacy buckets', () => {
  const snapshot = buildWorkInterestSnapshot([
    stream({
      id: 'paused',
      pause: { reason: 'private operator reason' } as WorkStream['pause'],
      openWaits: wait('manual'),
    }),
    stream({ id: 'merge', delivery: { kind: 'merge' }, openWaits: [] }),
    stream({ id: 'legacy', derivedState: 'blocked' }),
  ])
  expect(snapshot.bucketCounts).toEqual({ needsYou: 2, paused: 1, blocked: 0, queued: 0, running: 0, externalWait: 0 })
  expect(snapshot.top.find((row) => row.id === 'paused')).toMatchObject({ pause: true, bucket: 'paused' })
  expect(snapshot.top.find((row) => row.id === 'merge')).toMatchObject({
    delivery: { kind: 'merge' },
    bucket: 'needsYou',
  })
  expect(snapshot.top.find((row) => row.id === 'legacy')?.bucket).toBe('needsYou')
  expect(snapshot.liveActivity.top.find((row) => row.id === 'paused')?.bucket).toBe('paused')
  expect(JSON.stringify(snapshot)).not.toContain('private operator reason')
})

describe('manual wait actors in native projections', () => {
  const manual = (actor?: string) =>
    [
      { id: `w-${actor ?? 'legacy'}`, type: 'manual', message: 'secret', ...(actor ? { actor } : {}) },
    ] as WorkStream['openWaits']

  test('only human (or actor-less) manual waits count as needs-you; owner waits are external waits', () => {
    const snapshot = buildWorkInterestSnapshot([
      stream({ id: 'human', openWaits: manual('human'), derivedState: 'blocked' }),
      stream({ id: 'legacy', openWaits: manual(), derivedState: 'blocked' }),
      stream({ id: 'owner', openWaits: manual('owner'), derivedState: 'blocked' }),
      // The pre-rename value is unknown, so it is human.
      stream({ id: 'unknown', openWaits: manual('manager'), derivedState: 'blocked' }),
    ])
    expect(snapshot.bucketCounts).toMatchObject({ needsYou: 3, externalWait: 1, blocked: 0 })
    expect(snapshot.liveActivity.needsYouCount).toBe(3)
    expect(Object.fromEntries(snapshot.top.map((row) => [row.id, row.bucket]))).toEqual({
      human: 'needsYou',
      legacy: 'needsYou',
      owner: 'externalWait',
      unknown: 'needsYou',
    })
    // Attention-first ordering puts only the human-actionable rows first.
    expect(
      snapshot.top
        .slice(0, 3)
        .map((row) => row.id)
        .sort()
    ).toEqual(['human', 'legacy', 'unknown'])
    // The widget row keeps its existing shape: wait types only, never the actor's message.
    expect(snapshot.top.find((row) => row.id === 'owner')?.openWaitTypes).toEqual(['manual'])
  })

  test('an owner-only wait does not keep the Live Activity visible', () => {
    const state = buildLiveActivityState([stream({ openWaits: manual('owner'), derivedState: 'blocked' })])
    expect(state).toMatchObject({ activeCount: 0, needsYouCount: 0 })
    expect(shouldShowLiveActivity(state)).toBe(false)
  })
})

test('widget summary carries only the optional authoritative slot fact, including explicit clearing', () => {
  for (const hasActiveSlotWait of [true, false, undefined]) {
    const input = stream({ derivedState: 'idle', hasActiveSlotWait })
    const summary = JSON.parse(JSON.stringify(buildWorkInterestSnapshot([input]).top[0]))
    expect(summary.hasActiveSlotWait).toBe(hasActiveSlotWait)
    expect('poolKey' in summary).toBe(false)
  }
})
