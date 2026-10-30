import type { WorkflowAttempt, WorkflowRun } from './workflow-runtime'
import { workflowHistoricalStep, type WorkflowBriefSubmission } from './workflow-review-history'
import type { WorkflowDecisionBrief } from './workflow-decision-brief'
import type { WorkflowAttemptAttachment } from './workflow-attachments'

/**
 * A superseded result of a completed agent attempt. Revision 1 is the original completion; each
 * `amend` while the human approval gate it feeds is open records the next revision. Called a
 * "result revision" to keep it apart from `WorkflowAttempt.revision` (the definition revision).
 */
export interface WorkflowResultRevision {
  revision: number
  /** Run version that recorded this revision; for revision 1, the attempt's settledVersion (absent on legacy attempts). */
  version?: number
  /** When it was recorded; absent for revision 1, which is recorded by the completion itself. */
  recordedAt?: string
  evidence?: string
  decisionBrief?: WorkflowBriefSubmission
  /** Attachment IDs of this revision, in display order. */
  attachmentIds: string[]
}

/** The source revision a human decision was made on. */
export interface WorkflowReviewedRevision {
  attemptId: number
  revision: number
}

/** What the agent is told when a person deciding a review gate messages it from the review screen. */
export interface WorkflowReviewConsultation {
  workStreamId: string
  /** The reference agents use with `ficus workstream` commands. */
  workStreamRef: string
  gateAttemptId: number
  gateStepId: string
  gateName: string
  /** This agent's attempts under review, at their current revisions. */
  sources: Array<{ attemptId: number; stepId: string; revision: number }>
  amend: { available: true } | { available: false; reason: string }
}

/** The most result revisions one attempt may have; past this the reviewer should request changes. */
export const WORKFLOW_MAX_RESULT_REVISIONS = 20

/** The exact refusal for a decision made on a revision that is no longer the latest. */
export const WORKFLOW_REVIEW_REVISED_MESSAGE = 'This was revised since you opened it. Review the latest revision.'

/** Error code the API returns with {@link WORKFLOW_REVIEW_REVISED_MESSAGE}. */
export const WORKFLOW_REVIEW_REVISED_CODE = 'WORKFLOW_REVIEW_REVISED'

/** The attempt's current result revision; attempts that predate amend are revision 1. */
export function workflowResultRevision(attempt: Pick<WorkflowAttempt, 'resultRevision'>): number {
  return attempt.resultRevision ?? 1
}

/**
 * The attachment IDs of the attempt's current revision. Attempts never amended use every
 * revision-1 file, in the given (upload) order.
 */
export function workflowCurrentAttachmentIds(
  attempt: Pick<WorkflowAttempt, 'id' | 'attachmentIds'>,
  rows: WorkflowAttemptAttachment[]
): string[] {
  if (attempt.attachmentIds) return [...attempt.attachmentIds]
  return rows.filter((row) => row.attemptId === attempt.id && (row.revision ?? 1) === 1).map((row) => row.id)
}

/** Every result revision of an attempt, ascending; an attempt that was never amended is exactly revision 1. */
export function workflowAttemptResults(
  attempt: WorkflowAttempt,
  rows: WorkflowAttemptAttachment[]
): WorkflowResultRevision[] {
  const current: WorkflowResultRevision = {
    revision: workflowResultRevision(attempt),
    ...(attempt.resultRevisedVersion !== undefined
      ? { version: attempt.resultRevisedVersion }
      : attempt.settledVersion !== undefined
        ? { version: attempt.settledVersion }
        : {}),
    ...(attempt.resultRevisedAt ? { recordedAt: attempt.resultRevisedAt } : {}),
    ...(attempt.evidence !== undefined ? { evidence: attempt.evidence } : {}),
    ...(attempt.decisionBrief ? { decisionBrief: attempt.decisionBrief } : {}),
    attachmentIds: workflowCurrentAttachmentIds(attempt, rows),
  }
  return [...(attempt.earlierResults ?? []), current]
}

/** Display order of the brief fields, shared by every review surface. */
export const WORKFLOW_DECISION_BRIEF_FIELDS = [
  'decision',
  'recommendation',
  'approvalEffect',
  'risks',
  'changesSinceLastReview',
] as const satisfies ReadonlyArray<keyof WorkflowDecisionBrief>

export interface WorkflowResultChanges {
  briefFields: Array<{ field: keyof WorkflowDecisionBrief; before?: string; after?: string }>
  unchangedBriefFields: Array<keyof WorkflowDecisionBrief>
  evidenceChanged: boolean
  attachments: {
    added: WorkflowAttemptAttachment[]
    removed: WorkflowAttemptAttachment[]
    changed: Array<{ before: WorkflowAttemptAttachment; after: WorkflowAttemptAttachment }>
  }
}

/**
 * What changed between two revisions of one attempt. Attachments compare by path: the same file ID
 * is unchanged (unchanged files keep their ID across revisions), another ID at the same path is a
 * changed file, and a path on one side only is added or removed. `files` maps IDs to attachments
 * of either revision; unknown IDs are skipped.
 */
export function workflowResultChanges(
  before: Pick<WorkflowResultRevision, 'evidence' | 'decisionBrief' | 'attachmentIds'>,
  after: Pick<WorkflowResultRevision, 'evidence' | 'decisionBrief' | 'attachmentIds'>,
  files: Record<string, WorkflowAttemptAttachment>
): WorkflowResultChanges {
  const briefFields: WorkflowResultChanges['briefFields'] = []
  const unchangedBriefFields: WorkflowResultChanges['unchangedBriefFields'] = []
  for (const field of WORKFLOW_DECISION_BRIEF_FIELDS) {
    const old = before.decisionBrief?.value[field]
    const now = after.decisionBrief?.value[field]
    if ((old ?? '') === (now ?? '')) {
      if (old !== undefined) unchangedBriefFields.push(field)
    } else
      briefFields.push({
        field,
        ...(old !== undefined ? { before: old } : {}),
        ...(now !== undefined ? { after: now } : {}),
      })
  }
  const byPath = (ids: string[]) =>
    new Map(ids.flatMap((id) => (files[id] ? [[files[id]!.path, files[id]!] as const] : [])))
  const old = byPath(before.attachmentIds)
  const now = byPath(after.attachmentIds)
  return {
    briefFields,
    unchangedBriefFields,
    evidenceChanged: (before.evidence ?? '') !== (after.evidence ?? ''),
    attachments: {
      added: [...now].filter(([path]) => !old.has(path)).map(([, file]) => file),
      removed: [...old].filter(([path]) => !now.has(path)).map(([, file]) => file),
      changed: [...now].flatMap(([path, file]) => {
        const previous = old.get(path)
        return previous && previous.id !== file.id ? [{ before: previous, after: file }] : []
      }),
    },
  }
}

/** Whether two reviewed-revision lists name the same attempts at the same revisions, in any order. */
export function sameWorkflowReviewedRevisions(
  left: WorkflowReviewedRevision[],
  right: WorkflowReviewedRevision[]
): boolean {
  const key = (list: WorkflowReviewedRevision[]) =>
    [...new Set(list.map((entry) => `${entry.attemptId}:${entry.revision}`))].sort().join(',')
  return key(left) === key(right)
}

/**
 * The sentence that names what a settled human decision was made on, for example
 * "Approved revision 3 of design attempt 12". Null for a gate with no recorded agent sources.
 */
export function workflowDecisionRevisionNote(run: WorkflowRun, gate: WorkflowAttempt): string | null {
  if (!gate.reviewedRevisions?.length) return null
  // A human approval's first forward outcome is its approval; any other forward choice is named.
  const step = workflowHistoricalStep(run, gate)
  const approval =
    step?.kind === 'human-approval' &&
    Object.entries(step.outcomes).find(([, transition]) => !('returnTo' in transition))?.[0] === gate.outcome
  const verb =
    gate.status === 'returned' ? 'Changes requested on' : approval ? 'Approved' : `Chose '${gate.outcome}' on`
  const parts = gate.reviewedRevisions.map((entry) => {
    const source = run.attempts.find((attempt) => attempt.id === entry.attemptId)
    return `revision ${entry.revision} of ${source?.stepId ?? 'attempt'} attempt ${entry.attemptId}`
  })
  return `${verb} ${parts.join(' and ')}`
}

/** "Revised just now", "Revised 2 min ago", "Revised 3 h ago", else the date: the review screens' marker. */
export function workflowRevisedLabel(recordedAt: string | undefined, now: number): string {
  if (!recordedAt) return 'Revised'
  const minutes = Math.floor((now - new Date(recordedAt).getTime()) / 60_000)
  if (minutes < 1) return 'Revised just now'
  if (minutes < 60) return `Revised ${minutes} min ago`
  if (minutes < 24 * 60) return `Revised ${Math.floor(minutes / 60)} h ago`
  return `Revised ${new Date(recordedAt).toLocaleDateString()}`
}
