import {
  activeWorkflowAttempts,
  activityAgentLabel,
  workStreamSlotWaitLabel,
  type WorkflowAttempt,
  type WorkflowRun,
  type WorkflowStep,
  type WorkStreamSlotWait,
  type WorkStreamWait,
} from '@ficus/shared'

/**
 * The compact Progress list in the work stream modal.
 *
 * Listing rule. Steps are listed in the order the flow first reaches them from its entry, following
 * each step's forward outcomes (`next` and `parallel`). Each step appears once and shows its latest
 * state, so:
 * - a rework edge (`returnTo`) is not a step of its own: the step it sends work back to shows
 *   "Returned for rework" while it runs again;
 * - a loop (an outcome back to a step already listed) does not repeat that step;
 * - parallel branches are listed one after another, each marked as running in parallel, and the
 *   list continues at their join;
 * - an outcome that goes straight to `finish` ends the work early; it does not branch the list.
 *   Once the stream is done or canceled, steps that never ran say "Not run".
 *
 * A flow cannot be shown honestly as a list when one step can lead to two or more different steps
 * that have not been listed yet (true alternatives, such as a decision step choosing a path, or a
 * fork alongside a plain next step). Then only the current steps are shown and the graph carries
 * the full shape.
 */

export type WorkflowProgressState = 'done' | 'active' | 'waiting' | 'rework' | 'queued' | 'upcoming' | 'not-run'

export interface WorkflowProgressStep {
  id: string
  name: string
  state: WorkflowProgressState
  /** Plain words for the state, shown beside the step. */
  label: string
  /** Who does the step: an agent role, or a person or decision model for the non-agent kinds. */
  who: string
  /** The agent bound to the step's latest attempt, when one is. */
  agentId?: string
  /** Listed as one branch of a parallel fork. */
  parallel?: boolean
}

export type WorkflowProgress =
  | { kind: 'list'; steps: WorkflowProgressStep[] }
  /** The flow branches: only the steps under way now (possibly none). */
  | { kind: 'current'; steps: WorkflowProgressStep[]; total: number; done: number }

export interface WorkflowProgressContext {
  /** The stream's lifecycle status. */
  status: string
  openWaits: WorkStreamWait[]
  attemptAgents: Record<string, string>
  paused?: boolean
  slotWait?: WorkStreamSlotWait
  /** The stream has assigned reviewers, which decide its assigned-reviewers approvals. */
  hasAssignedReviewers?: boolean
}

/** `design-approval` → `Design approval`, unless the step has a display name. */
export function workflowStepDisplayName(step: Pick<WorkflowStep, 'id' | 'name'>): string {
  const name = step.name?.trim()
  if (name) return name
  const words = step.id.replace(/-/g, ' ')
  return words[0]!.toUpperCase() + words.slice(1)
}

function forwardTargets(step: WorkflowStep) {
  const next: string[] = []
  const parallel: Array<{ branches: string[]; join: string }> = []
  for (const transition of Object.values(step.outcomes)) {
    if ('next' in transition) next.push(transition.next)
    else if ('parallel' in transition) parallel.push({ branches: transition.parallel, join: transition.join })
  }
  return { next, parallel }
}

/** The listing order, or null when the flow has true alternatives and cannot be listed honestly. */
export function workflowListOrder(
  steps: readonly WorkflowStep[],
  entry: string
): Array<{ id: string; parallel: boolean }> | null {
  const byId = new Map(steps.map((step) => [step.id, step]))
  const listed = new Set<string>()
  const order: Array<{ id: string; parallel: boolean }> = []
  // Walk one path until `finish`, a listed step or `stop` (a fork's join). False: not listable.
  const walk = (start: string, stop: string | undefined, parallel: boolean): boolean => {
    let current: string | undefined = start
    while (current && current !== 'finish' && current !== stop && !listed.has(current)) {
      const step = byId.get(current)
      if (!step) return true
      listed.add(current)
      order.push({ id: current, parallel })
      const { next, parallel: forks } = forwardTargets(step)
      const fresh = [...new Set(next)].filter((id) => id !== 'finish' && !listed.has(id))
      const forkGroups = [...new Map(forks.map((fork) => [JSON.stringify(fork), fork])).values()]
      if (forkGroups.length > 1 || (forkGroups.length === 1 && fresh.length > 0) || fresh.length > 1) return false
      if (forkGroups.length === 1) {
        const fork = forkGroups[0]!
        for (const branch of fork.branches) if (!walk(branch, fork.join, true)) return false
        current = fork.join === stop ? undefined : fork.join
      } else current = fresh[0]
    }
    return true
  }
  return walk(entry, undefined, false) ? order : null
}

function stepWho(step: WorkflowStep, run: WorkflowRun, context: WorkflowProgressContext): string {
  if (step.kind === 'human-approval')
    return step.approver === 'assigned-reviewers' && context.hasAssignedReviewers ? 'Assigned reviewer' : 'Reviewer'
  if (step.kind === 'decision') return 'Decision model'
  return activityAgentLabel(run.definition.participants[step.participant]?.agentTypeId ?? null)
}

/** Whether this attempt was started because a later step sent the work back. */
function isRework(run: WorkflowRun, attempt: WorkflowAttempt): boolean {
  if (run.returns.some((entry) => entry.status === 'open' && entry.targetStepId === attempt.stepId)) return true
  return (attempt.sourceAttemptIds ?? []).some(
    (id) => run.attempts.find((source) => source.id === id)?.status === 'returned'
  )
}

function stepState(
  step: WorkflowStep,
  run: WorkflowRun,
  context: WorkflowProgressContext
): Pick<WorkflowProgressStep, 'state' | 'label' | 'agentId'> {
  const pass = run.attempts.slice(run.attemptEpoch ?? 0).filter((attempt) => attempt.stepId === step.id)
  const latest = pass.at(-1)
  const agentId = latest ? context.attemptAgents[latest.id] : undefined
  const withAgent = (state: WorkflowProgressState, label: string) => ({ state, label, ...(agentId ? { agentId } : {}) })
  const running = activeWorkflowAttempts(run).filter((attempt) => attempt.stepId === step.id)
  if (running.length) {
    const terminal = ['done', 'canceled'].includes(context.status)
    if (terminal) return withAgent('not-run', 'Stopped')
    if (context.status === 'queued') return withAgent('queued', 'Queued')
    if (context.paused) return withAgent('waiting', 'Paused')
    if (run.status === 'paused') return withAgent('waiting', 'Needs a decision')
    const waited = running.some((attempt) =>
      context.openWaits.some((wait) => wait.flowAttemptId == null || wait.flowAttemptId === attempt.id)
    )
    if (waited)
      return withAgent(
        'waiting',
        step.kind === 'human-approval'
          ? 'Waiting for review'
          : step.kind === 'decision'
            ? 'Waiting for a decision'
            : 'Waiting for input'
      )
    if (context.slotWait && running.some((attempt) => attempt.id === context.slotWait!.attemptId))
      return withAgent('queued', workStreamSlotWaitLabel(context.slotWait))
    if (running.some((attempt) => isRework(run, attempt))) return withAgent('rework', 'Returned for rework')
    return withAgent('active', 'In progress')
  }
  if (run.pendingStarts?.some((pending) => pending.stepId === step.id))
    return withAgent('queued', 'Queued for capacity')
  const join = run.joins
    ?.slice()
    .reverse()
    .find((entry) => entry.join === step.id && entry.status === 'open')
  if (join) return withAgent('waiting', `Waiting for branches (${join.arrived.length}/${join.branches.length})`)
  if (run.completedStepIds.includes(step.id)) return withAgent('done', 'Done')
  if (['done', 'canceled'].includes(context.status)) return withAgent('not-run', 'Not run')
  if (latest?.status === 'returned') return withAgent('upcoming', 'Sent back; runs again')
  return withAgent('upcoming', 'Upcoming')
}

export function workflowProgress(run: WorkflowRun, context: WorkflowProgressContext): WorkflowProgress {
  const steps = run.definition.steps
  const describe = (step: WorkflowStep, parallel = false): WorkflowProgressStep => ({
    id: step.id,
    name: workflowStepDisplayName(step),
    who: stepWho(step, run, context),
    ...stepState(step, run, context),
    ...(parallel ? { parallel } : {}),
  })
  const order = workflowListOrder(steps, run.definition.entry)
  if (!order) {
    const described = steps.map((step) => describe(step))
    return {
      kind: 'current',
      steps: described.filter((step) => ['active', 'waiting', 'rework', 'queued'].includes(step.state)),
      total: described.length,
      done: described.filter((step) => step.state === 'done').length,
    }
  }
  const byId = new Map(steps.map((step) => [step.id, step]))
  const listed = new Set(order.map((entry) => entry.id))
  // Steps the forward walk never reaches run only by explicit routing; list them once they have.
  const ranElsewhere = steps.filter(
    (step) => !listed.has(step.id) && run.attempts.slice(run.attemptEpoch ?? 0).some((a) => a.stepId === step.id)
  )
  return {
    kind: 'list',
    steps: [
      ...order.map((entry) => describe(byId.get(entry.id)!, entry.parallel)),
      ...ranElsewhere.map((step) => describe(step)),
    ],
  }
}
