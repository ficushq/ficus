import type { AgentQuestionAnswerForward } from '@ficus/shared'

/** Why an answer went to someone other than the asking step, and who received it. */
export function forwardedAnswerText(forward: AgentQuestionAnswerForward): string {
  const cause =
    forward.reason === 'attempt-finished'
      ? 'The agent had already finished that step'
      : 'The step the agent asked from had been replaced'
  const others = forward.recipients.filter((recipient) => recipient.role !== 'asker')
  if (!others.length) return `${cause}; the answer was sent to the agent as a message.`
  const names = others.map((recipient) =>
    recipient.role === 'owner'
      ? `${recipient.label} (work stream owner)`
      : recipient.role === 'manager'
        ? `${recipient.label} (squad manager)`
        : recipient.label
  )
  return `${cause}; the answer was passed to ${names.join(', ')}.`
}
