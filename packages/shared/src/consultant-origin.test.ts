import { describe, expect, it } from 'bun:test'
import { consultantOrigin } from './consultant-origin'

describe('consultantOrigin', () => {
  it('reads a stamped origin', () => {
    expect(consultantOrigin({ scope: { type: 'consultant', id: 's' }, origin: 'user' })).toBe('user')
    expect(consultantOrigin({ origin: 'channel' })).toBe('channel')
  })

  it('is null for unstamped, unknown or missing contexts', () => {
    expect(consultantOrigin({ scope: { type: 'consultant' } })).toBeNull()
    expect(consultantOrigin({ origin: 'martian' })).toBeNull()
    expect(consultantOrigin(null)).toBeNull()
  })
})
