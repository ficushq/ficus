/** Test fixtures for pending actions, waits, streams and workflow runs. Test-only. */
import type { WorkflowRunDetail } from '@ficus/client-core'
import type {
  AgentErrorActionData,
  AgentQuestionActionData,
  AssistantTaskActionData,
  PendingAction,
  PendingActionType,
  QuestionData,
  SquadQuestionActionData,
  WorkStream,
  WorkStreamActionData,
  WorkStreamWait,
} from '@ficus/shared'

export const oneTextQuestion: QuestionData = {
  questions: [{ id: 'color', type: 'text', question: 'Which color?' }],
}

export function wait(overrides: Partial<WorkStreamWait> = {}): WorkStreamWait {
  return {
    id: 'wait-1',
    workStreamId: 'ws-1',
    type: 'review',
    referenceId: null,
    message: 'Please review the tomatoes',
    createdBy: 'agent',
    createdByAgentId: 'agent-1',
    createdByUserId: null,
    completesOnApproval: true,
    openedAt: '2026-09-27T10:00:00.000Z',
    closedAt: null,
    resolution: null,
    resolutionNote: null,
    ...overrides,
  }
}

function action(type: PendingActionType, id: string, data: PendingAction['data'], extra: Partial<PendingAction> = {}) {
  return {
    id,
    type,
    priority: 1,
    createdAt: '2026-09-27T10:00:00.000Z',
    canRespond: true,
    squadId: 'squad-1',
    squadName: 'Veg Squad',
    data,
    ...extra,
  } satisfies PendingAction
}

export function squadQuestionAction(extra: Partial<PendingAction> = {}): PendingAction {
  const data: SquadQuestionActionData = {
    agentId: 'agent-1',
    agentName: 'Sprout',
    agentTypeId: 'planter',
    squadId: 'squad-1',
    squadName: 'Veg Squad',
    questionData: oneTextQuestion,
  }
  return action('squad-question', 'squad-question:agent-1', data, extra)
}

export function agentQuestionAction(
  extra: Partial<PendingAction> = {},
  dataExtra: Partial<AgentQuestionActionData> = {}
): PendingAction {
  const data: AgentQuestionActionData = {
    questionId: 'q-1',
    agentId: 'agent-2',
    agentName: 'Bean',
    agentTypeId: 'planter',
    squadId: 'squad-1',
    squadName: 'Veg Squad',
    ownerUserId: null,
    questionData: oneTextQuestion,
    ...dataExtra,
  }
  return action('agent-question', `agent-question:${data.questionId}`, data, extra)
}

export function agentErrorAction(agentId = 'agent-3', extra: Partial<PendingAction> = {}): PendingAction {
  const data: AgentErrorActionData = {
    agentId,
    agentName: `Robot ${agentId}`,
    agentTypeId: 'planter',
    squadId: 'squad-1',
    squadName: 'Veg Squad',
    ownerUserId: null,
    reason: 'Rate limited by the provider',
  }
  return action('agent-error', `agent-error:${agentId}`, data, { priority: 0, ...extra })
}

export function streamAction(
  kind: 'review' | 'blocked',
  waitOverrides: Partial<WorkStreamWait> = {},
  dataExtra: Partial<WorkStreamActionData> = {},
  extra: Partial<PendingAction> = {}
): PendingAction {
  const w = wait({ type: kind === 'review' ? 'review' : 'manual', ...waitOverrides })
  const data: WorkStreamActionData = {
    workStreamId: w.workStreamId,
    workStreamTitle: 'Grow tomatoes',
    squadId: 'squad-1',
    squadName: 'Veg Squad',
    waitId: w.id,
    wait: w,
    focus: { kind: 'workstream-wait', workStreamId: w.workStreamId, waitId: w.id },
    assigneeAgentId: 'agent-1',
    assigneeName: 'Sprout',
    completionMode: 'pr-merge',
    prompt: { type: 'text', message: w.message ?? '' },
    ...dataExtra,
  }
  return action(
    kind === 'review' ? 'workstream-review' : 'workstream-blocked',
    `workstream-${kind}:${w.workStreamId}:${w.id}`,
    data,
    { priority: kind === 'review' ? 2 : 3, ...extra }
  )
}

export function assistantAction(extra: Partial<PendingAction> = {}): PendingAction {
  const data: AssistantTaskActionData = {
    conversationId: 'conv-1',
    conversationTitle: 'Plan the harvest festival',
    taskId: 'task-1',
    taskLabel: 'Book the barn',
    ownerUserId: 'user-1',
    agentId: 'agent-9',
    squadId: null,
    squadName: null,
    question: 'Saturday or Sunday?',
    updateMessageId: null,
    updateCreatedAt: '2026-09-27T09:00:00.000Z',
  }
  return action('assistant-needs-input', 'assistant-needs-input:task-1', data, extra)
}

export function stream(overrides: Partial<WorkStream> = {}): WorkStream {
  return {
    id: 'ws-1',
    squadId: 'squad-1',
    title: 'Grow tomatoes',
    status: 'active',
    pause: null,
    openWaits: [],
    handoffMessage: null,
    files: [],
    metadata: {},
    completionMode: 'pr-merge',
    ...overrides,
  } as WorkStream
}

/** A workflow run stub with just what the decision UI reads. */
export function workflowRun(
  kind: 'gate' | 'delivery',
  overrides: { version?: number; openWaits?: WorkStreamWait[] } = {}
): WorkflowRunDetail {
  const steps = [
    { id: 'build', kind: 'agent', name: 'Build', participant: 'dev', instructions: 'Build it', outcomes: {} },
    {
      id: 'approve',
      kind: 'human-approval',
      name: 'Taste test',
      approver: 'reviewers',
      instructions: 'Taste the tomatoes',
      outcomes: { approved: { next: 'finish' }, 'needs-salt': { returnTo: 'build', resumeAt: 'approve' } },
    },
  ]
  const attempts =
    kind === 'gate'
      ? [
          { id: 1, stepId: 'build', status: 'completed', outcome: 'done', evidence: 'Planted and watered' },
          { id: 2, stepId: 'approve', status: 'running', sourceAttemptIds: [1] },
        ]
      : [{ id: 1, stepId: 'build', status: 'completed', outcome: 'done', evidence: 'All grown' }]
  return {
    workStreamId: 'ws-1',
    source: null,
    version: overrides.version ?? 7,
    attemptAgents: { 1: 'agent-1' },
    openWaits: overrides.openWaits,
    state: {
      schemaVersion: 1,
      version: overrides.version ?? 7,
      status: kind === 'gate' ? 'running' : 'completion-ready',
      activeAttemptId: kind === 'gate' ? 2 : null,
      attempts,
      returns: [],
      definition: { steps, completion: { mode: 'review-approval' } },
    },
  } as unknown as WorkflowRunDetail
}
