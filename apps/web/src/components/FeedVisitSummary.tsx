import clsx from 'clsx'
import { workStreamRef, workStreamTitle, type WorkStream } from '@ficus/shared'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useInfiniteQuery } from '../reactQueryHooks'
import { ApiError } from '../api/client'
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

/** Keep the compact visual format without naming a role that prohibits aria-label. */
function FeedTimestamp({ value }: { value: string }) {
  const exact = new Date(value).toLocaleString()
  return (
    <time dateTime={value} title={exact}>
      <span aria-hidden="true">{formatAssistantUpdateTime(value)}</span>
      <span className="sr-only">{exact}</span>
    </time>
  )
}

type Receipt = { state: 'seen' | 'failed' | 'changed'; message?: string }
type SaveCompletion = (stream: WorkStream) => Promise<Receipt>

/** One exact-revision receipt pipeline for both exposure and explicit dismissal. */
function useCompletionReceipts(acknowledge: typeof acknowledgeFeedCompletion) {
  const [receipts, setReceipts] = useState<Map<string, Receipt>>(() => new Map())
  const settled = useRef(new Map<string, Receipt>())
  const pending = useRef(new Map<string, Promise<Receipt>>())
  const active = useRef(true)
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])
  const save = useCallback<SaveCompletion>(
    (stream) => {
      const key = completionKey(stream)
      const previous = settled.current.get(key)
      if (previous && previous.state !== 'failed') return Promise.resolve(previous)
      const inflight = pending.current.get(key)
      if (inflight) return inflight
      if (!active.current || !stream.completedAt) return Promise.resolve({ state: 'failed' })
      const request = (async (): Promise<Receipt> => {
        let receipt: Receipt
        try {
          await acknowledge(stream.id, new Date(stream.completedAt!).toISOString())
          receipt = { state: 'seen' }
        } catch (error) {
          receipt =
            error instanceof ApiError && error.status === 409
              ? { state: 'changed', message: error.message }
              : { state: 'failed' }
        }
        settled.current.set(key, receipt)
        pending.current.delete(key)
        if (active.current) setReceipts(new Map(settled.current))
        return receipt
      })()
      pending.current.set(key, request)
      return request
    },
    [acknowledge]
  )
  return { receipts, save, active }
}

/** Exposure is deliberately conservative: no observer support means no automatic acknowledgement. */
function CompletionExposure({
  stream,
  save,
  receipt,
  children,
}: {
  stream: WorkStream
  save: SaveCompletion
  receipt?: Receipt
  children: ReactNode
}) {
  const row = useRef<HTMLLIElement>(null)
  const retry = useRef<() => void>(() => {})
  useEffect(() => {
    const target = row.current
    if (!target || !stream.completedAt || !window.IntersectionObserver) return
    let active = true
    let visible = false
    const acknowledgeExposed = () => {
      if (!active || !visible || document.visibilityState !== 'visible') return
      // Intersection notifications can have been queued before a section was collapsed.
      if (target.closest('details:not([open])')) return
      void save(stream)
    }
    retry.current = acknowledgeExposed
    const observer = new window.IntersectionObserver(
      (entries) => {
        visible = entries.some(
          (entry) => entry.target === target && entry.isIntersecting && entry.intersectionRatio >= 0.5
        )
        if (visible) acknowledgeExposed()
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
  }, [stream, save])
  return (
    <li ref={row} data-completion-id={stream.id}>
      <div className="relative">
        {children}
        {(!receipt || receipt.state === 'failed') && (
          <span className="absolute right-3 top-2.5 text-xs text-muted">New</span>
        )}
      </div>
      {receipt?.state === 'changed' && (
        <p role="status" className="ml-9 text-xs text-muted">
          {receipt.message}
        </p>
      )}
      {receipt?.state === 'failed' && (
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
  const { receipts, save, active } = useCompletionReceipts(acknowledge)
  const [dismissing, setDismissing] = useState(false)
  const dismissingRef = useRef(false)
  const [dismissedThrough, setDismissedThrough] = useState<number | null>(null)
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
  useEffect(() => {
    const heading = section.current?.querySelector('summary')
    if (!newAbove || !heading || !window.IntersectionObserver) return
    const observer = new window.IntersectionObserver((entries) => {
      if (
        document.visibilityState === 'visible' &&
        entries.some((entry) => entry.isIntersecting && entry.boundingClientRect.top >= 0)
      )
        setNewAbove(false)
    })
    observer.observe(heading)
    return () => observer.disconnect()
  }, [newAbove])
  const streams = retained.filter((stream) => squadIds.length === 0 || squadIds.includes(stream.squadId))
  // Only a completion newer than the loaded newest-first frontier reopens the section.
  // Refetching unseen older pages after receipts were saved is NOT a new arrival.
  // This is visit-local presentation state, never a persisted seen watermark.
  const newestCompletion = Math.max(0, ...streams.map((stream) => new Date(stream.completedAt!).getTime()))
  const dismissed = dismissedThrough !== null && newestCompletion <= dismissedThrough
  useEffect(() => {
    if (dismissed) setNewAbove(false)
  }, [dismissed])
  const dismiss = async () => {
    if (dismissingRef.current) return
    dismissingRef.current = true
    setDismissing(true)
    const frontier = newestCompletion
    let allSeen = true
    // Snapshot only loaded rows in this list. Sequential writes bound request pressure and
    // let an account switch cancel the remaining queue without using the next user's session.
    for (const stream of streams) {
      if (!active.current) return
      const receipt = await save(stream)
      if (receipt.state !== 'seen') allSeen = false
    }
    if (!active.current) return
    if (allSeen) {
      setDismissedThrough(frontier)
    }
    dismissingRef.current = false
    setDismissing(false)
  }
  // These remain useful pointers into domain-unread Assistant conversations. Feed exposure does
  // not consume their unread state; they are not labeled as new Feed completions.
  const activity = useActivity()
  const unreadConversations =
    squadIds.length > 0 || activity.ownerId !== userId
      ? []
      : (activity.activity?.conversations ?? []).filter((row) => row.unreadUpdates > 0)
  if (dismissed || (!streams.length && !unreadConversations.length && !completed.isError)) return null
  const parts = [
    streams.length
      ? `${completed.hasNextPage ? (completed.data?.pages[0]?.totalCount ?? streams.length) : streams.length} completed`
      : '',
    unreadConversations.length
      ? `${unreadConversations.length} Assistant ${unreadConversations.length === 1 ? 'update' : 'updates'}`
      : '',
  ].filter(Boolean)
  return (
    <>
      {newAbove && (
        <div className="pointer-events-none sticky top-2 z-10 flex h-0 items-start justify-end">
          <button
            type="button"
            className="ficus-button ficus-button-secondary pointer-events-auto shrink-0 rounded-full px-3 py-2 text-sm shadow-sm"
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
        </div>
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
          <button
            type="button"
            className="ficus-button ficus-button-link ml-auto shrink-0 text-xs"
            disabled={dismissing}
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              void dismiss()
            }}
          >
            {dismissing ? 'Dismissing…' : 'Dismiss'}
          </button>
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
                              · <FeedTimestamp value={latest.createdAt} />
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
                  <CompletionExposure
                    key={completionKey(stream)}
                    stream={stream}
                    save={save}
                    receipt={receipts.get(completionKey(stream))}
                  >
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
                              · <FeedTimestamp value={new Date(stream.completedAt).toISOString()} />
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
