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
import { Panel } from './popover'
import { HEADER_DROPDOWN_PLACEMENT } from './headerDropdown'
import { useLoadingShapeCount } from '../hooks/useLoadingShapeCount'
import { LoadingSurface, SkeletonBlock, SkeletonLine, SkeletonRows } from './loading/Skeleton'
import { INBOX_POPUP_ID, useInboxPopup } from './InboxPopupProvider'

/**
 * The inbox dropdown under the header; its open state lives in `InboxPopupProvider`. A `Panel` on the popover
 * layer, so it draws above floating windows and the Assistant. An outside press, Escape, its close button or
 * the `I` shortcut closes it; opening it never moves focus.
 */
export function InboxPopup() {
  const { open: isOpen, setOpen: setIsOpen, triggerRef, hover } = useInboxPopup()
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

  // Keyboard shortcut: 'I' to toggle. Escape is the panel's own (Popover) dismissal.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.defaultPrevented) return
      if (e.metaKey || e.ctrlKey || e.altKey) return

      const tag = (e.target as HTMLElement).tagName
      const inputFocused =
        tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target as HTMLElement).isContentEditable

      if ((e.key === 'i' || e.key === 'I') && !inputFocused) {
        e.preventDefault()
        setIsOpen((prev) => !prev)
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [setIsOpen])

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
            <SkeletonBlock className="h-2 w-2 shrink-0 rounded-full!" />
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
      {/* The nav button is its trigger (a press on it toggles or pins, never dismisses); it is placed against the
          viewport corner instead, so the I shortcut opens it in the same place while that button is hidden. */}
      <Panel
        {...HEADER_DROPDOWN_PLACEMENT}
        {...hover.popoverProps}
        id={INBOX_POPUP_ID}
        label="Inbox"
        open={isOpen}
        onDismiss={() => setIsOpen(false)}
        trigger={triggerRef}
        // Escape leaves focus where it was (in the composer, say); with focus inside, closing returns it to the trigger.
        restoreFocus={false}
        scroll={false}
        className="ficus-overlay w-[min(24rem,calc(100vw-1.5rem))] flex flex-col origin-top-right"
      >
        <div className="flex items-center justify-between px-4 py-3 ">
          <div className="flex items-center gap-2">
            <h2 className="font-semibold text-primary">Inbox</h2>
            {unread.totalCount > 0 && <span className="text-xs text-muted">{unread.totalCount} unread</span>}
          </div>
          <div className="flex items-center gap-2">
            {/* A compact ghost control in the header, shaped like the close button beside it. The
                negative end margin keeps the label within 4px of where the old link sat while leaving
                a gap between its hover fill and the close button's. */}
            {unread.totalCount > 0 && (
              <button
                onClick={() => markAllAsReadMutation.mutate()}
                disabled={markAllAsReadMutation.isPending}
                className="ficus-button ficus-button-ghost -mr-1 rounded-lg px-2 py-1 text-xs text-muted disabled:opacity-50"
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
          {/* Only a press in the search field pins a hover-opened inbox, so a search being typed survives the
              pointer drifting off. Other presses (Mark all read, a row's Mark read) leave it in hover mode:
              moving away still closes it. */}
          <InboxSearchInput value={query} onChange={setQuery} onPointerDown={hover.pin} />
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
                    className="ficus-button ficus-button-ghost w-full rounded-lg py-2 pl-6 pr-3 flex items-center gap-2 text-sm focus-visible:-outline-offset-2"
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
      </Panel>
    </>
  )
}
