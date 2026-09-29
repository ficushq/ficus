import { useCallback, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { markAsRead, markMyInboxAllRead, markSystemInboxAllRead } from '../api/inbox'
import { queries } from '../queryOptions'
import { queryKeys } from '../queryKeys'
import { usePermissions } from '../hooks/usePermissions'
import { useURLBooleanState } from '../hooks/useURLState'
import { MessageRow, SectionHeader } from './InboxMessageRow'
import { PullToRefresh } from './PullToRefresh'
import { useLoadingShapeCount } from '../hooks/useLoadingShapeCount'
import { LoadingSurface, SkeletonLine, SkeletonRows } from './loading/Skeleton'

export function InboxPage() {
  const queryClient = useQueryClient()
  const { can } = usePermissions()
  const canSystem = can('inbox:system')

  const { data: squads = [] } = useQuery(queries.squads.list())

  // The user's own inbox, plus the shared system inbox (if permitted), merged inline.
  const { data: mine = [], isLoading: mineLoading } = useQuery({ ...queries.inbox.mine(true), refetchInterval: 10000 })
  const { data: system = [], isLoading: systemLoading } = useQuery({
    ...queries.inbox.system(true),
    refetchInterval: 10000,
    enabled: canSystem,
  })

  const isLoading = mineLoading || (canSystem && systemLoading)

  const messages = useMemo(
    () =>
      [...mine, ...(canSystem ? system : [])].sort((a, b) =>
        a.readAt && !b.readAt ? 1 : !a.readAt && b.readAt ? -1 : Date.parse(b.createdAt) - Date.parse(a.createdAt)
      ),
    [mine, system, canSystem]
  )

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

  // Split messages into unread and read
  const unreadMessages = messages.filter((m) => !m.readAt)
  const readMessages = messages.filter((m) => m.readAt)
  const loadingRowCount = useLoadingShapeCount('inbox:list', isLoading ? undefined : messages.length, {
    fallbackCount: 5,
    maxCount: 12,
  })

  const unreadTotal = unreadMessages.length
  const hasUnread = unreadMessages.length > 0
  const hasRead = readMessages.length > 0
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

      {isLoading ? (
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
      ) : isEmpty ? (
        <div className="ficus-section text-muted p-6 text-center">No messages</div>
      ) : (
        <div className="flex flex-col gap-4">
          {/* Unread Section */}
          {hasUnread && (
            <section className="ficus-section overflow-hidden">
              <SectionHeader title="Unread" count={unreadMessages.length} />
              <div className="divide-y divide-th-border">
                {unreadMessages.map((message) => (
                  <MessageRow
                    key={message.id}
                    squads={squads}
                    message={message}
                    onMarkAsRead={() => markAsReadMutation.mutate(message.id)}
                  />
                ))}
              </div>
            </section>
          )}

          {/* Read Section */}
          {hasRead && (
            <section className="ficus-section overflow-hidden">
              <SectionHeader
                title="Read"
                count={readMessages.length}
                collapsible
                collapsed={readCollapsed}
                onToggle={() => setReadCollapsed(!readCollapsed)}
              />
              {!readCollapsed && (
                <div className="divide-y divide-th-border">
                  {readMessages.map((message) => (
                    <MessageRow key={message.id} squads={squads} message={message} />
                  ))}
                </div>
              )}
            </section>
          )}
        </div>
      )}
    </PullToRefresh>
  )
}
