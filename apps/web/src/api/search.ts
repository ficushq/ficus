import type { EntitySearchQuery, EntitySearchResponse } from '@ficus/shared'
import { webTransport } from './transport'

export function searchEntities(q: string, limit = 20, filters: Pick<EntitySearchQuery, 'kind' | 'squadId'> = {}) {
  const params = new URLSearchParams({ q, limit: String(limit) })
  if (filters.kind) params.set('kind', filters.kind)
  if (filters.squadId) params.set('squadId', filters.squadId)
  return webTransport.request<EntitySearchResponse>(`/search?${params}`)
}
