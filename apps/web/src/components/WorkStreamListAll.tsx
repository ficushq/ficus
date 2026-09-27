import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { feedQueries, queries } from '../queryOptions'
import { useInfiniteDoneWorkStreams } from '../hooks/useInfiniteDoneWorkStreams'
import { useURLStringArrayState } from '../hooks/useURLState'
import { WorkStreamList, VALID_WS_STATUS_FILTERS, WS_DONE_STATUSES } from './WorkStreamList'
export function WorkStreamListAll({ filterContainer }: { filterContainer?: HTMLElement | null }) {
  const [statusFilters, setStatusFilters] = useURLStringArrayState('status', VALID_WS_STATUS_FILTERS)
  const [squadFilters] = useURLStringArrayState('squad')
  const { data: activeWorkStreams = [], isLoading: wsLoading } = useQuery(queries.squads.attentionWorkStreams())
  const { data: squads = [], isLoading: squadsLoading } = useQuery(queries.squads.list())
  const { data: allAgents = [] } = useQuery(queries.agents.list())

  const selectedDoneStatuses = WS_DONE_STATUSES.filter((status) => statusFilters.includes(status))
  const recentOnly = statusFilters.length === 0
  const [recentAfter] = useState(() => new Date(Date.now() - 7 * 86_400_000).toISOString())
  const recent = useQuery({ ...feedQueries.recent(recentAfter, squadFilters), enabled: recentOnly })
  const doneEnabled = statusFilters.length === 0 || selectedDoneStatuses.length > 0
  const doneStatuses = statusFilters.length === 0 ? WS_DONE_STATUSES : selectedDoneStatuses
  const { doneStreams, doneTotalCount, hasMoreDone, isFetchingMoreDone, isLoadingDone, fetchMoreDone } =
    useInfiniteDoneWorkStreams({
      // Keep the singular endpoint optimization for one selection; use its
      // aggregate filter for multiple selections.
      squadId: squadFilters.length === 1 ? squadFilters[0] : undefined,
      squadIds: squadFilters.length > 1 ? squadFilters : undefined,
      statuses: doneStatuses,
      enabled: doneEnabled && !recentOnly,
    })

  // Build maps
  const squadMap = useMemo(() => new Map(squads.map((s) => [s.id, s])), [squads])
  const agentMap = useMemo(() => new Map(allAgents.map((a) => [a.id, a])), [allAgents])

  return (
    <WorkStreamList
      filterContainer={filterContainer}
      workStreams={activeWorkStreams}
      squadMap={squadMap}
      agentMap={agentMap}
      squads={squads}
      squadsLoading={squadsLoading}
      showSquadFilter={true}
      feedLayout
      doneTitle={recentOnly ? 'Recently completed' : 'Completed work'}
      doneCountLabel={recentOnly ? `Latest ${recent.data?.items?.length ?? 0} · Past 7 days` : undefined}
      doneFooter={
        recentOnly && (
          <button
            className="ficus-button pl-10 pr-3 py-2 text-xs text-muted hover:text-primary"
            onClick={() => setStatusFilters(['done'])}
          >
            See all →
          </button>
        )
      }
      loadingError={recentOnly && recent.isError ? 'Recent completions could not be loaded.' : undefined}
      isLoading={wsLoading}
      isLoadingDone={recentOnly ? recent.isPending : doneEnabled && isLoadingDone}
      doneStreams={recentOnly ? (recent.data?.items ?? []) : doneEnabled ? doneStreams : []}
      doneTotalCount={recentOnly ? (recent.data?.totalCount ?? 0) : doneEnabled ? doneTotalCount : 0}
      hasMoreDone={!recentOnly && doneEnabled && hasMoreDone}
      isFetchingMoreDone={isFetchingMoreDone}
      onLoadMoreDone={fetchMoreDone}
      emptyMessage="No active work right now"
    />
  )
}
