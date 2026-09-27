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

interface FeedPageDependencies {
  FeedVisitSummary: typeof FeedVisitSummary
  usePendingActions: typeof usePendingActions
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
    WorkStreamListAll: WorkStreamList = WorkStreamListAll,
    ActionCenterContent: ActionCenter = ActionCenterContent,
  } = dependencies
  const queryClient = useQueryClient()
  const [filterContainer, setFilterContainer] = useState<HTMLDivElement | null>(null)
  const pendingQuery = usePendingActionsHook()
  const { actions, count: actionCount, status: actionsStatus } = pendingActionsPresentation(pendingQuery)
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

      <VisitSummary actions={actions} ready={actionsStatus === 'ready'} />

      {actionsError || actions.length > 0 ? (
        <details open className="mb-4 group">
          <summary className="ficus-button flex cursor-pointer list-none items-center gap-2 py-2 text-left hover:bg-surface-hover marker:hidden [&::-webkit-details-marker]:hidden">
            <span
              aria-hidden="true"
              className="shrink-0 text-placeholder transition-transform group-open:rotate-90 motion-reduce:transition-none"
            >
              <ChevronRightIcon className="h-4 w-4" />
            </span>
            <span className="text-sm font-semibold text-secondary">Needs you</span>
            <span className="text-xs text-muted tabular-nums">
              {actionsError ? 'Unavailable' : `${actionCount} pending`}
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
          className="ficus-button mb-4 flex w-full items-center gap-2 py-2 text-left text-muted"
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
            <span className="text-xs">You’re all caught up</span>
          )}
        </button>
      )}

      <WorkStreamList filterContainer={filterContainer} />
    </PullToRefresh>
  )
}
