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

  it('drops older, unstamped consultants a channel thread or the Assistant made', () => {
    const slackThread = consultant({
      scope: { type: 'consultant' },
      thread: { id: '1790287735.049049', channelId: 'C0C3L3QDSJK' },
      channelInstance: { id: 'slack-t0c454vr9rs', provider: 'slack' },
    })
    expect(isUserStartedConsultant(slackThread)).toBe(false)
    const assistantTask = makeAgent({
      agentTypeId: 'consultant',
      squadId: 'sq',
      context: { scope: { type: 'consultant', id: 'sq' } },
      metadata: { name: 'Assistant task', purpose: 'Fix inline PR regression' },
    })
    expect(isUserStartedConsultant(assistantTask)).toBe(false)
  })

  it('ignores other agent types', () => {
    expect(isUserStartedConsultant(makeAgent({ agentTypeId: 'coder' }))).toBe(false)
  })
})
