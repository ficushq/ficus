import type {
  AgentErrorActionData,
  AgentQuestionActionData,
  AssistantTaskActionData,
  PendingAction,
  SquadQuestionActionData,
  WorkStreamActionData,
  WorkStreamWait,
} from '@ficus/shared'

/** A pending action with its `data` narrowed by `type`; `unknown` covers types newer than this build. */
export type TypedAction =
  | { type: 'squad-question'; action: PendingAction; data: SquadQuestionActionData }
  | { type: 'agent-question'; action: PendingAction; data: AgentQuestionActionData }
  | { type: 'agent-error'; action: PendingAction; data: AgentErrorActionData }
  | { type: 'workstream-review'; action: PendingAction; data: WorkStreamActionData }
  | { type: 'workstream-blocked'; action: PendingAction; data: WorkStreamActionData }
  | { type: 'assistant-needs-input'; action: PendingAction; data: AssistantTaskActionData }
  | { type: 'unknown'; action: PendingAction }

export function typedAction(action: PendingAction): TypedAction {
  switch (action.type) {
    case 'squad-question':
      return { type: action.type, action, data: action.data as SquadQuestionActionData }
    case 'agent-question':
      return { type: action.type, action, data: action.data as AgentQuestionActionData }
    case 'agent-error':
      return { type: action.type, action, data: action.data as AgentErrorActionData }
    case 'workstream-review':
    case 'workstream-blocked':
      return { type: action.type, action, data: action.data as WorkStreamActionData }
    case 'assistant-needs-input':
      return { type: action.type, action, data: action.data as AssistantTaskActionData }
    default:
      return { type: 'unknown', action }
  }
}

/**
 * Actions that belong on a work stream's plot: its review / blocked waits
 * (`WorkStreamActionData.workStreamId`), plus, when the stream's open waits are
 * given, the agent questions its `question` waits point at (the wait's
 * `referenceId` is the agent question id).
 */
export function actionsForStream(
  actions: PendingAction[],
  workStreamId: string,
  stream?: { openWaits?: WorkStreamWait[] }
): PendingAction[] {
  const questionIds = new Set(
    (stream?.openWaits ?? [])
      .filter((wait) => wait.type === 'question' && wait.referenceId)
      .map((wait) => wait.referenceId as string)
  )
  return actions.filter((action) => {
    const typed = typedAction(action)
    switch (typed.type) {
      case 'workstream-review':
      case 'workstream-blocked':
        return typed.data.workStreamId === workStreamId
      case 'agent-question':
        return questionIds.has(typed.data.questionId)
      default:
        return false
    }
  })
}

/**
 * Actions that belong on a robot: its questions and halts (`agentId` on the
 * question / error / assistant-task data). Unless `direct` is set, also the
 * review / blocked waits it is assigned to or opened
 * (`assigneeAgentId`, `wait.createdByAgentId`), which also appear on the plot.
 */
export function actionsForAgent(
  actions: PendingAction[],
  agentId: string,
  { direct = false }: { direct?: boolean } = {}
): PendingAction[] {
  return actions.filter((action) => {
    const typed = typedAction(action)
    switch (typed.type) {
      case 'squad-question':
      case 'agent-question':
      case 'agent-error':
      case 'assistant-needs-input':
        return typed.data.agentId === agentId
      case 'workstream-review':
      case 'workstream-blocked':
        return !direct && (typed.data.assigneeAgentId === agentId || typed.data.wait.createdByAgentId === agentId)
      default:
        return false
    }
  })
}
