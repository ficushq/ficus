import type {
  DerivationFilters,
  PublicSurface,
  PublicVoiceProfileJson,
  PublicVoiceSurfaces,
  SquadPublicVoice,
  SquadPublicVoicePatch,
  SquadPublicVoiceState,
} from '@ficus/shared'
import { formatDerivationError, VOICE_DERIVATION_ACCEPT } from '@ficus/shared'
import { readVoiceDerivation, VoiceDerivationError, type ReadVoiceDerivationOptions } from '@ficus/client-core'
import { apiFetch, authFetch, readApiErrorMessage, ApiError } from './client'

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

export type { VoiceDerivationResult } from '@ficus/shared'
import type { VoiceDerivationResult } from '@ficus/shared'

export type VoiceDerivationTarget = { kind: 'squad'; squadId: string } | { kind: 'connection'; connectionId: string }

export function deriveSquadVoice(
  squadId: string,
  body: { login: string; filters?: DerivationFilters },
  options: ReadVoiceDerivationOptions = {}
): Promise<VoiceDerivationResult> {
  return deriveVoice({ kind: 'squad', squadId }, body, options)
}

export async function deriveVoice(
  target: VoiceDerivationTarget,
  body: { login: string; filters?: DerivationFilters },
  options: ReadVoiceDerivationOptions = {}
): Promise<VoiceDerivationResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new VoiceDerivationError('derivation_stream_interrupted')), 220_000)
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
  try {
    const response = await authFetch(
      target.kind === 'squad' ? `/squads/${target.squadId}/voice/derive` : '/public-voices/derive',
      {
        method: 'POST',
        body: JSON.stringify(target.kind === 'connection' ? { ...body, connectionId: target.connectionId } : body),
        signal,
        headers: { 'Content-Type': 'application/json', Accept: VOICE_DERIVATION_ACCEPT },
      }
    )
    if (!response.ok) {
      const payload = await response
        .clone()
        .json()
        .catch(() => undefined)
      throw new ApiError(response.status, await readApiErrorMessage(response), payload)
    }
    return await readVoiceDerivation(response, { ...options, signal })
  } catch (error) {
    if (error instanceof VoiceDerivationError)
      throw new ApiError(
        422,
        formatDerivationError(error.code, error.payload, { includeCode: false, target: target.kind }) ?? error.message,
        error.payload
      )
    if (error instanceof ApiError) {
      const code = (error.payload as { error?: unknown } | undefined)?.error
      const message = formatDerivationError(typeof code === 'string' ? code : undefined, error.payload, {
        includeCode: false,
        target: target.kind,
      })
      if (message) throw new ApiError(error.status, message, error.payload)
    }
    throw error
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}
