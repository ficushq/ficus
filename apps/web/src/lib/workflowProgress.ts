import {
  activeWorkflowAttempts,
  activityAgentLabel,
  isEarlierWorkflowStep,
  workStreamSlotWaitLabel,
  type WorkflowAttempt,
  type WorkflowRun,
  type WorkflowStep,
  type WorkStreamSlotWait,
  type WorkStreamWait,
} from '@ficus/shared'
import type { WorkStreamViewer } from './workStreamRuntime'

/**
 * The compact Progress list in the work stream modal.
 *
 * Listing rule. Steps are listed in the order the flow first reaches them from its entry, following
 * each step's forward outcomes (`next` and `parallel`). Each step appears once and shows its latest
 * state, so:
 * - a rework edge (`returnTo`) is not a step of its own: the step it sends work back to shows
 *   "Returned for rework" while it runs again, and completed steps after it that the work will pass
 *   through again read "Runs again" rather than "Done" (unless the correction goes straight back to
 *   the step that asked for it, which skips the steps in between);
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
  /**
   * Who does the step: an agent role, the decision model, or for a human approval "You" when the
   * viewer decides it, else the assigned reviewers by name, else "Reviewer".
   */
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
  /** The stream's assigned reviewers (user IDs), who decide its assigned-reviewers approvals. */
  assignedReviewerIds?: string[]
  /** People with review permission in the squad, to name approvers; absent while unknown. */
  reviewers?: Array<{ id: string; name: string }>
  /** Who is looking; undefined while their permissions load, which never says "You". */
  viewer?: WorkStreamViewer
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

/** "Ana", "Ana or Ben", "Ana, Ben or Cy", "Ana, Ben or 2 others": any one of them decides. */
function anyOf(names: string[], unnamed = 0): string {
  const shown = names.length > 3 || (names.length === 3 && unnamed > 0) ? names.slice(0, 2) : names
  const others = names.length - shown.length + unnamed
  if (others > 0) return `${shown.join(', ')} or ${others} ${others === 1 ? 'other' : 'others'}`
  return shown.length > 1 ? `${shown.slice(0, -1).join(', ')} or ${shown.at(-1)}` : shown[0]!
}

/**
 * Who decides a human approval, mirroring Core's mayDecideFlowGate: anyone with review permission,
 * or for an assigned-reviewers step on a stream with assigned reviewers, one of them. "You" is said
 * only before the decision (a finished approval records no decider) and only to a user who may decide.
 */
function approverWho(step: WorkflowStep, state: WorkflowProgressState, context: WorkflowProgressContext): string {
  const assigned = context.assignedReviewerIds ?? []
  const limited = step.kind === 'human-approval' && step.approver !== 'reviewers' && assigned.length > 0
  const viewer = context.viewer
  const userId = viewer?.identity?.type === 'user' ? viewer.identity.userId : undefined
  const viewerDecides = !!userId && viewer!.can('workstreams:review') && (!limited || assigned.includes(userId))
  if (viewerDecides && state !== 'done' && state !== 'not-run') return 'You'
  const nameOf = (id: string) => context.reviewers?.find((person) => person.id === id)?.name
  if (limited) {
    const names = assigned.map(nameOf).filter((name): name is string => !!name)
    return names.length ? anyOf(names, assigned.length - names.length) : 'Assigned reviewer'
  }
  // Anyone with review permission decides; name them only when there is exactly one.
  return context.reviewers?.length === 1 ? context.reviewers[0]!.name : 'Reviewer'
}

function stepWho(
  step: WorkflowStep,
  state: WorkflowProgressState,
  run: WorkflowRun,
  context: WorkflowProgressContext
): string {
  if (step.kind === 'human-approval') return approverWho(step, state, context)
  if (step.kind === 'decision') return 'Decision model'
  return activityAgentLabel(run.definition.participants[step.participant]?.agentTypeId ?? null)
}

/**
 * Steps the work will pass through again: those after a step it has gone back to (a
 * running or queued attempt) in the listing order and reachable from it along forward outcomes. When
 * an open return sends the corrected work straight back to the step that asked for it, the steps in
 * between are skipped, so the count starts from that requester instead. Only a completed step's
 * state changes for it: "Runs again" rather than "Done".
 */
function stepsRunningAgain(
  run: WorkflowRun,
  order: Array<{ id: string }>,
  context: WorkflowProgressContext
): Set<string> {
  const again = new Set<string>()
  if (['done', 'canceled'].includes(context.status)) return again
  const position = new Map(order.map((entry, index) => [entry.id, index]))
  const restarts = [
    ...activeWorkflowAttempts(run).map((attempt) => attempt.stepId),
    ...(run.pendingStarts ?? []).map((pending) => pending.stepId),
  ]
  for (const stepId of new Set(restarts)) {
    const obligation = run.returns
      .slice()
      .reverse()
      .find((entry) => entry.status === 'open' && entry.targetStepId === stepId)
    const from = obligation?.resumeAt ?? stepId
    if (obligation) again.add(obligation.resumeAt)
    const start = position.get(from)
    if (start === undefined) continue
    for (const entry of order.slice(start + 1)) if (isEarlierWorkflowStep(run, from, entry.id)) again.add(entry.id)
  }
  return again
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
  context: WorkflowProgressContext,
  runsAgain: ReadonlySet<string> = new Set()
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
  if (run.completedStepIds.includes(step.id)) {
    if (!runsAgain.has(step.id)) return withAgent('done', 'Done')
    return withAgent('upcoming', latest?.status === 'returned' ? 'Sent back; runs again' : 'Runs again')
  }
  if (['done', 'canceled'].includes(context.status)) return withAgent('not-run', 'Not run')
  if (latest?.status === 'returned') return withAgent('upcoming', 'Sent back; runs again')
  return withAgent('upcoming', 'Upcoming')
}

export function workflowProgress(run: WorkflowRun, context: WorkflowProgressContext): WorkflowProgress {
  const steps = run.definition.steps
  const order = workflowListOrder(steps, run.definition.entry)
  const runsAgain = order ? stepsRunningAgain(run, order, context) : new Set<string>()
  const describe = (step: WorkflowStep, parallel = false): WorkflowProgressStep => {
    const state = stepState(step, run, context, runsAgain)
    return {
      id: step.id,
      name: workflowStepDisplayName(step),
      who: stepWho(step, state.state, run, context),
      ...state,
      ...(parallel ? { parallel } : {}),
    }
  }
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
