import { useCallback } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { markAsRead, markMyInboxAllRead, markSystemInboxAllRead } from '../api/inbox'
import { queries } from '../queryOptions'
import { queryKeys } from '../queryKeys'
import { usePermissions } from '../hooks/usePermissions'
import { useInboxView } from '../hooks/useInboxFeed'
import { useURLBooleanState } from '../hooks/useURLState'
import { MessageList, MessageRow, SectionHeader } from './InboxMessageRow'
import { InboxLoadMore } from './InboxLoadMore'
import { InboxSearchInput } from './InboxSearchInput'
import { PullToRefresh } from './PullToRefresh'
import { useLoadingShapeCount } from '../hooks/useLoadingShapeCount'
import { LoadingSurface, SkeletonLine, SkeletonRows } from './loading/Skeleton'

export function InboxPage() {
  const queryClient = useQueryClient()
  const { can } = usePermissions()
  const canSystem = can('inbox:system')

  const { data: squads = [] } = useQuery(queries.squads.list())

  // The user's own inbox, plus the shared system inbox (if permitted), merged and paged from the server.
  const { query, setQuery, searching, unread, read, results } = useInboxView({ includeSystem: canSystem, active: true })
  const isLoading = unread.isLoading || read.isLoading

  const invalidateInboxes = useCallback(() => {
    const invalidations = [queryClient.invalidateQueries({ queryKey: queryKeys.inbox.minePrefix() })]
    if (canSystem) {
      invalidations.push(queryClient.invalidateQueries({ queryKey: queryKeys.inbox.systemPrefix() }))
    }
    return Promise.all(invalidations)
  }, [canSystem, queryClient])

  const refreshInbox = useCallback(async () => {
    await Promise.all([invalidateInboxes(), queryClient.invalidateQueries({ queryKey: queryKeys.squads.all })])
  }, [invalidateInboxes, queryClient])

  const markAsReadMutation = useMutation({
    mutationFn: (messageId: string) => markAsRead(messageId),
    onSuccess: invalidateInboxes,
  })

  const markAllAsReadMutation = useMutation({
    mutationFn: async () => {
      await markMyInboxAllRead()
      if (canSystem) await markSystemInboxAllRead()
    },
    onSuccess: invalidateInboxes,
  })

  // URL-synced collapse state for read section
  const [readCollapsed, setReadCollapsed] = useURLBooleanState('collapsed', false)

  const unreadMessages = unread.messages
  const readMessages = read.messages
  const loadingRowCount = useLoadingShapeCount(
    'inbox:list',
    isLoading ? undefined : unreadMessages.length + readMessages.length,
    {
      fallbackCount: 5,
      maxCount: 12,
    }
  )

  // Counts are the server's totals, not the number of messages loaded so far.
  const unreadTotal = unread.totalCount
  const hasUnread = unreadMessages.length > 0
  const hasRead = read.totalCount > 0
  const isEmpty = !hasUnread && !hasRead

  return (
    <PullToRefresh
      id="inbox-pull-to-refresh"
      onRefresh={refreshInbox}
      label="inbox"
      data-testid="inbox-pull-to-refresh"
      className="h-full"
    >
      <div className="flex items-center justify-between gap-3 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-primary">Inbox</h1>
          {unreadTotal > 0 && <p className="text-sm text-muted mt-1">{unreadTotal} unread messages</p>}
        </div>
        {unreadTotal > 0 && (
          <button
            onClick={() => markAllAsReadMutation.mutate()}
            disabled={markAllAsReadMutation.isPending}
            className="ficus-button ficus-button-secondary px-3 py-2 text-sm shrink-0 disabled:opacity-50"
          >
            Mark all as read
          </button>
        )}
      </div>

      <InboxSearchInput value={query} onChange={setQuery} className="mb-4" />

      {(searching ? results.isLoading : isLoading) ? (
        <LoadingSurface label="Loading inbox">
          <div className="px-3 py-2">
            <SkeletonLine className="w-20" />
          </div>
          <div className="divide-y divide-th-border">
            <SkeletonRows count={Math.max(1, loadingRowCount)}>
              {(index) => (
                <div key={index} className="px-3 py-4 space-y-2">
                  <SkeletonLine className="w-16 h-3" />
                  <SkeletonLine className={index % 2 ? 'w-3/5' : 'w-4/5'} />
                  <SkeletonLine className="w-full max-w-xl h-3" />
                  <SkeletonLine className="w-12 h-3 md:hidden" />
                </div>
              )}
            </SkeletonRows>
          </div>
        </LoadingSurface>
      ) : searching ? (
        results.messages.length === 0 ? (
          <div className="ficus-section text-muted p-6 text-center">No messages match your search</div>
        ) : (
          <div className="-mx-2 md:mx-0">
            <section className="ficus-section py-2 md:p-2" aria-live="polite">
              <SectionHeader title="Results" count={results.totalCount} />
              <MessageList>
                {results.messages.map((message) => (
                  <MessageRow
                    key={message.id}
                    squads={squads}
                    message={message}
                    onMarkAsRead={message.readAt ? undefined : () => markAsReadMutation.mutate(message.id)}
                  />
                ))}
              </MessageList>
              {results.hasMore && <InboxLoadMore isFetching={results.isFetchingMore} onLoadMore={results.loadMore} />}
            </section>
          </div>
        )
      ) : isEmpty ? (
        <div className="ficus-section text-muted p-6 text-center">No messages</div>
      ) : (
        // Keep an 8px viewport gutter on phones without stacking page and section padding.
        // Shared rows retain their unread-dot gutter; desktop keeps the original insets.
        <div className="-mx-2 md:mx-0 flex flex-col gap-4">
          {/* Unread Section */}
          {hasUnread && (
            <section className="ficus-section py-2 md:p-2">
              <SectionHeader title="Unread" count={unreadTotal} />
              <MessageList>
                {unreadMessages.map((message) => (
                  <MessageRow
                    key={message.id}
                    squads={squads}
                    message={message}
                    onMarkAsRead={() => markAsReadMutation.mutate(message.id)}
                  />
                ))}
              </MessageList>
              {unread.hasMore && <InboxLoadMore isFetching={unread.isFetchingMore} onLoadMore={unread.loadMore} />}
            </section>
          )}

          {/* Read Section */}
          {hasRead && (
            <section className="ficus-section py-2 md:p-2">
              <SectionHeader
                title="Read"
                count={read.totalCount}
                collapsible
                collapsed={readCollapsed}
                onToggle={() => setReadCollapsed(!readCollapsed)}
              />
              {!readCollapsed && (
                <>
                  <MessageList>
                    {readMessages.map((message) => (
                      <MessageRow key={message.id} squads={squads} message={message} />
                    ))}
                  </MessageList>
                  {read.hasMore && <InboxLoadMore isFetching={read.isFetchingMore} onLoadMore={read.loadMore} />}
                </>
              )}
            </section>
          )}
        </div>
      )}
    </PullToRefresh>
  )
}
