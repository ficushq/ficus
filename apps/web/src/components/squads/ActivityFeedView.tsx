import { ActivityPreview } from './ActivityPreview'
import clsx from 'clsx'
import { useEffect, useRef } from 'react'
import type { Dispatch, MouseEvent as ReactMouseEvent, SetStateAction } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { Agent, SquadActivityItem, SquadActivityKind } from '@ficus/shared'
import { useStableRef } from '../../hooks/useStableRef'
import { useLoadingShapeCount } from '../../hooks/useLoadingShapeCount'
import { agentTypeColor } from '../../lib/agentTypeColor'
import { LoadingSurface, SkeletonBlock, SkeletonLine, SkeletonText, SkeletonRows } from '../loading/Skeleton'
import {
  activityExternalHref,
  ACTIVITY_SMALL_TEXT_CLASS,
  activityAgentLabel,
  activitySubjectLabel,
  FILTER_GROUPS,
  formatActivityTimestamp,
  squadActivityStatusMessage,
} from './squadActivityView'

export interface ActivityFeedViewProps<T extends SquadActivityItem = SquadActivityItem> {
  kinds: SquadActivityKind[]
  onKindsChange: Dispatch<SetStateAction<SquadActivityKind[]>>
  /** Presence strip data — omitted entirely when undefined. */
  presence?: { workingCount: number; needsYouCount: number; streamCount: number }
  presenceLoading?: boolean
  isLoading: boolean
  /** A new server-filtered kind selection is loading while current rows remain visible. */
  filtersPending?: boolean
  isError: boolean
  items: T[]
  loadingShapeKey: string
  /** Agent ids currently 'active' — the top-most row per id gets a pulsing live dot. */
  workingAgentIds: Set<string>
  /** Hover-tooltip detail for the label column (purpose/name); undefined renders no title. */
  agentDetailFor: (item: T) => string | undefined
  hrefFor: (item: T) => string
  /** Renders a separate squad identity column when provided (global feed only). */
  squadChipFor?: (item: T) => { label: string; href: string } | null
  /** Called for a plain (unmodified) click on a non-PR row; modified clicks keep navigation. */
  onOpen: (item: T) => void
  /** Keep resolved inline agent references in the owning feed, not a routed chat. */
  onOpenAgentReference: (agent: Agent) => void
  hasNextPage: boolean | undefined
  isFetchingNextPage: boolean
  onLoadMore: () => void
}

/**
 * Shared feed body for both the per-squad Activity tab (SquadActivityTab.tsx)
 * and the global cross-squad feed (ActivityPage.tsx): the kind-filter toolbar,
 * optional presence strip, the row list itself, and the infinite-scroll
 * sentinel. Row-shaping/filtering logic lives here ONCE — callers differ only
 * in how they source `items` (a live per-squad WS-overlaid query vs a plain
 * polled global query) and how they react to `onOpen` (which modal to show).
 * Generic over the item type so the global feed's rows (which carry a
 * `squadId` the per-squad wire shape omits) don't need casts.
 */
export function ActivityFeedView<T extends SquadActivityItem = SquadActivityItem>({
  kinds,
  onKindsChange,
  presence,
  presenceLoading = false,
  isLoading,
  filtersPending = false,
  isError,
  items,
  loadingShapeKey,
  workingAgentIds,
  agentDetailFor,
  hrefFor,
  squadChipFor,
  onOpen,
  onOpenAgentReference,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
}: ActivityFeedViewProps<T>) {
  const rowClassName = clsx(
    'relative flex flex-col gap-y-1 rounded-lg px-2 py-2.5 hover:bg-surface-hover lg:grid lg:gap-x-3',
    activityGridClass(squadChipFor !== undefined)
  )
  const navigate = useNavigate()
  const isGlobalFeed = squadChipFor !== undefined
  const loadingRowCount = useLoadingShapeCount(loadingShapeKey, isLoading ? undefined : items.length, {
    fallbackCount: 8,
    maxCount: 12,
  })
  const interceptRowClick = (item: T) => (event: ReactMouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
    if (item.ref.type === 'workstream' || item.ref.type === 'agent') {
      event.preventDefault()
      onOpen(item)
    }
  }

  // Infinite scroll (2026-08-27 audit: no Load-more button). The sentinel sits
  // under the list; entering the viewport (with a page of pre-fetch margin)
  // pulls the next page. Guarded: the SSR/static test harness has no
  // IntersectionObserver, and the ref re-observes when pagination state flips.
  const loadMoreSentinelRef = useRef<HTMLDivElement | null>(null)
  const loadMoreRef = useStableRef({ onLoadMore, hasNextPage, isFetchingNextPage })
  useEffect(() => {
    const sentinel = loadMoreSentinelRef.current
    if (!sentinel || !hasNextPage || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      (entries) => {
        const current = loadMoreRef.current
        if (entries.some((entry) => entry.isIntersecting) && current.hasNextPage && !current.isFetchingNextPage) {
          current.onLoadMore()
        }
      },
      { rootMargin: '600px 0px' }
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [hasNextPage, loadMoreRef])

  return (
    <>
      {/* Toolbar OUTSIDE the scroll container: the feed's scrollbar starts
          below it and the pills never scroll away (2026-08-27 audit). */}
      <div
        className={clsx(
          'flex shrink-0 items-center gap-1.5 overflow-x-auto ficus-section mb-2',
          isGlobalFeed ? 'px-3 py-3' : 'px-1 pb-1',
          filtersPending && 'animate-pulse'
        )}
        role="group"
        aria-label="Activity kind filters"
        aria-busy={filtersPending}
      >
        <button
          type="button"
          className={clsx(
            'ficus-button',
            'rounded-lg px-3 text-xs transition-colors',
            isGlobalFeed ? 'py-2' : 'py-1.5',
            kinds.length === 0
              ? 'bg-selection text-accent-light'
              : 'text-secondary hover:bg-surface-hover hover:text-primary'
          )}
          onClick={() => onKindsChange([])}
          aria-pressed={kinds.length === 0}
        >
          All
        </button>
        {FILTER_GROUPS.map((group) => {
          const active = group.kinds.every((kind) => kinds.includes(kind))
          return (
            <button
              type="button"
              key={group.label}
              className={clsx(
                'ficus-button',
                'rounded-lg px-3 text-xs transition-colors',
                isGlobalFeed ? 'py-2' : 'py-1.5',
                active ? 'bg-selection text-accent-light' : 'text-secondary hover:bg-surface-hover hover:text-primary'
              )}
              onClick={() =>
                onKindsChange((current) =>
                  active
                    ? current.filter((kind) => !group.kinds.includes(kind))
                    : [...current, ...group.kinds.filter((kind) => !current.includes(kind))]
                )
              }
              aria-pressed={active}
            >
              {group.label}
            </button>
          )
        })}
      </div>

      {/* Presence strip: background work at a glance even while no rows
          stream in. Counts only — per-agent chips were considered and
          rejected (can be many); the row dots below carry per-agent live
          state (operator decisions 2026-08-27). */}
      {presence && (
        <div
          className="mb-2 flex shrink-0 items-center gap-2 flex-wrap px-3 py-2 text-xs text-secondary"
          data-testid="activity-presence"
        >
          <span
            aria-hidden
            className={clsx(
              'inline-block h-1.5 w-1.5 rounded-full',
              presence.workingCount > 0 ? 'animate-pulse bg-status-progress-500' : 'bg-placeholder'
            )}
          />
          <span>{presenceLoading ? <SkeletonText className="inline-block w-3" /> : presence.workingCount} working</span>
          <span aria-hidden>·</span>
          <span
            className={clsx(
              presence.needsYouCount > 0 && 'font-medium text-status-attention-600 dark:text-status-attention-400'
            )}
          >
            {presenceLoading ? <SkeletonText className="inline-block w-3" /> : presence.needsYouCount} waiting on you
          </span>
          <span aria-hidden>·</span>
          <span>
            {presenceLoading ? <SkeletonText className="inline-block w-3" /> : presence.streamCount} active{' '}
            {presence.streamCount === 1 ? 'stream' : 'streams'}
          </span>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {isLoading && items.length === 0 && (
          <LoadingSurface label="Loading activity">
            <ol className="space-y-1 text-[13px]">
              <SkeletonRows count={Math.max(1, loadingRowCount)}>
                {(index) => (
                  <li key={index}>
                    <div className={rowClassName} aria-hidden="true">
                      <div
                        className={clsx(
                          'pointer-events-none min-w-0 items-center lg:contents',
                          isGlobalFeed ? 'grid grid-cols-[minmax(0,1fr)_minmax(0,auto)_auto] gap-x-2' : 'flex gap-2'
                        )}
                      >
                        <span
                          className={clsx(
                            'flex h-5 items-center lg:col-start-1',
                            isGlobalFeed
                              ? 'col-start-3 row-start-1 lg:col-start-1'
                              : 'order-last ml-auto lg:order-none lg:ml-0'
                          )}
                        >
                          <SkeletonLine className="w-10" />
                        </span>
                        {isGlobalFeed && <SkeletonBlock className="col-start-2 row-start-1 h-5 w-20 rounded" />}
                        <span
                          className={clsx(
                            'flex h-5 items-center',
                            isGlobalFeed ? 'col-start-1 row-start-1 lg:col-start-3' : 'lg:col-start-2'
                          )}
                        >
                          <SkeletonLine className="w-20" />
                        </span>
                      </div>
                      <span className="flex h-5 items-center">
                        <SkeletonLine className={index % 3 === 0 ? 'w-5/6' : 'w-2/3'} />
                      </span>
                    </div>
                  </li>
                )}
              </SkeletonRows>
            </ol>
          </LoadingSurface>
        )}
        {!isLoading && squadActivityStatusMessage(isLoading, isError, items.length) && (
          <p className={clsx('text-sm py-8 text-center', isError ? 'text-status-danger-600' : 'text-muted')}>
            {squadActivityStatusMessage(isLoading, isError, items.length)}
          </p>
        )}
        <ol className="space-y-1 text-[13px]">
          {(() => {
            // Top-most row per WORKING agent gets a pulsing live dot. Items
            // render newest-first, so first-seen wins; recomputed per render.
            const liveDotted = new Set<string>()
            return items.map((item) => {
              const subjectAgentId = item.ref.type === 'agent' ? item.ref.agentId : null
              const showLiveDot =
                !!subjectAgentId && workingAgentIds.has(subjectAgentId) && !liveDotted.has(subjectAgentId)
              if (showLiveDot) liveDotted.add(subjectAgentId!)
              const chip = squadChipFor?.(item)
              // Issue rows point at the code host; when the server resolved the
              // stream they also offer an in-app jump to it. Reusing `hrefFor`
              // with a work-stream ref keeps the spread's squadId, so the global
              // feed resolves each row's OWN squad slug.
              const workStreamChip =
                item.ref.type === 'issue' && item.ref.workStreamNumber !== undefined
                  ? {
                      number: item.ref.workStreamNumber,
                      href: hrefFor({
                        ...item,
                        ref: {
                          type: 'workstream',
                          workStreamId: item.ref.workStreamId ?? '',
                          workStreamNumber: item.ref.workStreamNumber,
                        },
                      } as T),
                    }
                  : null
              const content = (
                <>
                  {/* Responsive rows keep identity and time on one compact line. Global rows give
                      squad and agent independent shrinking boundaries; lg+ dissolves the
                      wrapper so all cells align to the row's desktop grid. */}
                  <div
                    className={clsx(
                      'pointer-events-none min-w-0 items-center lg:contents',
                      isGlobalFeed ? 'grid grid-cols-[minmax(0,1fr)_minmax(0,auto)_auto] gap-x-2' : 'flex gap-2'
                    )}
                    data-activity-mobile-header={isGlobalFeed ? 'global' : 'squad'}
                  >
                    <time
                      dateTime={item.at}
                      dir="ltr"
                      className={clsx(
                        'tabular-nums whitespace-nowrap lg:col-start-1',
                        isGlobalFeed
                          ? 'col-start-3 row-start-1 lg:col-start-1'
                          : 'order-last ml-auto lg:order-none lg:ml-0',
                        ACTIVITY_SMALL_TEXT_CLASS
                      )}
                    >
                      {formatActivityTimestamp(item.at)}
                    </time>
                    {chip && (
                      <button
                        type="button"
                        onClick={(event) => {
                          event.preventDefault()
                          event.stopPropagation()
                          navigate(chip.href)
                        }}
                        className="ficus-button pointer-events-auto relative z-10 col-start-2 row-start-1 min-w-0 max-w-full self-start justify-self-end overflow-hidden rounded bg-pill px-1.5 py-0.5 text-right text-[10px] font-sans font-medium text-muted hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent lg:col-start-2 lg:justify-self-start lg:text-left"
                        data-activity-column="squad"
                        aria-label={`Open activity for ${chip.label}`}
                        title={chip.label}
                      >
                        <span className="block truncate">{chip.label}</span>
                      </button>
                    )}
                    <span
                      className={clsx(
                        'min-w-0 truncate',
                        isGlobalFeed
                          ? 'col-start-1 row-start-1 justify-self-start text-left lg:col-start-3'
                          : 'lg:col-start-2',
                        agentTypeColor(item.ref.type === 'agent' ? item.agentTypeId : null)
                      )}
                      data-activity-column="agent"
                      title={item.ref.type === 'agent' ? agentDetailFor(item) : activitySubjectLabel(item)}
                    >
                      {showLiveDot && (
                        <span
                          title="Working now"
                          // Intentional exception: the newest live activity row inherits the
                          // adjacent agent-type identity color rather than a semantic status role.
                          className="mr-1.5 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-current align-middle"
                        />
                      )}
                      {activitySubjectLabel(item)}
                    </span>
                  </div>
                  <span
                    className={clsx(
                      'pointer-events-none relative z-10 min-w-0 break-words lg:col-span-1',
                      isGlobalFeed ? 'lg:col-start-4' : 'lg:col-start-3',
                      item.kind !== 'message' && ACTIVITY_SMALL_TEXT_CLASS
                    )}
                    data-activity-column="summary"
                  >
                    {item.ref.type === 'workstream' && item.kind !== 'handoff' && item.agentTypeId && (
                      <span>By {activityAgentLabel(item.agentTypeId)} · </span>
                    )}
                    <ActivityPreview spans={item.preview} onOpenAgent={onOpenAgentReference} />
                    {workStreamChip && (
                      <button
                        type="button"
                        onClick={(event) => {
                          event.preventDefault()
                          event.stopPropagation()
                          navigate(workStreamChip.href)
                        }}
                        className="ficus-button pointer-events-auto relative z-10 ml-1.5 rounded bg-pill px-1.5 py-0.5 align-middle text-[10px] font-medium text-muted hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                        aria-label={`Open work stream #${workStreamChip.number}`}
                      >
                        #{workStreamChip.number}
                      </button>
                    )}
                  </span>
                </>
              )
              const external = item.ref.type === 'pr' || item.ref.type === 'issue'
              const sourceHref =
                item.ref.type === 'pr' || item.ref.type === 'issue' ? activityExternalHref(item.ref.url) : hrefFor(item)
              return (
                <li key={item.id}>
                  <div className={rowClassName} data-activity-layout={isGlobalFeed ? 'global' : 'squad'}>
                    {/* A sibling stretched anchor owns the non-interactive row area.
                        Inline links/chips sit above it, never inside another control. */}
                    {sourceHref &&
                      (external ? (
                        <a
                          className="absolute inset-0 rounded-lg focus-visible:ring-2 focus-visible:ring-accent"
                          href={sourceHref}
                          target="_blank"
                          rel="noopener noreferrer"
                          aria-label={`Open activity source: ${activitySubjectLabel(item)} — ${item.summary}`}
                        />
                      ) : (
                        <Link
                          className="absolute inset-0 rounded-lg focus-visible:ring-2 focus-visible:ring-accent"
                          to={sourceHref}
                          onClick={interceptRowClick(item)}
                          aria-label={`Open activity source: ${activitySubjectLabel(item)} — ${item.summary}`}
                        />
                      ))}
                    {content}
                  </div>
                </li>
              )
            })
          })()}
        </ol>
        {hasNextPage && (
          <div ref={loadMoreSentinelRef} aria-hidden className="py-4 text-center text-sm text-muted">
            {isFetchingNextPage ? 'Loading more…' : ' '}
          </div>
        )}
      </div>
    </>
  )
}

function activityGridClass(global: boolean) {
  return global ? 'lg:grid-cols-[4rem_minmax(5rem,8rem)_8rem_minmax(0,1fr)]' : 'lg:grid-cols-[4rem_8rem_1fr]'
}
