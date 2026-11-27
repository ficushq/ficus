import {
  typeFirstAgentLabel,
  workStreamWaitActor,
  type AgentErrorActionData,
  type AgentQuestionActionData,
  type PendingAction,
  type SquadQuestionActionData,
  type WorkStreamActionData,
  type WorkStreamDeliveryActionData,
} from '@ficus/shared'
import { workStreamActionPresentationState } from './workStreamStatusPresentation'
import { noAgentTypeNames, type AgentTypeName } from './agentDisplay'

/**
 * One phrase for each kind of wait, used by every list that shows a Needs-you item (the Feed and
 * Action Center cards, the Assistant list). A routine review or approval is never "blocked": that
 * word is kept for a manual hold a person must clear.
 */
export const WAIT_PHRASES = {
  answer: 'needs your answer',
  review: 'review needed',
  approveDelivery: 'approve delivery',
  decision: 'decision needed',
  attemptLimit: 'attempt limit reached',
  manualHold: 'blocked on your input',
  waitingOnOwner: 'waiting on owner',
  waitingOnManager: 'waiting on manager',
  reviewPullRequest: 'review pull request',
  mergePullRequest: 'merge pull request',
  agentHalted: 'agent halted',
  answerNotDelivered: 'answer not delivered',
  answerUnconfirmed: 'answer delivery unconfirmed',
} as const

/** The wait an action stands for, in the shared vocabulary. */
export function pendingActionWaitPhrase(action: PendingAction): string {
  switch (action.type) {
    case 'agent-question': {
      const delivery = (action.data as AgentQuestionActionData).answerDelivery
      if (delivery?.status !== 'failed') return WAIT_PHRASES.answer
      return delivery.refusal ? WAIT_PHRASES.answerNotDelivered : WAIT_PHRASES.answerUnconfirmed
    }
    case 'squad-question':
    case 'assistant-needs-input':
      return WAIT_PHRASES.answer
    case 'agent-error':
      return WAIT_PHRASES.agentHalted
    case 'workstream-review':
      return WAIT_PHRASES.review
    case 'workstream-blocked': {
      const data = action.data as WorkStreamActionData
      if (workStreamActionPresentationState(action) === 'in_review') return WAIT_PHRASES.review
      if (data.deliveryApproval) return WAIT_PHRASES.approveDelivery
      if (data.attemptLimit) return WAIT_PHRASES.attemptLimit
      if (data.wait.resolutionHandler === 'workflow') return WAIT_PHRASES.decision
      const actor = workStreamWaitActor(data.wait)
      return actor === 'owner'
        ? WAIT_PHRASES.waitingOnOwner
        : actor === 'manager'
          ? WAIT_PHRASES.waitingOnManager
          : WAIT_PHRASES.manualHold
    }
    case 'workstream-delivery':
      return (action.data as WorkStreamDeliveryActionData).deliveryKind === 'merge'
        ? WAIT_PHRASES.mergePullRequest
        : WAIT_PHRASES.reviewPullRequest
    default:
      return 'needs you'
  }
}

/**
 * The agent an action is about, type first: "Engineer (#12)" for a question asked from a work
 * stream, else "Engineer". Action data carries agent identity only (seeing an action does not grant
 * reading the agent), so a purpose is never added here. The assignee of a work stream wait is named
 * by its type alone, since the stream is already the row.
 * Null when the action names no agent. Older servers send no type for an assignee; the card then
 * names no agent rather than showing its name alone.
 */
export function pendingActionAgentLabel(
  action: PendingAction,
  /** The configured agent type names (`useAgentTypeNames`); without them the type id is title-cased. */
  typeNames: AgentTypeName = noAgentTypeNames
): string | null {
  const typeName = (agentTypeId: string | null | undefined) => (agentTypeId ? typeNames(agentTypeId) : undefined)
  switch (action.type) {
    case 'agent-question': {
      const data = action.data as AgentQuestionActionData
      return typeFirstAgentLabel({
        agentTypeId: data.agentTypeId,
        typeName: typeName(data.agentTypeId),
        workingOn: data.workStream ? `#${data.workStream.number}` : undefined,
      })
    }
    case 'squad-question':
    case 'agent-error': {
      const data = action.data as SquadQuestionActionData | AgentErrorActionData
      return typeFirstAgentLabel({ agentTypeId: data.agentTypeId, typeName: typeName(data.agentTypeId) })
    }
    case 'workstream-review':
    case 'workstream-blocked': {
      const data = action.data as WorkStreamActionData
      return data.assigneeAgentTypeId
        ? typeFirstAgentLabel({ agentTypeId: data.assigneeAgentTypeId, typeName: typeName(data.assigneeAgentTypeId) })
        : null
    }
    default:
      return null
  }
}

/** The squad an action belongs to, when the action names one. */
function actionSquadName(action: PendingAction): string | null {
  const data = action.data as { squadName?: string | null }
  return data.squadName || action.squadName || null
}

/**
 * The one line of context under a Needs-you item's title, the same in every list:
 * "Squad · Agent · wait" for a work stream (the stream is the title), "Squad · wait" for an item
 * whose title already names the agent or the question.
 */
export function pendingActionContextLine(action: PendingAction, typeNames: AgentTypeName = noAgentTypeNames): string {
  const parts: string[] = []
  if (action.type === 'assistant-needs-input') parts.push('Assistant task')
  const squad = actionSquadName(action)
  if (squad) parts.push(squad)
  if (action.type === 'workstream-review' || action.type === 'workstream-blocked') {
    const agent = pendingActionAgentLabel(action, typeNames)
    if (agent) parts.push(agent)
  }
  parts.push(pendingActionWaitPhrase(action))
  const line = parts.join(' · ')
  return line[0]!.toUpperCase() + line.slice(1)
}
