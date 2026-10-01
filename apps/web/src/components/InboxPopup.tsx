import { useEffect, useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { queries } from '../queryOptions'
import { queryKeys } from '../queryKeys'
import { markAsRead, markMyInboxAllRead, markSystemInboxAllRead } from '../api/inbox'
import { usePermissions } from '../hooks/usePermissions'
import { CloseIcon, ChevronDownIcon, ChevronRightIcon } from './icons'
import { MessageRow } from './InboxMessageRow'
import { Presence } from './Presence'
import { useLoadingShapeCount } from '../hooks/useLoadingShapeCount'
import { LoadingSurface, SkeletonBlock, SkeletonLine, SkeletonRows } from './loading/Skeleton'

export function InboxPopup() {
  const [isOpen, setIsOpen] = useState(false)
  const [showRead, setShowRead] = useState(false)
  const queryClient = useQueryClient()
  const { can } = usePermissions()
  const canSystem = can('inbox:system')

  const { data: squads = [] } = useQuery(queries.squads.list())

  const { data: mine = [], isLoading } = useQuery({ ...queries.inbox.mine(true), refetchInterval: 10000 })
  const { data: system = [], isLoading: systemLoading } = useQuery({
    ...queries.inbox.system(true),
    refetchInterval: 10000,
    enabled: canSystem,
  })

  const messages = useMemo(
    () =>
      [...mine, ...(canSystem ? system : [])].sort((a, b) =>
        a.readAt && !b.readAt ? 1 : !a.readAt && b.readAt ? -1 : Date.parse(b.createdAt) - Date.parse(a.createdAt)
      ),
    [mine, system, canSystem]
  )

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

  // Broadcast open state changes so the icon can react
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('inbox-popup-state', { detail: { isOpen } }))
  }, [isOpen])

  // Listen for external open trigger
  useEffect(() => {
    const handler = () => setIsOpen(true)
    window.addEventListener('open-inbox-popup', handler)
    return () => window.removeEventListener('open-inbox-popup', handler)
  }, [])

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
  }, [isOpen])

  const unreadMessages = messages.filter((m) => !m.readAt)
  const readMessages = messages.filter((m) => m.readAt)
  const loadingRowCount = useLoadingShapeCount(
    'inbox:popup',
    isLoading || (canSystem && systemLoading) ? undefined : messages.length,
    {
      fallbackCount: 4,
      maxCount: 8,
    }
  )

  return (
    <>
      {/* Backdrop */}
      {isOpen && <div className="fixed inset-0 bg-chrome-scrim/20 z-40" onClick={() => setIsOpen(false)} />}

      {/* Popover dropdown */}
      <Presence
        open={isOpen}
        className="ficus-overlay fixed top-14 right-3 w-96 max-w-[calc(100vw-1.5rem)] max-h-[calc(100dvh-5rem)] z-50 flex flex-col origin-top-right"
      >
        <div className="flex items-center justify-between px-4 py-3 ">
          <div className="flex items-center gap-2">
            <h2 className="font-semibold text-primary">Inbox</h2>
            {unreadMessages.length > 0 && <span className="text-xs text-muted">{unreadMessages.length} unread</span>}
          </div>
          <div className="flex items-center gap-2">
            {unreadMessages.length > 0 && (
              <button
                onClick={() => markAllAsReadMutation.mutate()}
                disabled={markAllAsReadMutation.isPending}
                className="ficus-button text-xs text-accent-light hover:underline disabled:opacity-50"
              >
                Mark all read
              </button>
            )}
            <button
              onClick={() => setIsOpen(false)}
              aria-label="Close inbox"
              className="ficus-button rounded-lg text-muted hover:text-primary hover:bg-surface-hover p-2"
            >
              <CloseIcon />
            </button>
          </div>
        </div>
        <div className="overflow-y-auto flex-1 px-2 pb-2">
          {(isLoading || (canSystem && systemLoading)) && messages.length === 0 ? (
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
          ) : messages.length === 0 ? (
            <p className="p-4 text-sm text-muted">No messages</p>
          ) : (
            <>
              {/* Unread messages */}
              {unreadMessages.length > 0 ? (
                <div className="space-y-1">
                  {unreadMessages.map((message) => (
                    <MessageRow
                      key={message.id}
                      message={message}
                      squads={squads}
                      compact
                      onMarkAsRead={() => markAsReadMutation.mutate(message.id)}
                    />
                  ))}
                </div>
              ) : (
                <p className="p-4 text-sm text-muted">No unread messages</p>
              )}

              {/* Read messages - collapsible */}
              {readMessages.length > 0 && (
                <div className="mt-2 border-t border-panel-border pt-2">
                  <button
                    onClick={() => setShowRead(!showRead)}
                    className="ficus-button w-full rounded-lg py-2 pl-6 pr-3 flex items-center gap-2 text-sm text-muted hover:text-primary hover:bg-surface-hover"
                  >
                    {showRead ? <ChevronDownIcon className="w-4 h-4" /> : <ChevronRightIcon className="w-4 h-4" />}
                    <span>Read messages ({readMessages.length})</span>
                  </button>
                  {showRead && (
                    <div className="space-y-1">
                      {readMessages.map((message) => (
                        <MessageRow key={message.id} message={message} squads={squads} compact />
                      ))}
                    </div>
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
