import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { queries } from '../queryOptions'
import { queryKeys } from '../queryKeys'
import { markAsRead, markMyInboxAllRead, markSystemInboxAllRead } from '../api/inbox'
import { usePermissions } from '../hooks/usePermissions'
import { useInboxView } from '../hooks/useInboxFeed'
import { CloseIcon, ChevronDownIcon, ChevronRightIcon } from './icons'
import { MessageList, MessageRow } from './InboxMessageRow'
import { InboxLoadMore } from './InboxLoadMore'
import { InboxSearchInput } from './InboxSearchInput'
import { Presence } from './Presence'
import { useLoadingShapeCount } from '../hooks/useLoadingShapeCount'
import { LoadingSurface, SkeletonBlock, SkeletonLine, SkeletonRows } from './loading/Skeleton'
import { INBOX_POPUP_ID, useInboxPopup } from './InboxPopupProvider'

/** The inbox sheet under the top nav's Inbox button; its open state lives in `InboxPopupProvider`. */
export function InboxPopup() {
  const { open: isOpen, setOpen: setIsOpen, hover } = useInboxPopup()
  const [showRead, setShowRead] = useState(false)
  const queryClient = useQueryClient()
  const { can } = usePermissions()
  const canSystem = can('inbox:system')

  const { data: squads = [] } = useQuery(queries.squads.list())

  const { query, setQuery, searching, unread, read, results } = useInboxView({
    includeSystem: canSystem,
    active: isOpen,
  })

  const invalidateInboxes = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.inbox.minePrefix() })
    queryClient.invalidateQueries({ queryKey: queryKeys.inbox.systemPrefix() })
  }

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

  // Listen for external open trigger
  useEffect(() => {
    const handler = () => setIsOpen(true)
    window.addEventListener('open-inbox-popup', handler)
    return () => window.removeEventListener('open-inbox-popup', handler)
  }, [setIsOpen])

  // Keyboard shortcut: 'I' to toggle, Escape to close
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.defaultPrevented) return
      if (e.metaKey || e.ctrlKey || e.altKey) return

      const tag = (e.target as HTMLElement).tagName
      const inputFocused =
        tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target as HTMLElement).isContentEditable

      if (e.key === 'Escape' && isOpen) {
        setIsOpen(false)
        return
      }

      if ((e.key === 'i' || e.key === 'I') && !inputFocused) {
        e.preventDefault()
        setIsOpen((prev) => !prev)
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, setIsOpen])

  const unreadMessages = unread.messages
  const loadingRowCount = useLoadingShapeCount(
    'inbox:popup',
    unread.isLoading ? undefined : unreadMessages.length + read.messages.length,
    {
      fallbackCount: 4,
      maxCount: 8,
    }
  )
  const loadingRows = (
    <LoadingSurface label="Loading inbox" className="space-y-1">
      <SkeletonRows count={Math.max(1, loadingRowCount)}>
        {(index) => (
          <div key={index} className="flex min-h-16 items-center gap-3 px-4 py-3">
            <SkeletonBlock className="h-2 w-2 shrink-0 !rounded-full" />
            <div className="flex-1 space-y-2">
              <SkeletonLine className={index % 2 ? 'w-2/5' : 'w-1/2'} />
              <SkeletonLine className="w-4/5" />
            </div>
          </div>
        )}
      </SkeletonRows>
    </LoadingSurface>
  )

  return (
    <>
      {/* Backdrop. None while hover-opened: it would cover the nav trigger, which must keep receiving the
          pointer (leaving it closes the popup, a click pins it). Once pinned it returns. */}
      {isOpen && !hover.hoverOpened && (
        <div className="fixed inset-0 bg-chrome-scrim/20 z-40" onClick={() => setIsOpen(false)} />
      )}

      {/* Popover dropdown */}
      <Presence
        id={INBOX_POPUP_ID}
        open={isOpen}
        onPointerEnter={hover.popoverProps.onPointerEnter}
        onPointerLeave={hover.popoverProps.onPointerLeave}
        // Working in a hover-opened inbox (the search field, a row) keeps it open when the pointer leaves.
        onPointerDown={hover.pin}
        className="ficus-overlay fixed top-14 right-3 w-96 max-w-[calc(100vw-1.5rem)] max-h-[calc(100dvh-5rem)] z-50 flex flex-col origin-top-right"
      >
        <div className="flex items-center justify-between px-4 py-3 ">
          <div className="flex items-center gap-2">
            <h2 className="font-semibold text-primary">Inbox</h2>
            {unread.totalCount > 0 && <span className="text-xs text-muted">{unread.totalCount} unread</span>}
          </div>
          <div className="flex items-center gap-2">
            {unread.totalCount > 0 && (
              <button
                onClick={() => markAllAsReadMutation.mutate()}
                disabled={markAllAsReadMutation.isPending}
                className="ficus-button ficus-button-link text-xs disabled:opacity-50"
              >
                Mark all read
              </button>
            )}
            <button
              onClick={() => setIsOpen(false)}
              aria-label="Close inbox"
              className="ficus-button ficus-button-ghost rounded-lg p-2"
            >
              <CloseIcon />
            </button>
          </div>
        </div>
        <div className="px-4 pb-2">
          <InboxSearchInput value={query} onChange={setQuery} />
        </div>
        <div className="overflow-y-auto flex-1 px-2 pb-2">
          {searching ? (
            results.isLoading ? (
              loadingRows
            ) : results.messages.length === 0 ? (
              <p className="p-4 text-sm text-muted">No messages match your search</p>
            ) : (
              <>
                <p className="pl-6 pr-3 py-2 text-xs text-muted" aria-live="polite">
                  {results.totalCount} {results.totalCount === 1 ? 'result' : 'results'}
                </p>
                <MessageList>
                  {results.messages.map((message) => (
                    <MessageRow
                      key={message.id}
                      message={message}
                      squads={squads}
                      compact
                      onMarkAsRead={message.readAt ? undefined : () => markAsReadMutation.mutate(message.id)}
                    />
                  ))}
                </MessageList>
                {results.hasMore && <InboxLoadMore isFetching={results.isFetchingMore} onLoadMore={results.loadMore} />}
              </>
            )
          ) : unread.isLoading && unreadMessages.length === 0 ? (
            loadingRows
          ) : unreadMessages.length === 0 && read.totalCount === 0 ? (
            <p className="p-4 text-sm text-muted">{read.isLoading ? 'No unread messages' : 'No messages'}</p>
          ) : (
            <>
              {/* Unread messages */}
              {unreadMessages.length > 0 ? (
                <MessageList>
                  {unreadMessages.map((message) => (
                    <MessageRow
                      key={message.id}
                      message={message}
                      squads={squads}
                      compact
                      onMarkAsRead={() => markAsReadMutation.mutate(message.id)}
                    />
                  ))}
                </MessageList>
              ) : (
                <p className="p-4 text-sm text-muted">No unread messages</p>
              )}
              {unread.hasMore && <InboxLoadMore isFetching={unread.isFetchingMore} onLoadMore={unread.loadMore} />}

              {/* Read messages - collapsible; the count is the server's total, not the loaded page. */}
              {read.totalCount > 0 && (
                <div className="mt-2 border-t border-panel-border pt-2">
                  <button
                    onClick={() => setShowRead(!showRead)}
                    // Its focus ring sits inside: outside, the scrolling list clips it and it spills past the popup's edge.
                    className="ficus-button ficus-button-ghost w-full rounded-lg py-2 pl-6 pr-3 flex items-center gap-2 text-sm focus-visible:outline-offset-[-2px]"
                  >
                    {showRead ? <ChevronDownIcon className="w-4 h-4" /> : <ChevronRightIcon className="w-4 h-4" />}
                    <span>Read messages ({read.totalCount})</span>
                  </button>
                  {showRead && (
                    <>
                      <MessageList>
                        {read.messages.map((message) => (
                          <MessageRow key={message.id} message={message} squads={squads} compact />
                        ))}
                      </MessageList>
                      {read.hasMore && <InboxLoadMore isFetching={read.isFetchingMore} onLoadMore={read.loadMore} />}
                    </>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </Presence>
    </>
  )
}
