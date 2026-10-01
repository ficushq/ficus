import {
  MANUAL_WAIT_ACTOR_STATE,
  selectWorkStreamPresentationState,
  workStreamWaitActor,
  workStreamWaitDisplayType,
  WORK_STREAM_STATUS_ROLE,
  type WorkStreamWaitActor,
  type WorkStreamWaitDisplayFacts,
  type WorkStreamWaitType,
  type WorkStreamDeliveryExplanation,
  type WorkStreamPresentationFacts,
  type WorkStreamPresentationState,
  type StatusRole,
} from '@ficus/shared'
import { webStatus } from './statusPresentation'

// Merged label/color maps covering BOTH stored statuses (queued/active/done/canceled) and derived
// display states (in_progress/in_review/waiting_on_answer/waiting_on_dependency/blocked/idle). The
// key spaces overlap on queued/done/canceled, which share the same label either way.
export const WS_STATUS_LABELS: Record<WorkStreamPresentationState, string> = {
  delivery_approval: 'Approve Delivery',
  delivery_review: 'Review Pull Request',
  delivery_merge: 'Merge Pull Request',
  delivery_external: 'Awaiting Code Host',
  delivery_setup: 'Delivery Setup Required',
  delivery_failure: 'Delivery Changes Required',
  // Stored statuses
  queued: 'Queued',
  active: 'Active',
  done: 'Done',
  canceled: 'Canceled',
  // Derived display states
  in_progress: 'In Progress',
  in_review: 'In Review',
  waiting_on_answer: 'Waiting on Answer',
  waiting_on_dependency: 'Waiting on Dependency',
  // Manual waits by actor: `blocked` is the human one (Needs you).
  waiting_on_owner: 'Waiting on Owner',
  blocked: 'Blocked',
  idle: 'Idle',
  waiting_for_slot: 'Waiting for slot',
  execution_failed: 'Execution Failed',
  paused: 'Paused',
}

export const WS_STATUS_BADGE_COLORS: Record<WorkStreamPresentationState, StatusRole> = {
  delivery_approval: webStatus(WORK_STREAM_STATUS_ROLE.delivery_approval).badgeColor,
  delivery_review: webStatus(WORK_STREAM_STATUS_ROLE.delivery_review).badgeColor,
  delivery_merge: webStatus(WORK_STREAM_STATUS_ROLE.delivery_merge).badgeColor,
  delivery_external: webStatus(WORK_STREAM_STATUS_ROLE.delivery_external).badgeColor,
  delivery_failure: webStatus(WORK_STREAM_STATUS_ROLE.delivery_failure).badgeColor,
  delivery_setup: webStatus(WORK_STREAM_STATUS_ROLE.delivery_setup).badgeColor,
  queued: webStatus(WORK_STREAM_STATUS_ROLE.queued).badgeColor,
  active: webStatus(WORK_STREAM_STATUS_ROLE.active).badgeColor,
  done: webStatus(WORK_STREAM_STATUS_ROLE.done).badgeColor,
  canceled: webStatus(WORK_STREAM_STATUS_ROLE.canceled).badgeColor,
  in_progress: webStatus(WORK_STREAM_STATUS_ROLE.in_progress).badgeColor,
  in_review: webStatus(WORK_STREAM_STATUS_ROLE.in_review).badgeColor,
  waiting_on_answer: webStatus(WORK_STREAM_STATUS_ROLE.waiting_on_answer).badgeColor,
  waiting_on_dependency: webStatus(WORK_STREAM_STATUS_ROLE.waiting_on_dependency).badgeColor,
  waiting_on_owner: webStatus(WORK_STREAM_STATUS_ROLE.waiting_on_owner).badgeColor,
  blocked: webStatus(WORK_STREAM_STATUS_ROLE.blocked).badgeColor,
  waiting_for_slot: webStatus(WORK_STREAM_STATUS_ROLE.waiting_for_slot).badgeColor,
  idle: webStatus(WORK_STREAM_STATUS_ROLE.idle).badgeColor,
  execution_failed: webStatus(WORK_STREAM_STATUS_ROLE.execution_failed).badgeColor,
  paused: webStatus(WORK_STREAM_STATUS_ROLE.paused).badgeColor,
}

export const getWsDisplayState = selectWorkStreamPresentationState

/** Bounded pill text for the delivery-PR numbers a label carries. */
function formatPullRequestNumbers(numbers: number[]): string {
  const head = numbers.slice(0, 3).map((number) => `#${number}`)
  const rest = numbers.length - head.length
  return `${head.join(', ')}${rest > 0 ? ` +${rest} more` : ''}`
}

/**
 * A more specific label for a delivery-external stream, derived only from
 * server-owned explanation facts. Unknown or contradictory evidence returns
 * null so the caller keeps the generic label.
 */
export function externalDeliveryLabel(explanation?: WorkStreamDeliveryExplanation): string | null {
  if (!explanation) return null
  const pullRequests = explanation.pullRequests ?? []
  // Once every delivery PR merged, leftover gate facts describe nothing still pending.
  if (pullRequests.length && pullRequests.every((pullRequest) => pullRequest.state === 'merged'))
    return pullRequests.length === 1 ? 'PR merged — finalizing delivery' : 'PRs merged — finalizing delivery'
  const { gates } = explanation
  // A draft cannot merge yet, and stale gates may no longer describe the head.
  if (gates?.draft === true) return null
  if (gates?.checksState === 'pending') return 'Awaiting CI'
  if (gates?.reviewDecision === 'required' || gates?.pendingHumanReview === true) return 'Awaiting review'
  if (gates?.mergeState === 'blocked') return 'Blocked by branch protection'
  const open = pullRequests.filter((pullRequest) => pullRequest.state === 'open').map((p) => p.number)
  if (open.length) return `Awaiting merge of ${formatPullRequestNumbers(open)}`
  return null
}

/** The status pill label for a stream, including the derived external label. */
export function workStreamStatusLabel(workStream: WorkStreamPresentationFacts): string {
  const state = getWsDisplayState(workStream)
  if (state === 'delivery_external') {
    return externalDeliveryLabel(workStream.delivery?.explanation) ?? WS_STATUS_LABELS[state]
  }
  return WS_STATUS_LABELS[state]
}

/**
 * Badge text/color for one wait: open manual waits are labeled by who must act.
 * A resolved wait (`history`) keeps its type label, naming a non-human actor.
 */
export function workStreamWaitBadge(
  wait: WorkStreamWaitDisplayFacts,
  opts: { history?: boolean } = {}
): { label: string; color: StatusRole } {
  const type = workStreamWaitDisplayType(wait)
  if (type === 'manual') {
    const actor = workStreamWaitActor(wait)
    const label = opts.history
      ? `${WAIT_TYPE_LABELS.manual}${actor === 'human' ? '' : ` · ${MANUAL_WAIT_ACTOR_NAMES[actor]}`}`
      : MANUAL_WAIT_ACTOR_LABELS[actor]
    return { label, color: MANUAL_WAIT_ACTOR_BADGE_COLORS[actor] }
  }
  return { label: WAIT_TYPE_LABELS[type], color: WAIT_TYPE_BADGE_COLORS[type] }
}

const MANUAL_WAIT_ACTOR_NAMES: Record<WorkStreamWaitActor, string> = {
  human: 'Human',
  owner: 'Owner',
}

const WAIT_TYPE_LABELS: Record<WorkStreamWaitType, string> = {
  dependency: 'Dependency',
  question: 'Question',
  review: 'Review',
  manual: 'Manual',
}

const WAIT_TYPE_BADGE_COLORS: Record<WorkStreamWaitType, StatusRole> = {
  dependency: 'externalWait',
  question: 'humanWait',
  review: 'review',
  manual: 'attention',
}

export const MANUAL_WAIT_ACTOR_LABELS: Record<WorkStreamWaitActor, string> = {
  human: 'Needs you',
  owner: WS_STATUS_LABELS[MANUAL_WAIT_ACTOR_STATE.owner],
}

const MANUAL_WAIT_ACTOR_BADGE_COLORS: Record<WorkStreamWaitActor, StatusRole> = {
  human: WS_STATUS_BADGE_COLORS[MANUAL_WAIT_ACTOR_STATE.human],
  owner: WS_STATUS_BADGE_COLORS[MANUAL_WAIT_ACTOR_STATE.owner],
}

/** Queued work with a retained wait or pause has released its admission slot. */
export function isWorkStreamParked(workStream: WorkStreamPresentationFacts): boolean {
  if (workStream.status !== 'queued') return false
  return ['in_review', 'waiting_on_answer', 'waiting_on_dependency', 'waiting_on_owner', 'blocked', 'paused'].includes(
    // Admission state follows retained waits/pause, independently of delivery's primary label.
    getWsDisplayState({ ...workStream, delivery: undefined })
  )
}
