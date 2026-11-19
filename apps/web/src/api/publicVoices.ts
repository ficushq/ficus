import type {
  DerivationFilters,
  PublicSurface,
  PublicVoiceProfileJson,
  PublicVoiceSurfaces,
  SquadPublicVoice,
  SquadPublicVoicePatch,
  SquadPublicVoiceState,
} from '@ficus/shared'
import { formatDerivationError } from '@ficus/shared'
import { apiFetch, ApiError } from './client'

/** Voice profiles and squad voice settings. See docs/wiki/public-voice.md. */

export { publicVoiceQueryKeys } from '../queryKeys'

export interface PublicVoiceProfileInput {
  name: string
  description?: string | null
  base: string
  surfaces: PublicVoiceSurfaces
}

export function getPublicVoices(): Promise<PublicVoiceProfileJson[]> {
  return apiFetch<PublicVoiceProfileJson[]>('/public-voices')
}

export function createPublicVoice(data: PublicVoiceProfileInput & { id: string }): Promise<PublicVoiceProfileJson> {
  return apiFetch<PublicVoiceProfileJson>('/public-voices', { method: 'POST', body: JSON.stringify(data) })
}

export function updatePublicVoice(
  id: string,
  data: PublicVoiceProfileInput
): Promise<PublicVoiceProfileJson & { overCapSquadCount: number }> {
  return apiFetch(`/public-voices/${id}`, { method: 'PUT', body: JSON.stringify(data) })
}

export function deletePublicVoice(id: string): Promise<{ ok: true; unassignedSquads: number }> {
  return apiFetch(`/public-voices/${id}`, { method: 'DELETE' })
}

export async function setPublicVoiceDisabled(id: string, disabled: boolean): Promise<void> {
  await apiFetch<void>(`/public-voices/${id}/${disabled ? 'disable' : 'enable'}`, { method: 'POST' })
}

export async function revertPublicVoice(id: string): Promise<void> {
  await apiFetch<void>(`/public-voices/${id}/revert-to-template`, { method: 'POST' })
}

export function getSquadVoice(squadId: string): Promise<SquadPublicVoiceState> {
  return apiFetch<SquadPublicVoiceState>(`/squads/${squadId}/voice`)
}

export function patchSquadVoice(squadId: string, patch: SquadPublicVoicePatch): Promise<SquadPublicVoiceState> {
  return apiFetch<SquadPublicVoiceState>(`/squads/${squadId}/voice`, { method: 'PATCH', body: JSON.stringify(patch) })
}

export function previewSquadVoice(
  squadId: string,
  body: { surface: PublicSurface; sample?: string; draft?: SquadPublicVoice; voiceId?: string | null }
): Promise<{ text: string; model: string }> {
  return apiFetch(`/squads/${squadId}/voice/preview`, { method: 'POST', body: JSON.stringify(body) })
}

export interface VoiceDerivationResult {
  login: string
  draft: { base: string; surfaces: PublicVoiceSurfaces }
  observations: string[]
  exemplars: Array<{ surface: PublicSurface; text: string; repository: string }>
  sampling: {
    filters: DerivationFilters
    counts: {
      collected: number
      kept: number
      droppedByFilter: { date: number; repository: number }
      droppedAsToolAuthored: number
      droppedAsTemplate: number
    }
    dateRange: Record<string, { oldest: string; newest: string }>
    publicRepositories: string[]
    privateRepositories: string[]
    pagingCapped: boolean
    unavailableRepositories?: string[]
    commitRepositoriesNotSampled?: string[]
  }
  bytes: number
  maxBytes: number
}

export async function deriveSquadVoice(
  squadId: string,
  body: { login: string; filters?: DerivationFilters }
): Promise<VoiceDerivationResult> {
  try {
    return await apiFetch(`/squads/${squadId}/voice/derive`, { method: 'POST', body: JSON.stringify(body) })
  } catch (error) {
    if (error instanceof ApiError && (error.status === 422 || error.status === 502)) {
      const code = (error.payload as { error?: unknown } | undefined)?.error
      const message = formatDerivationError(typeof code === 'string' ? code : undefined, error.payload, {
        includeCode: false,
      })
      if (message) throw new ApiError(error.status, message, error.payload)
    }
    throw error
  }
}
