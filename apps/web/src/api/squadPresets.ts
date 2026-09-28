import { apiFetch } from './client'

export interface SquadPreset {
  disabled?: boolean
  workflows?: import('@ficus/shared').SquadPresetWorkflows | null
  id: string
  name: string
  description: string | null
  purpose: string | null
  defaultAgents: string[]
  managerInstructions: string | null
  createdAt: string
  updatedAt: string
}

export async function listSquadPresets(): Promise<SquadPreset[]> {
  return apiFetch<SquadPreset[]>('/squad-presets')
}

export async function getSquadPreset(id: string): Promise<SquadPreset> {
  return apiFetch<SquadPreset>(`/squad-presets/${id}`)
}
