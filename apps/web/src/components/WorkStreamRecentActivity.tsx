import clsx from 'clsx'
import { useContext, useEffect, useMemo, useRef } from 'react'
import { Link } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { activityRowContextLabel, hideRelayedSenderRows, type WorkStream } from '@ficus/shared'
import { queries } from '../queryOptions'
import { workStreamActivityQueryKeys } from '../queryKeys'
import { WebSocketContext } from '../hooks/useWebSocket'
import { agentTypeColor } from '../lib/agentTypeColor'
import { ActivityRowText } from './squads/ActivityRowText'
import {
  ACTIVITY_SMALL_TEXT_CLASS,
  activityAgentLabel,
  activitySubjectLabel,
  formatActivityTimestamp,
} from './squads/squadActivityView'
import { workStreamActivityHref } from '../lib/workStreamActivity'
import { LoadingSurface, SkeletonLine, SkeletonRows } from './loading/Skeleton'

/** How many rows the modal shows; the link opens the rest on the Activity page. */
export const WORK_STREAM_RECENT_ACTIVITY_LIMIT = 5

/** Changes arriving together (an agent's burst of steps) refetch once. */
export const REFRESH_DEBOUNCE_MS = 400

/**
 * Keeps one stream's recent rows live: its squad's `squadActivity` topic (the same topic the Activity
 * page listens to) refetches them shortly after any row there changes, and again after a reconnect.
 * Without a socket (tests, embeds) the query's poll is the fallback.
 */
function useWorkStreamRecentActivityLive(workStreamId: string, squadId: string) {
  const queryClient = useQueryClient()
  const socket = useContext(WebSocketContext)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const subscribe = socket?.subscribe
  useEffect(() => {
    if (!subscribe) return
    const refresh = () => {
      clearTimeout(timer.current)
      timer.current = setTimeout(
        () => void queryClient.invalidateQueries({ queryKey: workStreamActivityQueryKeys.recent(workStreamId) }),
        REFRESH_DEBOUNCE_MS
      )
    }
    const unsubscribe = subscribe(`squadActivity:${squadId}`, refresh)
    return () => {
      clearTimeout(timer.current)
      unsubscribe()
    }
  }, [subscribe, queryClient, squadId, workStreamId])
  const isConnected = socket?.isConnected ?? false
  const wasConnected = useRef(isConnected)
  useEffect(() => {
    if (isConnected && !wasConnected.current)
      void queryClient.invalidateQueries({ queryKey: workStreamActivityQueryKeys.recent(workStreamId) })
    wasConnected.current = isConnected
  }, [isConnected, queryClient, workStreamId])
}

/**
 * What happened last: the stream's newest Activity rows, from the Activity feed itself and worded the
 * same way, with a link to the Activity page filtered to this stream.
 */
export function WorkStreamRecentActivity({ stream, onNavigate }: { stream: WorkStream; onNavigate?: () => void }) {
  const { data, isPending, isError } = useQuery(queries.activity.workStreamRecent(stream.id))
  useWorkStreamRecentActivityLive(stream.id, stream.squadId)
  const items = useMemo(
    () => hideRelayedSenderRows(data?.items ?? []).slice(0, WORK_STREAM_RECENT_ACTIVITY_LIMIT),
    [data]
  )
  return (
    <section aria-label="Recent activity" className="space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-xs font-medium text-secondary">Recent activity</h3>
        <Link
          to={workStreamActivityHref(stream.id)}
          onClick={onNavigate}
          className="text-xs text-accent-light hover:text-link-hover hover:underline"
        >
          View all in Activity
        </Link>
      </div>
      {isPending ? (
        <LoadingSurface label="Loading recent activity">
          <ul className="space-y-2">
            <SkeletonRows count={3}>
              {(index) => (
                <li key={index}>
                  <SkeletonLine className={index % 2 ? 'w-2/3' : 'w-5/6'} />
                </li>
              )}
            </SkeletonRows>
          </ul>
        </LoadingSurface>
      ) : isError ? (
        <p className="text-xs text-muted">Recent activity could not be loaded.</p>
      ) : items.length === 0 ? (
        <p className="text-xs text-muted">No activity yet.</p>
      ) : (
        <ol className="space-y-1.5 text-[13px]">
          {items.map((item) => {
            // Rows about this stream would repeat its title and step; other context still shows.
            const context = item.context?.workStream?.id === stream.id ? null : activityRowContextLabel(item)
            return (
              <li
                key={item.id}
                className="flex flex-col gap-y-0.5 sm:grid sm:grid-cols-[3.25rem_minmax(0,7rem)_minmax(0,1fr)] sm:gap-x-3"
                data-recent-activity-row=""
              >
                <time
                  dateTime={item.at}
                  dir="ltr"
                  className={clsx('tabular-nums whitespace-nowrap', ACTIVITY_SMALL_TEXT_CLASS)}
                >
                  {formatActivityTimestamp(item.at)}
                </time>
                <span
                  className={clsx(
                    'min-w-0 truncate',
                    agentTypeColor(item.ref.type === 'agent' ? item.agentTypeId : null)
                  )}
                  title={activitySubjectLabel(item)}
                >
                  {activitySubjectLabel(item)}
                </span>
                <span className={clsx('min-w-0 wrap-break-word', item.kind !== 'message' && ACTIVITY_SMALL_TEXT_CLASS)}>
                  {context && <span className="block truncate text-xs text-muted">{context}</span>}
                  {item.ref.type === 'workstream' && item.kind !== 'handoff' && item.agentTypeId && (
                    <span>By {activityAgentLabel(item.agentTypeId)} · </span>
                  )}
                  <ActivityRowText item={item} />
                </span>
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}
