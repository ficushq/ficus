import { expect, test } from 'bun:test'
import { envelopeAttachmentsWithinLimit, cardStructureWithinLimit } from './request-limits'
test('envelope attachment count is checked without parsing individual invalid refs', () => {
  expect(envelopeAttachmentsWithinLimit(JSON.stringify({ attachments: Array(100).fill(null) }))).toBe(true)
  expect(envelopeAttachmentsWithinLimit(JSON.stringify({ attachments: Array(101).fill(null) }))).toBe(false)
  expect(envelopeAttachmentsWithinLimit('{')).toBe(true) // engine keeps the protocol malformed-JSON response
})
test('card preflight enforces depth, nodes, list and map cardinality iteratively', () => {
  expect(cardStructureWithinLimit({ extensions: { ok: [1, 2, 3] } })).toBe(true)
  expect(cardStructureWithinLimit(Array(1001).fill(null))).toBe(false)
  expect(cardStructureWithinLimit(Object.fromEntries(Array.from({ length: 257 }, (_, i) => [String(i), null])))).toBe(
    false
  )
  let deep: unknown = 0
  for (let i = 0; i < 33; i++) deep = { child: deep }
  expect(cardStructureWithinLimit(deep)).toBe(false)
  expect(cardStructureWithinLimit(Array.from({ length: 11 }, () => Array(1000).fill(null)))).toBe(false)
})
