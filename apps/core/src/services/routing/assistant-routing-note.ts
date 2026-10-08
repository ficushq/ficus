import {
  ASSISTANT_ROUTING_MIN_CONFIDENCE,
  type AssistantRoutingCorrection,
  type AssistantRoutingHint,
  type AssistantRoutingTarget,
} from '@ficus/shared'

const percent = (confidence: number) => `${Math.round(confidence * 100)}%`
const squadRef = (target: AssistantRoutingTarget) =>
  `squad ${JSON.stringify(target.squadName ?? 'unknown')} (squadId ${target.squadId})`

/**
 * The note the Assistant reads with a user message: the user's own correction, else the decision
 * model's pick when it is confident enough. Null when there is nothing to say.
 */
export function assistantRoutingNote(hint: AssistantRoutingHint): string | null {
  if (hint.correction) {
    return hint.correction.scope === 'squad' && hint.correction.squadId
      ? `Routing (set by the user): this is for ${squadRef(hint.correction)}. Use this squad for delegate_task.`
      : 'Routing (set by the user): this is not for a squad. Use no squad for delegate_task.'
  }
  if (!(hint.confidence >= ASSISTANT_ROUTING_MIN_CONFIDENCE)) return null
  const howSure = percent(hint.confidence)
  switch (hint.scope) {
    case 'squad':
      if (!hint.squadId) return null
      return `Routing hint (decision model): likely squad ${JSON.stringify(hint.squadName ?? 'unknown')} (${howSure}): a feature or bug in its project (squadId ${hint.squadId}). Use this squad for delegate_task unless the request says otherwise.`
    case 'instance':
      return `Routing hint (decision model): about Ficus itself (settings, admin or the instance), not a squad's project (${howSure}). Use no squad for delegate_task unless the request says otherwise.`
    case 'general':
      return `Routing hint (decision model): general work, not tied to one squad's project (${howSure}). Use no squad for delegate_task unless the request says otherwise.`
    default:
      return null
  }
}

/** The note on the message that carries a user's routing correction. */
export function assistantRoutingCorrectionNote(correction: AssistantRoutingCorrection): string {
  const target =
    correction.scope === 'squad' && correction.squadId ? `is for ${squadRef(correction)}` : 'is not for a squad'
  return (
    `Routing correction from the user: their message ${correction.messageId} ${target}. ` +
    `Use ${correction.scope === 'squad' ? 'this squad' : 'no squad'} for delegate_task for it. If that work already went ` +
    'to a different delegate and is still running, move it (cancel_task, then delegate_task) and say where it went.'
  )
}
