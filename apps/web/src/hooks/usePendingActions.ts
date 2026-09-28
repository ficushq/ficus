import { useQuery } from '@tanstack/react-query'
import { queries } from '../queryOptions'
import type { PendingAction } from '@ficus/shared'

export function usePendingActions() {
  return useQuery({
    ...queries.actions.pending(),
    // Refetch every 30 seconds as fallback
    refetchInterval: 30_000,
  })
}

export function pendingActionsPresentation<T = PendingAction>(query: {
  data?: T[]
  isLoading?: boolean
  isFetching?: boolean
  isError?: boolean
}) {
  const actions = query.data ?? []
  if (query.isError) return { actions, count: null, status: 'error' as const }
  if (query.isLoading) {
    return { actions, count: null, status: 'loading' as const }
  }
  return { actions, count: actions.length, status: 'ready' as const }
}
