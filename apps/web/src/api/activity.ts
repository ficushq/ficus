import type {
  GlobalActivityPresence,
  GlobalSquadActivityPage,
  NormalizedSquadActivityFilters,
  SquadActivityKind,
  SquadActivityPresence,
} from '@ficus/shared'
import { apiFetch } from './client'

export interface ListGlobalActivityOptions extends Partial<NormalizedSquadActivityFilters> {
  limit?: number
  cursor?: string | null
  signal?: AbortSignal
}

export async function getGlobalActivityPresence(fetch: typeof apiFetch = apiFetch): Promise<GlobalActivityPresence> {
  return fetch<GlobalActivityPresence>('/activity/presence')
}

/** One squad's Activity counts and Active work cards (GET /api/squads/:id/activity/presence). */
export async function getSquadActivityPresence(
  squadId: string,
  fetch: typeof apiFetch = apiFetch
): Promise<SquadActivityPresence> {
  return fetch<SquadActivityPresence>(`/squads/${squadId}/activity/presence`)
}

/**
 * Cross-squad activity feed (GET /api/activity) — sibling of listSquadActivity
 * in ./squads, minus the squadId path segment. No accessSignature cache-keying
 * here: the server resolves per-squad RBAC itself and the global feed has no
 * live-overlay WS subscription to key against (see ActivityPage.tsx).
 */
export async function listGlobalActivity(
  options: ListGlobalActivityOptions = {},
  fetch: typeof apiFetch = apiFetch
): Promise<GlobalSquadActivityPage> {
  const params = new URLSearchParams()
  if (options.limit !== undefined) params.set('limit', String(options.limit))
  if (options.cursor) params.set('cursor', options.cursor)
  if (options.verbose) params.set('verbose', 'true')
  if (options.workStreamId) params.set('workStreamId', options.workStreamId)
  for (const agentId of [...new Set(options.agentIds ?? [])].sort()) params.append('agentId', agentId)
  for (const kind of [...new Set<SquadActivityKind>(options.kinds ?? [])].sort()) params.append('kind', kind)
  const query = params.toString()
  return fetch<GlobalSquadActivityPage>(
    `/activity${query ? `?${query}` : ''}`,
    options.signal ? { signal: options.signal } : undefined
  )
}
