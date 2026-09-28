import { apiFetch } from './client'

export interface LocalAutoUpdateSettings {
  enabled: boolean
  intervalMinutes: number
  remote: string
  branch: string
}

export const DEFAULT_LOCAL_AUTO_UPDATE_SETTINGS = {
  enabled: false,
  intervalMinutes: 30,
  remote: 'origin',
  branch: 'main',
} as const satisfies LocalAutoUpdateSettings
export interface LocalUpdateRun {
  id?: string
  status?: string
  startedAt?: string
  completedAt?: string
  changedFiles?: string[]
  selectedTasks?: string[]
  commands?: Array<{ command: string[]; status: string; outputTail?: string; note?: string }>
  error?: string
  message?: string
  localRuntime?: boolean
  dirty?: boolean
  flavor?: { source: string; supervisor: string; sandboxRuntime: string }
  supported?: boolean
  supportReason?: string
}
export interface UpdateSettingsResponse {
  settings: LocalAutoUpdateSettings
  status: UpdateStatusResponse
  /**
   * True on a platform-managed instance (FICUS_MANAGED=1), where self-updates
   * cannot work and the hosting platform owns the upgrade lifecycle — the UI
   * hides the Updates surface entirely. Absent from older servers; treat
   * undefined as self-hosted.
   */
  managed?: boolean
}
export interface UpdateStatusResponse {
  flavor?: LocalUpdateRun['flavor']
  active: boolean
  latest: LocalUpdateRun | null
}

export const MANUAL_UPDATE_TARGETS = ['cli', 'sandbox', 'core', 'web'] as const
export type ManualUpdateTarget = (typeof MANUAL_UPDATE_TARGETS)[number]

export const getUpdateSettings = () => apiFetch<UpdateSettingsResponse>('/updates/settings')
export const patchUpdateSettings = (body: Partial<LocalAutoUpdateSettings>) =>
  apiFetch<UpdateSettingsResponse>('/updates/settings', { method: 'PATCH', body: JSON.stringify(body) })
export const checkForUpdates = () => apiFetch<LocalUpdateRun>('/updates/check', { method: 'POST' })
export const applyUpdate = () => apiFetch<LocalUpdateRun>('/updates/apply', { method: 'POST' })
export const applyTargetedUpdate = (targets: ManualUpdateTarget[]) =>
  apiFetch<LocalUpdateRun>('/updates/apply-target', { method: 'POST', body: JSON.stringify({ targets }) })
export const getUpdateStatus = () => apiFetch<UpdateStatusResponse>('/updates/status')
