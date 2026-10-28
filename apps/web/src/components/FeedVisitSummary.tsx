import clsx from 'clsx'
import { workStreamRef, workStreamTitle, type WorkStream } from '@ficus/shared'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useInfiniteQuery } from '../reactQueryHooks'
import { acknowledgeFeedCompletion } from '../api/squads'
import { feedQueries } from '../queryOptions'
import { usePermissions } from '../hooks/usePermissions'
import { useAssistantActivity } from '../hooks/useAssistantActivity'
import { formatAssistantUpdateTime } from '../lib/assistantActivityPresentation'
import { Link, useLocation } from 'react-router-dom'
import { ChevronRightIcon } from './icons'
import { webStatus } from '../lib/statusPresentation'

const ALL_SQUADS: readonly string[] = []
const completionKey = (stream: WorkStream) => `${stream.id}:${stream.completedAt}`

type FeedProps = { squadIds?: readonly string[] }

export function FeedVisitSummary(props: FeedProps) {
  const { identity } = usePermissions()
  return identity?.type === 'user' ? (
    <AccountFeedVisit key={identity.userId} userId={identity.userId} {...props} />
  ) : null
}

/** Exposure is deliberately conservative: no observer support means no automatic acknowledgement. */
function CompletionExposure({
  stream,
  acknowledge,
  seen,
  children,
}: {
  stream: WorkStream
  acknowledge: typeof acknowledgeFeedCompletion
  seen: Set<string>
  children: ReactNode
}) {
  const key = completionKey(stream)
  const row = useRef<HTMLLIElement>(null)
  const retry = useRef<() => void>(() => {})
  const [state, setState] = useState<'new' | 'seen' | 'failed'>(() => (seen.has(key) ? 'seen' : 'new'))
  useEffect(() => {
    const target = row.current
    if (!target || !stream.completedAt || !window.IntersectionObserver) return
    let active = true
    let visible = false
    let saving = false
    let saved = seen.has(key)
    const save = () => {
      if (!active || !visible || saving || saved || document.visibilityState !== 'visible') return
      // Intersection notifications can have been queued before a section was collapsed.
      if (target.closest('details:not([open])')) return
      saving = true
      void acknowledge(stream.id, new Date(stream.completedAt!).toISOString())
        .then(() => {
          saved = true
          seen.add(key)
          if (active) setState('seen')
        })
        .catch(() => {
          if (active) setState('failed')
        })
        .finally(() => {
          saving = false
        })
    }
    retry.current = save
    const observer = new window.IntersectionObserver(
      (entries) => {
        visible = entries.some(
          (entry) => entry.target === target && entry.isIntersecting && entry.intersectionRatio >= 0.5
        )
        if (visible) save()
      },
      { threshold: 0.5 }
    )
    const observe = () => {
      visible = false
      observer.disconnect()
      if (document.visibilityState === 'visible') observer.observe(target)
    }
    observe()
    document.addEventListener('visibilitychange', observe)
    return () => {
      active = false
      observer.disconnect()
      document.removeEventListener('visibilitychange', observe)
      retry.current = () => {}
    }
  }, [stream.id, stream.completedAt, acknowledge, seen, key])
  return (
    <li ref={row} data-completion-id={stream.id}>
      <div className="relative">
        {children}
        {state !== 'seen' && <span className="absolute right-3 top-2.5 text-xs text-muted">New</span>}
      </div>
      {state === 'failed' && (
        <p role="status" className="ml-9 text-xs text-muted">
          Could not save seen state.{' '}
          <button type="button" className="ficus-button ficus-button-link" onClick={() => retry.current()}>
            Retry
          </button>
        </p>
      )}
    </li>
  )
}

export function AccountFeedVisit({
  userId,
  squadIds = ALL_SQUADS,
  acknowledge = acknowledgeFeedCompletion,
  useActivity = useAssistantActivity,
}: FeedProps & {
  userId: string
  acknowledge?: typeof acknowledgeFeedCompletion
  useActivity?: typeof useAssistantActivity
}) {
  const location = useLocation()
  // Separate cache per mount/account: an old query page must not replay a saved receipt on refresh.
  const [visitId] = useState(() => crypto.randomUUID())
  const completed = useInfiniteQuery(feedQueries.updates(userId, visitId, squadIds))
  const [seen] = useState(() => new Set<string>())
  const [retained, setRetained] = useState<WorkStream[]>([])
  const section = useRef<HTMLDetailsElement>(null)
  const [newAbove, setNewAbove] = useState(false)
  useEffect(() => {
    if (!completed.isSuccess || !completed.isFetchedAfterMount) return
    const incoming = completed.data.pages.flatMap((page) => page.items)
    setRetained((previous) => {
      const keys = new Set(previous.map(completionKey))
      const added = incoming.filter((stream) => {
        const key = completionKey(stream)
        if (keys.has(key)) return false
        keys.add(key)
        return true
      })
      if (!added.length) return previous
      // Append, rather than reorder existing rows underneath the reader.
      return [...previous, ...added]
    })
  }, [completed.data, completed.isSuccess, completed.isFetchedAfterMount])
  useEffect(() => {
    if (retained.length && section.current && section.current.getBoundingClientRect().top < 0) setNewAbove(true)
  }, [retained])
  const streams = retained.filter((stream) => squadIds.length === 0 || squadIds.includes(stream.squadId))
  // These remain useful pointers into domain-unread Assistant conversations. Feed exposure does
  // not consume their unread state; they are not labeled as new Feed completions.
  const activity = useActivity()
  const unreadConversations =
    squadIds.length > 0 || activity.ownerId !== userId
      ? []
      : (activity.activity?.conversations ?? []).filter((row) => row.unreadUpdates > 0)
  if (!streams.length && !unreadConversations.length && !completed.isError) return null
  const parts = [
    streams.length ? `${streams.length} completed` : '',
    unreadConversations.length
      ? `${unreadConversations.length} Assistant ${unreadConversations.length === 1 ? 'update' : 'updates'}`
      : '',
  ].filter(Boolean)
  return (
    <>
      {newAbove && (
        <button
          type="button"
          className="ficus-button ficus-button-secondary fixed bottom-5 right-5 z-20 rounded-full px-3 py-2 text-sm shadow-sm"
          onClick={() => {
            if (section.current) {
              section.current.open = true
              section.current.scrollIntoView({ block: 'start' })
            }
            setNewAbove(false)
          }}
        >
          New updates ↑
        </button>
      )}
      <details ref={section} open className="mb-4 group" data-testid="feed-visit-summary">
        <summary className="ficus-button ficus-button-ghost flex cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 text-left marker:hidden [&::-webkit-details-marker]:hidden">
          <span
            aria-hidden="true"
            className="shrink-0 text-placeholder transition-transform group-open:rotate-90 motion-reduce:transition-none"
          >
            <ChevronRightIcon className="h-4 w-4" />
          </span>
          <span className="text-sm font-semibold text-secondary">Updates</span>
          <span className="text-xs text-muted">{parts.join(' · ')}</span>
        </summary>
        <div className="space-y-3 pb-3 pt-3">
          {completed.isError && (
            <p role="alert" className="ml-9 text-sm text-muted">
              Could not load updates.{' '}
              <button type="button" className="ficus-button ficus-button-link" onClick={() => void completed.refetch()}>
                Retry
              </button>
            </p>
          )}
          {unreadConversations.length > 0 && (
            <ul className="space-y-1" aria-label="Assistant updates">
              {unreadConversations.map((conversation) => {
                const params = new URLSearchParams(location.search)
                for (const key of ['commandStack', 'commandQuery', 'assistantChat']) params.delete(key)
                params.set('chat', 'open')
                params.set('assistantConversation', conversation.id)
                const latest = conversation.latestUpdate
                return (
                  <li key={conversation.id}>
                    <Link
                      to={{ pathname: location.pathname, search: params.toString() }}
                      className="flex items-start gap-2 rounded-lg py-2.5 pl-9 pr-3 hover:bg-surface-hover"
                    >
                      <span aria-hidden="true" className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-badge" />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium text-primary break-words">{conversation.title}</span>
                        {latest && <span className="mt-0.5 block truncate text-xs text-muted">{latest.preview}</span>}
                        <span className="mt-1 block text-xs text-muted">
                          {conversation.unreadUpdates === 1
                            ? '1 unread update'
                            : `${conversation.unreadUpdates} unread updates`}
                          {latest && (
                            <>
                              {' '}
                              ·{' '}
                              <time dateTime={latest.createdAt} title={new Date(latest.createdAt).toLocaleString()}>
                                {formatAssistantUpdateTime(latest.createdAt)}
                              </time>
                            </>
                          )}
                        </span>
                      </span>
                    </Link>
                  </li>
                )
              })}
            </ul>
          )}

          {streams.length > 0 && (
            <ul className="space-y-1" aria-label="Completed work updates">
              {streams.map((stream) => {
                const params = new URLSearchParams(location.search)
                params.set('ws', workStreamRef(stream))
                return (
                  <CompletionExposure key={completionKey(stream)} stream={stream} acknowledge={acknowledge} seen={seen}>
                    <Link
                      to={{ pathname: location.pathname, search: params.toString() }}
                      className="flex items-start gap-2 rounded-lg py-2.5 pl-9 pr-14 hover:bg-surface-hover"
                    >
                      <span
                        aria-hidden="true"
                        className={clsx('mt-1.5 h-2 w-2 shrink-0 rounded-full', webStatus('success').markerClass)}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium text-primary break-words">
                          {workStreamTitle(stream)}
                        </span>
                        <span className="mt-1 block text-xs text-muted">
                          Completed
                          {stream.completedAt && (
                            <>
                              {' '}
                              ·{' '}
                              <time
                                dateTime={new Date(stream.completedAt).toISOString()}
                                title={new Date(stream.completedAt).toLocaleString()}
                              >
                                {formatAssistantUpdateTime(new Date(stream.completedAt).toISOString())}
                              </time>
                            </>
                          )}
                        </span>
                      </span>
                    </Link>
                  </CompletionExposure>
                )
              })}
            </ul>
          )}
          {completed.hasNextPage && (
            <button
              type="button"
              className="ficus-button ficus-button-link ml-9 text-xs"
              disabled={completed.isFetchingNextPage}
              onClick={() => void completed.fetchNextPage()}
            >
              {completed.isFetchingNextPage ? 'Loading…' : 'Show more updates'}
            </button>
          )}
          {completed.isFetchNextPageError && (
            <p role="alert" className="ml-9 text-sm text-status-danger-600 dark:text-status-danger-400">
              Could not load more updates. Try again.
            </p>
          )}
        </div>
      </details>
    </>
  )
}
