import {
  selectWorkStreamPresentationState,
  workStreamNeedsHumanAttention,
  type Agent,
  type AgentErrorActionData,
  type PendingAction,
  type QuestionActionData,
  type WorkStream,
  type WorkStreamPresentationState,
} from '@ficus/shared'
import type { BadgeKind, PlantState, RobotFace } from './types'

/**
 * What a live work stream's plant looks like, or null for done/canceled streams
 * (those become harvest crates and compost, not plants).
 *
 * This reads the one shared display state, `selectWorkStreamPresentationState`,
 * so the farm never disagrees with the web status pill. That selector already
 * applies the precedence the server documents: terminal status, then pause,
 * then the explicit open-wait list (review > question > dependency > manual,
 * with a workflow approval gate counted as review), then a failed execution,
 * then delivery, then queued / in_progress / idle.
 *
 * | presentation state                      | plant     |
 * | --------------------------------------- | --------- |
 * | done, canceled                          | null      |
 * | queued (deps not all done)              | waiting   |
 * | queued                                  | queued    |
 * | waiting_on_dependency                   | waiting   |
 * | paused                                  | paused    |
 * | in_progress, active                     | growing   |
 * | delivery_external                       | delivering |
 * | waiting_on_answer                       | question  |
 * | in_review, delivery_approval/review/merge | review  |
 * | blocked, human can act                  | blocked   |
 * | blocked, human cannot act               | waiting   |
 * | idle                                    | idle      |
 * | execution_failed, delivery_failure/setup | failed   |
 * | anything else (future states)           | growing   |
 *
 * `blocked` is split with `workStreamNeedsHumanAttention`, which is the
 * shared definition of "a manual wait the human can clear". The selector only
 * yields `blocked` from a manual wait or from a legacy payload with no wait
 * list, and both count as attention, so the `waiting` branch is a guard for
 * future producers rather than a path taken today.
 *
 * A queued stream whose dependencies aren't done (`waitingOnDependencies`,
 * set by the server) is drawn as `waiting`, not a seed stake: it is waiting on
 * another work stream, not on a slot.
 */
type PlantRule = PlantState | null | ((stream: WorkStream) => PlantState)

/**
 * Every shared presentation state, so a state added to @ficus/shared fails to
 * compile here until the farm draws it, rather than quietly growing.
 */
const PLANT_FOR_STATE: Record<WorkStreamPresentationState, PlantRule> = {
  done: null,
  canceled: null,
  queued: (stream) => (stream.waitingOnDependencies ? 'waiting' : 'queued'),
  waiting_on_dependency: 'waiting',
  paused: 'paused',
  in_progress: 'growing',
  active: 'growing',
  // Handed to the code host: the pull request is open and nobody here has to act
  // (CI, automatic merge, or a merge Ficus hears about from the provider).
  delivery_external: 'delivering',
  waiting_on_answer: 'question',
  in_review: 'review',
  delivery_approval: 'review',
  delivery_review: 'review',
  delivery_merge: 'review',
  blocked: (stream) => (workStreamNeedsHumanAttention(stream) ? 'blocked' : 'waiting'),
  idle: 'idle',
  execution_failed: 'failed',
  delivery_failure: 'failed',
  delivery_setup: 'failed',
}

export function plantStateFor(stream: WorkStream): PlantState | null {
  const rule = PLANT_FOR_STATE[selectWorkStreamPresentationState(stream)]
  // A state from a newer server than this farm: draw it as growing.
  if (rule === undefined) return 'growing'
  return typeof rule === 'function' ? rule(stream) : rule
}

/**
 * The badge over a plant. Badges appear only when the human can act, so this
 * is exactly `workStreamNeedsHumanAttention`: a badge is shown iff the stream
 * counts toward the shared attention aggregate.
 */
export function badgeFor(state: PlantState, stream: WorkStream): BadgeKind | null {
  if (!workStreamNeedsHumanAttention(stream)) return null
  switch (state) {
    case 'question':
      return 'question'
    case 'review':
      return 'harvest'
    case 'blocked':
      return 'blocked'
    default:
      return null
  }
}

const RUNNING_STATUSES: ReadonlySet<Agent['status']> = new Set(['active', 'waiting-input', 'compacting', 'resetting'])

/** Ids of agents halted by a provider/rate-limit error (a pending `agent-error` action). */
export function haltedAgentIds(pendingActions: readonly PendingAction[]): Set<string> {
  const ids = new Set<string>()
  for (const action of pendingActions) {
    if (action.type !== 'agent-error') continue
    const agentId = (action.data as AgentErrorActionData | undefined)?.agentId
    if (agentId) ids.add(agentId)
  }
  return ids
}

/**
 * Ids of agents with a question open for you: a pending `agent-question` or
 * `squad-question`. An agent that asks without stopping (ask_human) stays
 * `active`, so its status alone doesn't say it's asking.
 */
export function askingAgentIds(pendingActions: readonly PendingAction[]): Set<string> {
  const ids = new Set<string>()
  for (const action of pendingActions) {
    if (action.type !== 'agent-question' && action.type !== 'squad-question') continue
    const agentId = (action.data as QuestionActionData | undefined)?.agentId
    if (agentId) ids.add(agentId)
  }
  return ids
}

/** Whether the agent has a pending `agent-error` action (halted, waiting for "Continue"). */
export function isHaltedAgent(agent: Agent, pendingActions: readonly PendingAction[]): boolean {
  return pendingActions.some(
    (action) => action.type === 'agent-error' && (action.data as AgentErrorActionData | undefined)?.agentId === agent.id
  )
}

/** The robot's screen face. A halted agent always shows the error face. */
export function faceFor(agent: Agent, halted = false): RobotFace {
  if (halted) return 'error'
  switch (agent.status) {
    case 'active':
    case 'compacting':
    case 'resetting':
      return 'happy'
    case 'waiting-input':
      return 'question'
    case 'idle':
      return 'normal'
    case 'dormant':
    case 'terminated':
      return 'sleepy'
    default:
      return 'normal'
  }
}

/** Whether the agent is doing something (or stuck mid-run), so it belongs in the field. */
export function isRunning(agent: Agent, halted = false): boolean {
  return halted || RUNNING_STATUSES.has(agent.status)
}

/** Dormant and terminated robots are never drawn. */
export function isAsleep(agent: Agent): boolean {
  return agent.status === 'dormant' || agent.status === 'terminated'
}
