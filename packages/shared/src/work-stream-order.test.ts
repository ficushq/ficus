import { describe, expect, test } from 'bun:test'
import {
  canonicalWorkStreamSortKey,
  sortCanonicalWorkStreams,
  type CanonicalWorkStreamOrderInput,
} from './work-stream-order'
import { WORK_STREAM_PRESENTATION_CASES } from './test-fixtures/work-stream-presentation'

const at = (day: number) => new Date(`2026-01-${String(day).padStart(2, '0')}T00:00:00Z`)

const ws = (id: string, overrides: Partial<CanonicalWorkStreamOrderInput> = {}): CanonicalWorkStreamOrderInput => ({
  id,
  status: 'active',
  priority: 'normal',
  createdAt: at(1),
  updatedAt: at(1),
  ...overrides,
})

const ids = (items: readonly CanonicalWorkStreamOrderInput[]) => sortCanonicalWorkStreams(items).map((item) => item.id)

const openWait = (type: 'dependency' | 'question' | 'review' | 'manual') => ({ type, closedAt: null })

describe('sortCanonicalWorkStreams', () => {
  test('orders active urgency, positioned queue, unpositioned queue, then terminals', () => {
    expect(
      ids([
        ws('terminal-new', { status: 'done', completedAt: at(9) }),
        ws('queue-unpositioned', { status: 'queued', effectivePriority: 'critical' }),
        ws('idle', { derivedState: 'idle' }),
        ws('progress', { derivedState: 'in_progress' }),
        ws('wait', { derivedState: 'blocked' }),
        ws('review', { derivedState: 'in_review' }),
        ws('queue-2', { status: 'queued', queuePosition: 2 }),
        ws('queue-1', { status: 'queued', queuePosition: 1 }),
      ])
    ).toEqual(['review', 'wait', 'progress', 'idle', 'queue-1', 'queue-2', 'queue-unpositioned', 'terminal-new'])
  })

  test('uses queue position ahead of opposing update timestamps', () => {
    expect(
      ids([
        ws('position-2-newer', { status: 'queued', queuePosition: 2, updatedAt: at(9) }),
        ws('position-1-older', { status: 'queued', queuePosition: 1, updatedAt: at(1) }),
      ])
    ).toEqual(['position-1-older', 'position-2-newer'])
  })

  test('breaks ordinary ties by effective priority, creation time, then id', () => {
    expect(
      ids([
        ws('low', { effectivePriority: 'low', createdAt: at(1), updatedAt: at(9) }),
        ws('high-new', { effectivePriority: 'high', createdAt: at(3), updatedAt: at(1) }),
        ws('b-high-old', { effectivePriority: 'high', createdAt: at(2), updatedAt: at(8) }),
        ws('a-high-old', { effectivePriority: 'high', createdAt: at(2), updatedAt: at(9) }),
      ])
    ).toEqual(['a-high-old', 'b-high-old', 'high-new', 'low'])
  })

  test('treats every invalid queue position as unpositioned', () => {
    const invalidPositions = [undefined, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]
    const items = invalidPositions.map((queuePosition, index) =>
      ws(`invalid-${index}`, { status: 'queued', queuePosition, effectivePriority: 'low' })
    )
    items.push(
      ws('unpositioned-critical', { status: 'queued', effectivePriority: 'critical' }),
      ws('positioned', { status: 'queued', queuePosition: 99, effectivePriority: 'low' })
    )

    expect(ids(items)).toEqual([
      'positioned',
      'unpositioned-critical',
      'invalid-0',
      'invalid-1',
      'invalid-2',
      'invalid-3',
      'invalid-4',
      'invalid-5',
    ])
  })

  test('fails closed when a positioned queued stream has wait annotations', () => {
    expect(
      ids([
        ws('dependency', { status: 'queued', queuePosition: 1, waitingOnDependencies: true }),
        ws('typed-wait', { status: 'queued', queuePosition: 2, openWaits: [openWait('manual')] }),
        ws('derived-wait', { status: 'queued', queuePosition: 3, derivedState: 'waiting_on_answer' }),
        ws('structured-eligible', {
          status: 'queued',
          queuePosition: 1,
          openWaits: [],
          derivedState: 'waiting_on_answer',
        }),
        ws('eligible', { status: 'queued', queuePosition: 4 }),
      ])
    ).toEqual(['structured-eligible', 'eligible', 'dependency', 'derived-wait', 'typed-wait'])
  })

  test('uses typed open waits authoritatively and derived state only when waits are absent', () => {
    expect(
      ids([
        ws('typed-review', { derivedState: 'idle', openWaits: [openWait('review')] }),
        ws('typed-manual', { derivedState: 'in_review', openWaits: [openWait('manual')] }),
        ws('empty-waits', { derivedState: 'in_review', openWaits: [] }),
        ws('legacy-review', { derivedState: 'in_review' }),
        ws('missing'),
      ])
    ).toEqual(['legacy-review', 'typed-manual', 'typed-review', 'empty-waits', 'missing'])
  })

  describe('active ordering by human actionability', () => {
    test('human review, question, and manual waits outrank running work; dependency and idle follow it', () => {
      expect(
        ids([
          ws('z-dependency', { derivedState: 'waiting_on_dependency' }),
          ws('m-progress', { derivedState: 'in_progress' }),
          ws('q-question', { derivedState: 'waiting_on_answer' }),
          ws('i-idle', { derivedState: 'idle' }),
          ws('b-manual', { derivedState: 'blocked' }),
          ws('a-review', { derivedState: 'in_review' }),
        ])
      ).toEqual(['a-review', 'b-manual', 'q-question', 'm-progress', 'i-idle', 'z-dependency'])
    })

    test('annotated automated review gates rank below running work and above other waiting work', () => {
      expect(
        ids([
          ws('auto-review', { derivedState: 'in_review', automatedReviewGate: true }),
          ws('progress', { derivedState: 'in_progress' }),
          ws('dependency', { derivedState: 'waiting_on_dependency' }),
          ws('idle', { derivedState: 'idle' }),
        ])
      ).toEqual(['progress', 'auto-review', 'dependency', 'idle'])
    })

    test('the automated discriminator applies to typed review waits too', () => {
      expect(
        ids([
          ws('gate', { openWaits: [openWait('review')], automatedReviewGate: true }),
          ws('human', { openWaits: [openWait('review')] }),
          ws('progress', { derivedState: 'in_progress' }),
        ])
      ).toEqual(['human', 'progress', 'gate'])
    })

    test('absent or false discriminator keeps review waits human-actionable (older payloads)', () => {
      expect(
        ids([
          ws('review-absent', { derivedState: 'in_review' }),
          ws('review-false', { derivedState: 'in_review', automatedReviewGate: false }),
          ws('progress', { derivedState: 'in_progress' }),
        ])
      ).toEqual(['review-absent', 'review-false', 'progress'])
    })

    test('the discriminator never lifts non-review states', () => {
      expect(
        ids([
          ws('flagged-dependency', { derivedState: 'waiting_on_dependency', automatedReviewGate: true }),
          ws('progress', { derivedState: 'in_progress' }),
        ])
      ).toEqual(['progress', 'flagged-dependency'])
    })
  })

  test('splits human-actionable waits from dependency waits that wait on another stream', () => {
    expect(
      ids([
        ws('a-blocked', { derivedState: 'blocked' }),
        ws('review', { derivedState: 'in_review' }),
        ws('z-answer', { derivedState: 'waiting_on_answer' }),
        ws('m-dependency', { derivedState: 'waiting_on_dependency' }),
      ])
    ).toEqual(['a-blocked', 'review', 'z-answer', 'm-dependency'])
  })

  test('defaults missing or malformed priority and dates without losing determinism', () => {
    expect(
      ids([
        ws('z-invalid', {
          priority: 'unexpected' as CanonicalWorkStreamOrderInput['priority'],
          createdAt: 'not-a-date',
        }),
        ws('a-invalid', { priority: undefined, createdAt: 'not-a-date' }),
        ws('critical-valid', { effectivePriority: 'critical', createdAt: at(9) }),
      ])
    ).toEqual(['critical-valid', 'a-invalid', 'z-invalid'])
  })

  test('orders terminal history by completion time then deterministic ordinary ties', () => {
    expect(
      ids([
        ws('old', { status: 'done', completedAt: at(2), effectivePriority: 'critical' }),
        ws('new', { status: 'canceled', completedAt: at(9), effectivePriority: 'low' }),
        ws('b-tie', { status: 'done', completedAt: at(5), effectivePriority: 'high', createdAt: at(2) }),
        ws('a-tie', { status: 'done', completedAt: at(5), effectivePriority: 'high', createdAt: at(2) }),
        ws('fallback', { status: 'done', completedAt: null, updatedAt: at(4) }),
        ws('invalid-completion', {
          status: 'done',
          completedAt: 'not-a-date',
          effectivePriority: 'critical',
        }),
        Object.assign(ws('wire-invalid-completion', { status: 'done', completedAt: null, updatedAt: at(29) }), {
          metadata: { completion: { completedAt: 'not-a-date' } },
        }),
      ])
    ).toEqual(['new', 'a-tie', 'b-tie', 'fallback', 'old', 'invalid-completion', 'wire-invalid-completion'])
  })

  test('sorts malformed runtime statuses after valid terminal rows', () => {
    expect(
      ids([
        ws('malformed', { status: 'legacy' as CanonicalWorkStreamOrderInput['status'] }),
        ws('terminal', { status: 'done', completedAt: at(1) }),
      ])
    ).toEqual(['terminal', 'malformed'])
  })
})

test('delivery review ranks with review and paused waits do not acquire urgency', () => {
  expect(
    ids([
      ws('a-paused', { pause: {}, openWaits: [openWait('review')] }),
      ws('b-running', { derivedState: 'in_progress', openWaits: [] }),
      ws('c-external', { delivery: { kind: 'external' }, openWaits: [] }),
      ws('d-merge', { delivery: { kind: 'merge' }, openWaits: [] }),
    ])
  ).toEqual(['d-merge', 'b-running', 'a-paused', 'c-external'])
})

test('a PR awaiting required human review sorts in the human-actionable tier, even under auto-merge', () => {
  expect(
    ids([
      ws('a-external', { delivery: { kind: 'external' }, openWaits: [] }),
      ws('b-running', { derivedState: 'in_progress', openWaits: [] }),
      ws('c-auto-gate', { openWaits: [openWait('review')], delivery: { kind: 'external' }, automatedReviewGate: true }),
      ws('d-pr-review', { delivery: { kind: 'review' }, openWaits: [] }),
      // A stale or inconsistent annotation cannot demote a human delivery gate.
      ws('e-pr-review-annotated', {
        openWaits: [openWait('review')],
        delivery: { kind: 'review' },
        automatedReviewGate: true,
      }),
    ])
  ).toEqual(['d-pr-review', 'e-pr-review-annotated', 'b-running', 'c-auto-gate', 'a-external'])
})

describe('manual wait actors', () => {
  const manual = (actor?: string) => ({ type: 'manual' as const, closedAt: null, ...(actor ? { actor } : {}) })

  test('human and legacy actor-less manual waits stay human-actionable ahead of running work', () => {
    expect(
      ids([
        ws('c-progress', { derivedState: 'in_progress', openWaits: [] }),
        ws('b-legacy', { openWaits: [manual()] }),
        ws('a-human', { openWaits: [manual('human')] }),
        ws('d-legacy-derived', { derivedState: 'blocked' }),
      ])
    ).toEqual(['a-human', 'b-legacy', 'd-legacy-derived', 'c-progress'])
  })

  test('an owner-actor wait never outranks human-actionable or running work; it sorts with dependency waits', () => {
    expect(
      ids([
        ws('a-owner', { openWaits: [manual('owner')] }),
        ws('b-dependency', { openWaits: [{ type: 'dependency', closedAt: null }] }),
        ws('c-progress', { derivedState: 'in_progress', openWaits: [] }),
        ws('d-question', { openWaits: [{ type: 'question', closedAt: null }] }),
        ws('e-human', { openWaits: [manual('human')] }),
      ])
    ).toEqual(['d-question', 'e-human', 'c-progress', 'a-owner', 'b-dependency'])
  })

  test('an owner-actor wait sorts with external delivery waits', () => {
    expect(
      ids([
        ws('a-owner-wait', { openWaits: [manual('owner')] }),
        ws('b-external-delivery', { delivery: { kind: 'external' }, openWaits: [] }),
        ws('c-progress', { derivedState: 'in_progress', openWaits: [] }),
        ws('d-merge', { delivery: { kind: 'merge' }, openWaits: [] }),
      ])
    ).toEqual(['d-merge', 'c-progress', 'a-owner-wait', 'b-external-delivery'])
  })

  test('an unknown future actor is treated as human', () => {
    expect(
      ids([
        ws('a-progress', { derivedState: 'in_progress', openWaits: [] }),
        ws('b-unknown', { openWaits: [manual('manager')] }),
      ])
    ).toEqual(['b-unknown', 'a-progress'])
  })

  test('a human manual wait lifts a stream that also has an owner wait', () => {
    expect(canonicalWorkStreamSortKey(ws('mixed', { openWaits: [manual('owner'), manual('human')] }))).toMatchObject({
      activeUrgency: 0,
    })
  })

  test('queued streams with a manual wait of any actor still lose their queue position', () => {
    for (const actor of [undefined, 'human', 'owner']) {
      expect(
        canonicalWorkStreamSortKey(
          ws(`queued-${actor}`, { status: 'queued', queuePosition: 1, openWaits: [manual(actor)] })
        )
      ).toMatchObject({ group: 2, queuePosition: Number.POSITIVE_INFINITY })
    }
    // A closed wait does not hold the stream out of its position.
    expect(
      canonicalWorkStreamSortKey(
        ws('queued-closed', {
          status: 'queued',
          queuePosition: 1,
          openWaits: [{ type: 'manual', actor: 'owner', closedAt: '2026-01-02T00:00:00Z' }],
        })
      )
    ).toMatchObject({ group: 1, queuePosition: 1 })
  })

  test('active ordering agrees with the native bucket for every shared presentation case', () => {
    for (const row of WORK_STREAM_PRESENTATION_CASES.filter((row) => row.facts.status === 'active')) {
      const urgency = canonicalWorkStreamSortKey(
        ws(row.name, {
          ...row.facts,
          openWaits: row.facts.openWaits?.map((wait) => ({ ...wait, closedAt: null })),
        } as Partial<CanonicalWorkStreamOrderInput>)
      ).activeUrgency
      const expected = row.bucket === 'needsYou' ? 0 : row.bucket === 'running' ? 1 : 3
      expect({ name: row.name, urgency }).toEqual({ name: row.name, urgency: expected })
    }
  })
})
