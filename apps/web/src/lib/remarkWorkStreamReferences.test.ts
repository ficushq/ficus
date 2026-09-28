import { expect, test } from 'bun:test'
import { remarkWorkStreamReferences } from './remarkWorkStreamReferences'

test('links numeric work references in prose without changing code, links or issue references', () => {
  const text = (value: string) => ({ type: 'text', value })
  const tree = {
    type: 'root',
    children: [
      { type: 'paragraph', children: [text('Check #42, then #57. PR #8 and issue #9 stay plain.')] },
      { type: 'link', url: 'https://example.com', children: [{ type: 'emphasis', children: [text('#42')] }] },
      { type: 'inlineCode', value: '#42' },
      { type: 'code', value: '#42' },
    ],
  }
  remarkWorkStreamReferences()(tree)
  const result = JSON.stringify(tree)
  expect(result.match(/ficus:ws:/g)).toHaveLength(2)
  expect(result).toContain('ficus:ws:42')
  expect(result).toContain('ficus:ws:57')
  expect(result).toContain('PR #8 and issue #9 stay plain.')
})

test('does not link invalid, out-of-range or embedded numbers', () => {
  const tree = { type: 'root', children: [{ type: 'text', value: '#0 #2147483648 word#42 ##42 /#42 #42abc' }] }
  remarkWorkStreamReferences()(tree)
  expect(JSON.stringify(tree)).not.toContain('ficus:ws:')
})
