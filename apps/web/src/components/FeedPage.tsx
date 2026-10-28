import { FeedVisitSummary } from './FeedVisitSummary'
import { type ComponentProps, type ComponentType, useCallback, useState } from 'react'
import { useQueryClient } from '../reactQueryHooks'
import { WorkStreamListAll } from './WorkStreamListAll'
import { ActionCenterContent } from './ActionCenterContent'
import { PullToRefresh } from './PullToRefresh'
import { pendingActionsPresentation, usePendingActions } from '../hooks/usePendingActions'
import { queryKeys } from '../queryKeys'
import { SkeletonBlock } from './loading/Skeleton'
import { ChevronRightIcon } from './icons'
import { useURLStringArrayState } from '../hooks/useURLState'
import { filterPendingActionsBySquads } from '../lib/pendingActionSquads'

/** The Feed's squad filter, shared through the `squad` URL param with the work stream list's Filters menu. */
function useFeedSquadFilters(): string[] {
  return useURLStringArrayState('squad')[0]
}

interface FeedPageDependencies {
  FeedVisitSummary: typeof FeedVisitSummary
  usePendingActions: typeof usePendingActions
  useSquadFilters: () => string[]
  WorkStreamListAll: ComponentType<ComponentProps<typeof WorkStreamListAll>>
  ActionCenterContent: ComponentType<ComponentProps<typeof ActionCenterContent>>
}

interface FeedPageProps {
  dependencies?: Partial<FeedPageDependencies>
}

export function FeedPage({ dependencies = {} }: FeedPageProps) {
  const {
    FeedVisitSummary: VisitSummary = FeedVisitSummary,
    usePendingActions: usePendingActionsHook = usePendingActions,
    useSquadFilters = useFeedSquadFilters,
    WorkStreamListAll: WorkStreamList = WorkStreamListAll,
    ActionCenterContent: ActionCenter = ActionCenterContent,
  } = dependencies
  const queryClient = useQueryClient()
  const [filterContainer, setFilterContainer] = useState<HTMLDivElement | null>(null)
  const pendingQuery = usePendingActionsHook()
  const { actions: allActions, status: actionsStatus } = pendingActionsPresentation(pendingQuery)
  // The squad filter is display-only: every section shows the selected squads' share of the same data.
  const squadFilters = useSquadFilters()
  const actions = filterPendingActionsBySquads(allActions, squadFilters)
  const hiddenByFilter = allActions.length > actions.length
  const { error, refetch } = pendingQuery
  const actionsLoading = actionsStatus === 'loading'
  const actionsError = actionsStatus === 'error'

  const refreshFeed = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.squads.all }),
      queryClient.invalidateQueries({ queryKey: queryKeys.actions.pending() }),
    ])
  }, [queryClient])

  return (
    <PullToRefresh id="feed-pull-to-refresh" onRefresh={refreshFeed} label="feed" data-testid="feed-pull-to-refresh">
      <div className="flex items-center justify-between mb-5">
        <h2 className="ficus-page-title">Feed</h2>
        <div ref={setFilterContainer} />
      </div>

      <VisitSummary squadIds={squadFilters} />

      {actionsError || actions.length > 0 ? (
        <details open className="mb-4 group">
          <summary className="ficus-button ficus-button-ghost flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-left marker:hidden [&::-webkit-details-marker]:hidden">
            <span
              aria-hidden="true"
              className="shrink-0 text-placeholder transition-transform group-open:rotate-90 motion-reduce:transition-none"
            >
              <ChevronRightIcon className="h-4 w-4" />
            </span>
            <span className="text-sm font-semibold text-secondary">Needs you</span>
            <span className="text-xs text-muted tabular-nums">
              {actionsError ? 'Unavailable' : `${actions.length} pending`}
            </span>
          </summary>
          <div className="pb-3 pt-3">
            <ActionCenter
              actions={actions}
              isLoading={false}
              isError={actionsError}
              error={error}
              onRetry={() => void refetch()}
            />
          </div>
        </details>
      ) : (
        <button
          type="button"
          disabled
          className="ficus-button ficus-button-ghost mb-4 flex w-full items-center gap-2 px-3 py-2 text-left text-muted"
          aria-busy={actionsLoading || undefined}
        >
          <span aria-hidden="true" className="shrink-0 text-placeholder opacity-50">
            <ChevronRightIcon className="h-4 w-4" />
          </span>
          <span className="text-sm font-semibold">Needs you</span>
          {actionsLoading ? (
            <span role="status">
              <span className="sr-only">Loading pending actions</span>
              <SkeletonBlock className="h-4 w-28" />
            </span>
          ) : (
            <span className="text-xs">
              {hiddenByFilter ? 'Nothing pending in the selected squads' : 'You’re all caught up'}
            </span>
          )}
        </button>
      )}

      <WorkStreamList filterContainer={filterContainer} />
    </PullToRefresh>
  )
}
