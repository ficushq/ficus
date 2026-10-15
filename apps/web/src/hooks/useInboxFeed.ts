import { useState } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import { useDebouncedValue } from './useDebouncedValue'
import { getMyInboxPage, getSystemInboxPage } from '../api/inbox'
import type { InboxMessageResponse, InboxMessagesPage, InboxReadState } from '../api/inbox'
import { queryKeys } from '../queryKeys'

export const INBOX_PAGE_SIZE = 50
export const INBOX_SEARCH_DEBOUNCE_MS = 250
const UNREAD_REFETCH_MS = 10_000

/** One cursor-paginated inbox (personal or system) as loaded so far. */
export interface InboxSource {
  items: InboxMessageResponse[]
  hasMore: boolean
}

const newestFirst = (a: InboxMessageResponse, b: InboxMessageResponse) =>
  Date.parse(b.createdAt) - Date.parse(a.createdAt) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)

/**
 * Merge independently paginated inboxes into one newest-first list.
 *
 * A source with more pages may still hold messages newer than another source's oldest loaded
 * message, so only messages at or after the latest of those sources' oldest loaded messages are
 * shown; anything older waits until the gap is filled. `pending` marks the sources whose next
 * page moves that frontier.
 */
export function mergeInboxSources(sources: InboxSource[]): { messages: InboxMessageResponse[]; pending: boolean[] } {
  const oldestLoaded = sources.map((source) =>
    source.items.length ? Date.parse(source.items[source.items.length - 1]!.createdAt) : Infinity
  )
  const frontier = Math.max(-Infinity, ...sources.flatMap((source, i) => (source.hasMore ? [oldestLoaded[i]!] : [])))
  const messages = sources
    .flatMap((source) => source.items)
    .filter((message) => Date.parse(message.createdAt) >= frontier)
    .sort(newestFirst)
  return { messages, pending: sources.map((source, i) => source.hasMore && oldestLoaded[i] === frontier) }
}

interface UseInboxFeedOptions {
  readState: InboxReadState
  /** Server-side search over the whole archive (subject + content). */
  search?: string
  /** Merge in the shared system inbox (callers with the inbox:system permission). */
  includeSystem: boolean
  enabled?: boolean
  refetchInterval?: number
}

/**
 * The caller's personal inbox merged with the shared system inbox, paged from the server.
 * `totalCount` is the server's count for the whole filter, not the number loaded.
 */
export function useInboxFeed({
  readState,
  search = '',
  includeSystem,
  enabled = true,
  refetchInterval,
}: UseInboxFeedOptions) {
  const pageQuery = (key: readonly unknown[], fetchPage: typeof getMyInboxPage, sourceEnabled: boolean) => ({
    queryKey: key,
    queryFn: ({ pageParam }: { pageParam: string | null }) =>
      fetchPage({ readState, search: search || undefined, limit: INBOX_PAGE_SIZE, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage: InboxMessagesPage) => (lastPage.hasMore ? lastPage.nextCursor : undefined),
    enabled: sourceEnabled,
    refetchInterval,
  })
  const mine = useInfiniteQuery(pageQuery(queryKeys.inbox.mineInfinite(readState, search), getMyInboxPage, enabled))
  const system = useInfiniteQuery(
    pageQuery(queryKeys.inbox.systemInfinite(readState, search), getSystemInboxPage, enabled && includeSystem)
  )

  const queries = includeSystem ? [mine, system] : [mine]
  const sources = queries.map((query) => ({
    items: query.data?.pages.flatMap((page) => page.items) ?? [],
    hasMore: query.hasNextPage,
  }))
  const { messages, pending } = mergeInboxSources(sources)
  const isFetchingMore = queries.some((query) => query.isFetchingNextPage)

  return {
    messages,
    // Only the first page of each source carries the total.
    totalCount: queries.reduce((sum, query) => sum + (query.data?.pages[0]?.totalCount ?? 0), 0),
    hasMore: sources.some((source) => source.hasMore),
    isLoading: enabled && queries.some((query) => query.isPending),
    isFetchingMore,
    loadMore: () => {
      if (isFetchingMore) return
      queries.forEach((query, i) => {
        if (pending[i]) void query.fetchNextPage()
      })
    },
  }
}

/**
 * Everything an inbox surface shows: unread messages (polled), the read archive, and, while the
 * search box has text, server-side results across the whole archive instead of the read list.
 * `active` gates the read and search requests to when the surface is visible.
 */
export function useInboxView({ includeSystem, active }: { includeSystem: boolean; active: boolean }) {
  const [query, setQuery] = useState('')
  const debounced = useDebouncedValue(query.trim(), INBOX_SEARCH_DEBOUNCE_MS)
  // Clearing the box returns to the normal lists at once; only typing is debounced.
  const search = query.trim() ? debounced : ''
  const searching = search !== ''
  const unread = useInboxFeed({ readState: 'unread', includeSystem, refetchInterval: UNREAD_REFETCH_MS })
  const read = useInboxFeed({ readState: 'read', includeSystem, enabled: active && !searching })
  const results = useInboxFeed({ readState: 'all', search, includeSystem, enabled: active && searching })
  return { query, setQuery, searching, unread, read, results }
}
