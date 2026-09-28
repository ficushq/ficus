import { useState } from 'react'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { OperationsRecommendationStatus } from '@ficus/shared'
import { queries } from '../queryOptions'
import { queryKeys } from '../queryKeys'
import { isRecommendationCursorReset, updateRecommendationStatus } from '../api/recommendations'
import { usePermissions } from '../hooks/usePermissions'
import { Modal } from './Modal'
import { RecommendationCard } from './recommendations/RecommendationCard'
import { RecommendationDetail } from './recommendations/RecommendationDetail'
import { useLoadingShapeCount } from '../hooks/useLoadingShapeCount'
import { LoadingSurface, SkeletonBlock, SkeletonCard, SkeletonLine, SkeletonRows } from './loading/Skeleton'
import clsx from 'clsx'

const STATUS_OPTIONS: OperationsRecommendationStatus[] = ['open', 'acknowledged', 'dismissed', 'resolved']

const SELECT_CLASSES =
  'appearance-none rounded-md border border-th-border bg-surface py-1.5 pl-3 pr-8 text-sm text-primary ' +
  'hover:border-th-border-hover  focus:ring-2 focus:ring-accent'

/** Shared chevron affordance for the appearance-none selects above. */
function SelectChevron() {
  return (
    <svg
      className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted"
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden="true"
    >
      <path d="M2.5 4.5L6 8l3.5-3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

export function RecommendationsPage() {
  const [status, setStatus] = useState<OperationsRecommendationStatus>('open')
  const [selected, setSelected] = useState<string | null>(null)
  const [squadId, setSquadId] = useState('')
  const { can, isLoading: permissionsLoading, isError: permissionsError } = usePermissions()
  const canReadRecommendations = !permissionsLoading && !permissionsError && can('recommendations:read')
  const canReadSquads = canReadRecommendations && can('squads:read')
  const filters = { status, squadId: squadId || undefined, limit: 50 }
  const recommendationOptions = queries.recommendations.infinite(filters)
  const squadsQuery = useQuery({ ...queries.squads.list(), enabled: canReadSquads })
  const query = useInfiniteQuery({ ...recommendationOptions, enabled: canReadRecommendations })
  const detail = useQuery({
    ...queries.recommendations.detail(selected ?? ''),
    enabled: canReadRecommendations && !!selected,
  })
  const qc = useQueryClient()
  const mutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: OperationsRecommendationStatus }) =>
      updateRecommendationStatus(id, status),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.recommendations.all }),
  })
  const items = query.data?.pages.flatMap((p) => p.items) ?? []
  const collectionIsLoading = permissionsLoading || query.isLoading
  const loadingCardCount = useLoadingShapeCount(
    'recommendations:list',
    collectionIsLoading ? undefined : items.length,
    { fallbackCount: 4, maxCount: 8 }
  )
  const recommendationSkeletons = (
    <LoadingSurface label="Loading recommendations" className="space-y-2">
      <SkeletonRows count={Math.max(1, loadingCardCount)}>
        {(index) => (
          <SkeletonCard key={index} className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <SkeletonLine className={index % 2 ? 'w-2/5' : 'w-3/5'} />
              <SkeletonBlock className="h-5 w-16 rounded-full" />
            </div>
            <SkeletonLine className="w-full" />
            <SkeletonLine className="w-5/6" />
            <SkeletonLine className="w-2/5" />
          </SkeletonCard>
        )}
      </SkeletonRows>
    </LoadingSurface>
  )
  if (permissionsLoading) return <div className="max-w-3xl">{recommendationSkeletons}</div>
  if (permissionsError || !can('recommendations:read')) return <p className="text-sm text-muted">Access denied</p>
  return (
    <div className="max-w-3xl space-y-4">
      <header className="space-y-1">
        <h2 className="text-lg font-semibold text-primary">Ops Insights</h2>
        <p className="text-sm text-secondary">
          Operational recommendations distilled from completed executions.{' '}
          <span className="text-muted">Recommendation only — Ficus never applies these changes automatically.</span>
        </p>
      </header>

      <div
        className={clsx(
          'flex flex-wrap items-center gap-3',
          query.isPlaceholderData && query.isFetching && 'animate-pulse'
        )}
        aria-busy={query.isPlaceholderData && query.isFetching}
      >
        <label className="flex items-center gap-2 text-sm text-secondary">
          Status
          <span className="relative">
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as OperationsRecommendationStatus)}
              className={clsx('ficus-field', `${SELECT_CLASSES} capitalize`)}
            >
              {STATUS_OPTIONS.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
            <SelectChevron />
          </span>
        </label>
        {canReadSquads ? (
          <label className="flex items-center gap-2 text-sm text-secondary">
            Squad
            <span className="relative">
              <select
                value={squadId}
                onChange={(event) => {
                  setSquadId(event.target.value)
                  setSelected(null)
                }}
                aria-label="Filter recommendations by squad"
                className={clsx('ficus-field', `${SELECT_CLASSES} max-w-56 truncate`)}
              >
                <option value="">All authorized squads</option>
                {(squadsQuery.data ?? []).map((squad) => (
                  <option key={squad.id} value={squad.id}>
                    {squad.name}
                  </option>
                ))}
              </select>
              <SelectChevron />
            </span>
          </label>
        ) : (
          <p className="text-sm text-muted">Showing all authorized squads</p>
        )}
      </div>

      {query.isFetchNextPageError && isRecommendationCursorReset(query.error) ? (
        <p className="text-sm text-secondary">
          Your recommendation access changed. Restart results to continue.{' '}
          <button
            onClick={() => qc.resetQueries({ queryKey: recommendationOptions.queryKey, exact: true })}
            className="ficus-button rounded-md border border-th-border px-2.5 py-1 text-sm text-primary hover:bg-surface-hover"
          >
            Restart results
          </button>
        </p>
      ) : query.isLoading ? (
        recommendationSkeletons
      ) : query.isError ? (
        <p className="text-sm text-muted">Unable to load recommendations.</p>
      ) : items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-th-border p-8 text-center text-sm text-muted">
          No {status} recommendations.
        </div>
      ) : (
        <div className="space-y-2">
          {items.map((item) => (
            <RecommendationCard key={item.id} item={item} onOpen={() => setSelected(item.id)} />
          ))}
        </div>
      )}
      {query.hasNextPage && (
        <button
          onClick={() => query.fetchNextPage()}
          disabled={query.isFetchingNextPage}
          className="ficus-button rounded-md border border-th-border px-3 py-1.5 text-sm text-primary hover:bg-surface-hover disabled:opacity-50"
        >
          {query.isFetchingNextPage ? 'Loading…' : 'Load more'}
        </button>
      )}
      <Modal isOpen={!!selected} onClose={() => setSelected(null)} title={detail.data?.title ?? 'Recommendation'}>
        {detail.data ? (
          <RecommendationDetail
            item={detail.data}
            canUpdate={can('recommendations:update')}
            onStatus={(s) => mutation.mutate({ id: detail.data.id, status: s })}
          />
        ) : (
          <LoadingSurface label="Loading recommendation details" className="space-y-4">
            <div className="flex gap-2">
              <SkeletonBlock className="h-6 w-24 rounded-full" />
              <SkeletonBlock className="h-6 w-20 rounded-full" />
            </div>
            <SkeletonLine className="w-full" />
            <SkeletonLine className="w-4/5" />
            <SkeletonCard className="space-y-2">
              <SkeletonLine className="w-24" />
              <SkeletonLine className="w-full" />
              <SkeletonLine className="w-3/4" />
            </SkeletonCard>
          </LoadingSurface>
        )}
      </Modal>
    </div>
  )
}
