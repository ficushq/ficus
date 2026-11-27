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
  workflowReviewBriefForAttempt,
  agentTypeNoun,
  typeFirstAgentLabel,
  type Agent,
  type WorkflowAttempt,
  type WorkflowAttemptAttachment,
  type WorkflowDecisionBrief,
  type WorkflowRun,
  type WorkflowStep,
  type WorkflowTransition,
  type WorkStream,
  type WorkStreamWait,
} from '@ficus/shared'
import type { WorkflowRunDetail } from '@ficus/client-core'
import { getAgentLabel } from './agentDisplay'

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

/** The squad's own name for an agent type (`AgentType.name`), when it is known. */
export type AgentTypeName = (agentTypeId: string) => string | undefined
const noTypeNames: AgentTypeName = () => undefined

/** "Engineer", or "General Purpose agent" for the built-in general type (see `agentTypeNoun`). */
function agentNoun(type: string, typeName: AgentTypeName): string {
  return agentTypeNoun({ agentTypeId: type, typeName: typeName(type) })
}

/** The agent type a step's participant runs as, when the step is an agent step. */
function stepAgentType(run: WorkflowRun, stepId: string): string | undefined {
  const step = run.definition.steps.find((entry) => entry.id === stepId)
  return step?.kind === 'agent' ? run.definition.participants[step.participant]?.agentTypeId : undefined
}

function joinWords(parts: string[]): string {
  return parts.length < 2 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`
}

/**
 * What an outcome does, in plain words, so a reviewer knows the effect before deciding: who gets the work
 * next ("Returns to the Engineer with your notes", "Next: Release (Engineer)"), or that the work stream
 * completes. It never restates the brief: what approval allows is shown whole beside the buttons.
 */
export function outcomeEffect(
  run: WorkflowRun,
  transition: WorkflowTransition,
  attempt?: WorkflowAttempt,
  outcome?: string,
  { typeName = noTypeNames }: { typeName?: AgentTypeName } = {}
): string {
  if ('returnTo' in transition) {
    const type = stepAgentType(run, transition.returnTo)
    return type
      ? `Returns to the ${agentNoun(type, typeName)} with your notes`
      : `Returns to ${stepName(run, transition.returnTo)} with your notes`
  }
  const targets =
    attempt && outcome
      ? workflowCompletionTargets(run, attempt, outcome)
      : 'parallel' in transition
        ? transition.parallel
        : [transition.next]
  if (targets.every((target) => target === 'finish')) return 'Completes the work stream'
  const described = targets.map((target) => {
    if (target === 'finish') return 'completion'
    const type = stepAgentType(run, target)
    return type ? `${stepName(run, target)} (${agentNoun(type, typeName)})` : stepName(run, target)
  })
  return `Next: ${joinWords(described)}`
}

/**
 * What approval allows, word for word, from a brief authored for this gate, when the gate has exactly one
 * forward outcome for it to describe. It is never shortened: a first sentence, a list's first step or a
 * statement without its code block can read as the whole promise. A carried-forward brief is not fresh
 * authorization for this gate, and join briefs that disagree are not merged, so neither gives one.
 */
export function approvalStatement(run: WorkflowRun, gateAttempt: WorkflowAttempt): string | undefined {
  const step = effectiveWorkflowStep(run, gateAttempt)
  if (!step || step.kind === 'agent') return undefined
  const forward = Object.values(step.outcomes).filter((transition) => !('returnTo' in transition))
  if (forward.length !== 1) return undefined
  const brief = workflowReviewBriefForAttempt(run, gateAttempt)
  if (brief.kind !== 'authored') return undefined
  const statements = [
    ...new Set(brief.sources.map((source) => source.decisionBrief?.value.approvalEffect?.trim() ?? '').filter(Boolean)),
  ]
  return statements.length === 1 ? statements[0] : undefined
}

/**
 * Who prepared an attempt's handoff: its agent's type, with the agent's purpose when it has one
 * ("Engineer (Payments)"). The type comes from the agent when it is listed, else the participant the
 * attempt ran as. Undefined for an attempt no agent ran.
 */
export function attemptAuthor(
  run: Pick<WorkflowRunDetail, 'state' | 'attemptAgents'>,
  attempt: WorkflowAttempt,
  {
    agents,
    typeName = noTypeNames,
  }: {
    agents?: ReadonlyMap<string, Pick<Agent, 'agentTypeId' | 'metadata'>>
    typeName?: AgentTypeName
  } = {}
): string | undefined {
  const agentId = run.attemptAgents[String(attempt.id)]
  const agent = agentId ? agents?.get(agentId) : undefined
  const step = workflowHistoricalStep(run.state, attempt)
  const participantType =
    attempt.participant?.agentTypeId ??
    (step?.kind === 'agent' ? run.state.definition.participants[step.participant]?.agentTypeId : undefined)
  const type = agent?.agentTypeId ?? participantType
  if (!type) return undefined
  // The shared type-first label, so the review names agents as every other surface does.
  return agent
    ? getAgentLabel(agent, undefined, typeName(type))
    : typeFirstAgentLabel({ agentTypeId: type, typeName: typeName(type) })
}

/** "Waiting 7 days": how long a review has waited, in the largest whole unit. */
export function waitingLabel(openedAt: string, now: number): string {
  const minutes = Math.floor(Math.max(0, now - Date.parse(openedAt)) / 60_000)
  const unit = (count: number, word: string) => `Waiting ${count} ${word}${count === 1 ? '' : 's'}`
  if (minutes < 1) return 'Waiting less than a minute'
  if (minutes < 60) return unit(minutes, 'minute')
  if (minutes < 24 * 60) return unit(Math.floor(minutes / 60), 'hour')
  return unit(Math.floor(minutes / (24 * 60)), 'day')
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
  /** What the brief under review says approval allows, whole, when one forward outcome can carry it. */
  approvalStatement?: string
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
    approvalStatement: approvalStatement(run.state, attempt),
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

/** The brief's fields in reading order, with their reviewer-facing labels. */
export const DECISION_BRIEF_FIELD_LABELS: ReadonlyArray<readonly [keyof WorkflowDecisionBrief, string]> = [
  ['decision', 'Decision'],
  ['recommendation', 'Recommendation'],
  ['approvalEffect', 'What approval allows'],
  ['risks', 'Risks and tradeoffs'],
  ['changesSinceLastReview', 'What changed since your last review'],
]

/** Every file an attempt has had, current and earlier revisions. */
export function attemptFiles(
  run: Pick<WorkflowRunDetail, 'attachments' | 'earlierAttachments'>,
  attemptId: number
): WorkflowAttemptAttachment[] {
  return [...(run.attachments?.[String(attemptId)] ?? []), ...(run.earlierAttachments?.[String(attemptId)] ?? [])]
}
