import { describe, expect, it } from 'bun:test'
import { letterForEvent, onLetter, sendLetter, type Letter } from './letters'

const event = (name: string, data: unknown) => ({ type: 'event' as const, topic: 'inbox', event: name, data })

describe('letters', () => {
  it('come from mail to a robot (from its sender, or the mailbox) and answers to its questions', () => {
    expect(
      letterForEvent(
        event('inbox.messageReceived', { recipientType: 'agent', recipientId: 'b', senderAgentId: 'a', messageId: 'm' })
      )
    ).toEqual({ from: { kind: 'agent', agentId: 'a' }, toAgentId: 'b' })
    expect(
      letterForEvent(event('inbox.messageReceived', { recipientType: 'agent', recipientId: 'b', senderAgentId: null }))
    ).toEqual({ from: { kind: 'mailbox' }, toAgentId: 'b' })
    expect(letterForEvent(event('agent-question.answered', { questionId: 'q', agentId: 'b' }))).toEqual({
      from: { kind: 'mailbox' },
      toAgentId: 'b',
    })
  })

  it('never come from mail to people, or other events', () => {
    expect(letterForEvent(event('inbox.messageReceived', { recipientType: 'user', recipientId: 'u' }))).toBeNull()
    expect(letterForEvent(event('agent.updated', { agentId: 'b' }))).toBeNull()
  })

  it('reach whoever is listening', () => {
    const got: Letter[] = []
    const stop = onLetter((letter) => got.push(letter))
    sendLetter({ from: { kind: 'me' }, toAgentId: 'b' })
    stop()
    sendLetter({ from: { kind: 'me' }, toAgentId: 'c' })
    expect(got).toEqual([{ from: { kind: 'me' }, toAgentId: 'b' }])
  })
})
