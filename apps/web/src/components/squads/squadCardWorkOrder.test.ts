import { describe, expect, test } from 'bun:test'
import type { PendingAction, WorkStream } from '@ficus/shared'
import { orderSquadCardWork, workStreamIdsNeedingViewer } from './squadCardWorkOrder'

function stream(id: string, updatedAt: string, extra: Partial<WorkStream> = {}) {
  return { id, status: 'active', updatedAt: updatedAt as never, openWaits: [], ...extra } as Pick<
    WorkStream,
    'id' | 'status' | 'updatedAt' | 'openWaits'
  >
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
