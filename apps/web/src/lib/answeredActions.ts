import type { QueryClient } from '@tanstack/react-query'
import type { PendingAction } from '@ficus/shared'
import { queryKeys } from '../queryKeys'

/**
 * Pending actions the user answered (or resolved) in this session. A refetch that started before the
 * answer reached the server can briefly return the card again; Needs you shows it then without the
 * arrival highlight (LiveListMotion's `quiet` rows), since nothing new arrived.
 */
const answered = new Set<string>()

/** Whether the user answered this pending action in this session. */
export function wasActionAnswered(actionId: string): boolean {
  return answered.has(actionId)
}

/**
 * Records answered pending actions and removes them from the cached list at once, before the caller
 * refetches the authoritative list.
 */
export function removeAnsweredActions(queryClient: QueryClient, actionIds: Iterable<string>): void {
  const removed = new Set(actionIds)
  for (const id of removed) answered.add(id)
  queryClient.setQueryData<PendingAction[]>(queryKeys.actions.pending(), (current) =>
    current?.filter((action) => !removed.has(action.id))
  )
}
