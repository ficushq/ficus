import type {
  OperationsRecommendationDetail,
  OperationsRecommendationPage,
  OperationsRecommendationStatus,
} from '@ficus/shared'
import { apiFetch, authFetch } from './client'
export interface ListRecommendationsParams {
  status?: OperationsRecommendationStatus
  squadId?: string
  limit?: number
  cursor?: string
}
export class RecommendationsApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string
  ) {
    super(message)
  }
}

export function isRecommendationCursorReset(error: unknown): error is RecommendationsApiError {
  return error instanceof RecommendationsApiError && error.code === 'RECOMMENDATIONS_CURSOR_RESET_REQUIRED'
}

export async function listRecommendations(
  params: ListRecommendationsParams = {},
  client: Pick<typeof import('./client'), 'authFetch'> = { authFetch }
): Promise<OperationsRecommendationPage> {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, String(v))
  const response = await client.authFetch(`/recommendations${q.size ? `?${q}` : ''}`)
  const body = (await response.json()) as OperationsRecommendationPage & { error?: string; code?: string }
  if (!response.ok) throw new RecommendationsApiError(body.error ?? 'Request failed', response.status, body.code)
  return body
}
export const getRecommendation = (id: string): Promise<OperationsRecommendationDetail> =>
  apiFetch(`/recommendations/${id}`)
export const updateRecommendationStatus = (
  id: string,
  status: OperationsRecommendationStatus,
  fetch: typeof apiFetch = apiFetch
): Promise<OperationsRecommendationDetail> =>
  fetch(`/recommendations/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) })
