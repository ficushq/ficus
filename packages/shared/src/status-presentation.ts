import type {
  AgentStatus,
  ExecutionStatus,
  SandboxRuntimeState,
  SandboxToolchainStatus,
  WorkStreamDerivedState,
  WorkStreamStatus,
  WorkStreamWaitActor,
  WorkStreamWaitType,
} from './types'
import { workStreamWaitActor } from './types'

/** Platform-neutral meanings used by web, mobile, and native adapters. */
export type StatusRole =
  | 'progress'
  | 'queue'
  | 'review'
  | 'humanWait'
  | 'externalWait'
  | 'attention'
  | 'danger'
  | 'success'
  | 'neutral'

export type AgentPresentationState = AgentStatus | 'offline'
export type DeliveryPresentationKind = 'approval' | 'review' | 'merge' | 'external' | 'setup' | 'failure'

/** One designated delivery pull request in the server's delivery view, primary first. */
export interface WorkStreamDeliveryPullRequestFact {
  number: number
  /** Open unless a merge or close is positively observed. */
  state: 'open' | 'merged' | 'closed'
}

/** Provider gate facts for one delivery pull request, as last observed. */
export interface WorkStreamDeliveryGateFacts {
  mergeState?: string
  checksState?: 'success' | 'failure' | 'pending' | 'unknown'
  reviewDecision?: 'required' | 'approved' | 'changes_requested' | 'unknown'
  draft?: boolean
  pendingHumanReview?: boolean
}

/** Presentation-only reason selected by Core from the canonical winning PR's evidence.
 * Never grants approval/merge authority. Omission and future values mean unknown.
 */
export type CodeHostDeliveryReason =
  | 'ci-pending'
  | 'ci-failed'
  | 'merge-conflict'
  | 'changes-requested'
  | 'draft'
  | 'awaiting-merge'
  | 'merged'
  | 'closed'

/**
 * Server-owned facts explaining a delivery presentation. Omitted fields are
 * unknown; consumers must fail soft rather than infer them client-side.
 */
export interface WorkStreamDeliveryExplanation {
  /** Canonical reason, not a client inference from sparse `gates` or PR existence. */
  codeHostReason?: CodeHostDeliveryReason
  /** Why a `setup` presentation cannot complete, when the classifier knows. */
  setupReason?: 'unbound' | 'not-following-changes' | 'branch-mismatch' | 'direct-merge-facts'
  /** Stream vs pull request branch disagreement, when `setupReason` is `branch-mismatch`. */
  branchMismatch?: {
    streamBranch?: string
    pullRequestBranch?: string
    streamBaseBranch?: string
    pullRequestBaseBranch?: string
  }
  /** Designated delivery pull requests, primary first. */
  pullRequests?: WorkStreamDeliveryPullRequestFact[]
  /** Gate facts for the pull request that decided the kind, when evidence exists. */
  gates?: WorkStreamDeliveryGateFacts
}

/** Server-owned delivery facts, never inferred from client metadata. Unknown kinds are ignored. */
export interface WorkStreamDeliveryPresentation {
  kind: DeliveryPresentationKind
  /** The one operational approval wait represented by this gate; other waits retain precedence. */
  approvalWaitId?: string
  /** Explanatory facts, attached only when the server owns them. */
  explanation?: WorkStreamDeliveryExplanation
}

/** Shared row-label refinement. Call only after selecting the canonical presentation state.
 * Old payloads, unknown reasons and incompatible kind/reason pairs keep the caller's generic label.
 * Raw gate facts are intentionally not interpreted: they can outlive readiness evidence.
 */
export function codeHostDeliveryLabel(delivery?: WorkStreamDeliveryPresentation): string | null {
  const reason = delivery?.explanation?.codeHostReason
  if (delivery?.kind === 'failure') {
    switch (reason) {
      case 'ci-failed':
        return 'CI failed'
      case 'merge-conflict':
        return 'Resolve merge conflicts'
      case 'changes-requested':
        return 'Changes requested'
      case 'closed':
        return 'PR closed without merging'
      default:
        return null
    }
  }
  if (delivery?.kind === 'external') {
    switch (reason) {
      case 'ci-pending':
        return 'Awaiting CI'
      case 'draft':
        return 'PR is draft'
      case 'awaiting-merge':
        return 'Awaiting merge'
      case 'merged':
        return (delivery.explanation?.pullRequests?.length ?? 0) > 1
          ? 'PRs merged — finalizing delivery'
          : 'PR merged — finalizing delivery'
      default:
        return null
    }
  }
  return null
}

/**
 * Presentation-only states for a manual wait another party must clear. Core
 * keeps the stored/derived vocabulary (`blocked`) for older consumers; these
 * are selected only from explicit wait facts carrying an actor.
 */
export type ManualWaitPresentationState = 'waiting_on_owner'

export type WorkStreamPresentationState =
  | WorkStreamStatus
  | WorkStreamDerivedState
  | 'waiting_for_slot'
  | ManualWaitPresentationState
  | `delivery_${DeliveryPresentationKind}`
export type SubagentPresentationState = 'queued' | 'running' | 'idle' | 'stopped' | 'done' | 'failed'
export type SandboxPresentationState = SandboxRuntimeState | 'installing_packages' | 'running_setup' | 'degraded'

export const AGENT_STATUS_ROLE = {
  active: 'progress',
  idle: 'neutral',
  'waiting-input': 'humanWait',
  compacting: 'attention',
  resetting: 'attention',
  dormant: 'neutral',
  terminated: 'neutral',
  offline: 'neutral',
} as const satisfies Record<AgentPresentationState, StatusRole>

export const WORK_STREAM_STATUS_ROLE = {
  delivery_approval: 'review',
  delivery_review: 'review',
  delivery_merge: 'review',
  delivery_external: 'externalWait',
  delivery_setup: 'attention',
  delivery_failure: 'danger',
  paused: 'neutral',
  queued: 'queue',
  active: 'progress',
  in_progress: 'progress',
  in_review: 'review',
  waiting_on_answer: 'humanWait',
  waiting_on_dependency: 'externalWait',
  waiting_on_owner: 'externalWait',
  blocked: 'attention',
  idle: 'neutral',
  waiting_for_slot: 'queue',
  execution_failed: 'danger',
  done: 'success',
  canceled: 'neutral',
} as const satisfies Record<WorkStreamPresentationState, StatusRole>

export const EXECUTION_STATUS_ROLE = {
  queued: 'queue',
  'waiting-maintenance': 'externalWait',
  'waiting-sandbox': 'externalWait',
  running: 'progress',
  stopping: 'attention',
  stopped: 'neutral',
  completed: 'success',
  failed: 'danger',
} as const satisfies Record<ExecutionStatus, StatusRole>

export const SUBAGENT_STATUS_ROLE = {
  queued: 'queue',
  running: 'progress',
  idle: 'neutral',
  stopped: 'neutral',
  done: 'success',
  failed: 'danger',
} as const satisfies Record<SubagentPresentationState, StatusRole>

export const SANDBOX_STATUS_ROLE = {
  not_found: 'neutral',
  pending: 'attention',
  starting: 'attention',
  running: 'success',
  succeeded: 'neutral',
  failed: 'danger',
  terminating: 'attention',
  unknown: 'neutral',
  installing_packages: 'progress',
  running_setup: 'progress',
  degraded: 'attention',
} as const satisfies Record<SandboxPresentationState, StatusRole>

export const WORK_STREAM_WAIT_DISPLAY_PRECEDENCE = [
  'review',
  'question',
  'dependency',
  'manual',
] as const satisfies readonly WorkStreamWaitType[]

export const WORK_STREAM_WAIT_STATE = {
  review: 'in_review',
  question: 'waiting_on_answer',
  dependency: 'waiting_on_dependency',
  manual: 'blocked',
} as const satisfies Record<WorkStreamWaitType, WorkStreamDerivedState>

export interface WorkStreamWaitDisplayFacts {
  type: WorkStreamWaitType
  resolutionHandler?: 'workflow'
  flowAttemptId?: number | null
  /** Manual waits only; missing or unknown means `human`. */
  actor?: WorkStreamWaitActor | string | null
}

/**
 * The state a manual wait presents, by who must act. Human (and legacy
 * actor-less) waits stay `blocked` and need the user; owner waits are
 * non-alarming waits on the stream's owning agent.
 */
export const MANUAL_WAIT_ACTOR_STATE = {
  human: 'blocked',
  owner: 'waiting_on_owner',
} as const satisfies Record<WorkStreamWaitActor, WorkStreamPresentationState>

/**
 * The wait type a stream presents. A workflow human-approval gate is stored as
 * a manual wait the workflow resolves, pinned to its attempt; it is a review
 * waiting on a person, not a blocked stream. Delivery and attempt-limit waits
 * are whole-stream (no attempt) and keep their stored type.
 */
export function workStreamWaitDisplayType(wait: WorkStreamWaitDisplayFacts): WorkStreamWaitType {
  return wait.type === 'manual' && wait.resolutionHandler === 'workflow' && wait.flowAttemptId != null
    ? 'review'
    : wait.type
}

export interface WorkStreamPresentationFacts {
  /** Read-only server projection; absent/false never implies a live resource wait. */
  hasActiveSlotWait?: boolean
  delivery?: WorkStreamDeliveryPresentation
  pause?: unknown
  status: WorkStreamStatus
  derivedState?: WorkStreamDerivedState
  openWaits?: ReadonlyArray<WorkStreamWaitDisplayFacts & { id?: string }>
}

/**
 * Select one display state from server facts. An explicit wait list is
 * authoritative; omitted waits retain compatibility with older payloads.
 */
export function selectWorkStreamPresentationState(
  workStream: WorkStreamPresentationFacts
): WorkStreamPresentationState {
  if (workStream.status === 'done' || workStream.status === 'canceled') return workStream.status

  if (workStream.pause || workStream.derivedState === 'paused') return 'paused'

  const deliveryState =
    workStream.delivery &&
    ['approval', 'review', 'merge', 'external', 'setup', 'failure'].includes(workStream.delivery.kind)
      ? (`delivery_${workStream.delivery.kind}` as WorkStreamPresentationState)
      : undefined
  if (workStream.openWaits !== undefined) {
    const waitType = WORK_STREAM_WAIT_DISPLAY_PRECEDENCE.find((type) =>
      workStream.openWaits!.some(
        (wait) =>
          workStreamWaitDisplayType(wait) === type &&
          !(
            deliveryState === 'delivery_approval' &&
            wait.type === 'manual' &&
            wait.id &&
            wait.id === workStream.delivery?.approvalWaitId
          )
      )
    )
    if (waitType === 'manual') {
      // Anything a human must clear wins over an owner-only hold.
      const humanActionable = workStream.openWaits.some(
        (wait) =>
          workStreamWaitDisplayType(wait) === 'manual' &&
          !(deliveryState === 'delivery_approval' && wait.id && wait.id === workStream.delivery?.approvalWaitId) &&
          workStreamWaitActor(wait) === 'human'
      )
      return MANUAL_WAIT_ACTOR_STATE[humanActionable ? 'human' : 'owner']
    }
    if (waitType) return WORK_STREAM_WAIT_STATE[waitType]
    if (workStream.derivedState === 'execution_failed') return 'execution_failed'
    if (deliveryState) return deliveryState
    if (workStream.status === 'queued') return 'queued'
    // Non-wait-derived states survive an explicit empty wait list: an empty
    // list cannot speak against a live execution or a failed execution, but a
    // STALE wait-derived state (in_review/…) must still collapse to idle.
    if (workStream.derivedState === 'in_progress') return 'in_progress'
    return workStream.hasActiveSlotWait === true ? 'waiting_for_slot' : 'idle'
  }

  if (workStream.derivedState === 'execution_failed') return 'execution_failed'
  const state = deliveryState ?? workStream.derivedState ?? workStream.status
  return state === 'idle' && workStream.hasActiveSlotWait === true ? 'waiting_for_slot' : state
}

/** Whether a stream contributes to a user-attention aggregate. */
export function workStreamNeedsHumanAttention(workStream: WorkStreamPresentationFacts): boolean {
  const state = selectWorkStreamPresentationState(workStream)
  if (state === 'delivery_approval' || state === 'delivery_review' || state === 'delivery_merge') return true
  // `blocked` is selected only for a manual wait a human must clear (a missing
  // or unknown actor is human), or from an older payload that omitted waits,
  // whose historical `blocked` fallback is retained. Owner manual waits
  // present as waiting_on_owner instead.
  return state === 'in_review' || state === 'waiting_on_answer' || state === 'blocked'
}

export interface SandboxPresentationFacts {
  status: SandboxRuntimeState
  devboxReady?: boolean
  readiness?: 'pending' | 'reconciling' | 'ready' | 'ready_degraded'
  toolchain?: { status: SandboxToolchainStatus }
}

/** Project physical and setup facts into a named state before applying UI treatment. */
export function selectSandboxPresentationState(facts: SandboxPresentationFacts): SandboxPresentationState {
  if (facts.status !== 'running') return facts.status
  if (facts.readiness === 'ready_degraded') return 'degraded'
  if (facts.toolchain?.status === 'failed') return 'failed'
  if (facts.toolchain?.status === 'running_setup') return 'running_setup'
  if (facts.toolchain?.status === 'installing') return 'installing_packages'
  if (facts.toolchain?.status === 'pending') return 'degraded'
  if (facts.devboxReady === false) return 'installing_packages'
  return 'running'
}
