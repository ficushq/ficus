import { useEffect, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { queries } from '../queryOptions'
import { queryKeys } from '../queryKeys'
import { useWebSocket } from './useWebSocket'

/** Changes arriving together (an agent's burst of steps, a sweep) refetch once. */
const REFRESH_DEBOUNCE_MS = 400

/**
 * Keeps the cross-squad Activity feed live: listens to each visible squad's
 * `squadActivity:<id>` topic (the per-squad tab's live feed) and refreshes the
 * global feed shortly after any row there changes, and again after a
 * reconnect. The server still decides what each viewer may see, so a refetch
 * rather than merging pushed rows keeps access and filters exactly as the
 * endpoint answers them. The feed's 30s poll stays as the fallback.
 */
export function useGlobalActivityLive(enabled = true): void {
  const queryClient = useQueryClient()
  const { subscribe, isConnected } = useWebSocket()
  const { data: squads = [] } = useQuery({ ...queries.squads.list(), enabled })
  const squadIds = squads
    .filter((squad) => squad.status !== 'archived')
    .map((squad) => squad.id)
    .sort()
    .join(',')
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)

  useEffect(() => {
    if (!enabled || !squadIds) return
    const refresh = () => {
      clearTimeout(timer.current)
      timer.current = setTimeout(() => {
        void queryClient.invalidateQueries({ queryKey: queryKeys.activity.all })
      }, REFRESH_DEBOUNCE_MS)
    }
    const unsubscribes = squadIds.split(',').map((id) =>
      subscribe(`squadActivity:${id}`, ({ event }) => {
        if (event === 'squadActivity.projected' || event === 'squadActivity.accessRevoked') refresh()
      })
    )
    return () => {
      clearTimeout(timer.current)
      for (const unsubscribe of unsubscribes) unsubscribe()
    }
  }, [enabled, squadIds, subscribe, queryClient])

  // Whatever changed while the socket was away.
  const wasConnected = useRef(isConnected)
  useEffect(() => {
    if (enabled && isConnected && !wasConnected.current)
      void queryClient.invalidateQueries({ queryKey: queryKeys.activity.all })
    wasConnected.current = isConnected
  }, [enabled, isConnected, queryClient])
}
