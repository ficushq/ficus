export const MAX_SLOT_CAPACITY = 1_000
export const DEFAULT_SLOT_CLAIM_TIMEOUT_MS = 60 * 60 * 1000
export const MIN_SLOT_CLAIM_TIMEOUT_MS = 60 * 1000
export const MAX_SLOT_CLAIM_TIMEOUT_MS = 24 * 60 * 60 * 1000
export const SLOT_KEY_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/
/** Usage guidance is published into every agent prompt, so keep it short. */
export const MAX_SLOT_USAGE_LENGTH = 1_000

export type SlotServiceErrorCode =
  | 'invalid_slot_key'
  | 'invalid_capacity'
  | 'invalid_timeout'
  | 'invalid_usage'
  | 'invalid_history_limit'
  | 'invalid_cursor'
  | 'pool_not_found'
  | 'pool_exists'
  | 'pool_busy'
  | 'squad_not_found'
  | 'agent_identity_required'
  | 'agent_not_live'
  | 'agent_not_in_squad'
  | 'claim_not_found'
  | 'waiter_not_found'

export class SlotServiceError extends Error {
  constructor(
    readonly code: SlotServiceErrorCode,
    message: string,
    readonly httpStatus: 400 | 403 | 404 | 409
  ) {
    super(message)
    this.name = 'SlotServiceError'
  }
}

/** Squad + pool key resolved from a globally unique claim or waiter id. */
export interface SlotResourceContext {
  squadId: string
  key: string
}

export interface SlotViewer {
  agentId?: string
  diagnostics: boolean
}

export interface SlotClaimView {
  id?: string
  ownerAgentId?: string
  ownerShortId: string
  claimedAt: Date
  expiresAt: Date
}

export interface SlotWaiterView {
  id?: string
  ownerAgentId?: string
  ownerShortId: string
  queuedAt: Date
}

export interface SlotHistoryItem {
  kind: 'claim' | 'waiter'
  id: string
  ownerAgentId: string
  ownerShortId: string
  status: string
  reason: string | null
  endedAt: Date | null
}

export interface SlotHistoryPage {
  items: SlotHistoryItem[]
  hasMore: boolean
  nextCursor: string | null
}

export interface SlotPoolSummary {
  id: string
  squadId: string
  key: string
  capacity: number
  claimTimeoutMs: number
  /** Optional "how to use" guidance published to agent prompts. */
  usage: string | null
  /** False while the pool is disabled: not enforced, no queueing, omitted from prompts. */
  enabled: boolean
  disabledAt: Date | null
  activeCount: number
  availableCount: number
  queuedCount: number
  holders: SlotClaimView[]
  callerClaim?: SlotClaimView
  callerWaiter?: SlotWaiterView
}

/** Serialized slot pool administration record (slot_pools row). */
export interface SlotPoolRecord {
  id: string
  squadId: string
  key: string
  capacity: number
  claimTimeoutMs: number
  usage: string | null
  createdBy: string
  createdAt: Date
  updatedAt: Date
  disabledAt: Date | null
  unregisteredAt: Date | null
}

export type SlotPoolMutationOutcome = 'registered' | 'updated' | 'unregistered'

/**
 * Stable REST response contract for slot pool administration mutations.
 * Callers must read `outcome` and `message` instead of inferring success
 * from the HTTP status or the raw pool payload shape.
 */
export interface SlotPoolMutationResponse {
  outcome: SlotPoolMutationOutcome
  message: string
  pool: SlotPoolRecord
}

export interface SlotPoolView extends SlotPoolSummary {
  oldestWaiterAgeMs: number | null
}

export type SlotRenewResult = {
  outcome: 'renewed' | 'expired' | 'already_released'
  message: string
  claimId: string
  expiresAt: Date
}

/**
 * Live status of the claim a granted waiter produced.
 *
 * `unsubscribe` on an already-granted waiter used to report only the claim id,
 * so the CLI warned "YOU OWN A LIVE CLAIM" even when that claim had long since
 * been released or expired. Callers need the claim's actual state to decide
 * whether ownership is still outstanding.
 */
export type SlotGrantedClaimStatus = 'active' | 'released' | 'expired'

export type SlotUnsubscribeResult =
  | { outcome: 'canceled'; message: string; waiterId: string }
  | {
      outcome: 'already_granted'
      message: string
      waiterId: string
      claimId: string
      claimStatus: SlotGrantedClaimStatus
    }

export type SlotReleaseResult = {
  outcome: 'released' | 'already_released' | 'expired'
  message: string
  claimId: string
}

export interface SlotAcquirePoolSnapshot {
  key: string
  capacity: number
  activeCount: number
  availableCount: number
  queuedCount: number
}

export interface SlotAcquireClaim {
  id: string
  expiresAt: Date
}

export interface SlotAcquireWaiter {
  id: string
}

export type SlotAcquireResult =
  | { outcome: 'granted'; message: string; pool: SlotAcquirePoolSnapshot; claim: SlotAcquireClaim }
  | { outcome: 'queued'; message: string; pool: SlotAcquirePoolSnapshot; waiter: SlotAcquireWaiter }
  | { outcome: 'unavailable'; message: string; pool: SlotAcquirePoolSnapshot }
  /** The pool is registered but disabled: nothing was claimed or queued. */
  | { outcome: 'disabled'; message: string; pool: SlotAcquirePoolSnapshot }
