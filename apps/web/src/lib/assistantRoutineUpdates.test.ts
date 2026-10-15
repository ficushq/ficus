import { describe, expect, test } from 'bun:test'
import type { AssistantActivityUpdate } from '@ficus/shared'
import { routineUpdateSlots, timelineAnchors } from './assistantRoutineUpdates'

const at = (minute: number) => new Date(Date.UTC(2026, 9, 15, 9, minute)).toISOString()

const update = (
  messageId: string,
  sequence: number,
  minute: number,
  extra: Partial<AssistantActivityUpdate> = {}
): AssistantActivityUpdate => ({
  messageId,
  taskId: 'task-a',
  requestId: 'request-a',
  sequence,
  reportedStatus: 'working',
  content: messageId,
  subject: null,
  senderName: 'Riley',
  processedAt: at(minute),
  summarized: false,
  seenAt: null,
  createdAt: at(minute),
  ...extra,
})

const persisted = (id: string, role: string, minutes: number[], metadata: object = {}) =>
  ({
    kind: 'persisted',
    id,
    message: { id, role, createdAt: at(minutes[0]!), metadata },
    mergedFrom: minutes.length > 1 ? minutes.map((minute) => ({ id, createdAt: at(minute) })) : undefined,
    blocks: [],
  }) as never

describe('timelineAnchors', () => {
  test('keeps shown persisted rows, timed by their earliest merged row', () => {
    const anchors = timelineAnchors([
      persisted('human', 'human', [0]),
      persisted('inbox', 'human', [3], { source: 'inbox' }),
      persisted('reply', 'assistant', [7, 5]),
      { kind: 'streaming', id: 'live' } as never,
    ])
    expect(anchors).toEqual([
      { id: 'human', at: Date.parse(at(0)) },
      { id: 'reply', at: Date.parse(at(5)) },
    ])
  })
})

describe('routineUpdateSlots', () => {
  const anchors = [
    { id: 'request', at: Date.parse(at(0)) },
    { id: 'reply', at: Date.parse(at(10)) },
  ]

  test('places each routine update under the last row shown at or before it', () => {
    const slots = routineUpdateSlots(anchors, [update('early', 1, 2), update('late', 2, 12)])
    expect(slots.get('request')?.map((group) => group.updates.map((u) => u.messageId))).toEqual([['early']])
    expect(slots.get('reply')?.map((group) => group.updates.map((u) => u.messageId))).toEqual([['late']])
  })

  test('coalesces a task’s updates in one slot, oldest first, and keeps tasks apart', () => {
    const slots = routineUpdateSlots(anchors, [
      update('a2', 3, 4, { reportedStatus: 'waiting' }),
      update('b1', 2, 3, { taskId: 'task-b' }),
      update('a1', 1, 2),
    ])
    const groups = slots.get('request')!
    // Each task's chip sits where its latest update would: task-b (seq 2) before task-a (seq 3).
    expect(groups.map((group) => group.taskId)).toEqual(['task-b', 'task-a'])
    expect(groups[1]!.updates.map((u) => u.messageId)).toEqual(['a1', 'a2'])
  })

  test('leaves out summarized, untracked, status-less, and summary-worthy updates', () => {
    const slots = routineUpdateSlots(anchors, [
      update('summarized', 1, 2, { summarized: true }),
      update('untracked', 2, 2, { taskId: null }),
      update('status-less', 3, 2, { reportedStatus: null }),
      update('needs-input', 4, 2, { reportedStatus: 'needs-input' }),
      update('completed', 5, 2, { reportedStatus: 'completed' }),
    ])
    expect(slots.size).toBe(0)
  })

  test('drops updates older than every loaded row', () => {
    const slots = routineUpdateSlots([{ id: 'reply', at: Date.parse(at(10)) }], [update('older', 1, 2)])
    expect(slots.size).toBe(0)
  })
})
