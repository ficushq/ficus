import { describe, expect, test } from 'bun:test'
import type { MessageMetadata } from '@ficus/shared'
import { withVisibleReplySuggestions } from './visibility'

const message = (id: string, metadata: MessageMetadata | null) => ({ id, metadata })

describe('withVisibleReplySuggestions', () => {
  test('keeps saved replies while the switch is on', () => {
    const messages = [message('m1', { replySuggestions: ['Yes', 'No'] })]
    expect(withVisibleReplySuggestions(messages, true)).toBe(messages)
  })

  test('leaves saved replies out while the switch is off, keeping the rest of the metadata', () => {
    const saved = message('m1', { executionId: 'e1', replySuggestions: ['Yes', 'No'] })
    const plain = message('m2', { executionId: 'e2' })
    const empty = message('m3', null)
    const visible = withVisibleReplySuggestions([saved, plain, empty], false)
    expect(visible).toEqual([message('m1', { executionId: 'e1' }), plain, empty])
    expect(visible[1]).toBe(plain)
    expect(visible[2]).toBe(empty)
    // The source rows are untouched: turning the switch back on shows the replies again.
    expect(saved.metadata?.replySuggestions).toEqual(['Yes', 'No'])
  })
})
