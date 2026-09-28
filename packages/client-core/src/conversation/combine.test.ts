import { describe, expect, test } from 'bun:test'
import type { ContentBlock, Message } from '@ficus/shared'
import { combine, completedGroupIds, groupPersisted } from './combine'
import type { CombineSession, PendingItem, StreamGroupSnapshot, SystemMessageItem } from './types'

const SESSION_LIVE: CombineSession = { agentId: 'a', streamStatus: 'live' }
const SESSION_ENDED: CombineSession = { agentId: 'a', streamStatus: 'ended' }

function msg(partial: Partial<Message> & Pick<Message, 'id' | 'role'>): Message {
  return {
    agentId: 'a',
    content: '',
    metadata: null,
    pending: false,
    createdAt: new Date('2026-06-25T00:00:00.000Z'),
    ...partial,
  }
}

function textBlock(id: string, content: string): ContentBlock {
  return { type: 'text', id, content }
}

function streamGroup(
  partial: Partial<StreamGroupSnapshot> & Pick<StreamGroupSnapshot, 'streamGroupId'>
): StreamGroupSnapshot {
  return {
    agentId: 'a',
    blocks: [],
    startedAt: 1000,
    done: false,
    doneMessageIds: null,
    flushed: false,
    errored: false,
    ...partial,
  }
}

describe('groupPersisted', () => {
  test('merges M1 + M2 of a tool turn by streamGroupId, concatenating blocks in createdAt order', () => {
    const m1 = msg({
      id: 'm1',
      role: 'assistant',
      createdAt: new Date('2026-06-25T00:00:01.000Z'),
      metadata: {
        streamGroupId: 'S',
        content: [
          textBlock('b1', 'pre'),
          {
            type: 'tool_use',
            id: 't',
            toolCall: { toolCallId: 't', toolName: 'bash', args: '', result: 'ok', isError: false },
          },
        ],
      },
    })
    const m2 = msg({
      id: 'm2',
      role: 'assistant',
      createdAt: new Date('2026-06-25T00:00:02.000Z'),
      metadata: { streamGroupId: 'S', content: [textBlock('b2', 'post')] },
    })
    const turns = groupPersisted([m2, m1]) // deliberately out of order
    expect(turns).toHaveLength(1)
    expect(turns[0].id).toBe('m1')
    expect(turns[0].mergedFrom.map((m) => m.id)).toEqual(['m1', 'm2'])
    expect(turns[0].blocks.map((b) => b.id)).toEqual(['b1', 't', 'b2'])
  })

  test('interposed human/system rows never split a turn (grouping is by id, not adjacency)', () => {
    const m1 = msg({
      id: 'm1',
      role: 'assistant',
      createdAt: new Date('2026-06-25T00:00:01.000Z'),
      metadata: { streamGroupId: 'S', content: [textBlock('b1', 'pre')] },
    })
    const sys = msg({ id: 'sys', role: 'human', createdAt: new Date('2026-06-25T00:00:01.500Z') })
    const m2 = msg({
      id: 'm2',
      role: 'assistant',
      createdAt: new Date('2026-06-25T00:00:02.000Z'),
      metadata: { streamGroupId: 'S', content: [textBlock('b2', 'post')] },
    })
    const turns = groupPersisted([m1, sys, m2])
    const sgTurn = turns.find((t) => t.streamGroupId === 'S')!
    expect(sgTurn.mergedFrom.map((m) => m.id)).toEqual(['m1', 'm2'])
    expect(turns.map((t) => t.id)).toContain('sys')
  })

  test('legacy assistant rows without streamGroupId each become their own turn', () => {
    const a = msg({ id: 'a1', role: 'assistant', metadata: { content: [textBlock('x', 'hi')] } })
    const b = msg({ id: 'a2', role: 'assistant', metadata: { content: [textBlock('y', 'yo')] } })
    const turns = groupPersisted([a, b])
    expect(turns.map((t) => t.id).sort()).toEqual(['a1', 'a2'])
  })

  test('sorts rows whose createdAt arrived as an ISO string (JSON over the wire, no Date revival)', () => {
    // getMessages → res.json() leaves createdAt as a string; groupPersisted must not call .getTime() on it.
    const a = msg({ id: 'a1', role: 'human', createdAt: '2026-06-25T00:00:02.000Z' as unknown as Date })
    const b = msg({ id: 'b1', role: 'human', createdAt: '2026-06-25T00:00:01.000Z' as unknown as Date })
    const turns = groupPersisted([a, b])
    expect(turns.map((t) => t.id)).toEqual(['b1', 'a1'])
  })
})

describe('combine — streaming xor persisted', () => {
  test('while streaming (no done) renders the streaming item and suppresses any persisted turn for S', () => {
    const persisted = groupPersisted([
      msg({ id: 'm1', role: 'assistant', metadata: { streamGroupId: 'S', content: [textBlock('b1', 'final')] } }),
    ])
    const groups = [
      streamGroup({
        streamGroupId: 'S',
        blocks: [{ type: 'text', id: 's1', content: 'streaming…', streamGroupId: 'S' }],
      }),
    ]
    const items = combine(persisted, groups, [], SESSION_LIVE)
    expect(items).toHaveLength(1)
    expect(items[0].kind).toBe('streaming')
  })

  test('after done, keeps streaming until ALL messageIds are persisted, then swaps', () => {
    const groups = [streamGroup({ streamGroupId: 'S', done: true, doneMessageIds: ['m1', 'm2'] })]

    const partial = groupPersisted([
      msg({ id: 'm1', role: 'assistant', metadata: { streamGroupId: 'S', content: [textBlock('b1', 'pre')] } }),
    ])
    expect(combine(partial, groups, [], SESSION_LIVE)[0].kind).toBe('streaming') // m2 missing

    const complete = groupPersisted([
      msg({
        id: 'm1',
        role: 'assistant',
        createdAt: new Date('2026-06-25T00:00:01.000Z'),
        metadata: { streamGroupId: 'S', content: [textBlock('b1', 'pre')] },
      }),
      msg({
        id: 'm2',
        role: 'assistant',
        createdAt: new Date('2026-06-25T00:00:02.000Z'),
        metadata: { streamGroupId: 'S', content: [textBlock('b2', 'post')] },
      }),
    ])
    const swapped = combine(complete, groups, [], SESSION_LIVE)
    expect(swapped).toHaveLength(1)
    expect(swapped[0].kind).toBe('persisted')
    expect(completedGroupIds(complete, groups, SESSION_LIVE)).toEqual(['S'])
  })

  test('ended without done but persisted turn present → swap to persisted', () => {
    const groups = [streamGroup({ streamGroupId: 'S', done: false })]
    const complete = groupPersisted([
      msg({ id: 'm1', role: 'assistant', metadata: { streamGroupId: 'S', content: [textBlock('b1', 'x')] } }),
    ])
    const items = combine(complete, groups, [], SESSION_ENDED)
    expect(items[0].kind).toBe('persisted')
  })

  test('ended without done and no persisted rows → streaming item marked interrupted', () => {
    const groups = [
      streamGroup({
        streamGroupId: 'S',
        done: false,
        blocks: [{ type: 'text', id: 's1', content: 'half', streamGroupId: 'S' }],
      }),
    ]
    const items = combine([], groups, [], SESSION_ENDED)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'streaming', status: 'interrupted' })
  })

  test('a persisted compaction notice cannot merge into a response or discard interrupted live text', () => {
    const persisted = groupPersisted([
      msg({
        id: 'compaction-notice',
        role: 'assistant',
        content: '[System] Context compacted — continuing...',
        metadata: {
          source: 'compaction',
          systemMessageKey: 'compaction:response-group',
        },
      }),
    ])
    const groups = [
      streamGroup({
        streamGroupId: 'response-group',
        done: false,
        blocks: [{ type: 'text', id: 'partial', content: 'interrupted response', streamGroupId: 'response-group' }],
      }),
    ]

    const items = combine(persisted, groups, [], SESSION_ENDED)

    expect(items.some((item) => item.kind === 'persisted' && item.id === 'compaction-notice')).toBe(true)
    expect(items).toContainEqual(
      expect.objectContaining({ id: 'response-group', kind: 'streaming', status: 'interrupted' })
    )
  })

  test('flushed group renders with status flushed until its persisted turn arrives', () => {
    const groups = [
      streamGroup({
        streamGroupId: 'S',
        flushed: true,
        blocks: [{ type: 'text', id: 's1', content: 'steered away', streamGroupId: 'S' }],
      }),
    ]
    const items = combine([], groups, [], SESSION_LIVE)
    expect(items[0]).toMatchObject({ kind: 'streaming', status: 'flushed' })
  })
})

describe('combine — pending dedup & placement', () => {
  test('pending is dropped once a persisted human row echoes its clientId', () => {
    const pending: PendingItem[] = [{ clientId: 'c1', content: 'hello', status: 'sending', createdAt: 10 }]
    const persisted = groupPersisted([msg({ id: 'h1', role: 'human', content: 'hello', metadata: { clientId: 'c1' } })])
    const items = combine(persisted, [], pending, SESSION_LIVE)
    expect(items.filter((i) => i.kind === 'pending')).toHaveLength(0)
    expect(items.filter((i) => i.kind === 'persisted')).toHaveLength(1)
  })

  test('lone pending send (agent idle, nothing queued) sits at the bottom of region A, above a later stream', () => {
    const pending: PendingItem[] = [{ clientId: 'c1', content: 'hi', status: 'sending', createdAt: 500 }]
    const groups = [
      streamGroup({
        streamGroupId: 'S',
        startedAt: 1000,
        blocks: [{ type: 'text', id: 's1', content: '…', streamGroupId: 'S' }],
      }),
    ]
    const items = combine([], groups, pending, SESSION_LIVE)
    // The in-flight lone send also lights the activity indicator at the foot of the timeline.
    expect(items.map((i) => i.kind)).toEqual(['pending', 'streaming', 'working'])
    // A lone Region-A send is NOT queued → the UI must not label it Interrupt/Follow-up.
    const lone = items.find((i) => i.kind === 'pending')
    expect(lone && 'queued' in lone && lone.queued).toBeFalsy()
  })

  test('all interrupts sort above all follow-ups, each in send order', () => {
    const pending: PendingItem[] = [
      { clientId: 'f1', content: 'follow 1', deliveryMode: 'follow-up', status: 'queued', createdAt: 1 },
      { clientId: 's1', content: 'steer 1', deliveryMode: 'steer', status: 'queued', createdAt: 2 },
      { clientId: 's2', content: 'steer 2', deliveryMode: 'steer', status: 'queued', createdAt: 3 },
    ]
    const groups = [
      streamGroup({
        streamGroupId: 'S',
        startedAt: 0,
        blocks: [{ type: 'text', id: 'x', content: '…', streamGroupId: 'S' }],
      }),
    ]
    const items = combine([], groups, pending, SESSION_LIVE)
    expect(items.filter((i) => i.kind === 'pending').map((i) => i.id)).toEqual(['s1', 's2', 'f1'])
    // Queued interrupts/follow-ups ARE flagged queued → the UI labels them.
    expect(items.filter((i) => i.kind === 'pending').every((i) => 'queued' in i && i.queued)).toBe(true)
    // queued region sits below the active stream
    expect(items[0].kind).toBe('streaming')
  })

  test('a sending message while the agent is active is placed in its delivery-mode region with loading', () => {
    const pending: PendingItem[] = [
      { clientId: 'c9', content: 'steer me', deliveryMode: 'steer', status: 'sending', createdAt: 9 },
    ]
    const groups = [
      streamGroup({
        streamGroupId: 'S',
        startedAt: 0,
        blocks: [{ type: 'text', id: 'x', content: '…', streamGroupId: 'S' }],
      }),
    ]
    const items = combine([], groups, pending, SESSION_LIVE)
    const last = items[items.length - 1]
    expect(last).toMatchObject({ kind: 'pending', id: 'c9', status: 'sending', deliveryMode: 'steer' })
  })

  test('a persisted human row still pending with a deliveryMode renders as a queued item (not a chronological persisted row)', () => {
    // Mirrors a refresh: the optimistic pending is gone; the queued follow-up survives only as a
    // server-persisted human row (pending:true, deliveryMode set). It must still read as queued.
    const processed = msg({
      id: 'u1',
      role: 'human',
      content: 'do the thing',
      createdAt: new Date('2026-06-25T00:00:01.000Z'),
    })
    const assistant = msg({
      id: 'a1',
      role: 'assistant',
      createdAt: new Date('2026-06-25T00:00:02.000Z'),
      metadata: { streamGroupId: 'S', content: [textBlock('b', 'working…')] },
    })
    const queuedFollowUp = msg({
      id: 'q1',
      role: 'human',
      content: 'also do this after',
      createdAt: new Date('2026-06-25T00:00:03.000Z'),
      pending: true,
      metadata: { deliveryMode: 'follow-up' },
    })
    const history = groupPersisted([processed, assistant, queuedFollowUp])
    const items = combine(history, [], [], SESSION_LIVE)

    const q = items.find((i) => i.kind === 'pending')
    expect(q && q.kind === 'pending' && q.queued).toBe(true)
    expect(q && q.kind === 'pending' && q.deliveryMode).toBe('follow-up')
    // It must NOT also appear as a chronological persisted row.
    expect(items.some((i) => i.kind === 'persisted' && i.id === 'q1')).toBe(false)
    // Queued region sits after the processed message + its turn.
    const ids = items.map((i) => i.id)
    expect(ids.indexOf('q1')).toBeGreaterThan(ids.indexOf('a1'))
  })

  test('a persisted pending inbox row keeps metadata on the queued render item', () => {
    const queuedInbox = msg({
      id: 'q-inbox',
      role: 'human',
      content: 'Full raw inbox delivery prompt',
      createdAt: new Date('2026-06-25T00:00:03.000Z'),
      pending: true,
      metadata: {
        source: 'inbox',
        deliveryMode: 'steer',
        inboxDeliveryMode: 'steer',
        inboxMessageIds: ['inbox-1'],
        inboxMessageSummaries: [
          {
            id: 'inbox-1',
            senderType: 'agent',
            senderId: 'agent-1',
            senderDisplay: 'Pearl (manager) [agent-1]',
            subject: 'Please review',
            preview: 'Review this change',
          },
        ],
      },
    })

    const items = combine(groupPersisted([queuedInbox]), [], [], SESSION_LIVE)
    const pending = items.find((item) => item.kind === 'pending')

    expect(pending).toMatchObject({
      kind: 'pending',
      id: 'q-inbox',
      metadata: expect.objectContaining({ source: 'inbox', inboxMessageIds: ['inbox-1'] }),
    })
  })

  test('a consumed (no longer pending) human row stays a chronological persisted row', () => {
    const consumed = msg({
      id: 'q1',
      role: 'human',
      content: 'already ran',
      createdAt: new Date('2026-06-25T00:00:03.000Z'),
      pending: false,
      metadata: { deliveryMode: 'follow-up', consumedAt: '2026-06-25T00:00:04.000Z' },
    })
    const items = combine(groupPersisted([consumed]), [], [], SESSION_LIVE)
    expect(items.some((i) => i.kind === 'persisted' && i.id === 'q1')).toBe(true)
    expect(items.some((i) => i.kind === 'pending')).toBe(false)
  })

  test('a send that loses a race (stream started before it) becomes an interrupt below the stream', () => {
    // Agent looked idle when the user typed (plain send, defaulted to steer), but a stream started
    // BEFORE the send's client time (e.g. an inbox message woke the agent) → it is queued as an interrupt.
    const pending: PendingItem[] = [
      { clientId: 'c1', content: 'hi', deliveryMode: 'steer', status: 'sending', createdAt: 100 },
    ]
    const groups = [
      streamGroup({
        streamGroupId: 'S',
        startedAt: 50,
        blocks: [{ type: 'text', id: 'x', content: '…', streamGroupId: 'S' }],
      }),
    ]
    const items = combine([], groups, pending, SESSION_LIVE)
    expect(items.map((i) => i.kind)).toEqual(['streaming', 'pending'])
    const last = items[items.length - 1]
    expect(last).toMatchObject({ kind: 'pending', id: 'c1', deliveryMode: 'steer', status: 'sending' })
  })

  test('a send whose stream starts AFTER it stays in region A (the prompt that started the turn), deliveryMode dormant', () => {
    const pending: PendingItem[] = [
      { clientId: 'c2', content: 'go', deliveryMode: 'steer', status: 'sending', createdAt: 100 },
    ]
    const groups = [
      streamGroup({
        streamGroupId: 'S',
        startedAt: 200,
        blocks: [{ type: 'text', id: 'x', content: '…', streamGroupId: 'S' }],
      }),
    ]
    const items = combine([], groups, pending, SESSION_LIVE)
    expect(items.map((i) => i.kind)).toEqual(['pending', 'streaming', 'working'])
  })
})

describe('combine — working indicator', () => {
  const SESSION_RUNNING: CombineSession = { agentId: 'a', streamStatus: 'live', executionStatus: 'running' }

  test('emits a single working item at the foot when the agent execution is running', () => {
    const items = combine([], [], [], SESSION_RUNNING)
    expect(items.map((i) => i.kind)).toEqual(['working'])
    expect(items[0]).toMatchObject({ kind: 'working', id: '__working__' })
  })

  test('renders maintenance-waiting work as a static queue row without thinking', () => {
    const items = combine([], [], [], {
      agentId: 'a',
      streamStatus: 'ended',
      executionStatus: 'waiting-maintenance',
    })

    expect(items).toEqual([
      {
        kind: 'queued',
        id: '__maintenance_queue__',
        reason: 'maintenance',
        label: 'Queued until maintenance completes',
      },
    ])
    expect(items.some((item) => item.kind === 'working')).toBe(false)
  })

  test('no working item when execution is idle/terminal and nothing is in flight', () => {
    for (const executionStatus of ['completed', 'failed', 'stopped', null] as const) {
      const items = combine([], [], [], { agentId: 'a', streamStatus: 'live', executionStatus })
      expect(items.some((i) => i.kind === 'working')).toBe(false)
    }
  })

  test('a lone in-flight send lights the indicator before execution status is known', () => {
    const pending: PendingItem[] = [{ clientId: 'c1', content: 'hi', status: 'sending', createdAt: 10 }]
    const items = combine([], [], pending, SESSION_LIVE) // no executionStatus yet
    expect(items.map((i) => i.kind)).toEqual(['pending', 'working'])
  })

  test('working indicator sits above a queued interrupt, which is tagged even when it is the only one', () => {
    // A single message sent into a running turn (group started before it) must be queued+tagged, and
    // the activity indicator belongs above it (the queued send is not being processed yet).
    const pending: PendingItem[] = [
      { clientId: 'c1', content: 'hold on', deliveryMode: 'steer', status: 'sending', createdAt: 100 },
    ]
    const groups = [
      streamGroup({
        streamGroupId: 'S',
        startedAt: 50,
        blocks: [{ type: 'text', id: 'x', content: '…', streamGroupId: 'S' }],
      }),
    ]
    const items = combine([], groups, pending, SESSION_RUNNING)
    expect(items.map((i) => i.kind)).toEqual(['streaming', 'working', 'pending'])
    const queued = items.find((i) => i.kind === 'pending')
    expect(queued && 'queued' in queued && queued.queued).toBe(true)
  })

  test('a failed send does not light the indicator (it self-clears)', () => {
    const pending: PendingItem[] = [{ clientId: 'c1', content: 'hi', status: 'failed', createdAt: 10 }]
    const items = combine([], [], pending, SESSION_LIVE)
    expect(items.some((i) => i.kind === 'working')).toBe(false)
  })

  test('the indicator sits below the current turn but above queued sends', () => {
    const groups = [
      streamGroup({
        streamGroupId: 'S',
        startedAt: 0,
        blocks: [{ type: 'text', id: 'x', content: '…', streamGroupId: 'S' }],
      }),
    ]
    const pending: PendingItem[] = [
      { clientId: 's1', content: 'steer', deliveryMode: 'steer', status: 'queued', createdAt: 5 },
    ]
    const items = combine([], groups, pending, SESSION_RUNNING)
    expect(items.map((i) => i.kind)).toEqual(['streaming', 'working', 'pending'])
  })
})

describe('combine — sandbox wait sub-state', () => {
  const SESSION_RUNNING: CombineSession = { agentId: 'a', streamStatus: 'live', executionStatus: 'running' }

  test('waiting-sandbox status is nonterminal busy and tagged as a sandbox wait', () => {
    const items = combine([], [], [], {
      agentId: 'a',
      streamStatus: 'ended',
      executionStatus: 'waiting-sandbox',
    })
    expect(items).toContainEqual({ kind: 'working', id: '__working__', waitingFor: 'sandbox' })
  })

  test('waiting flag + busy ⇒ the working item is tagged waitingFor: sandbox', () => {
    const items = combine([], [], [], { ...SESSION_RUNNING, waitingForSandbox: true })
    expect(items.map((i) => i.kind)).toEqual(['working'])
    expect(items[0]).toMatchObject({ kind: 'working', id: '__working__', waitingFor: 'sandbox' })
  })

  test('waiting flag without busy ⇒ no working item at all (busy remains the gate)', () => {
    const items = combine([], [], [], {
      agentId: 'a',
      streamStatus: 'live',
      executionStatus: 'completed',
      waitingForSandbox: true,
    })
    expect(items.some((i) => i.kind === 'working')).toBe(false)
  })

  test('flag cleared ⇒ a plain working item with no waitingFor', () => {
    const items = combine([], [], [], { ...SESSION_RUNNING, waitingForSandbox: false })
    expect(items.map((i) => i.kind)).toEqual(['working'])
    expect(items[0]).toMatchObject({ kind: 'working', id: '__working__' })
    expect((items[0] as { waitingFor?: string }).waitingFor).toBeUndefined()
  })
})

describe('combine — determinism', () => {
  test('scrambled input orders produce identical output', () => {
    const rows = [
      msg({ id: 'h1', role: 'human', content: 'q', createdAt: new Date('2026-06-25T00:00:00.000Z') }),
      msg({
        id: 'm1',
        role: 'assistant',
        createdAt: new Date('2026-06-25T00:00:01.000Z'),
        metadata: { streamGroupId: 'S', content: [textBlock('b1', 'pre')] },
      }),
      msg({
        id: 'm2',
        role: 'assistant',
        createdAt: new Date('2026-06-25T00:00:02.000Z'),
        metadata: { streamGroupId: 'S', content: [textBlock('b2', 'post')] },
      }),
    ]
    const a = combine(groupPersisted(rows), [], [], SESSION_LIVE)
    const b = combine(groupPersisted([rows[2], rows[0], rows[1]]), [], [], SESSION_LIVE)
    expect(a.map((i) => i.id)).toEqual(b.map((i) => i.id))
  })
})

describe('combine — system messages', () => {
  test('emits system items in Region A ordered by arrival, interleaved with the timeline', () => {
    const turn = groupPersisted([
      msg({
        id: 'm1',
        role: 'assistant',
        createdAt: new Date('2026-06-25T00:00:01.000Z'),
        metadata: { streamGroupId: 'S', content: [textBlock('b', 'hi')] },
      }),
    ])
    const sys: SystemMessageItem[] = [
      { id: 'sys-1', text: 'Retrying (attempt 1/3)', at: new Date('2026-06-25T00:00:02.000Z').getTime() },
    ]
    const items = combine(turn, [], [], SESSION_LIVE, sys)
    expect(items.map((i) => i.kind)).toEqual(['persisted', 'system'])
    const sysItem = items.find((i) => i.kind === 'system')!
    expect(sysItem).toMatchObject({ kind: 'system', id: 'sys-1', text: 'Retrying (attempt 1/3)' })
  })

  test('mid-stream compaction: pre-compaction turn, compaction notice, post-compaction stream all render in order', () => {
    const t1 = new Date('2026-06-25T00:00:01.000Z')
    const t2 = new Date('2026-06-25T00:00:02.000Z')
    const t3 = new Date('2026-06-25T00:00:03.000Z')

    const turn = groupPersisted([
      msg({
        id: 'm1',
        role: 'assistant',
        createdAt: t1,
        metadata: { streamGroupId: 'exec:run:1', content: [textBlock('b1', 'before compaction')] },
      }),
    ])
    const sys: SystemMessageItem[] = [{ id: 'sys-1', text: 'Context compacted — continuing...', at: t2.getTime() }]
    const groups = [
      streamGroup({
        streamGroupId: 'exec:run:2',
        startedAt: t3.getTime(),
        blocks: [{ type: 'text', id: 's1', content: 'after compaction…', streamGroupId: 'exec:run:2' }],
      }),
    ]

    const items = combine(turn, groups, [], SESSION_LIVE, sys)

    expect(items.map((i) => i.kind)).toEqual(['persisted', 'system', 'streaming'])
    expect(items.map((i) => i.id)).toEqual(['m1', 'sys-1', 'exec:run:2'])
  })

  test('mid-stream compaction: persisted compaction notice replaces matching live system notice', () => {
    const t1 = new Date('2026-06-25T00:00:01.000Z')
    const t2 = new Date('2026-06-25T00:00:02.000Z')
    const t3 = new Date('2026-06-25T00:00:03.000Z')

    const turn = groupPersisted([
      msg({
        id: 'm1',
        role: 'assistant',
        createdAt: t1,
        metadata: { streamGroupId: 'exec:run:1', content: [textBlock('b1', 'before compaction')] },
      }),
      msg({
        id: 'sys-db-1',
        role: 'assistant',
        content: '[System] Context compacted — continuing...',
        createdAt: t2,
        metadata: { source: 'compaction', systemMessageKey: 'compaction:exec:run:2' },
      }),
    ])
    const sys: SystemMessageItem[] = [
      {
        id: 'sys-live-1',
        text: 'Context compacted — continuing...',
        at: t2.getTime(),
        transientId: 'compaction:exec:run:2',
      },
    ]
    const groups = [
      streamGroup({
        streamGroupId: 'exec:run:2',
        startedAt: t3.getTime(),
        blocks: [{ type: 'text', id: 's1', content: 'after compaction…', streamGroupId: 'exec:run:2' }],
      }),
    ]

    const items = combine(turn, groups, [], SESSION_LIVE, sys)

    expect(items.map((i) => i.kind)).toEqual(['persisted', 'persisted', 'streaming'])
    expect(items.map((i) => i.id)).toEqual(['m1', 'sys-db-1', 'exec:run:2'])
  })

  test('no systemMessages arg → no system items (backward compatible)', () => {
    const items = combine([], [], [], SESSION_LIVE)
    expect(items.some((i) => i.kind === 'system')).toBe(false)
  })
})

describe('explicit per-message queue placement', () => {
  test('accepted first prompt stays above its response and loader while internally pending', () => {
    const history = groupPersisted([
      msg({
        id: 'first',
        role: 'human',
        pending: true,
        queued: false,
        createdAt: new Date(1),
        metadata: { deliveryMode: 'follow-up', clientId: 'c1' },
      }),
    ])
    const items = combine(history, [streamGroup({ streamGroupId: 'S', startedAt: 2 })], [], {
      agentId: 'a',
      streamStatus: 'live',
      executionStatus: 'running',
    })
    expect(items.map((i) => i.kind)).toEqual(['persisted', 'streaming', 'working'])
  })

  test('explicit queued state wins over later sends and stream arrival times', () => {
    const pending: PendingItem[] = [
      { clientId: 'first', content: 'first', status: 'sending', queued: false, createdAt: 20 },
      { clientId: 'next', content: 'next', status: 'queued', queued: true, deliveryMode: 'follow-up', createdAt: 30 },
    ]
    const items = combine([], [streamGroup({ streamGroupId: 'S', startedAt: 10 })], pending, SESSION_LIVE)
    expect(items.find((i) => i.id === 'first')).toMatchObject({ queued: false })
    expect(items.find((i) => i.id === 'next')).toMatchObject({ queued: true })
  })
})

describe('incomplete durable handoff', () => {
  test.each(['ended', 'errored', 'flushed'] as const)(
    '%s preserves uncommitted tails until complete coverage',
    (reason) => {
      const group = streamGroup({
        streamGroupId: 'S',
        blocks: [textBlock('b', 'Visible response')],
        errored: reason === 'errored',
        flushed: reason === 'flushed',
      })
      const session = reason === 'ended' ? SESSION_ENDED : SESSION_LIVE
      const partial = groupPersisted([
        msg({ id: 'm', role: 'assistant', metadata: { streamGroupId: 'S', content: [textBlock('b', 'Visible')] } }),
      ])
      expect(completedGroupIds(partial, [group], session)).toEqual([])
      expect(combine(partial, [group], [], session)[0]).toMatchObject({ kind: 'streaming', blocks: group.blocks })
      const full = groupPersisted([
        msg({ id: 'm', role: 'assistant', metadata: { streamGroupId: 'S', content: group.blocks } }),
      ])
      expect(completedGroupIds(full, [group], session)).toEqual(['S'])
      expect(combine(full, [group], [], session)[0].kind).toBe('persisted')
      // Once handed off, authoritative removal is not resurrected by a retained longest-text cache.
      expect(combine([], [], [], session)).toEqual([])
    }
  )
})

test('transport end while execution is busy cannot retire an open group even if current prefix is saved', () => {
  const group = streamGroup({ streamGroupId: 'S', blocks: [textBlock('b', 'prefix')] })
  const history = groupPersisted([
    msg({ id: 'm', role: 'assistant', metadata: { streamGroupId: 'S', content: group.blocks } }),
  ])
  expect(
    completedGroupIds(history, [group], { agentId: 'a', streamStatus: 'ended', executionStatus: 'running' })
  ).toEqual([])
})

test.each(['ended', 'errored', 'flushed', 'done'] as const)(
  '%s handoff checks split rows, final tool result and every done ID',
  (reason) => {
    const tool: ContentBlock = {
      type: 'tool_use',
      id: 'tool',
      toolCall: { toolCallId: 't', toolName: 'search', args: '{}', result: 'final', isError: false },
    }
    const blocks: ContentBlock[] = [textBlock('b', 'prefix'), tool, textBlock('tail', 'tail')]
    const group = streamGroup({
      streamGroupId: 'S',
      blocks,
      done: reason === 'done',
      doneMessageIds: reason === 'done' ? ['m1', 'm2'] : null,
      errored: reason === 'errored',
      flushed: reason === 'flushed',
    })
    const first = msg({
      id: 'm1',
      role: 'assistant',
      createdAt: new Date(1),
      metadata: { streamGroupId: 'S', content: blocks.slice(0, 2) },
    })
    const last = msg({
      id: 'm2',
      role: 'assistant',
      createdAt: new Date(2),
      metadata: { streamGroupId: 'S', content: blocks.slice(2) },
    })
    const staleTool = {
      ...first,
      metadata: {
        ...first.metadata,
        content: [blocks[0], { ...tool, toolCall: { ...tool.toolCall, result: '' } }],
      },
    }
    const session = reason === 'ended' ? SESSION_ENDED : SESSION_LIVE
    for (const messages of [[first], [last], [staleTool, last]]) {
      expect(completedGroupIds(groupPersisted(messages), [group], session)).toEqual([])
      expect(combine(groupPersisted(messages), [group], [], session)[0]).toMatchObject({ kind: 'streaming', blocks })
    }
    expect(completedGroupIds(groupPersisted([last, first]), [group], session)).toEqual(['S'])
  }
)

test('a final saved text superset proves coverage after missed final deltas', () => {
  const group = streamGroup({
    streamGroupId: 'S',
    blocks: [textBlock('b', 'prefix')],
    done: true,
    doneMessageIds: ['m'],
  })
  const history = groupPersisted([
    msg({ id: 'm', role: 'assistant', metadata: { streamGroupId: 'S', content: [textBlock('b', 'prefix tail')] } }),
  ])
  expect(completedGroupIds(history, [group], SESSION_ENDED)).toEqual(['S'])
  expect(combine(history, [group], [], SESSION_ENDED)[0]).toMatchObject({
    kind: 'persisted',
    blocks: [textBlock('b', 'prefix tail')],
  })
})

test('durable completed tools cover explicitly unfinished tools, but never overwrite finalized tool content or uncovered tails', () => {
  const finalTool: ContentBlock = {
    type: 'tool_use',
    id: 't',
    toolCall: {
      toolCallId: 't',
      toolName: 'search',
      args: '{"query":"value"}',
      result: 'final result',
      isError: false,
    },
  }
  const unfinished = {
    ...finalTool,
    _done: false,
    toolCall: { ...finalTool.toolCall, args: '{"query":', result: 'progress' },
  }
  const group = streamGroup({ streamGroupId: 'S', blocks: [unfinished], doneMessageIds: ['m'], done: true })
  const history = groupPersisted([
    msg({
      id: 'm',
      role: 'assistant',
      metadata: { streamGroupId: 'S', content: [finalTool, textBlock('answer', 'final answer')] },
    }),
  ])
  expect(completedGroupIds(history, [group], SESSION_ENDED)).toEqual([])
  const authoritative: CombineSession = { ...SESSION_ENDED, authoritativeCompletedGroupIds: new Set(['S']) }
  expect(completedGroupIds(history, [group], authoritative)).toEqual(['S'])
  const finalized = { ...unfinished, _done: true }
  expect(completedGroupIds(history, [{ ...group, blocks: [finalized] }], authoritative)).toEqual([])
  expect(
    completedGroupIds(history, [{ ...group, blocks: [unfinished, textBlock('tail', 'uncovered tail')] }], authoritative)
  ).toEqual([])
  expect(completedGroupIds(history, [{ ...group, doneMessageIds: ['m', 'missing'] }], authoritative)).toEqual([])
  expect(
    completedGroupIds(
      history,
      [
        {
          ...group,
          blocks: [{ ...unfinished, toolCall: { ...unfinished.toolCall, args: 'different', toolCallId: 'other' } }],
        },
      ],
      SESSION_ENDED
    )
  ).toEqual([])
})

test.each(['result', 'error', 'legacy', 'id', 'name', 'args'] as const)(
  'tool coverage does not waive %s equality/identity beyond unfinished progress',
  (field) => {
    const saved: ContentBlock = {
      type: 'tool_use',
      id: 't',
      toolCall: { toolCallId: 't', toolName: 'search', args: '{"query":"value"}', result: 'final', isError: false },
    }
    const streamed = {
      ...saved,
      _done: field === 'legacy' ? undefined : field === 'result' || field === 'error',
      toolCall: { ...saved.toolCall },
    }
    if (field === 'result' || field === 'legacy') streamed.toolCall.result = 'observed final'
    if (field === 'error') streamed.toolCall.isError = true
    if (field === 'id') streamed.toolCall.toolCallId = 'other'
    if (field === 'name') streamed.toolCall.toolName = 'other'
    if (field === 'args') streamed.toolCall.args = '{"different":'
    const group = streamGroup({ streamGroupId: 'S', done: true, blocks: [streamed] })
    const history = groupPersisted([
      msg({ id: 'm', role: 'assistant', metadata: { streamGroupId: 'S', content: [saved] } }),
    ])
    expect(
      completedGroupIds(history, [group], { ...SESSION_ENDED, authoritativeCompletedGroupIds: new Set(['S']) })
    ).toEqual([])
  }
)
