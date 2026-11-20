import { describe, expect, it } from 'bun:test'
import {
  ANSWER_NO_RECIPIENT_MESSAGE,
  AnswerNoRecipientError,
  answerDeliveryRefusal,
  FLOW_WAIT_STREAM_ENDED_MESSAGES,
  FLOW_WAIT_SUPERSEDED_MESSAGE,
  FlowWaitStreamEndedError,
  FlowWaitSupersededError,
} from './wait-scope'

/**
 * Refused answers store the error message, not a code, so answerDeliveryRefusal reads the refusal
 * kind back from the exact wording. These literals are copies on purpose: rewording a constant
 * must fail here, because rows stored with the old wording would otherwise fall back to the
 * generic failure, offer Retry again and lose their cause.
 */
const STORED_REFUSAL_MESSAGES = [
  ['The flow attempt was superseded. The response is retained in history without waking an agent.', 'attempt-replaced'],
  ['The work stream had already finished. The response is retained in history without waking an agent.', 'stream-done'],
  [
    'The work stream had already been canceled. The response is retained in history without waking an agent.',
    'stream-canceled',
  ],
  [
    'Nobody was left to receive the answer: the asking agent had stopped, and no live agent held the work. The response is retained in history.',
    'no-recipient',
  ],
] as const

describe('answerDeliveryRefusal', () => {
  it.each(STORED_REFUSAL_MESSAGES)('reads the stored message %p as %p', (message, refusal) => {
    expect(answerDeliveryRefusal(message)).toBe(refusal)
  })

  it('keeps the message constants and the errors that record them on the stored wording', () => {
    const [[superseded], [done], [canceled], [nobody]] = STORED_REFUSAL_MESSAGES
    expect(ANSWER_NO_RECIPIENT_MESSAGE).toBe(nobody)
    expect(new AnswerNoRecipientError().message).toBe(nobody)
    expect(FLOW_WAIT_SUPERSEDED_MESSAGE).toBe(superseded)
    expect(FLOW_WAIT_STREAM_ENDED_MESSAGES).toEqual({ done, canceled })
    expect(new FlowWaitSupersededError().message).toBe(superseded)
    expect(new FlowWaitStreamEndedError('done').message).toBe(done)
    expect(new FlowWaitStreamEndedError('canceled').message).toBe(canceled)
  })

  it('treats any other recorded error as a generic failure', () => {
    expect(answerDeliveryRefusal(null)).toBeNull()
    expect(answerDeliveryRefusal(undefined)).toBeNull()
    expect(answerDeliveryRefusal('')).toBeNull()
    expect(answerDeliveryRefusal('Sandbox unavailable')).toBeNull()
  })
})
