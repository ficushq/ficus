import { describe, expect, test } from 'bun:test'
import type { InboxMessageResponse } from '../api/inbox'
import { mergeInboxSources } from './useInboxFeed'

const at = (id: string, minute: number) =>
  ({ id, createdAt: new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString() }) as InboxMessageResponse
const ids = (messages: InboxMessageResponse[]) => messages.map((message) => message.id)

describe('mergeInboxSources', () => {
  test('interleaves exhausted sources newest first', () => {
    const { messages, pending } = mergeInboxSources([
      { items: [at('mine-3', 30), at('mine-1', 10)], hasMore: false },
      { items: [at('system-2', 20)], hasMore: false },
    ])
    expect(ids(messages)).toEqual(['mine-3', 'system-2', 'mine-1'])
    expect(pending).toEqual([false, false])
  })

  test('holds back messages older than a source that still has unseen newer pages', () => {
    // The personal inbox has only loaded down to minute 40; the system inbox's minute-10 message
    // could still be preceded by unseen personal messages from minutes 11-39.
    const { messages, pending } = mergeInboxSources([
      { items: [at('mine-50', 50), at('mine-40', 40)], hasMore: true },
      { items: [at('system-45', 45), at('system-10', 10)], hasMore: false },
    ])
    expect(ids(messages)).toEqual(['mine-50', 'system-45', 'mine-40'])
    expect(pending).toEqual([true, false])
  })

  test('only the source bounding the visible list needs its next page', () => {
    const { messages, pending } = mergeInboxSources([
      { items: [at('mine-50', 50), at('mine-20', 20)], hasMore: true },
      { items: [at('system-45', 45), at('system-30', 30)], hasMore: true },
    ])
    expect(ids(messages)).toEqual(['mine-50', 'system-45', 'system-30'])
    expect(pending).toEqual([false, true])
  })

  test('handles empty and single sources', () => {
    expect(mergeInboxSources([]).messages).toEqual([])
    expect(mergeInboxSources([{ items: [], hasMore: false }]).messages).toEqual([])
    expect(ids(mergeInboxSources([{ items: [at('a', 2), at('b', 1)], hasMore: true }]).messages)).toEqual(['a', 'b'])
  })
})
