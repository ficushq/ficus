import { apiFetch } from './client'

export interface SettingMetadata {
  key: string
  value: string
  type: string
  default: string
  description: string
  isDefault: boolean
  updatedAt: string | null
  updatedBy: string | null
  /** Live context for this setting, such as the value derived when nothing is stored. */
  detail?: string
}

export async function listSettings(): Promise<SettingMetadata[]> {
  return apiFetch<SettingMetadata[]>('/settings')
}

export async function getSetting(key: string): Promise<{ key: string; value: string }> {
  return apiFetch<{ key: string; value: string }>(`/settings/${key}`)
}

export async function setSetting(key: string, value: string): Promise<void> {
  await apiFetch(`/settings/${key}`, {
    method: 'PUT',
    body: JSON.stringify({ value }),
  })
}

export async function deleteSetting(key: string): Promise<void> {
  await apiFetch(`/settings/${key}`, { method: 'DELETE' })
}
