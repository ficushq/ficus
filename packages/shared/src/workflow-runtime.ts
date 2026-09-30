import { z } from 'zod'
import {
  workflowDefinitionSchema,
  workflowParticipantSchema,
  workflowCustomizationSchema,
  resolveWorkflow,
  type WorkflowDefinition,
  type WorkflowStep,
  type WorkflowParticipant,
} from './workflows'

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
  /** Attempts whose handoffs directly started this attempt (empty for the entry). */
  sourceAttemptIds?: number[]
  /** Durable command-response handoff; no inbox delivery is needed for this attempt. */
  responseAssignment?: { requestId: string; agentId: string; version: number; content: string }
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
  expectedVersion: z.number().int().nonnegative(),
  attemptId: z.number().int().positive(),
}
export const workflowCommandSchema = z.discriminatedUnion('action', [
  z
    .object({
      ...commandFields,
      action: z.literal('rework'),
      feedback: z.string().trim().min(1).max(64_000),
    })
    .strict(),
  z
    .object({
      ...commandFields,
      action: z.literal('delegate'),
      participant: workflowParticipantSchema,
      task: z.string().trim().min(1).max(64000),
    })
    .strict(),
  z
    .object({
      expectedVersion: commandFields.expectedVersion,
      attemptId: commandFields.attemptId.nullable(),
      action: z.literal('revise'),
      operations: z.array(workflowCustomizationSchema).min(1).max(512),
      reason: z.string().trim().min(1).max(4000),
      active: z.enum(['keep', 'restart']),
    })
    .strict(),
  z
    .object({
      ...commandFields,
      action: z.literal('complete'),
      outcome: z.string().min(1).max(100),
      evidence: z.string().trim().min(1).max(64_000),
      // An agent doing rework may return its result directly to the requester.
      resume: z.boolean().default(false),
    })
    .strict(),
  z
    .object({
      ...commandFields,
      action: z.literal('return'),
      targetStepId: z.string().min(1).max(100),
      resumeAt: z.string().min(1).max(100),
      feedback: z.string().trim().min(1).max(64_000),
    })
    .strict(),
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
  feedback?: string
): void {
  const step = stepById(state, stepId)
  const exhausted =
    state.attempts.slice(state.attemptEpoch ?? 0).filter((attempt) => attempt.stepId === stepId).length >=
    (state.definition.limits.maxStepAttempts ?? Infinity)
  if (exhausted || activeWorkflowAttempts(state).length >= (state.definition.limits.maxParallelAttempts ?? Infinity)) {
    state.pendingStarts ??= []
    if (!state.pendingStarts.some((entry) => entry.stepId === stepId && branchKey(entry.branch) === branchKey(branch)))
      state.pendingStarts.push({ stepId, branch, freshSession, sourceAttemptIds, feedback })
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
    startAttempt(state, next.stepId, next.branch, next.freshSession, next.sourceAttemptIds, next.feedback)
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
  stepById(state, targetStepId)
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

  if (command.action === 'return') {
    const declared = Object.values(step.outcomes).some(
      (outcome) =>
        'returnTo' in outcome &&
        outcome.returnTo === command.targetStepId &&
        command.resumeAt === step.id &&
        outcome.afterRework === 'return-to-requester'
    )
    const flexible =
      state.definition.routing.mode !== 'guided' &&
      state.definition.routing.returnTo === 'earlier-steps' &&
      command.resumeAt === step.id &&
      isEarlierWorkflowStep(state, command.targetStepId, step.id)
    if (!declared && !flexible) throw new Error('Return path is not allowed by this workflow')
    requestReturn(state, attempt, command.targetStepId, command.resumeAt, command.feedback)
    return finishState(state)
  }

  if (!Object.hasOwn(step.outcomes, command.outcome)) throw new Error(`Unknown outcome '${command.outcome}'`)
  const transition = step.outcomes[command.outcome]!
  attempt.outcome = command.outcome
  attempt.evidence = command.evidence
  if ('returnTo' in transition) {
    if (command.resume) throw new Error('A rework request cannot also resolve a return')
    if (transition.afterRework === 'return-to-requester') {
      requestReturn(state, attempt, transition.returnTo, step.id, command.evidence, true)
    } else {
      attempt.status = 'returned'
      attempt.feedback = command.evidence
      startAttempt(state, transition.returnTo, attempt.branch, false, [attempt.id])
    }
    return finishState(state)
  }

  attempt.status = 'completed'
  if (!state.completedStepIds.includes(step.id)) state.completedStepIds.push(step.id)
  let obligation = activeReturn(state, attempt.branch)
  if (obligation?.direct && obligation.targetStepId === step.id && obligation.resumeAt !== step.id) {
    continueAt(state, obligation.resumeAt, attempt.branch, [attempt.id])
    return finishState(state)
  }
  if (command.resume) {
    if (!obligation || obligation.resumeAt === step.id) throw new Error('No return destination for this result')
    continueAt(state, obligation.resumeAt, attempt.branch, [attempt.id])
    return finishState(state)
  }
  if (obligation?.resumeAt === step.id) {
    obligation.status = 'resolved'
    obligation.resolvedByAttemptId = attempt.id
    obligation = activeReturn(state, attempt.branch)
  }
  // A nested correction may just have returned to the outer correction step.
  if (obligation?.direct && obligation.targetStepId === step.id && obligation.resumeAt !== step.id) {
    continueAt(state, obligation.resumeAt, attempt.branch, [attempt.id])
    return finishState(state)
  }
  if ('parallel' in transition) {
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
    continueAt(state, next, attempt.branch, [attempt.id])
  }
  return finishState(state)
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
