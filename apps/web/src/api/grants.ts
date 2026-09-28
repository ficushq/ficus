import type { CreateSquadMemoryGrantInput, SquadMemoryGrantDTO } from '@ficus/shared'
import { apiFetch } from './client'

export async function listOutboundGrants(
  sourceSquadId: string,
  fetch: typeof apiFetch = apiFetch
): Promise<SquadMemoryGrantDTO[]> {
  return fetch<SquadMemoryGrantDTO[]>(`/squads/${sourceSquadId}/grants`)
}

export async function listInboundGrants(
  granteeSquadId: string,
  fetch: typeof apiFetch = apiFetch
): Promise<SquadMemoryGrantDTO[]> {
  return fetch<SquadMemoryGrantDTO[]>(`/squads/${granteeSquadId}/granted`)
}

export async function createGrant(
  sourceSquadId: string,
  input: CreateSquadMemoryGrantInput,
  fetch: typeof apiFetch = apiFetch
): Promise<SquadMemoryGrantDTO> {
  return fetch<SquadMemoryGrantDTO>(`/squads/${sourceSquadId}/grants`, {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export async function deleteGrant(id: string, fetch: typeof apiFetch = apiFetch): Promise<void> {
  return fetch<void>(`/grants/${id}`, { method: 'DELETE' })
}
