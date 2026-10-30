import { z } from 'zod'
import { workflowDecisionBriefSchema } from './workflow-decision-brief'
import {
  workflowDefinitionSchema,
  workflowParticipantSchema,
  workflowCustomizationSchema,
  resolveWorkflow,
  type WorkflowDefinition,
  type WorkflowStep,
  type WorkflowParticipant,
  type WorkflowTransition,
} from './workflows'
import {
  workflowEarlierHumanDecisions,
  workflowCarryForwardSources,
  workflowHasLegacyBriefSource,
  workflowHistoricalStep,
  type WorkflowBriefSubmission,
  type WorkflowReviewBriefBinding,
} from './workflow-review-history'
import type { WorkflowDecisionRecord } from './workflow-decision'
import {
  WORKFLOW_MAX_RESULT_REVISIONS,
  workflowResultRevision,
  workflowReviewDecisionRefusal,
  type WorkflowResultRevision,
  type WorkflowReviewedRevision,
} from './workflow-result-revisions'

export interface WorkflowBranch {
  forkId: number
  branchId: string
}
export interface WorkflowJoin {
  id: number
  join: string
  branches: string[]
  arrived: string[]
  sourceAttemptIds?: number[]
  parent?: WorkflowBranch
  status: 'open' | 'joined' | 'canceled'
}

export interface WorkflowAttempt {
  decisionBrief?: WorkflowBriefSubmission
  reviewBrief?: WorkflowReviewBriefBinding
  settledVersion?: number
  /** Attempts whose handoffs directly started this attempt (empty for the entry). */
  sourceAttemptIds?: number[]
  /** Durable command-response handoff; no inbox delivery is needed for this attempt. */
  responseAssignment?: { requestId: string; agentId: string; version: number; content: string; executionId?: string }
  /**
   * The work brief this attempt's agent had when assigned: a digest of the stream description and owner's
   * handoff, and the agent's session-reset count. A later attempt for the same agent repeats the brief only
   * when either changed.
   */
  briefContext?: { digest: string; sessionResets: number }
  branch?: WorkflowBranch
  id: number
  stepId: string
  status: 'running' | 'completed' | 'returned' | 'canceled'
  /** Initial brief and routing snapshot; never rewritten by a keep revision. */
  step?: WorkflowStep
  /** Live routing overlay, bound at this run version. Non-outcome fields stay pinned. */
  effectiveOutcomes?: { version: number; outcomes: WorkflowStep['outcomes'] }
  revision?: number
  participant?: WorkflowParticipant
  freshSession?: boolean
  outcome?: string
  evidence?: string
  feedback?: string
  /** A decision step's model answers and routing; set once, when Core evaluates the step. */
  decision?: WorkflowDecisionRecord
  /**
   * Current result revision of a completed agent attempt; absent means 1 (the original completion).
   * `evidence`, `decisionBrief` and `attachmentIds` always hold this latest revision.
   */
  resultRevision?: number
  /** Run version and time that recorded the current revision; set from revision 2 on. */
  resultRevisedVersion?: number
  resultRevisedAt?: string
  /** Superseded result revisions, ascending. Immutable once written. */
  earlierResults?: WorkflowResultRevision[]
  /** Attachment IDs of the current revision; absent means every revision-1 file of this attempt. */
  attachmentIds?: string[]
  /** Human decisions only: the source revisions this decision was made on, computed by the kernel. */
  reviewedRevisions?: WorkflowReviewedRevision[]
}

/** Effective routing exposed by flow inspection and live revision receipts. */
export interface WorkflowOutcomeBinding {
  attemptId: number
  stepId: string
  agentId: string | null
  version: number
  outcomes: WorkflowStep['outcomes']
}

export interface WorkflowReturnObligation {
  branch?: WorkflowBranch
  id: number
  requestedByAttemptId: number
  targetStepId: string
  resumeAt: string
  direct?: boolean
  parentId: number | null
  feedback: string
  status: 'open' | 'resolved' | 'superseded'
  resolvedByAttemptId?: number
  supersededByReturnId?: number
}

export interface WorkflowRun {
  schemaVersion: 1
  version: number
  definition: WorkflowDefinition
  status: 'running' | 'paused' | 'completion-ready'
  activeAttemptId: number | null
  joins?: WorkflowJoin[]
  pendingStarts?: Array<{
    stepId: string
    branch?: WorkflowBranch
    freshSession?: boolean
    sourceAttemptIds?: number[]
    feedback?: string
    reviewBrief?: WorkflowReviewBriefBinding
  }>
  attempts: WorkflowAttempt[]
  returns: WorkflowReturnObligation[]
  completedStepIds: string[]
  revisions?: Array<{
    version: number
    definition: WorkflowDefinition
    reason: string
    affectedAttemptIds?: number[]
    /** Core acceptance receipt, including explicit null identities before participant binding. */
    outcomeUpdates?: WorkflowOutcomeBinding[]
  }>
  delegationCount?: number
  attemptEpoch?: number
  pauseReason?: { type: 'attempt-limit'; stepId: string }
}

const commandFields = {
  expectedVersion: z.int().nonnegative(),
  attemptId: z.int().positive(),
}
/** The source revisions a person reviewed; Core refuses the decision when any is no longer current. */
const reviewedRevisionsField = z
  .array(z.strictObject({ attemptId: z.int().positive(), revision: z.int().positive() }))
  .max(32)
  .optional()
export const workflowCommandSchema = z.discriminatedUnion('action', [
  z.strictObject({
    ...commandFields,
    action: z.literal('rework'),
    feedback: z.string().trim().min(1).max(64_000),
  }),
  z.strictObject({
    ...commandFields,
    action: z.literal('delegate'),
    participant: workflowParticipantSchema,
    task: z.string().trim().min(1).max(64000),
  }),
  z.strictObject({
    expectedVersion: commandFields.expectedVersion,
    attemptId: commandFields.attemptId.nullable(),
    action: z.literal('revise'),
    operations: z.array(workflowCustomizationSchema).min(1).max(512),
    reason: z.string().trim().min(1).max(4000),
    active: z.enum(['keep', 'restart']),
  }),
  z.strictObject({
    ...commandFields,
    action: z.literal('complete'),
    decisionBrief: workflowDecisionBriefSchema.optional(),
    outcome: z.string().min(1).max(100),
    // May be empty only for a human approval that moves work forward; see workflowOutcomeRequiresEvidence.
    evidence: z.string().trim().max(64_000),
    // An agent doing rework may return its result directly to the requester.
    resume: z.boolean().default(false),
    reviewedRevisions: reviewedRevisionsField,
  }),
  z.strictObject({
    ...commandFields,
    action: z.literal('return'),
    decisionBrief: workflowDecisionBriefSchema.optional(),
    targetStepId: z.string().min(1).max(100),
    resumeAt: z.string().min(1).max(100),
    feedback: z.string().trim().min(1).max(64_000),
    reviewedRevisions: reviewedRevisionsField,
  }),
  // An agent revises its own completed attempt while the human approval gate it feeds is open.
  z.strictObject({
    ...commandFields,
    action: z.literal('amend'),
    decisionBrief: workflowDecisionBriefSchema,
    evidence: z.string().trim().min(1).max(64_000),
    /** Paths of files staged (uploaded) for this amend to publish; they add or replace by path. */
    attachmentPaths: z.array(z.string().min(1).max(1024)).max(10).optional(),
    /** Files of the current revision to drop. */
    removeAttachmentPaths: z.array(z.string().min(1).max(1024)).max(10).optional(),
  }),
])

export type WorkflowCommand = z.infer<typeof workflowCommandSchema>

function stepById(state: WorkflowRun, id: string): WorkflowStep {
  const step = state.definition.steps.find((step) => step.id === id)
  if (!step) throw new Error(`Unknown step '${id}'`)
  return step
}

/** Outcome/transition keys may be reordered by JSONB persistence; branch array order stays significant. */
function sameOutcomes(left: WorkflowStep['outcomes'], right: WorkflowStep['outcomes']): boolean {
  return (
    Object.keys(left).length === Object.keys(right).length &&
    Object.entries(left).every(([name, target]) => {
      const other = right[name]
      return (
        other !== undefined &&
        JSON.stringify(target, Object.keys(target).sort()) === JSON.stringify(other, Object.keys(other).sort())
      )
    })
  )
}

/** Resolve pinned work with its latest authorized outcome binding (also for historical attempts). */
export function effectiveWorkflowStep(state: WorkflowRun, attempt: WorkflowAttempt): WorkflowStep {
  const initial = attempt.step ?? stepById(state, attempt.stepId)
  return attempt.effectiveOutcomes ? { ...initial, outcomes: attempt.effectiveOutcomes.outcomes } : initial
}

/**
 * Whether completing a step with this outcome needs non-empty evidence. Agent results always do.
 * A human approver may move work forward without notes, but a return is rework feedback the
 * returned step needs, so it must say what to change. Decided by transition shape, not outcome name.
 */
export function workflowOutcomeRequiresEvidence(step: WorkflowStep, transition: WorkflowTransition): boolean {
  return step.kind === 'agent' || 'returnTo' in transition
}

/**
 * The attempts whose handoffs feed this one, in attempt order. A decision step does no work of its
 * own, so its sources pass through: the step after a decision still sees the result decided on.
 */
export function workflowIncomingAttempts(state: WorkflowRun, attempt: WorkflowAttempt): WorkflowAttempt[] {
  const found = new Map<number, WorkflowAttempt>()
  const pending = [...(attempt.sourceAttemptIds ?? [])]
  while (pending.length) {
    const id = pending.pop()!
    const source = state.attempts.find((entry) => entry.id === id)
    if (!source || found.has(id)) continue
    found.set(id, source)
    if ((source.step ?? state.definition.steps.find((step) => step.id === source.stepId))?.kind === 'decision')
      pending.push(...(source.sourceAttemptIds ?? []))
  }
  return [...found.values()].sort((a, b) => a.id - b.id)
}

/**
 * Whether a person decides this attempt: a human approval, or a decision step its model handed to a
 * person. Its decision records the source revisions it was made on.
 */
export function isWorkflowHumanDecisionAttempt(state: WorkflowRun, attempt: WorkflowAttempt): boolean {
  const kind = workflowHistoricalStep(state, attempt)?.kind
  return kind === 'human-approval' || (kind === 'decision' && !!attempt.decision?.awaitingPerson)
}

/**
 * The agent attempts whose results feed a human decision, with their current result revisions
 * (decision steps pass through, as in {@link workflowIncomingAttempts}). `revisedVersion` is the run
 * version of the latest amendment, absent for revision 1.
 */
export function workflowGateRevisions(
  state: WorkflowRun,
  gate: WorkflowAttempt
): Array<WorkflowReviewedRevision & { revisedVersion?: number }> {
  return workflowIncomingAttempts(state, gate)
    .filter((source) => workflowHistoricalStep(state, source)?.kind === 'agent')
    .map((source) => ({
      attemptId: source.id,
      revision: workflowResultRevision(source),
      ...(source.resultRevisedVersion !== undefined ? { revisedVersion: source.resultRevisedVersion } : {}),
    }))
}

export type WorkflowAmendEligibility = { ok: true; gates: WorkflowAttempt[] } | { ok: false; reason: string }

/**
 * Whether an attempt's result may be amended now: a completed agent attempt whose every consumer is a
 * running human approval gate that opened with this attempt's own decision brief. Anything that
 * already used the result (an agent, an automatic decision, a decided gate, a queued start or an
 * open join) would silently see different content, so it refuses. Pure; Core, the CLI preflight,
 * the attachment guard and the review consultation all use it.
 */
export function workflowAmendEligibility(state: WorkflowRun, attemptId: number): WorkflowAmendEligibility {
  const refuse = (reason: string): WorkflowAmendEligibility => ({ ok: false, reason })
  const attempt = state.attempts.find((entry) => entry.id === attemptId)
  if (!attempt) return refuse(`Attempt ${attemptId} does not exist.`)
  if (workflowHistoricalStep(state, attempt)?.kind !== 'agent')
    return refuse(`Only an agent's completed attempt can be amended; attempt ${attemptId} is not an agent step.`)
  if (attempt.status !== 'completed')
    return refuse(`Only a completed attempt can be amended; attempt ${attemptId} is ${attempt.status}.`)
  const notFeeding = refuse(`Attempt ${attemptId} does not feed an open human approval gate.`)
  if (
    state.pendingStarts?.some((entry) => entry.sourceAttemptIds?.includes(attemptId)) ||
    state.joins?.some((join) => join.status === 'open' && join.sourceAttemptIds?.includes(attemptId))
  )
    return notFeeding
  const consumers = state.attempts.filter(
    (entry) => entry.status !== 'canceled' && entry.sourceAttemptIds?.includes(attemptId)
  )
  if (!consumers.length) return notFeeding
  const used = consumers.find((entry) => workflowHistoricalStep(state, entry)?.kind !== 'human-approval')
  if (used)
    return refuse(
      `Attempt ${attemptId}'s result was already used by '${used.stepId}' (attempt ${used.id}); only a result waiting at an open human approval gate can be amended.`
    )
  const closed = consumers.find((gate) => gate.status !== 'running' || gate.id <= (state.attemptEpoch ?? 0))
  if (closed)
    return refuse(
      `Human approval '${closed.stepId}' is no longer open, so attempt ${attemptId} can no longer be amended.`
    )
  const unbound = consumers.find(
    (gate) =>
      !attempt.decisionBrief ||
      gate.reviewBrief?.kind !== 'authored' ||
      !gate.reviewBrief.sourceAttemptIds.includes(attemptId)
  )
  if (unbound)
    return refuse(
      `Human approval '${unbound.stepId}' did not open with this attempt's decision brief, so it cannot be amended; recommend Changes requested instead.`
    )
  // Checked after the gate, so a decided gate explains itself rather than the run's later state.
  if (state.status !== 'running') return refuse(`Workflow is ${state.status}`)
  if (workflowResultRevision(attempt) >= WORKFLOW_MAX_RESULT_REVISIONS)
    return refuse(
      `Attempt ${attemptId} has reached ${WORKFLOW_MAX_RESULT_REVISIONS} revisions; recommend Changes requested instead.`
    )
  return { ok: true, gates: consumers }
}

export function activeWorkflowAttempts(state: WorkflowRun): WorkflowAttempt[] {
  return state.attempts.filter((attempt) => attempt.status === 'running')
}
const branchKey = (branch?: WorkflowBranch) => (branch ? `${branch.forkId}:${branch.branchId}` : 'main')
function syncActive(state: WorkflowRun) {
  state.activeAttemptId = activeWorkflowAttempts(state)[0]?.id ?? null
}
function activeReturn(state: WorkflowRun, branch?: WorkflowBranch): WorkflowReturnObligation | undefined {
  return [...state.returns]
    .reverse()
    .find((entry) => entry.status === 'open' && branchKey(entry.branch) === branchKey(branch))
}
function startAttempt(
  state: WorkflowRun,
  stepId: string,
  branch?: WorkflowBranch,
  freshSession = false,
  sourceAttemptIds: number[] = [],
  feedback?: string,
  reviewBrief?: WorkflowReviewBriefBinding
): void {
  const step = stepById(state, stepId)
  if (step.kind === 'human-approval' && freshSession && reviewBrief?.kind !== 'legacy') reviewBrief = { kind: 'none' }
  if (step.kind === 'human-approval' && !reviewBrief) {
    const candidates = [
      ...new Map(
        [
          ...state.attempts.filter(
            (a) =>
              sourceAttemptIds.includes(a.id) && a.decisionBrief && effectiveWorkflowStep(state, a).kind === 'agent'
          ),
          ...workflowCarryForwardSources(state, sourceAttemptIds),
        ].map((a) => [a.id, a])
      ).values(),
    ]
    // A settled human round has already consumed its authored submission. A later
    // human-only return may carry that source, but cannot present it as newly authored.
    const reviewedSources = new Set(
      workflowEarlierHumanDecisions(state, stepId).flatMap((gate) =>
        gate.reviewBrief?.kind === 'authored' ? gate.reviewBrief.sourceAttemptIds : []
      )
    )
    const authored = candidates.filter(
      (a) => !reviewedSources.has(a.id) && a.decisionBrief!.contexts.some((c) => c.gateStepId === stepId)
    )
    const carried = candidates
      .filter((a) => !authored.includes(a))
      .sort((a, b) => b.decisionBrief!.submittedVersion - a.decisionBrief!.submittedVersion || b.id - a.id)[0]
    reviewBrief = authored.length
      ? {
          kind: 'authored',
          sourceAttemptIds: authored.map((a) => a.id).sort((a, b) => a - b),
          ...(carried ? { carriedSourceAttemptIds: [carried.id] } : {}),
        }
      : carried
        ? { kind: 'carried-forward', sourceAttemptId: carried.id }
        : workflowHasLegacyBriefSource(state, sourceAttemptIds)
          ? { kind: 'legacy' }
          : { kind: 'none' }
  }
  const exhausted =
    state.attempts.slice(state.attemptEpoch ?? 0).filter((attempt) => attempt.stepId === stepId).length >=
    (state.definition.limits.maxStepAttempts ?? Infinity)
  if (exhausted || activeWorkflowAttempts(state).length >= (state.definition.limits.maxParallelAttempts ?? Infinity)) {
    state.pendingStarts ??= []
    if (!state.pendingStarts.some((entry) => entry.stepId === stepId && branchKey(entry.branch) === branchKey(branch)))
      state.pendingStarts.push({ stepId, branch, freshSession, sourceAttemptIds, feedback, reviewBrief })
    if (exhausted) {
      state.status = 'paused'
      state.pauseReason = { type: 'attempt-limit', stepId }
    }
    syncActive(state)
    return
  }
  const attempt: WorkflowAttempt = {
    id: state.attempts.length + 1,
    sourceAttemptIds: [...sourceAttemptIds],
    ...(feedback ? { feedback } : {}),
    stepId,
    status: 'running',
    step: structuredClone(step),
    revision: state.revisions?.length ?? 0,
    ...(branch ? { branch } : {}),
    ...(freshSession ? { freshSession: true } : {}),
  }
  if (step.kind === 'agent') attempt.participant = structuredClone(state.definition.participants[step.participant]!)
  if (reviewBrief) attempt.reviewBrief = reviewBrief
  state.attempts.push(attempt)
  syncActive(state)
}
function finishState(state: WorkflowRun): WorkflowRun {
  syncActive(state)
  while (
    state.status === 'running' &&
    state.pendingStarts?.length &&
    activeWorkflowAttempts(state).length < (state.definition.limits.maxParallelAttempts ?? Infinity)
  ) {
    const next = state.pendingStarts.shift()!
    startAttempt(
      state,
      next.stepId,
      next.branch,
      next.freshSession,
      next.sourceAttemptIds,
      next.feedback,
      next.reviewBrief ?? (stepById(state, next.stepId).kind === 'human-approval' ? { kind: 'legacy' } : undefined)
    )
  }
  if (state.status === 'paused' || activeWorkflowAttempts(state).length || state.pendingStarts?.length) return state
  if (state.joins?.some((join) => join.status === 'open'))
    throw new Error('Parallel work cannot finish before every branch reaches its join')
  if (state.returns.some((entry) => entry.status === 'open'))
    throw new Error('Work cannot finish with an open return obligation')
  state.status = 'completion-ready'
  delete state.pauseReason
  return state
}
function continueAt(
  state: WorkflowRun,
  next: string,
  branch: WorkflowBranch | undefined,
  sourceAttemptIds: number[]
): void {
  const join = branch ? state.joins?.find((entry) => entry.id === branch.forkId && entry.status === 'open') : undefined
  if (branch && !join) throw new Error('Parallel branch has no open join')
  if (join && next === join.join) {
    if (!join.arrived.includes(branch!.branchId)) {
      join.arrived.push(branch!.branchId)
      join.sourceAttemptIds = [...new Set([...(join.sourceAttemptIds ?? []), ...sourceAttemptIds])]
    }
    if (join.branches.every((id) => join.arrived.includes(id))) {
      join.status = 'joined'
      continueAt(state, join.join, join.parent, join.sourceAttemptIds ?? [])
    }
    return
  }
  if (next === 'finish') {
    if (join) throw new Error('A parallel branch must reach its join before finishing')
    return
  }
  startAttempt(state, next, branch, false, sourceAttemptIds)
}

export function createWorkflowRun(definition: unknown): WorkflowRun {
  const parsed = workflowDefinitionSchema.parse(definition)
  const state: WorkflowRun = {
    schemaVersion: 1,
    version: 0,
    definition: parsed,
    status: 'running',
    activeAttemptId: null,
    attempts: [],
    returns: [],
    completedStepIds: [],
  }
  startAttempt(state, parsed.entry)
  return state
}

/** Earlier means a predecessor in the declared graph, not its array position. */
export function isEarlierWorkflowStep(state: WorkflowRun, target: string, current: string): boolean {
  if (target === current) return false
  const visited = new Set<string>()
  const pending = [target]
  while (pending.length) {
    const id = pending.pop()!
    if (id === current) return true
    if (id === 'finish' || visited.has(id)) continue
    visited.add(id)
    const step = stepById(state, id)
    for (const outcome of Object.values(step.outcomes)) {
      if ('next' in outcome) pending.push(outcome.next)
      else if ('parallel' in outcome) pending.push(...outcome.parallel)
    }
  }
  return false
}

function requestReturn(
  state: WorkflowRun,
  attempt: WorkflowAttempt,
  targetStepId: string,
  resumeAt: string,
  feedback: string,
  direct = false
): void {
  if (stepById(state, targetStepId).kind === 'decision') throw new Error('A decision step cannot do revisions')
  stepById(state, resumeAt)
  if (targetStepId === resumeAt) throw new Error('Rework and return destinations must be different steps')
  const parent = activeReturn(state, attempt.branch)
  const replaces = parent?.resumeAt === attempt.stepId
  const id = state.returns.length + 1
  if (parent && replaces) {
    parent.status = 'superseded'
    parent.supersededByReturnId = id
  }
  state.returns.push({
    id,
    requestedByAttemptId: attempt.id,
    ...(attempt.branch ? { branch: attempt.branch } : {}),
    targetStepId,
    resumeAt,
    direct,
    parentId: replaces ? parent.parentId : (parent?.id ?? null),
    feedback,
    status: 'open',
  })
  attempt.status = 'returned'
  attempt.feedback = feedback
  startAttempt(state, targetStepId, attempt.branch, false, [attempt.id])
}

/** The delivery agent attempt a completion-ready flow sends back to when rework is requested. */
export function workflowReworkAttempt(run: WorkflowRun): WorkflowAttempt | undefined {
  const target = run.definition.completion.changeEventsTo
  return [...run.attempts]
    .reverse()
    .find(
      (attempt) =>
        attempt.status === 'completed' &&
        (attempt.step ?? stepById(run, attempt.stepId)).kind === 'agent' &&
        (!target || target === 'delivery-owner' || attempt.stepId === target.step)
    )
}

/**
 * Pure transition kernel. The server must authorize the active step's actor and
 * atomically persist the result plus dispatch intent using expectedVersion.
 * This does not spawn agents, approve human gates, or mark a work stream done.
 */
export function advanceWorkflowRun(previous: WorkflowRun, input: unknown): WorkflowRun {
  const command = workflowCommandSchema.parse(input)
  if (command.expectedVersion !== previous.version) throw new Error('Stale workflow version')
  if (command.action === 'amend') return amendWorkflowAttempt(previous, command)
  if (command.action === 'rework') {
    if (previous.status !== 'completion-ready') throw new Error('Rework requires a completion-ready flow')
    const last = workflowReworkAttempt(previous)
    if (!last || last.id !== command.attemptId)
      throw new Error('Rework must reference the latest completed delivery agent attempt')
    const state = structuredClone(previous)
    // A completed parallel branch has a closed join. Replay its outer fork,
    // rather than detaching a branch and silently skipping its sibling gates.
    let entry = last
    while (entry.branch) {
      const fork = state.attempts.find((attempt) => attempt.id === entry.branch!.forkId)
      if (!fork) throw new Error('Rework branch has no fork attempt')
      entry = fork
    }
    state.status = 'running'
    state.version++
    state.completedStepIds = state.completedStepIds.filter(
      (id) => id !== entry.stepId && !isEarlierWorkflowStep(state, entry.stepId, id)
    )
    // Preserve evidence and attempt limits; rework is another attempt, not a reset.
    startAttempt(
      state,
      entry.stepId,
      undefined,
      false,
      [...new Set([...(entry.sourceAttemptIds ?? []), last.id])],
      command.feedback
    )
    state.revisions ??= [{ version: 0, definition: structuredClone(state.definition), reason: 'Initial flow' }]
    state.revisions.push({
      version: state.version,
      definition: structuredClone(state.definition),
      reason: `Rework: ${command.feedback}`,
    })
    return finishState(state)
  }
  if (command.action === 'revise') {
    if (
      command.attemptId === null
        ? activeWorkflowAttempts(previous).length > 0
        : !activeWorkflowAttempts(previous).some((entry) => entry.id === command.attemptId)
    )
      throw new Error('Stale step attempt')
    const state = structuredClone(previous)
    const resolved = resolveWorkflow(
      { kind: 'preset', id: 'revision', customizations: command.operations },
      { id: 'revision', revision: 'current', disabled: false, definition: state.definition }
    )
    for (const obligation of state.returns.filter((entry) => entry.status === 'open')) {
      for (const id of [obligation.targetStepId, obligation.resumeAt])
        if (!resolved.definition.steps.some((step) => step.id === id))
          throw new Error('Cannot remove a step referenced by an open return')
    }
    const active = activeWorkflowAttempts(state).find((attempt) => attempt.id === command.attemptId)
    for (const entry of [...activeWorkflowAttempts(state), ...(state.pendingStarts ?? [])]) {
      if (!resolved.definition.steps.some((step) => step.id === entry.stepId))
        throw new Error('Cannot remove an active or queued step')
    }
    for (const join of state.joins?.filter((entry) => entry.status === 'open') ?? []) {
      if (
        ![join.join, ...join.branches].every(
          (id) => id === 'finish' || resolved.definition.steps.some((step) => step.id === id)
        )
      )
        throw new Error('Cannot remove a destination of an open parallel join')
    }
    const affectedAttemptIds: number[] = []
    for (const kept of activeWorkflowAttempts(state).filter((entry) => entry !== active || command.active === 'keep')) {
      const step = kept.step ?? stepById(state, kept.stepId)
      if (step.kind === 'agent' && !resolved.definition.participants[step.participant])
        throw new Error('Cannot remove the active participant while keeping its attempt')
      const revised = resolved.definition.steps.find((entry) => entry.id === kept.stepId)!.outcomes
      const current = effectiveWorkflowStep(state, kept).outcomes
      // Do not silently repair legacy stale snapshots when an unrelated field is revised.
      const outcomes = sameOutcomes(stepById(state, kept.stepId).outcomes, revised) ? current : revised
      if (!sameOutcomes(current, outcomes)) {
        kept.effectiveOutcomes = { version: state.version + 1, outcomes: structuredClone(outcomes) }
        affectedAttemptIds.push(kept.id)
      }
      // Validate the newly effective routes, not destinations in the preserved initial snapshot.
      for (const target of Object.values(outcomes)) {
        const ids =
          'next' in target
            ? [target.next]
            : 'parallel' in target
              ? [...target.parallel, target.join]
              : [target.returnTo]
        if (ids.some((id) => id !== 'finish' && !resolved.definition.steps.some((entry) => entry.id === id)))
          throw new Error('Cannot remove a destination of the kept active attempt')
      }
    }
    state.revisions ??= [{ version: 0, definition: structuredClone(state.definition), reason: 'Initial flow' }]
    state.definition = resolved.definition
    state.version++
    state.revisions.push({
      version: state.version,
      definition: structuredClone(state.definition),
      reason: command.reason,
      affectedAttemptIds,
    })
    if (active && command.active === 'restart') {
      active.status = 'canceled'
      startAttempt(state, active.stepId, active.branch, true, active.sourceAttemptIds)
    }
    if (state.status !== 'running') {
      const pausedStep = state.pauseReason?.type === 'attempt-limit' ? state.pauseReason.stepId : undefined
      state.status = 'running'
      delete state.pauseReason
      if (!state.pendingStarts?.length && !activeWorkflowAttempts(state).length) {
        if (pausedStep) startAttempt(state, pausedStep)
      }
    }
    return finishState(state)
  }
  if (previous.status !== 'running') throw new Error(`Workflow is ${previous.status}`)
  if (!activeWorkflowAttempts(previous).some((entry) => entry.id === command.attemptId))
    throw new Error('Stale step attempt')
  const state = structuredClone(previous)
  const attempt = state.attempts.find((attempt) => attempt.id === command.attemptId)
  if (!attempt || attempt.status !== 'running') throw new Error('No active step attempt')
  const step = effectiveWorkflowStep(state, attempt)
  state.version += 1

  if (command.action === 'delegate') {
    if (state.definition.routing.delegation === 'disabled') throw new Error('Delegation is disabled for this workflow')
    const count = (state.delegationCount ?? 0) + 1
    if (count > state.definition.limits.maxDelegations)
      throw new Error('Delegation limit reached; request an authorized revision')
    const id = `delegation-${count}`
    if (state.definition.steps.some((entry) => entry.id === id) || Object.hasOwn(state.definition.participants, id))
      throw new Error('Delegation ID conflicts with an existing step or participant')
    state.delegationCount = count
    state.definition.participants[id] = command.participant
    state.definition.steps.push({
      id,
      kind: 'agent',
      participant: id,

      instructions: command.task,
      output: 'Requested specialist result and evidence.',
      outcomes: { completed: { next: step.id } },
    })
    const requester = stepById(state, step.id)
    requester.outcomes[id] = { returnTo: id, afterRework: 'return-to-requester' }
    workflowDefinitionSchema.parse(state.definition)
    requestReturn(state, attempt, id, step.id, command.task)
    return finishState(state)
  }

  recordReviewedRevisions(previous, attempt, command)
  if (command.action === 'return') {
    attempt.settledVersion = state.version
    recordDecisionBrief(state, previous, attempt, command)
    applyExplicitReturnRoute(state, attempt, step, command.targetStepId, command.resumeAt, command.feedback)
    return finishState(state)
  }

  if (!Object.hasOwn(step.outcomes, command.outcome)) throw new Error(`Unknown outcome '${command.outcome}'`)
  const transition = step.outcomes[command.outcome]!
  if (!command.evidence && workflowOutcomeRequiresEvidence(step, transition))
    throw new Error(
      step.kind !== 'agent'
        ? `Decision notes are required for '${command.outcome}': say what needs to change`
        : 'Evidence is required to complete this step'
    )
  attempt.outcome = command.outcome
  if (command.evidence) attempt.evidence = command.evidence
  attempt.settledVersion = state.version
  recordDecisionBrief(state, previous, attempt, command)
  applyCompletionRoute(state, attempt, step, transition, command.resume, command.evidence)
  return finishState(state)
}

type WorkflowBriefCommand = Extract<WorkflowCommand, { action: 'complete' | 'return' }>
type WorkflowAmendCommand = Extract<WorkflowCommand, { action: 'amend' }>

/**
 * A human decision records the source revisions it was made on. A client that names the revisions
 * it showed is refused when any is no longer current (Core answers the same check first, as a 409).
 */
function recordReviewedRevisions(previous: WorkflowRun, attempt: WorkflowAttempt, command: WorkflowCommand) {
  if (command.action !== 'complete' && command.action !== 'return') return
  if (!isWorkflowHumanDecisionAttempt(previous, attempt)) {
    if (command.reviewedRevisions) throw new Error('reviewedRevisions is only for human review decisions')
    return
  }
  const current = workflowGateRevisions(previous, attempt)
  const refusal = workflowReviewDecisionRefusal(command.reviewedRevisions, current, command.expectedVersion)
  if (refusal) throw new Error(refusal)
  attempt.reviewedRevisions = current.map(({ attemptId, revision }) => ({ attemptId, revision }))
}

/**
 * Record a new result revision of a completed attempt. The previous result moves, unchanged, to
 * `earlierResults`; the attempt's own fields hold the new one. Nothing else in the run changes: no
 * attempt starts or settles, no gate closes or opens, and no review round is counted.
 */
function amendWorkflowAttempt(previous: WorkflowRun, command: WorkflowAmendCommand): WorkflowRun {
  const eligible = workflowAmendEligibility(previous, command.attemptId)
  if (!eligible.ok) throw new Error(eligible.reason)
  const gateStepIds = [...new Set(eligible.gates.map((gate) => gate.stepId))].sort()
  requireChangesSinceLastReview(previous, gateStepIds, command.decisionBrief)
  const state = structuredClone(previous)
  const attempt = state.attempts.find((entry) => entry.id === command.attemptId)!
  state.version += 1
  const revision = workflowResultRevision(attempt)
  const prior = attempt.resultRevisedVersion ?? attempt.settledVersion
  attempt.earlierResults = [
    ...(attempt.earlierResults ?? []),
    {
      revision,
      ...(prior !== undefined ? { version: prior } : {}),
      ...(attempt.resultRevisedAt ? { recordedAt: attempt.resultRevisedAt } : {}),
      ...(attempt.evidence !== undefined ? { evidence: attempt.evidence } : {}),
      ...(attempt.decisionBrief ? { decisionBrief: attempt.decisionBrief } : {}),
      // Core fills this from the attachment rows, which the pure kernel cannot see.
      attachmentIds: attempt.attachmentIds ? [...attempt.attachmentIds] : [],
    },
  ]
  attempt.resultRevision = revision + 1
  attempt.resultRevisedVersion = state.version
  delete attempt.resultRevisedAt
  attempt.evidence = command.evidence
  // The gate round is the same, so the context recorded at completion (earlier decision, returns,
  // revisions and interruptions before the gate opened) still describes it.
  const recorded = attempt.decisionBrief?.contexts ?? []
  attempt.decisionBrief = {
    value: command.decisionBrief,
    submittedVersion: state.version,
    contexts: gateStepIds.map(
      (gateStepId) =>
        recorded.find((context) => context.gateStepId === gateStepId) ?? {
          gateStepId,
          previousDecisionAttemptId: workflowEarlierHumanDecisions(previous, gateStepId)[0]?.id,
          returnIds: [],
          revisionVersions: [],
          interruptedExecutions: [],
        }
    ),
  }
  return state
}

function requireChangesSinceLastReview(
  run: WorkflowRun,
  targets: string[],
  brief: { changesSinceLastReview?: string } | undefined
) {
  const previous = targets
    .map((id) => ({ id, decision: workflowEarlierHumanDecisions(run, id)[0] }))
    .filter((t) => t.decision)
  if (previous.length && !brief?.changesSinceLastReview)
    throw new Error(
      `decisionBrief.changesSinceLastReview is required because ${previous.map((t) => `human approval '${t.id}' has an earlier decision (attempt ${t.decision!.id})`).join('; ')}.`
    )
}

function recordDecisionBrief(
  state: WorkflowRun,
  previous: WorkflowRun,
  attempt: WorkflowAttempt,
  command: WorkflowBriefCommand
) {
  const targets = validateWorkflowDecisionBrief(previous, command)
  if (command.decisionBrief)
    attempt.decisionBrief = {
      value: command.decisionBrief,
      submittedVersion: state.version,
      contexts: targets.map((gateStepId) => ({
        gateStepId,
        previousDecisionAttemptId: workflowEarlierHumanDecisions(previous, gateStepId)[0]?.id,
        returnIds: [],
        revisionVersions: [],
        interruptedExecutions: [],
      })),
    }
}

/** Explicit return authorization and routing, shared by acceptance and read-only preflight. */
function applyExplicitReturnRoute(
  state: WorkflowRun,
  attempt: WorkflowAttempt,
  step: WorkflowStep,
  targetStepId: string,
  resumeAt: string,
  feedback: string
): string[] {
  const declared = Object.values(step.outcomes).some(
    (outcome) =>
      'returnTo' in outcome &&
      outcome.returnTo === targetStepId &&
      resumeAt === step.id &&
      outcome.afterRework === 'return-to-requester'
  )
  const flexible =
    state.definition.routing.mode !== 'guided' &&
    state.definition.routing.returnTo === 'earlier-steps' &&
    resumeAt === step.id &&
    isEarlierWorkflowStep(state, targetStepId, step.id)
  if (!declared && !flexible) throw new Error('Return path is not allowed by this workflow')
  requestReturn(state, attempt, targetStepId, resumeAt, feedback)
  return [targetStepId]
}

export function workflowReturnReviewTargets(
  run: WorkflowRun,
  attempt: WorkflowAttempt,
  targetStepId: string,
  resumeAt = attempt.stepId
): string[] {
  const state = structuredClone(run)
  const source = state.attempts.find((a) => a.id === attempt.id)!
  const targets = applyExplicitReturnRoute(
    state,
    source,
    effectiveWorkflowStep(state, source),
    targetStepId,
    resumeAt,
    'Routing preflight.'
  )
  return targets.filter((id) => state.definition.steps.find((s) => s.id === id)?.kind === 'human-approval')
}

/** The single effective routing implementation, used on a clone for preflight as well as acceptance. */
function applyCompletionRoute(
  state: WorkflowRun,
  attempt: WorkflowAttempt,
  step: WorkflowStep,
  transition: WorkflowTransition,
  resume: boolean,
  evidence: string
): string[] {
  if ('returnTo' in transition) {
    if (resume) throw new Error('A rework request cannot also resolve a return')
    if (transition.afterRework === 'return-to-requester') {
      requestReturn(state, attempt, transition.returnTo, step.id, evidence, true)
    } else {
      attempt.status = 'returned'
      attempt.feedback = evidence
      startAttempt(state, transition.returnTo, attempt.branch, false, [attempt.id])
    }
    return [transition.returnTo]
  }

  attempt.status = 'completed'
  if (!state.completedStepIds.includes(step.id)) state.completedStepIds.push(step.id)
  let obligation = activeReturn(state, attempt.branch)
  if (obligation?.direct && obligation.targetStepId === step.id && obligation.resumeAt !== step.id) {
    continueAt(state, obligation.resumeAt, attempt.branch, [attempt.id])
    return [obligation.resumeAt]
  }
  if (resume) {
    if (!obligation || obligation.resumeAt === step.id) throw new Error('No return destination for this result')
    continueAt(state, obligation.resumeAt, attempt.branch, [attempt.id])
    return [obligation.resumeAt]
  }
  if (obligation?.resumeAt === step.id) {
    obligation.status = 'resolved'
    obligation.resolvedByAttemptId = attempt.id
    obligation = activeReturn(state, attempt.branch)
  }
  // A nested correction may just have returned to the outer correction step.
  if (obligation?.direct && obligation.targetStepId === step.id && obligation.resumeAt !== step.id) {
    continueAt(state, obligation.resumeAt, attempt.branch, [attempt.id])
    return [obligation.resumeAt]
  }
  let destinations: string[]
  if ('parallel' in transition) {
    destinations = [...transition.parallel]
    const id = attempt.id
    state.joins ??= []
    state.joins.push({
      id,
      join: transition.join,
      branches: [...transition.parallel],
      arrived: [],
      status: 'open',
      ...(attempt.branch ? { parent: attempt.branch } : {}),
    })
    for (const branchId of transition.parallel) continueAt(state, branchId, { forkId: id, branchId }, [attempt.id])
  } else {
    const join = attempt.branch ? state.joins?.find((entry) => entry.id === attempt.branch!.forkId) : undefined
    const next =
      obligation && (transition.next === 'finish' || transition.next === join?.join)
        ? obligation.resumeAt
        : transition.next
    destinations = [next]
    continueAt(state, next, attempt.branch, [attempt.id])
  }
  return destinations
}

export function workflowCompletionTargets(
  run: WorkflowRun,
  attempt: WorkflowAttempt,
  outcome: string,
  resume = false
): string[] {
  const state = structuredClone(run)
  const source = state.attempts.find((a) => a.id === attempt.id)!
  const step = effectiveWorkflowStep(state, source)
  const transition = step.outcomes[outcome]
  if (!transition) throw new Error(`Unknown outcome '${outcome}'`)
  return [...new Set(applyCompletionRoute(state, source, step, transition, resume, 'Routing preflight.'))]
}

export function workflowCompletionReviewTargets(
  run: WorkflowRun,
  attempt: WorkflowAttempt,
  outcome: string,
  resume = false
): string[] {
  return workflowCompletionTargets(run, attempt, outcome, resume)
    .filter((id) => run.definition.steps.find((s) => s.id === id)?.kind === 'human-approval')
    .sort()
}

/** Contextual validation must run before any persistent state, wait or dispatch side effect. */
export function validateWorkflowDecisionBrief(run: WorkflowRun, command: WorkflowBriefCommand): string[] {
  const attempt = run.attempts.find((a) => a.id === command.attemptId)
  if (!attempt || effectiveWorkflowStep(run, attempt).kind !== 'agent') return []
  const targets =
    command.action === 'complete'
      ? workflowCompletionReviewTargets(run, attempt, command.outcome, command.resume)
      : workflowReturnReviewTargets(run, attempt, command.targetStepId, command.resumeAt)
  if (targets.length && !command.decisionBrief)
    throw new Error(
      `A decisionBrief is required for ${command.action === 'complete' ? `outcome '${command.outcome}'` : `return to '${command.targetStepId}'`} because it sends this agent's result to human approval '${targets.join("', '")}'. Add decisionBrief to the same advance command JSON, alongside evidence for complete or feedback for return, with decision, recommendation, approvalEffect and risks. Add changesSinceLastReview after an earlier decision on the same gate. Write normal readable prose; preserve exact resource identifiers.`
    )
  requireChangesSinceLastReview(run, targets, command.decisionBrief)
  return targets
}

/** Explicit reopen keeps the audit trail but starts a new bounded pass through the flow. */
export function reopenWorkflowRun(previous: WorkflowRun): WorkflowRun {
  const state = structuredClone(previous)
  for (const active of activeWorkflowAttempts(state)) active.status = 'canceled'
  for (const join of state.joins ?? []) if (join.status === 'open') join.status = 'canceled'
  state.pendingStarts = []
  for (const obligation of state.returns) if (obligation.status === 'open') obligation.status = 'superseded'
  state.completedStepIds = []
  state.attemptEpoch = state.attempts.length
  state.delegationCount = previous.delegationCount ?? 0
  state.status = 'running'
  delete state.pauseReason
  state.version++
  state.revisions ??= [{ version: 0, definition: structuredClone(state.definition), reason: 'Initial flow' }]
  state.revisions.push({
    version: state.version,
    definition: structuredClone(state.definition),
    reason: 'Work stream reopened',
  })
  startAttempt(state, state.definition.entry)
  const next = state.attempts.find((entry) => entry.id === state.activeAttemptId)
  if (next) next.freshSession = true
  return state
}
