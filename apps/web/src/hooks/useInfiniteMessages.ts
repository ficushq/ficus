import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import { queryKeys } from '../queryKeys'
import { getMessages, type MessagesResponse } from '../api/agents'
import type { Message } from '@ficus/shared'

const PAGE_SIZE = 50

export function getNextMessagesCursor(lastPage: MessagesResponse): string | undefined {
  if (!lastPage.pagination.hasMore) return undefined
  return lastPage.pagination.nextCursor
}

export function useInfiniteMessages(agentId: string | undefined, options: { refetchInterval?: number | false } = {}) {
  const queryClient = useQueryClient()

  const query = useInfiniteQuery({
    queryKey: queryKeys.agents.messagesInfinite(agentId!),
    queryFn: async ({ pageParam }) => {
      return getMessages(agentId!, {
        cursor: pageParam,
        limit: PAGE_SIZE,
      })
    },
    getNextPageParam: getNextMessagesCursor,
    initialPageParam: undefined as string | undefined,
    enabled: !!agentId,
    staleTime: 30_000, // 30 seconds
    refetchInterval: options.refetchInterval,
    select: (data) => ({
      pages: data.pages,
      pageParams: data.pageParams,
      // Flatten all pages into chronological order
      // Pages are fetched newest-first, each page's messages are chronological
      // So we need to reverse the pages array and flatten
      messages: [...data.pages].reverse().flatMap((p) => p.messages),
      hasOlder: data.pages[data.pages.length - 1]?.pagination.hasMore ?? false,
      totalCount: data.pages[0]?.pagination.totalCount ?? 0,
    }),
  })

  // Method to prepend a new message (for optimistic updates / SSE)
  const appendMessage = useCallback(
    (message: Message) => {
      queryClient.setQueryData(queryKeys.agents.messagesInfinite(agentId!), (old: any) => {
        if (!old) return old
        return {
          ...old,
          pages: old.pages.map((page: any, i: number) =>
            i === 0 ? { ...page, messages: [...page.messages, message] } : page
          ),
          pageParams: old.pageParams,
        }
      })
    },
    [queryClient, agentId]
  )

  // Invalidate the messages query to refetch latest data.
  // Returns the promise so callers can await the refetch.
  const invalidateLatest = useCallback(() => {
    return queryClient.refetchQueries({
      queryKey: queryKeys.agents.messagesInfinite(agentId!),
    })
  }, [queryClient, agentId])

  return {
    ...query,
    messages: query.data?.messages ?? [],
    hasOlder: query.data?.hasOlder ?? false,
    totalCount: query.data?.totalCount ?? 0,
    fetchOlder: query.fetchNextPage,
    isFetchingOlder: query.isFetchingNextPage,
    appendMessage,
    invalidateLatest,
  }
}
