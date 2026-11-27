import type { WorkflowRun } from './workflow-runtime'
import { effectiveWorkflowStep } from './workflow-runtime'

/**
 * Who decides a workflow gate. `assigned-reviewers`: one of the work stream's assigned reviewers
 * when it names any, else anyone with review permission. `reviewers`: anyone with review permission
 * (every decision step waiting on a person reads this way too).
 */
export type WorkflowGateApprover = 'assigned-reviewers' | 'reviewers'

/** The part of a gate step the rule reads: its kind and, for a human approval, its approver. */
export interface WorkflowGateFacts {
  kind: string
  approver?: string
}

/**
 * The people a gate is limited to: the stream's assigned reviewers when the gate is a human
 * approval for assigned reviewers and the stream names some; null when anyone with review
 * permission decides.
 */
export function workflowGateAssignedDeciders(
  assignedReviewerIds: readonly string[] | null | undefined,
  gate: WorkflowGateFacts
): readonly string[] | null {
  const assigned = assignedReviewerIds ?? []
  return gate.kind === 'human-approval' && gate.approver === 'assigned-reviewers' && assigned.length > 0
    ? assigned
    : null
}

/**
 * Whether a person may decide a workflow gate (a human approval, or a decision step waiting on a
 * person). The one rule Core enforces and every client shows: a user with review permission in the
 * squad, and for a gate limited to the stream's assigned reviewers, one of them. Agents never decide.
 */
export function mayDecideWorkflowGate(
  person: { type: string; userId?: string } | null | undefined,
  canReview: boolean,
  assignedReviewerIds: readonly string[] | null | undefined,
  gate: WorkflowGateFacts
): boolean {
  if (person?.type !== 'user' || !person.userId || !canReview) return false
  const limitedTo = workflowGateAssignedDeciders(assignedReviewerIds, gate)
  return !limitedTo || limitedTo.includes(person.userId)
}

/** Who decides this gate step; undefined for a step no person decides. */
export function workflowGateApprover(step: WorkflowGateFacts): WorkflowGateApprover | undefined {
  if (step.kind === 'decision') return 'reviewers'
  if (step.kind !== 'human-approval') return undefined
  return step.approver === 'assigned-reviewers' ? 'assigned-reviewers' : 'reviewers'
}

/** Who decides the gate an attempt holds open; undefined when the attempt or its step is unknown. */
export function workflowGateApproverForAttempt(
  state: WorkflowRun,
  attemptId: number
): WorkflowGateApprover | undefined {
  const attempt = state.attempts.find((entry) => entry.id === attemptId)
  if (!attempt) return undefined
  try {
    return workflowGateApprover(effectiveWorkflowStep(state, attempt))
  } catch {
    return undefined
  }
}

/**
 * The gate a workflow gate wait stands for, from the approver Core puts on the wait. Older servers
 * omit it; the gate then reads as limited to assigned reviewers, so a viewer outside them is never
 * told a wait is theirs when it may not be.
 */
export function workflowGateOfWait(wait: { workflowGateApprover?: WorkflowGateApprover }): WorkflowGateFacts {
  return { kind: 'human-approval', approver: wait.workflowGateApprover ?? 'assigned-reviewers' }
}
