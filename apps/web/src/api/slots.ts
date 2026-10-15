import { apiFetch } from './client'

/** Mirrors the server's slot pool rules so forms can validate before saving. */
export const SLOT_KEY_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/
export const MAX_SLOT_CAPACITY = 1_000
export const MIN_SLOT_CLAIM_TIMEOUT_MS = 60_000
export const MAX_SLOT_CLAIM_TIMEOUT_MS = 86_400_000
export const MAX_SLOT_USAGE_LENGTH = 1_000

/**
 * A live claim on a pool. `ownerAgentId`/`id` are present only for the
 * caller's own claim or when the viewer has slots:write diagnostics; other
 * holders are identified by short id alone.
 */
export interface SlotHolder {
  id?: string
  ownerAgentId?: string
  ownerShortId: string
  claimedAt: string
  expiresAt: string
}

/** A registered slot pool with its live usage (`GET /squads/:id/slots`). */
export interface SlotPool {
  id: string
  squadId: string
  key: string
  capacity: number
  claimTimeoutMs: number
  usage: string | null
  enabled: boolean
  disabledAt: string | null
  activeCount: number
  availableCount: number
  queuedCount: number
  holders: SlotHolder[]
  oldestWaiterAgeMs: number | null
}

export interface RegisterSlotPoolInput {
  key: string
  capacity: number
  claimTimeoutMs: number
  usage?: string | null
}

/** Partial update: send only what changes. */
export interface UpdateSlotPoolInput {
  capacity?: number
  claimTimeoutMs?: number
  usage?: string | null
  enabled?: boolean
}

/** Stable administration envelope: read `outcome`/`message`, not the HTTP status. */
export interface SlotPoolMutationResponse {
  outcome: 'registered' | 'updated' | 'unregistered'
  message: string
  pool: { key: string }
}

function poolsPath(squadId: string, key?: string): string {
  return `/squads/${encodeURIComponent(squadId)}/slots${key ? `/${encodeURIComponent(key)}` : ''}`
}

export function listSlotPools(squadId: string): Promise<SlotPool[]> {
  return apiFetch<SlotPool[]>(poolsPath(squadId))
}

export function registerSlotPool(squadId: string, input: RegisterSlotPoolInput): Promise<SlotPoolMutationResponse> {
  return apiFetch<SlotPoolMutationResponse>(poolsPath(squadId), { method: 'POST', body: JSON.stringify(input) })
}

export function updateSlotPool(
  squadId: string,
  key: string,
  input: UpdateSlotPoolInput
): Promise<SlotPoolMutationResponse> {
  return apiFetch<SlotPoolMutationResponse>(poolsPath(squadId, key), { method: 'PATCH', body: JSON.stringify(input) })
}

export function unregisterSlotPool(squadId: string, key: string): Promise<SlotPoolMutationResponse> {
  return apiFetch<SlotPoolMutationResponse>(poolsPath(squadId, key), { method: 'DELETE' })
}
