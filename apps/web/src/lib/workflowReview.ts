export {
  humanGateSubtitle,
  workflowReviewPlainText as plainText,
  workflowRevisedLabel as revisedLabel,
} from '@ficus/shared'
import {
  activeWorkflowAttempts,
  workflowReviewPlainText as plainText,
  workflowReviewBlockingWaits,
  workflowCompletionTargets,
  isWorkflowHumanGateWait,
  workflowEarlierHumanDecisions,
  describeWorkflowDecision,
  effectiveWorkflowStep,
  workflowIncomingAttempts,
  workflowOutcomeRequiresEvidence,
  workflowHistoricalStep,
  type WorkflowAttempt,
  type WorkflowRun,
  type WorkflowStep,
  type WorkflowTransition,
  type WorkStream,
  type WorkStreamWait,
} from '@ficus/shared'
import type { WorkflowRunDetail } from '@ficus/client-core'

export type HumanApprovalStep = Extract<WorkflowStep, { kind: 'human-approval' }>
/** A step a person decides: an approval, or a decision step that got no automatic decision. */
export type HumanGateStep = HumanApprovalStep | Extract<WorkflowStep, { kind: 'decision' }>

/** Whether a person decides this attempt now. */
export function isHumanGate(run: WorkflowRun, attempt: WorkflowAttempt): boolean {
  const step = effectiveWorkflowStep(run, attempt)
  return step?.kind === 'human-approval' || (step?.kind === 'decision' && !!attempt.decision?.awaitingPerson)
}

export const stepName = (run: WorkflowRun, stepId: string) =>
  run.definition.steps.find((entry) => entry.id === stepId)?.name ?? stepId

export function outcomeLabel(outcome: string): string {
  const words = outcome.replace(/[-_]+/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** Where an outcome sends the work, so a reviewer knows the effect before deciding. */
export function outcomeEffect(
  run: WorkflowRun,
  transition: WorkflowTransition,
  attempt?: WorkflowAttempt,
  outcome?: string
): string {
  if ('returnTo' in transition) return `Sends back to ${stepName(run, transition.returnTo)}`
  const targets =
    attempt && outcome
      ? workflowCompletionTargets(run, attempt, outcome)
      : 'parallel' in transition
        ? transition.parallel
        : [transition.next]
  if (targets.length === 1 && targets[0] === 'finish') return 'Finishes the flow'
  return `Continues to ${targets.map((target) => (target === 'finish' ? 'finish' : stepName(run, target))).join(', ')}`
}

/**
 * Whether deciding this outcome needs decision notes: the one place the web rule lives. It mirrors
 * Core's authoritative check, so forward approval needs no notes and a send-back (`returnTo`) does,
 * because the notes are the returned step's rework feedback.
 */
export function outcomeRequiresNotes(step: WorkflowStep, transition: WorkflowTransition): boolean {
  return workflowOutcomeRequiresEvidence(step, transition)
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
    .filter((attempt) => isHumanGate(run.state, attempt))
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
  attempt: WorkflowAttempt
  step: HumanGateStep
  /** For a decision step: why no automatic decision was made, and what the model answered. */
  decisionNote?: string
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
  if (!step || !isHumanGate(run.state, attempt) || step.kind === 'agent') return undefined
  const waits = run.openWaits ?? stream.openWaits ?? []
  const gateWait = waits.find((wait) => wait.flowAttemptId === attempt.id && isWorkflowHumanGateWait(wait))
  const blockingWaits = workflowReviewBlockingWaits(gateWait ?? { type: 'manual', flowAttemptId: attempt.id }, waits)
  const assigned = stream.assignedReviewerIds ?? []
  // Any reviewer decides for a decision step; only approvals can be limited to assigned reviewers.
  const restricted = step.kind === 'human-approval' && step.approver === 'assigned-reviewers' && assigned.length > 0
  const canReview = permissions.can('workstreams:review')
  const identity = permissions.identity
  const canDecide =
    canReview && (!restricted || (identity?.type === 'user' && !!identity.userId && assigned.includes(identity.userId)))
  // A decision step before this gate passes its own sources through, so the work under review shows.
  const sources = workflowIncomingAttempts(run.state, attempt)
  const declared = Object.entries(step.outcomes)
  const primaryOutcome = declared.find(([, transition]) => !('returnTo' in transition))?.[0]
  const outcomes = [
    ...declared.filter(([outcome]) => outcome === primaryOutcome),
    ...declared.filter(([outcome]) => outcome !== primaryOutcome),
  ]
  const history = workflowEarlierHumanDecisions(run.state, attempt.stepId).filter((entry) => entry.id !== attempt.id)
  return {
    attempt,
    step,
    ...(step.kind === 'decision' && attempt.decision
      ? { decisionNote: describeWorkflowDecision(step, attempt.decision) }
      : {}),
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

/** Completion modes whose delivery is a pull request the squad finishes on merge. */
export const PULL_REQUEST_COMPLETION_MODES: ReadonlySet<string> = new Set(['pr-merge', 'pr-auto-merge', 'direct-merge'])

/** A deep link that opens a work stream's review surface over the Feed. */
export function workflowReviewPath(workStreamRef: string, waitId?: string): string {
  const params = new URLSearchParams({ review: workStreamRef })
  if (waitId) params.set('reviewWait', waitId)
  return `/?${params}`
}

/** With an inline agent chat, the review splits into the document and a chat column from this width. */
export const REVIEW_CHAT_COLUMNS_QUERY = '(min-width: 1024px)'

/**
 * The agents whose completed attempts feed this gate (its agent sources), each with the attempts it
 * produced, in attempt order. The review screen chats with them in their existing sessions.
 */
export function producingAgents(
  run: Pick<WorkflowRunDetail, 'state' | 'attemptAgents'>,
  sources: WorkflowAttempt[]
): Array<{ agentId: string; sources: WorkflowAttempt[] }> {
  const byAgent = new Map<string, WorkflowAttempt[]>()
  for (const source of sources) {
    const agentId = run.attemptAgents[String(source.id)]
    if (!agentId || workflowHistoricalStep(run.state, source)?.kind !== 'agent') continue
    byAgent.set(agentId, [...(byAgent.get(agentId) ?? []), source])
  }
  return [...byAgent].map(([agentId, attempts]) => ({ agentId, sources: attempts }))
}

/**
 * The source revisions a reviewer has looked at, kept per gate for the browser session so reopening
 * the review compares against what they last saw. Storage failures degrade to component state.
 */
export function reviewSeenRevisionsKey(stream: { id: string }, attempt: { id: number }): string {
  return `ficus.reviewSeen.${stream.id}.${attempt.id}`
}
export function readSeenRevisions(key: string): Record<string, number> | null {
  try {
    const value = JSON.parse(window.sessionStorage.getItem(key) ?? 'null') as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    return Object.fromEntries(
      Object.entries(value).filter((entry): entry is [string, number] => Number.isSafeInteger(entry[1]))
    )
  } catch {
    return null
  }
}
export function writeSeenRevisions(key: string, value: Record<string, number>): void {
  try {
    window.sessionStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Kept in component state only.
  }
}
