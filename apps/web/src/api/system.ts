import type { StorageSnapshot, StorageStatus } from '@ficus/shared'
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
