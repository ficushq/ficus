import type { SpendBreakdown, SpendDimension, SpendFilters, SpendSummary } from '@ficus/shared'
import { apiFetch } from './client'

export interface SpendQuery {
  /** ISO timestamps, `[from, to)`. */
  from: string
  to: string
  filters: SpendFilters
}

function params(query: SpendQuery, extra: Record<string, string | number | undefined> = {}): string {
  const search = new URLSearchParams({ from: query.from, to: query.to })
  for (const [key, value] of Object.entries({ ...query.filters, ...extra }))
    if (value !== undefined) search.set(key, String(value))
  return search.toString()
}

/** Totals, daily series, subscription line items and this month's projection (needs usage:read). */
export function getSpendSummary(query: SpendQuery): Promise<SpendSummary> {
  return apiFetch<SpendSummary>(`/spend/summary?${params(query)}`)
}

/** Spend grouped by one dimension, optionally split by a second (needs usage:read). */
export function getSpendBreakdown(
  query: SpendQuery & { by: SpendDimension; by2?: SpendDimension; limit?: number }
): Promise<SpendBreakdown> {
  return apiFetch<SpendBreakdown>(
    `/spend/breakdown?${params(query, { by: query.by, by2: query.by2, limit: query.limit })}`
  )
}
