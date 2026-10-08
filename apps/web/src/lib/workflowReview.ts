import {
  activeWorkflowAttempts,
  effectiveWorkflowStep,
  type WorkflowAttempt,
  type WorkflowRun,
  type WorkflowStep,
  type WorkflowTransition,
  type WorkStream,
  type WorkStreamWait,
} from '@ficus/shared'
import type { WorkflowRunDetail } from '@ficus/client-core'

export type HumanApprovalStep = Extract<WorkflowStep, { kind: 'human-approval' }>

export const stepName = (run: WorkflowRun, stepId: string) =>
  run.definition.steps.find((entry) => entry.id === stepId)?.name ?? stepId

export function outcomeLabel(outcome: string): string {
  const words = outcome.replace(/[-_]+/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** Where an outcome sends the work, so a reviewer knows the effect before deciding. */
export function outcomeEffect(run: WorkflowRun, transition: WorkflowTransition): string {
  if ('returnTo' in transition) return `Sends back to ${stepName(run, transition.returnTo)}`
  const targets = 'parallel' in transition ? transition.parallel : [transition.next]
  if (targets.length === 1 && targets[0] === 'finish') return 'Finishes the flow'
  return `Continues to ${targets.map((target) => (target === 'finish' ? 'finish' : stepName(run, target))).join(', ')}`
}

/**
 * Whether deciding this outcome needs decision notes: the one place the rule lives. Core's `complete`
 * command requires non-empty evidence for every outcome today (`workflowCommandSchema`), so this
 * follows that contract. PR #480 makes forward approval notes optional and exports
 * `workflowOutcomeRequiresEvidence(step, transition)` from `@ficus/shared`; once it lands this body
 * becomes `return workflowOutcomeRequiresEvidence(step, transition)` and the surface follows.
 */
export function outcomeRequiresNotes(step: WorkflowStep, transition: WorkflowTransition): boolean {
  void step
  void transition
  return true
}

/** The notes helper for a gate's outcomes: "Required.", "Optional." or which outcomes need them. */
export function decisionNotesHint(step: WorkflowStep, outcomes: Array<[string, WorkflowTransition]>): string {
  const labelsWhere = (required: boolean) =>
    outcomes
      .filter(([, transition]) => outcomeRequiresNotes(step, transition) === required)
      .map(([outcome]) => outcomeLabel(outcome))
  const requiredFor = labelsWhere(true)
  const optionalFor = labelsWhere(false)
  const rule = !requiredFor.length
    ? 'Optional.'
    : !optionalFor.length
      ? 'Required.'
      : `Optional for ${optionalFor.join(', ')}; required for ${requiredFor.join(', ')}.`
  return `${rule} Your notes are recorded with the decision and passed to the next step.`
}

/** "design-assessment · Attempt 16 · Proposal ready": the attempt whose handoff is under review. */
export function attemptSummary(run: WorkflowRun, attempt: WorkflowAttempt): string {
  return `${stepName(run, attempt.stepId)} · Attempt ${attempt.id}${attempt.outcome ? ` · ${outcomeLabel(attempt.outcome)}` : ''}`
}

/**
 * The open human-approval gates of a running flow, the one a notification or action focuses first.
 * A paused, finished or canceled stream has none to decide.
 */
export function openHumanGates(stream: WorkStream, run: WorkflowRunDetail, focusWaitId?: string): WorkflowAttempt[] {
  if (stream.pause || stream.status === 'done' || stream.status === 'canceled') return []
  if (run.state.status !== 'running') return []
  const waits = run.openWaits ?? stream.openWaits ?? []
  const focusedAttemptId = waits.find((wait) => wait.id === focusWaitId)?.flowAttemptId
  return activeWorkflowAttempts(run.state)
    .filter((attempt) => effectiveWorkflowStep(run.state, attempt)?.kind === 'human-approval')
    .sort((a, b) => Number(b.id === focusedAttemptId) - Number(a.id === focusedAttemptId))
}

/** The gate a wait points at, or (without a wait) the first open gate. */
export function focusedHumanGate(
  stream: WorkStream,
  run: WorkflowRunDetail,
  focusWaitId?: string
): WorkflowAttempt | undefined {
  const gates = openHumanGates(stream, run, focusWaitId)
  if (!focusWaitId) return gates[0]
  const waits = run.openWaits ?? stream.openWaits ?? []
  const attemptId = waits.find((wait) => wait.id === focusWaitId)?.flowAttemptId
  return gates.find((gate) => gate.id === attemptId)
}

export interface HumanGateContext {
  step: HumanApprovalStep
  /** The workflow-owned wait this gate holds open, when the run reports it. */
  gateWait?: WorkStreamWait
  /** Other waits on this step that must be resolved before the gate can be decided. */
  blockingWaits: WorkStreamWait[]
  canDecide: boolean
  /** Why the viewer cannot decide, when they cannot. */
  readOnlyReason?: string
  /** The attempts whose handoffs are under review. */
  sources: WorkflowAttempt[]
  /** The first forward outcome: the primary action even when a rework outcome is declared first. */
  primaryOutcome?: string
  /** Outcomes in display order: the primary action first, then the rest as declared. */
  outcomes: Array<[string, WorkflowTransition]>
  /** Earlier decisions on this gate, newest first. */
  history: WorkflowAttempt[]
}

export function humanGateContext(
  stream: WorkStream,
  run: WorkflowRunDetail,
  attempt: WorkflowAttempt,
  permissions: {
    can: (permission: 'workstreams:review') => boolean
    identity?: { type: string; userId?: string }
  }
): HumanGateContext | undefined {
  const step = effectiveWorkflowStep(run.state, attempt)
  if (step?.kind !== 'human-approval') return undefined
  const waits = run.openWaits ?? stream.openWaits ?? []
  const gateWait = waits.find((wait) => wait.flowAttemptId === attempt.id && wait.resolutionHandler === 'workflow')
  const blockingWaits = waits.filter(
    (wait) =>
      (wait.flowAttemptId == null || wait.flowAttemptId === attempt.id) &&
      !(wait.resolutionHandler === 'workflow' && wait.flowAttemptId === attempt.id)
  )
  const assigned = stream.assignedReviewerIds ?? []
  const restricted = step.approver === 'assigned-reviewers' && assigned.length > 0
  const canReview = permissions.can('workstreams:review')
  const identity = permissions.identity
  const canDecide =
    canReview && (!restricted || (identity?.type === 'user' && !!identity.userId && assigned.includes(identity.userId)))
  const sources = (attempt.sourceAttemptIds ?? [])
    .map((id) => run.state.attempts.find((entry) => entry.id === id))
    .filter((entry): entry is WorkflowAttempt => !!entry)
  const declared = Object.entries(step.outcomes)
  const primaryOutcome = declared.find(([, transition]) => !('returnTo' in transition))?.[0]
  const outcomes = [
    ...declared.filter(([outcome]) => outcome === primaryOutcome),
    ...declared.filter(([outcome]) => outcome !== primaryOutcome),
  ]
  const history = run.state.attempts
    .filter((entry) => entry.stepId === attempt.stepId && entry.id !== attempt.id && !!entry.outcome)
    .sort((a, b) => b.id - a.id)
  return {
    step,
    gateWait,
    blockingWaits,
    canDecide,
    readOnlyReason: canDecide
      ? undefined
      : canReview
        ? 'Only the reviewers assigned to this work stream can decide.'
        : 'You need review permission in this squad to decide.',
    sources,
    primaryOutcome,
    outcomes,
    history,
  }
}

/** The document's own title: its first heading, else its first line, as plain text. */
export function documentTitle(markdown: string | undefined): string | undefined {
  if (!markdown) return undefined
  const lines = markdown.split('\n').map((line) => line.trim())
  const body = lines[0] === '---' ? lines.slice(lines.indexOf('---', 1) + 1) : lines
  const heading = body.find((line) => /^#{1,6}\s+\S/.test(line))
  const first = heading ?? body.find((line) => line && !/^(```|---|\*\*\*|___)/.test(line))
  const text = first && plainText(first)
  if (!text) return undefined
  return text.length > 140 ? `${text.slice(0, 139).trimEnd()}…` : text
}

/** Markdown reduced to readable plain text, for a clamped preview. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/[*_~`]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Instructions longer than this start collapsed behind a preview in the review document. */
export const LONG_INSTRUCTIONS = { characters: 420, lines: 6 }

export function isLongMarkdown(markdown: string, limit = LONG_INSTRUCTIONS): boolean {
  return markdown.length > limit.characters || markdown.trim().split('\n').length > limit.lines
}

/**
 * Decision notes survive closing the review: the draft is kept per wait (or attempt) for the
 * browser session and cleared once the decision is recorded. Storage can be unavailable (private
 * mode, blocked site data), so every access degrades to an in-memory draft.
 */
export function reviewDraftKey(stream: { id: string }, attempt: { id: number }, waitId?: string): string {
  return `ficus.reviewDraft.${waitId ?? `${stream.id}.${attempt.id}`}`
}

export function readReviewDraft(key: string): string {
  try {
    return window.sessionStorage.getItem(key) ?? ''
  } catch {
    return ''
  }
}

export function writeReviewDraft(key: string, value: string): void {
  try {
    if (value.trim()) window.sessionStorage.setItem(key, value)
    else window.sessionStorage.removeItem(key)
  } catch {
    // The draft stays in component state only.
  }
}

/** A deep link that opens a work stream's review surface over the Feed. */
export function workflowReviewPath(workStreamRef: string, waitId?: string): string {
  const params = new URLSearchParams({ review: workStreamRef })
  if (waitId) params.set('reviewWait', waitId)
  return `/?${params}`
}
