import { useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '../queryKeys'

/** Refetch everything a workflow decision changes: the run, the stream, its squad lists and the Feed. */
export function useWorkflowRefresh(stream: { id: string }) {
  const queryClient = useQueryClient()
  return () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.workflows.all })
    queryClient.invalidateQueries({ queryKey: queryKeys.squads.all })
    queryClient.invalidateQueries({ queryKey: queryKeys.squads.workStreamDetail(stream.id) })
    queryClient.invalidateQueries({ queryKey: queryKeys.actions.pending() })
  }
}
