import type {
  IdleConsultantsDormancyResult,
  IdleConsultantsPreview,
  RemoveDormantAgentsResult,
  StorageSnapshot,
  StorageStatus,
  StoredFilesSummary,
} from '@ficus/shared'
import { apiFetch } from './client'

export interface PublicMaintenanceStatus {
  effective: boolean
  phase: 'active' | 'pausing' | 'paused'
}

export interface MaintenanceSnapshot {
  effective: boolean
  phase: 'active' | 'pausing' | 'paused'
  generation: number
  quiescedGeneration: number
  adminHold: { active: boolean; reason: string | null; heldAt: string | null; heldBy: string | null }
  platformLease: {
    active: boolean
    leaseId: string | null
    holder: string | null
    acquiredAt: string | null
    expiresAt: string | null
  }
}

export function getSystemPause(): Promise<PublicMaintenanceStatus> {
  return apiFetch('/system/pause')
}

export function getSystemPauseDetails(): Promise<MaintenanceSnapshot> {
  return apiFetch('/system/pause/details')
}

export function setAdminPause(active: boolean, reason?: string): Promise<MaintenanceSnapshot> {
  return apiFetch('/system/pause/admin', {
    method: 'PUT',
    body: JSON.stringify({ active, ...(reason ? { reason } : {}) }),
  })
}

export function getStorage(): Promise<StorageSnapshot> {
  return apiFetch('/system/storage')
}

export function refreshStorage(): Promise<StorageSnapshot> {
  return apiFetch('/system/storage/refresh', { method: 'POST' })
}

export function getStorageStatus(): Promise<StorageStatus> {
  return apiFetch('/system/storage/status')
}

export function getStoredFiles(): Promise<StoredFilesSummary> {
  return apiFetch('/system/storage/files')
}

type Fetcher = <T>(path: string, options?: RequestInit) => Promise<T>

/** A batch action that may have stopped part-way: what succeeded, plus the error that stopped it. */
export type PartialResult<T> = T & { error?: string }

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * Queue dormant agents for background removal (system:cleanup), 500 ids per request.
 * If a later request fails, the earlier accepted ids are kept and the error is returned with them.
 */
export async function removeDormantAgents(
  agentIds: string[],
  fetcher: Fetcher = apiFetch
): Promise<PartialResult<RemoveDormantAgentsResult>> {
  const merged: PartialResult<RemoveDormantAgentsResult> = { accepted: [], skipped: [] }
  for (let start = 0; start < agentIds.length; start += 500) {
    try {
      const result = await fetcher<RemoveDormantAgentsResult>('/system/storage/dormant-agents/remove', {
        method: 'POST',
        body: JSON.stringify({ agentIds: agentIds.slice(start, start + 500) }),
      })
      merged.accepted.push(...result.accepted)
      merged.skipped.push(...result.skipped)
    } catch (error) {
      if (start === 0) throw error
      merged.error = errorMessage(error)
      break
    }
  }
  return merged
}

export function getIdleConsultants(squadId: string, days: number): Promise<IdleConsultantsPreview> {
  return apiFetch(`/squads/${squadId}/idle-consultants?days=${days}`)
}

/**
 * Make the previewed idle consultants dormant in sequential chunks of 25 (each request is
 * synchronous; the server accepts at most 100 ids). The server recomputes the idle set and
 * only narrows it by these ids. Reports progress after each chunk; if a chunk fails, what
 * already succeeded is returned with the error.
 */
export async function makeIdleConsultantsDormantInChunks(
  squadId: string,
  days: number,
  agentIds: string[],
  onProgress?: (made: number, total: number) => void,
  fetcher: Fetcher = apiFetch
): Promise<PartialResult<IdleConsultantsDormancyResult>> {
  const merged: PartialResult<IdleConsultantsDormancyResult> = { dormant: [], deferred: [], skipped: [] }
  for (let start = 0; start < agentIds.length; start += 25) {
    try {
      const result = await fetcher<IdleConsultantsDormancyResult>(`/squads/${squadId}/idle-consultants/dormant`, {
        method: 'POST',
        body: JSON.stringify({ days, agentIds: agentIds.slice(start, start + 25) }),
      })
      merged.dormant.push(...result.dormant)
      merged.deferred.push(...result.deferred)
      merged.skipped.push(...result.skipped)
      onProgress?.(merged.dormant.length + merged.deferred.length, agentIds.length)
    } catch (error) {
      if (start === 0) throw error
      merged.error = errorMessage(error)
      break
    }
  }
  return merged
}

export interface NixGcResult {
  candidates: Array<{ sandboxId: string; bytes: number; verdict: 'orphaned' | 'terminated' | 'live'; running: boolean }>
  totalReclaimableBytes: number
  reclaimed?: string[]
  failed?: string[]
}

export interface WorkspaceGcResult {
  mode: 'dry-run' | 'apply'
  scanned: number
  eligible: number
  removed: number
  protected: Record<string, number>
  skipped: Record<string, number>
  errors: Record<string, number>
  hasMore: boolean
  nextCursor: string | null
}

/** Orphaned/terminated agent Nix stores on the Ficus host; dry run unless `apply`. */
export function runNixGc(apply: boolean): Promise<NixGcResult> {
  return apiFetch('/admin/nix-gc', { method: 'POST', body: JSON.stringify(apply ? { apply: true } : {}) })
}

/** Empty orphan squad workspace folders on the Ficus host; dry run unless `apply`. */
export function runWorkspaceGc(apply: boolean): Promise<WorkspaceGcResult> {
  return apiFetch('/admin/workspace-gc', { method: 'POST', body: JSON.stringify(apply ? { apply: true } : {}) })
}
