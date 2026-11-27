import { describe, expect, test } from 'bun:test'
import type { PendingAction, WorkStream } from '@ficus/shared'
import { lastActivityTime, orderSquadCardWork, workStreamIdsNeedingViewer } from './squadCardWorkOrder'

type Row = Pick<WorkStream, 'id' | 'status' | 'createdAt' | 'updatedAt' | 'runtime' | 'openWaits'>

/** A stream from a server that does not report `runtime.lastWorkedAt`, unless `extra` sets it. */
function stream(id: string, updatedAt: string, extra: Partial<WorkStream> = {}) {
  return {
    id,
    status: 'active',
    createdAt: '2026-01-01T00:00:00Z' as never,
    updatedAt: updatedAt as never,
    openWaits: [],
    ...extra,
  } as Row
}

/** A stream whose executions last worked at `lastWorkedAt` (null: none has run). */
function worked(id: string, lastWorkedAt: string | null, extra: Partial<WorkStream> = {}) {
  return stream(id, '2026-11-27T00:00:00Z', {
    runtime: { totalMs: 0, activeCount: 0, lastWorkedAt, computedAt: '2026-11-27T00:00:00Z' },
    ...extra,
  })
}

function action(type: PendingAction['type'], data: Record<string, unknown>): PendingAction {
  return { id: `${type}:x`, type, priority: 1, createdAt: '2026-11-26T00:00:00Z', canRespond: true, data } as never
}

describe('workStreamIdsNeedingViewer', () => {
  test('takes the streams that the viewer’s review, blocker and delivery actions name', () => {
    const ids = workStreamIdsNeedingViewer(
      [
        action('workstream-review', { workStreamId: 'review' }),
        action('workstream-blocked', { workStreamId: 'blocked' }),
        action('workstream-delivery', { workStreamId: 'delivery' }),
      ],
      []
    )
    expect([...ids].sort()).toEqual(['blocked', 'delivery', 'review'])
  })

  test('matches an agent question to the stream whose open question wait it is', () => {
    const asking = stream('asking', '2026-11-26T00:00:00Z', {
      openWaits: [{ type: 'question', referenceId: 'q-1' } as never],
    })
    const otherQuestion = stream('other', '2026-11-26T00:00:00Z', {
      openWaits: [{ type: 'question', referenceId: 'q-2' } as never],
    })
    // A dependency wait's reference is another stream, never a question.
    const dependency = stream('dependency', '2026-11-26T00:00:00Z', {
      openWaits: [{ type: 'dependency', referenceId: 'q-1' } as never],
    })
    const ids = workStreamIdsNeedingViewer(
      [action('agent-question', { questionId: 'q-1' })],
      [asking, otherQuestion, dependency]
    )
    expect([...ids]).toEqual(['asking'])
  })

  test('ignores actions that are not about a stream', () => {
    const ids = workStreamIdsNeedingViewer(
      [action('agent-error', { agentId: 'a' }), action('squad-question', { agentId: 'a' })],
      [stream('s', '2026-11-26T00:00:00Z')]
    )
    expect(ids.size).toBe(0)
  })
})

describe('orderSquadCardWork', () => {
  test('puts the streams that need the viewer first, then the rest by most recent activity', () => {
    const ordered = orderSquadCardWork(
      [
        stream('old', '2026-11-20T00:00:00Z'),
        stream('newest', '2026-11-26T00:00:00Z'),
        stream('needs-old', '2026-11-01T00:00:00Z'),
        stream('middle', '2026-11-23T00:00:00Z'),
        stream('needs-new', '2026-11-10T00:00:00Z'),
      ],
      new Set(['needs-old', 'needs-new'])
    )
    expect(ordered.map((ws) => ws.id)).toEqual(['needs-new', 'needs-old', 'newest', 'middle', 'old'])
  })

  test('keeps queued and active streams only', () => {
    const ordered = orderSquadCardWork(
      [
        stream('queued', '2026-11-20T00:00:00Z', { status: 'queued' }),
        stream('done', '2026-11-26T00:00:00Z', { status: 'done' }),
        stream('canceled', '2026-11-26T00:00:00Z', { status: 'canceled' }),
        stream('active', '2026-11-21T00:00:00Z'),
      ],
      new Set(['done'])
    )
    expect(ordered.map((ws) => ws.id)).toEqual(['active', 'queued'])
  })
})

describe('last activity', () => {
  test('orders by when the work last ran, not by edits that bumped updatedAt', () => {
    // Every stream below was edited at the same, later time; only their work differs.
    const ordered = orderSquadCardWork(
      [worked('older', '2026-11-20T00:00:00Z'), worked('newer', '2026-11-24T00:00:00Z')],
      new Set()
    )
    expect(ordered.map((ws) => ws.id)).toEqual(['newer', 'older'])
    const edited = worked('edited', '2026-11-20T00:00:00Z', { updatedAt: '2026-11-26T00:00:00Z' as never })
    expect(lastActivityTime(edited)).toBe(Date.parse('2026-11-20T00:00:00Z'))
  })

  test('a stream nothing has worked on yet counts from its creation', () => {
    const fresh = worked('fresh', null, { createdAt: '2026-11-22T00:00:00Z' as never })
    expect(lastActivityTime(fresh)).toBe(Date.parse('2026-11-22T00:00:00Z'))
    const ordered = orderSquadCardWork(
      [worked('older', '2026-11-20T00:00:00Z'), fresh, worked('newer', '2026-11-24T00:00:00Z')],
      new Set()
    )
    expect(ordered.map((ws) => ws.id)).toEqual(['newer', 'fresh', 'older'])
  })

  test('creation counts when it is later than the work an agent did before the stream', () => {
    const relisted = worked('relisted', '2026-11-01T00:00:00Z', { createdAt: '2026-11-15T00:00:00Z' as never })
    expect(lastActivityTime(relisted)).toBe(Date.parse('2026-11-15T00:00:00Z'))
  })

  test('falls back to updatedAt for a server that does not report when work last ran', () => {
    const legacy = stream('legacy', '2026-11-21T00:00:00Z', {
      runtime: { totalMs: 0, activeCount: 0, computedAt: '2026-11-27T00:00:00Z' },
    })
    expect(lastActivityTime(legacy)).toBe(Date.parse('2026-11-21T00:00:00Z'))
    expect(lastActivityTime(stream('no-runtime', '2026-11-23T00:00:00Z'))).toBe(Date.parse('2026-11-23T00:00:00Z'))
  })

  test('streams working right now keep one order whatever order the server sent them in', () => {
    const now = '2026-11-27T07:00:00Z'
    const rows = [
      worked('b', now, { createdAt: '2026-11-10T00:00:00Z' as never }),
      worked('a', now, { createdAt: '2026-11-10T00:00:00Z' as never }),
      worked('newest', now, { createdAt: '2026-11-20T00:00:00Z' as never }),
    ]
    const expected = ['newest', 'a', 'b']
    expect(orderSquadCardWork(rows, new Set()).map((ws) => ws.id)).toEqual(expected)
    expect(orderSquadCardWork([...rows].reverse(), new Set()).map((ws) => ws.id)).toEqual(expected)
  })
})
