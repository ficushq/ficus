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
 * What the fallback for a gate whose assigned reviewers are all gone reads. Core computes
 * `inactiveAssignedReviewerIds`; clients read it from the work stream. Without it (an older server)
 * every assigned reviewer counts as active, so the fallback never applies.
 */
export interface WorkflowGateFallback {
  /**
   * The stream's assigned reviewers who can no longer decide: the account is disabled or deleted,
   * or the person no longer holds review permission in the stream's squad (removed from the squad,
   * or their role lost `workstreams:review`).
   */
  inactiveAssignedReviewerIds?: readonly string[] | null
  /** The person who requested the stream: its owner among people. */
  requestingUserId?: string | null
  /** Whether the person deciding is an admin: holds every permission (`*`) in the squad. */
  isAdmin?: boolean
}

/**
 * Whether a stream names assigned reviewers and none of them can still decide, so its
 * assigned-reviewers gates fall back to the owner and admins, and the owner is asked to reassign.
 */
export function workflowGateHasNoActiveAssignedReviewer(
  assignedReviewerIds: readonly string[] | null | undefined,
  inactiveAssignedReviewerIds: readonly string[] | null | undefined
): boolean {
  const assigned = assignedReviewerIds ?? []
  const inactive = inactiveAssignedReviewerIds ?? []
  return assigned.length > 0 && assigned.every((id) => inactive.includes(id))
}

/**
 * Why a person may decide a workflow gate, or null when they may not:
 * - `reviewer`: the gate takes anyone with review permission;
 * - `assigned-reviewer`: they are one of the stream's assigned reviewers the gate is limited to;
 * - `owner` / `admin`: the gate is limited to assigned reviewers, none of them is still active, and
 *   they requested the stream or are an admin.
 */
export type WorkflowGateDecisionBasis = 'reviewer' | 'assigned-reviewer' | 'owner' | 'admin'

export function workflowGateDecisionBasis(
  person: { type: string; userId?: string } | null | undefined,
  canReview: boolean,
  assignedReviewerIds: readonly string[] | null | undefined,
  gate: WorkflowGateFacts,
  fallback: WorkflowGateFallback = {}
): WorkflowGateDecisionBasis | null {
  if (person?.type !== 'user' || !person.userId || !canReview) return null
  const limitedTo = workflowGateAssignedDeciders(assignedReviewerIds, gate)
  if (!limitedTo) return 'reviewer'
  if (limitedTo.includes(person.userId)) return 'assigned-reviewer'
  if (!workflowGateHasNoActiveAssignedReviewer(assignedReviewerIds, fallback.inactiveAssignedReviewerIds)) return null
  if (fallback.requestingUserId && fallback.requestingUserId === person.userId) return 'owner'
  return fallback.isAdmin ? 'admin' : null
}

/**
 * Whether a person may decide a workflow gate (a human approval, or a decision step waiting on a
 * person). The one rule Core enforces and every client shows: a user with review permission in the
 * squad, and for a gate limited to the stream's assigned reviewers, one of them; when none of those
 * is still active, the stream's owner (its requester) or an admin. Agents never decide.
 */
export function mayDecideWorkflowGate(
  person: { type: string; userId?: string } | null | undefined,
  canReview: boolean,
  assignedReviewerIds: readonly string[] | null | undefined,
  gate: WorkflowGateFacts,
  fallback?: WorkflowGateFallback
): boolean {
  return workflowGateDecisionBasis(person, canReview, assignedReviewerIds, gate, fallback) !== null
}

/**
 * The fallback facts a client reads for a viewer: the stream's inactive assigned reviewers and
 * requester as the server sent them, and whether the viewer holds `*` in the squad.
 */
export function workflowGateFallbackForViewer(
  stream: { inactiveAssignedReviewerIds?: readonly string[] | null; requestingUserId?: string | null },
  can: ((permission: string) => boolean) | undefined
): WorkflowGateFallback {
  return {
    inactiveAssignedReviewerIds: stream.inactiveAssignedReviewerIds,
    requestingUserId: stream.requestingUserId,
    isAdmin: !!can?.('*'),
  }
}

/** The fallback eligibility shown to viewers who are not deciding the gate. */
export const WORKFLOW_GATE_FALLBACK_ELIGIBILITY = 'Only an admin or the owner with squad review permission can decide.'

/** The note a gate card shows a person who decides only through the fallback; undefined otherwise. */
export function workflowGateFallbackNote(basis: WorkflowGateDecisionBasis | null): string | undefined {
  if (basis === 'owner') return 'No active assigned reviewer; you can decide as the owner.'
  if (basis === 'admin') return 'No active assigned reviewer; you can decide as an admin.'
  return undefined
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
