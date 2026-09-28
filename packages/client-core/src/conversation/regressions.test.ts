import { describe, expect, test } from 'bun:test'
import type { ContentBlock, Message, StreamEvent } from '@ficus/shared'
import { combine, completedGroupIds, groupPersisted } from './combine'
import { StreamGroupStore } from './groups'
import type { CombineSession } from './types'

const LIVE: CombineSession = { agentId: 'a', streamStatus: 'live' }
const ENDED: CombineSession = { agentId: 'a', streamStatus: 'ended' }

function msg(p: Partial<Message> & Pick<Message, 'id' | 'role'>): Message {
  return {
    agentId: 'a',
    content: '',
    metadata: null,
    pending: false,
    createdAt: new Date('2026-06-25T00:00:00.000Z'),
    ...p,
  }
}
function text(id: string, content: string): ContentBlock {
  return { type: 'text', id, content }
}

// WEB BUG: tool turn (text → tool → text) persisted as M1 + M2; the done event and
// optimistic frontend carried only M2's fragment, so the full turn collapsed to ~20 chars.
describe('regression: web tool-turn fragment loss', () => {
  test('streaming shows full live content; swap shows the full merged turn, never the fragment', () => {
    const store = new StreamGroupStore()
    const stream: StreamEvent[] = [
      { type: 'agent', agentId: 'a' },
      { type: 'text', text: 'Let me check that. ', streamGroupId: 'S' },
      { type: 'tool_start', toolCallId: 't', toolName: 'bash', args: 'ls', streamGroupId: 'S' },
      { type: 'tool_end', toolCallId: 't', result: 'file.txt', isError: false, streamGroupId: 'S' },
      { type: 'text', text: 'Found it.', streamGroupId: 'S' },
    ]
    for (const e of stream) store.ingest(e, 1000)

    // Mid-turn: full streamed content visible (3 blocks), no fragment.
    const mid = combine([], store.snapshot(), [], LIVE)
    expect(mid).toHaveLength(1)
    expect(mid[0]).toMatchObject({ kind: 'streaming' })
    if (mid[0].kind === 'streaming') expect(mid[0].blocks).toHaveLength(3)

    // done enumerates BOTH rows; swap waits for both, then shows the merged turn.
    store.ingest({ type: 'done', response: 'Found it.', streamGroupId: 'S', messageIds: ['m1', 'm2'] }, 1001)
    const m1 = msg({
      id: 'm1',
      role: 'assistant',
      createdAt: new Date('2026-06-25T00:00:01.000Z'),
      metadata: {
        streamGroupId: 'S',
        content: [
          text('b1', 'Let me check that. '),
          {
            type: 'tool_use',
            id: 't',
            toolCall: { toolCallId: 't', toolName: 'bash', args: 'ls', result: 'file.txt', isError: false },
          },
        ],
      },
    })
    const m2 = msg({
      id: 'm2',
      role: 'assistant',
      createdAt: new Date('2026-06-25T00:00:02.000Z'),
      metadata: { streamGroupId: 'S', content: [text('b2', 'Found it.')] },
    })

    // Only M2 landed first (the fragment) — must NOT swap yet.
    const onlyM2 = combine(groupPersisted([m2]), store.snapshot(), [], LIVE)
    expect(onlyM2).toHaveLength(1)
    expect(onlyM2[0].kind).toBe('streaming')

    // Both rows present — swap to the full merged turn (3 blocks, not the 1-block fragment).
    const done = combine(groupPersisted([m1, m2]), store.snapshot(), [], LIVE)
    expect(done).toHaveLength(1)
    expect(done[0].kind).toBe('persisted')
    if (done[0].kind === 'persisted') expect(done[0].blocks).toHaveLength(3)
  })
})

// WEB BUG: streamed content briefly vanished when the assistant row existed but had not yet
// refreshed with all finalized optimistic content.
describe('regression: streamed content refresh gap', () => {
  test('retains streamed blocks until the persisted turn includes finalized text, thinking, and tool content', () => {
    const store = new StreamGroupStore()
    store.ingest({ type: 'agent', agentId: 'a' }, 1)
    store.ingest({ type: 'thinking', text: 'Plan', streamGroupId: 'S' }, 2)
    store.ingest({ type: 'thinking_end', durationMs: 10, streamGroupId: 'S' }, 3)
    store.ingest({ type: 'text', text: 'Checking ', streamGroupId: 'S' }, 4)
    store.ingest({ type: 'tool_start', toolCallId: 't', toolName: 'bash', args: 'pwd', streamGroupId: 'S' }, 5)
    store.ingest({ type: 'tool_end', toolCallId: 't', result: '/repo', isError: false, streamGroupId: 'S' }, 6)
    store.ingest({ type: 'text', text: 'done', streamGroupId: 'S' }, 7)
    store.ingest({ type: 'done', response: 'Checking done', streamGroupId: 'S', messageIds: ['m1'] }, 8)
    // The queued interrupt starts a new stream before history has caught up for the previous one.
    store.ingest({ type: 'text', text: 'Next turn', streamGroupId: 'S2' }, 9)

    const staleTurn = groupPersisted([
      msg({
        id: 'm1',
        role: 'assistant',
        createdAt: new Date(6),
        metadata: {
          streamGroupId: 'S',
          content: [
            {
              type: 'tool_use',
              id: 't',
              toolCall: { toolCallId: 't', toolName: 'bash', args: 'pwd', result: '/repo', isError: false },
            },
          ],
        },
      }),
    ])

    const stale = combine(staleTurn, store.snapshot(), [], LIVE)
    expect(stale).toHaveLength(2)
    expect(stale[0].kind).toBe('streaming')
    expect(stale[0].id).toBe('S')
    expect(stale[1]).toMatchObject({ kind: 'streaming', id: 'S2' })
    expect(completedGroupIds(staleTurn, store.snapshot(), LIVE)).toEqual([])

    const refreshedTurn = groupPersisted([
      msg({
        id: 'm1',
        role: 'assistant',
        createdAt: new Date(6),
        metadata: {
          streamGroupId: 'S',
          content: [
            { type: 'thinking', id: 'p1', content: 'Plan', durationMs: 12 },
            { type: 'text', id: 'p2', content: 'Checking ' },
            {
              type: 'tool_use',
              id: 't',
              toolCall: { toolCallId: 't', toolName: 'bash', args: 'pwd', result: '/repo', isError: false },
            },
            { type: 'text', id: 'p3', content: 'done' },
          ],
        },
      }),
    ])

    const refreshed = combine(refreshedTurn, store.snapshot(), [], LIVE)
    expect(refreshed).toHaveLength(2)
    expect(refreshed[0].kind).toBe('persisted')
    expect(refreshed[1]).toMatchObject({ kind: 'streaming', id: 'S2' })
    expect(completedGroupIds(refreshedTurn, store.snapshot(), LIVE)).toEqual(['S'])
  })
})

// MOBILE BUG: message appears then vanishes — a premature clear exposed a gap between
// done and the DB rows landing. With the swap rule there is never a gap.
describe('regression: mobile appear-then-vanish', () => {
  test('no render is ever empty between done and rows landing', () => {
    const store = new StreamGroupStore()
    store.ingest({ type: 'text', text: 'Hello', streamGroupId: 'S' }, 1)
    store.ingest({ type: 'done', response: 'Hello', streamGroupId: 'S', messageIds: ['m1'] }, 2)
    // Rows have not landed yet.
    expect(combine([], store.snapshot(), [], LIVE)).toHaveLength(1)
    // Rows land → still exactly one item (now persisted).
    const turn = groupPersisted([
      msg({ id: 'm1', role: 'assistant', metadata: { streamGroupId: 'S', content: [text('b', 'Hello')] } }),
    ])
    const landed = combine(turn, store.snapshot(), [], LIVE)
    expect(landed).toHaveLength(1)
    expect(landed[0].kind).toBe('persisted')
  })
})

// MOBILE BUG: follow-up marked non-pending too early; wrong-timestamp ordering.
describe('regression: follow-up ordering by consumedAt', () => {
  test('a steer consumed mid-conversation sorts between the correct turns via consumedAt', () => {
    const turn1 = msg({
      id: 'm1',
      role: 'assistant',
      createdAt: new Date('2026-06-25T00:00:01.000Z'),
      metadata: { streamGroupId: 'S1', content: [text('b1', 'first')] },
    })
    // Steer created early (createdAt) but consumed later (consumedAt) — must sort after turn1.
    const steer = msg({
      id: 'h2',
      role: 'human',
      content: 'steer',
      createdAt: new Date('2026-06-25T00:00:00.500Z'),
      metadata: { deliveryMode: 'steer', consumedAt: '2026-06-25T00:00:01.500Z' },
    })
    const turn2 = msg({
      id: 'm3',
      role: 'assistant',
      createdAt: new Date('2026-06-25T00:00:02.000Z'),
      metadata: { streamGroupId: 'S2', content: [text('b3', 'second')] },
    })
    const items = combine(groupPersisted([turn1, steer, turn2]), [], [], LIVE)
    expect(items.map((i) => i.id)).toEqual(['m1', 'h2', 'm3'])
  })
})

// RESILIENCE: reconnect replays catchup; idempotent — no doubled content, swap completes.
describe('regression: reconnect catchup idempotency', () => {
  test('replaying the catchup batch twice does not double content and still swaps on done', () => {
    const store = new StreamGroupStore()
    const batch: StreamEvent[] = [
      { type: 'agent', agentId: 'a' },
      { type: 'text', text: 'Partial', streamGroupId: 'S' },
    ]
    store.applyCatchup(batch, 1)
    store.applyCatchup(batch, 1) // second reconnect
    const snap = store.snapshot()[0]
    expect(snap.blocks.filter((b) => b.type === 'text').map((b) => (b.type === 'text' ? b.content : ''))).toEqual([
      'Partial',
    ])
    // Reconnect also delivers the done; once the persisted row lands, the group swaps to persisted.
    store.ingest({ type: 'done', response: 'Partial', streamGroupId: 'S', messageIds: ['m1'] }, 2)
    const turn = groupPersisted([
      msg({ id: 'm1', role: 'assistant', metadata: { streamGroupId: 'S', content: [text('b', 'Partial')] } }),
    ])
    const swapped = combine(turn, store.snapshot(), [], LIVE)
    expect(swapped).toHaveLength(1)
    expect(swapped[0].kind).toBe('persisted')
  })
})

// RESILIENCE: stream died before any commit — content is not lost, marked interrupted.
describe('regression: ended-without-done preserves content', () => {
  test('interrupted streaming item survives when no rows were committed', () => {
    const store = new StreamGroupStore()
    store.ingest({ type: 'text', text: 'died mid-turn', streamGroupId: 'S' }, 1)
    const items = combine([], store.snapshot(), [], ENDED)
    expect(items[0]).toMatchObject({ kind: 'streaming', status: 'interrupted' })
  })
})
