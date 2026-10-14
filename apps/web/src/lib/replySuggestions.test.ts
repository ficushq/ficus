import { describe, expect, test } from 'bun:test'
import type { RenderItem } from '@ficus/client-core'
import type { Message, MessageMetadata } from '@ficus/shared'
import { latestReplySuggestions } from './replySuggestions'

const message = (id: string, role: Message['role'], metadata: MessageMetadata | null = null): Message => ({
  id,
  agentId: 'agent',
  role,
  content: `${role} ${id}`,
  metadata,
  pending: false,
  injectedAt: null,
  createdAt: new Date('2026-10-14T12:00:00Z'),
})
const persisted = (row: Message, mergedFrom?: Message[]): RenderItem => ({
  kind: 'persisted',
  id: row.id,
  message: row,
  mergedFrom,
  blocks: [],
})

describe('latestReplySuggestions', () => {
  test('the replies saved on the last agent message', () => {
    const items = [
      persisted(message('h1', 'human')),
      persisted(message('a1', 'assistant', { replySuggestions: ['Yes', 'Not now'] })),
    ]
    expect(latestReplySuggestions(items)).toEqual({ messageId: 'a1', replies: ['Yes', 'Not now'] })
  })

  test('reads the merged turn’s rows, newest first', () => {
    const first = message('a1', 'assistant')
    const last = message('a2', 'assistant', { replySuggestions: ['A', 'B'] })
    expect(latestReplySuggestions([persisted(first, [first, last])])).toEqual({ messageId: 'a2', replies: ['A', 'B'] })
  })

  test('nothing once anything follows the agent message', () => {
    const agent = persisted(message('a1', 'assistant', { replySuggestions: ['Yes', 'No'] }))
    expect(latestReplySuggestions([agent, persisted(message('h2', 'human'))])).toBeNull()
    expect(latestReplySuggestions([agent, { kind: 'pending', id: 'c1', content: 'Yes', status: 'sending' }])).toBeNull()
    expect(latestReplySuggestions([agent, { kind: 'working', id: '__working__' }])).toBeNull()
    expect(latestReplySuggestions([agent, { kind: 'system', id: 's1', text: 'Compacted' }])).toBeNull()
  })

  test('nothing for messages without suggestions or with unusable ones', () => {
    expect(latestReplySuggestions([])).toBeNull()
    expect(latestReplySuggestions([persisted(message('a1', 'assistant'))])).toBeNull()
    const junk = { replySuggestions: [42, '', 'x'.repeat(200)] } as unknown as MessageMetadata
    expect(latestReplySuggestions([persisted(message('a1', 'assistant', junk))])).toBeNull()
  })

  test('at most four distinct replies', () => {
    const metadata = { replySuggestions: ['1', '1', '2', '3', '4', '5'] }
    expect(latestReplySuggestions([persisted(message('a1', 'assistant', metadata))])?.replies).toEqual([
      '1',
      '2',
      '3',
      '4',
    ])
  })
})
