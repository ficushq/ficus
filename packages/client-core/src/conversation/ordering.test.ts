import { describe, expect, test } from 'bun:test'
import type { Message } from '@ficus/shared'
import { compareByKey, messageSortAt } from './ordering'

function human(id: string, createdAt: string, consumedAt?: string): Message {
  return {
    id,
    agentId: 'a',
    role: 'human',
    content: 'x',
    metadata: consumedAt ? { consumedAt } : null,
    pending: false,
    createdAt: new Date(createdAt),
  }
}

describe('messageSortAt', () => {
  test('human row sorts by consumedAt when present', () => {
    const m = human('m1', '2026-06-25T00:00:00.000Z', '2026-06-25T01:00:00.000Z')
    expect(messageSortAt(m)).toBe(new Date('2026-06-25T01:00:00.000Z').getTime())
  })

  test('human row falls back to createdAt without consumedAt', () => {
    const m = human('m1', '2026-06-25T00:00:00.000Z')
    expect(messageSortAt(m)).toBe(new Date('2026-06-25T00:00:00.000Z').getTime())
  })

  test('non-human row always sorts by createdAt even if consumedAt present', () => {
    const m: Message = { ...human('m1', '2026-06-25T00:00:00.000Z', '2026-06-25T02:00:00.000Z'), role: 'assistant' }
    expect(messageSortAt(m)).toBe(new Date('2026-06-25T00:00:00.000Z').getTime())
  })
})

describe('compareByKey', () => {
  test('orders ascending by sort key', () => {
    expect(compareByKey(1, 'b', 2, 'a')).toBeLessThan(0)
  })

  test('ties break by id ascending (deterministic under jitter)', () => {
    expect(compareByKey(5, 'b', 5, 'a')).toBeGreaterThan(0)
    expect(compareByKey(5, 'a', 5, 'b')).toBeLessThan(0)
    expect(compareByKey(5, 'a', 5, 'a')).toBe(0)
  })
})
