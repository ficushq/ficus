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

/** Finalize dormant agents now (system:cleanup). Irreversible. */
export function removeDormantAgents(agentIds: string[]): Promise<RemoveDormantAgentsResult> {
  return apiFetch('/system/storage/dormant-agents/remove', { method: 'POST', body: JSON.stringify({ agentIds }) })
}

export function getIdleConsultants(squadId: string, days: number): Promise<IdleConsultantsPreview> {
  return apiFetch(`/squads/${squadId}/idle-consultants?days=${days}`)
}

/** The server recomputes the idle set; `agentIds` (what was previewed) only narrows it. */
export function makeIdleConsultantsDormant(
  squadId: string,
  days: number,
  agentIds: string[]
): Promise<IdleConsultantsDormancyResult> {
  return apiFetch(`/squads/${squadId}/idle-consultants/dormant`, {
    method: 'POST',
    body: JSON.stringify({ days, agentIds }),
  })
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
