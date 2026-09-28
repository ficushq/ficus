import { describe, expect, it } from 'bun:test'
import { deliveryNote } from './delivery'

describe('deliveryNote', () => {
  it('says nothing without facts', () => {
    expect(deliveryNote(undefined)).toBeNull()
    expect(deliveryNote({})).toBeNull()
  })

  it('reports merged pull requests first', () => {
    expect(deliveryNote({ pullRequests: [{ number: 1, state: 'merged' }], gates: { checksState: 'pending' } })).toBe(
      'PR merged — finalizing delivery'
    )
  })

  it('walks the gates in the web app order', () => {
    expect(deliveryNote({ gates: { checksState: 'pending' } })).toBe('Awaiting CI')
    expect(deliveryNote({ gates: { reviewDecision: 'required' } })).toBe('Awaiting review')
    expect(deliveryNote({ gates: { mergeState: 'blocked' } })).toBe('Blocked by branch protection')
    expect(deliveryNote({ gates: { draft: true, checksState: 'pending' } })).toBeNull()
  })

  it('lists open pull requests, bounded', () => {
    const pullRequests = [1, 2, 3, 4, 5].map((number) => ({ number, state: 'open' as const }))
    expect(deliveryNote({ pullRequests })).toBe('Awaiting merge of #1, #2, #3 +2 more')
  })
})
