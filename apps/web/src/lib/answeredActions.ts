import type { QueryClient } from '@tanstack/react-query'
import type { PendingAction } from '@ficus/shared'
import { queryKeys } from '../queryKeys'

/**
 * Pending actions the user just answered (or resolved), each with the order it was answered in. A
 * refetch that started before the answer reached the server can briefly return the card again;
 * Needs you shows it then without the arrival highlight (LiveListMotion's `quiet` rows), since
 * nothing new arrived.
 *
 * Some ids name a recurring item, not one occurrence (`agent-error:<agentId>` for every halt of
 * that agent, `squad-question:<agentId>`, a delivery gate, an Assistant task), so an id is forgotten
 * as soon as a fetch that started after the answer returns without it: from then on the card coming
 * back is a new occurrence and is highlighted like any arrival.
 */
const answered = new Map<string, number>()
let answeredCount = 0

/** Whether the user answered this pending action and no later fetch has confirmed it gone. */
export function wasActionAnswered(actionId: string): boolean {
  return answered.has(actionId)
}

/**
 * Records answered pending actions and removes them from the cached list at once, before the caller
 * refetches the authoritative list.
 */
export function removeAnsweredActions(queryClient: QueryClient, actionIds: Iterable<string>): void {
  const removed = new Set(actionIds)
  for (const id of removed) answered.set(id, ++answeredCount)
  queryClient.setQueryData<PendingAction[]>(queryKeys.actions.pending(), (current) =>
    current?.filter((action) => !removed.has(action.id))
  )
}

/**
 * Wraps the pending actions fetch: when it returns, every answer recorded before it started whose
 * card is not in the result is forgotten. A fetch already in flight when the user answered may still
 * return the card, so it forgets nothing recorded after it started.
 */
export function forgetSettledAnswers(
  fetchPendingActions: () => Promise<PendingAction[]>
): () => Promise<PendingAction[]> {
  return async () => {
    const answeredBefore = answeredCount
    const actions = await fetchPendingActions()
    if (answered.size === 0) return actions
    const present = new Set(actions.map((action) => action.id))
    for (const [id, order] of answered) if (order <= answeredBefore && !present.has(id)) answered.delete(id)
    return actions
  }
}
