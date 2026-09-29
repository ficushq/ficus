import { describe, expect, it } from 'bun:test'
import { consultantOrigin, inferredConsultantOrigin } from './consultant-origin'

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

describe('inferredConsultantOrigin', () => {
  const scope = { type: 'consultant', id: 's' }

  it('prefers the stamped origin', () => {
    expect(
      inferredConsultantOrigin({
        context: { scope, origin: 'user', thread: { id: 't' } },
        metadata: { name: 'Assistant task' },
      })
    ).toBe('user')
  })

  it('reads channel facts on an older consultant', () => {
    expect(inferredConsultantOrigin({ context: { scope, channelInstance: { id: 'slack-1' } } })).toBe('channel')
    expect(inferredConsultantOrigin({ context: { scope, thread: { id: '1790287735.049049' } } })).toBe('channel')
    expect(inferredConsultantOrigin({ context: { scope, directMessage: { id: 'dm' } } })).toBe('channel')
  })

  it('reads the Assistant task name on an older consultant', () => {
    expect(inferredConsultantOrigin({ context: { scope }, metadata: { name: 'Assistant task' } })).toBe('assistant')
  })

  it('is null when an older consultant carries nothing', () => {
    expect(inferredConsultantOrigin({ context: { scope }, metadata: { name: 'Ruby' } })).toBeNull()
    expect(inferredConsultantOrigin({})).toBeNull()
  })
})
