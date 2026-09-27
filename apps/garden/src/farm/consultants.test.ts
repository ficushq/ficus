import { describe, expect, it } from 'bun:test'
import { isUserStartedConsultant } from './consultants'
import { makeAgent } from './testFixtures'

const consultant = (context: Record<string, unknown>) =>
  makeAgent({ agentTypeId: 'consultant', squadId: 'sq', context })

describe('isUserStartedConsultant', () => {
  it('keeps consultants a person started', () => {
    expect(isUserStartedConsultant(consultant({ scope: { type: 'consultant', id: 'sq' }, origin: 'user' }))).toBe(true)
  })

  it('drops channel, integration and Assistant-task consultants', () => {
    for (const origin of ['channel', 'integration', 'assistant'])
      expect(isUserStartedConsultant(consultant({ scope: { type: 'consultant' }, origin }))).toBe(false)
  })

  it('treats consultants from before origins were stamped as user-started', () => {
    expect(isUserStartedConsultant(consultant({ scope: { type: 'consultant', id: 'sq' } }))).toBe(true)
  })

  it('ignores other agent types', () => {
    expect(isUserStartedConsultant(makeAgent({ agentTypeId: 'coder' }))).toBe(false)
  })
})
