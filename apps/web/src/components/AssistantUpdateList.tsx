import clsx from 'clsx'
import { useEffect, useRef, useState } from 'react'
import type { AssistantActivityUpdate, AssistantTaskSummary } from '@ficus/shared'
import { useStableRef } from '../hooks/useStableRef'
import { shouldAcknowledgeAssistantUpdate } from '../lib/assistantActivityPresentation'
import { AssistantUpdateCard } from './AssistantUpdateCard'
import { ChevronRightIcon } from './icons'

export interface AssistantUpdateObserver {
  observe(element: Element): void
  unobserve(element: Element): void
  disconnect(): void
}
export type AssistantUpdateObserverFactory = (
  onChange: (entries: Array<{ target: Element; isIntersecting: boolean }>) => void,
  root: Element | null
) => AssistantUpdateObserver | null

export interface AssistantUpdateListProps {
  updates: AssistantActivityUpdate[]
  tasks: AssistantTaskSummary[]
  /** The presentation surface is actually on screen; a hidden mounted panel never acknowledges. */
  visible: boolean
  /** Newest sequence the caller displayed; "Mark updates read" acknowledges through this snapshot only. */
  latestSequence: number
  hasMore: boolean
  onLoadMore?: () => Promise<void>
  onSeen: (messageIds: string[]) => Promise<void>
  onSeenThrough: (sequence: number) => Promise<void>
  /** Fires when the section opens or closes so the host can yield the chat area on narrow screens. */
  onExpandedChange?: (expanded: boolean) => void
  dependencies?: { createObserver?: AssistantUpdateObserverFactory; documentVisible?: () => boolean }
}

const SEEN_BATCH = 50

function defaultObserverFactory(
  onChange: (entries: Array<{ target: Element; isIntersecting: boolean }>) => void,
  root: Element | null
): AssistantUpdateObserver | null {
  if (typeof IntersectionObserver === 'undefined') return null
  return new IntersectionObserver((entries) => onChange(entries), { root, threshold: 0.5 })
}

/**
 * Durable raw update cards. Renders regardless of Realtime state so results stay readable while
 * catch-up is pending or a connection is unavailable. Acknowledgment happens only when a card
 * intersects the visible scroll viewport in a visible document, or through the explicit action.
 */
export function AssistantUpdateList(props: AssistantUpdateListProps) {
  const region = useRef<HTMLDivElement>(null)
  const intersecting = useRef(new Set<string>())
  const pendingSeen = useRef(new Set<string>())
  /** Acknowledged in this session; a slow refetch must not cause a second round-trip. */
  const acknowledged = useRef(new Set<string>())
  const [marking, setMarking] = useState(false)
  const [ackError, setAckError] = useState(false)
  // Collapsed by default so history does not repeat the transcript; unread updates open it, and an
  // explicit toggle wins until the next batch of unread updates arrives.
  const [expandedOverride, setExpandedOverride] = useState<boolean | null>(null)
  // Cards hidden with the per-card action stay out of view until the section is toggled again.
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set())
  // Read updates stay out of the way by default; a small text toggle brings the history back.
  const [showRead, setShowRead] = useState(false)
  // Cards that were unread while the section was open stay in view after they are acknowledged, so
  // reading an update never makes it vanish under you. Cleared when the section is toggled.
  const [retained, setRetained] = useState<ReadonlySet<string>>(new Set())
  // Once unread updates open the section it stays open after they are read, until the user closes it.
  const [latched, setLatched] = useState(false)
  const propsRef = useStableRef(props)
  const documentVisible = props.dependencies?.documentVisible ?? (() => document.visibilityState === 'visible')
  const documentVisibleRef = useStableRef(documentVisible)
  const flush = useStableRef(async () => {
    const current = propsRef.current
    const seenIds = new Set(current.updates.filter((update) => update.seenAt).map((update) => update.messageId))
    const eligible = [...intersecting.current].filter(
      (id) =>
        !pendingSeen.current.has(id) &&
        shouldAcknowledgeAssistantUpdate({
          surfaceVisible: current.visible,
          documentVisible: documentVisibleRef.current(),
          intersects: true,
          alreadySeen: seenIds.has(id) || acknowledged.current.has(id),
        })
    )
    if (!eligible.length) return
    for (let index = 0; index < eligible.length; index += SEEN_BATCH) {
      const batch = eligible.slice(index, index + SEEN_BATCH)
      for (const id of batch) pendingSeen.current.add(id)
      try {
        await current.onSeen(batch)
        for (const id of batch) acknowledged.current.add(id)
        setAckError(false)
      } catch {
        // Unread counts are never cleared optimistically; the next intersection change retries.
        setAckError(true)
      } finally {
        for (const id of batch) pendingSeen.current.delete(id)
      }
    }
  })
  const unread = props.updates.filter((update) => !update.seenAt).length
  const previousUnread = useRef(unread)
  useEffect(() => {
    // New unread updates reopen a section the user had collapsed.
    if (unread > previousUnread.current) setExpandedOverride(null)
    if (unread > 0) setLatched(true)
    previousUnread.current = unread
  }, [unread])
  const expanded = expandedOverride ?? (unread > 0 || latched)
  const unreadIds = props.updates
    .filter((update) => !update.seenAt)
    .map((update) => update.messageId)
    .join(',')
  useEffect(() => {
    if (!expanded || !unreadIds) return
    setRetained((current) => {
      const ids = unreadIds.split(',').filter((id) => !current.has(id))
      return ids.length ? new Set([...current, ...ids]) : current
    })
  }, [expanded, unreadIds])
  const onExpandedChange = useStableRef(props.onExpandedChange)
  useEffect(() => {
    onExpandedChange.current?.(expanded)
  }, [expanded, onExpandedChange])
  const hideCard = useStableRef(async (messageId: string) => {
    setHidden((current) => new Set([...current, messageId]))
    if (acknowledged.current.has(messageId) || pendingSeen.current.has(messageId)) return
    pendingSeen.current.add(messageId)
    try {
      await propsRef.current.onSeen([messageId])
      acknowledged.current.add(messageId)
      setAckError(false)
    } catch {
      setAckError(true)
      setHidden((current) => {
        const next = new Set(current)
        next.delete(messageId)
        return next
      })
    } finally {
      pendingSeen.current.delete(messageId)
    }
  })
  const createObserver = props.dependencies?.createObserver ?? defaultObserverFactory
  // Read cards not already in view (retained ones are shown regardless of the toggle).
  const readCount = props.updates.filter((update) => update.seenAt && !retained.has(update.messageId)).length
  const shown = props.updates
    .filter((update) => !hidden.has(update.messageId) && (showRead || !update.seenAt || retained.has(update.messageId)))
    // Newest first: the latest result or question is what the user came to see.
    .sort((a, b) => b.sequence - a.sequence)
  const updateIds = shown.map((update) => update.messageId).join(',')
  useEffect(() => {
    const root = region.current
    if (!root || !expanded) return
    const observer = createObserver((entries) => {
      for (const entry of entries) {
        const id = (entry.target as HTMLElement).dataset.updateId
        if (!id) continue
        if (entry.isIntersecting) intersecting.current.add(id)
        else intersecting.current.delete(id)
      }
      void flush.current()
    }, root)
    if (!observer) return
    for (const card of root.querySelectorAll<HTMLElement>('[data-update-id]')) observer.observe(card)
    return () => {
      observer.disconnect()
      intersecting.current.clear()
    }
    // Re-observe when the set of rendered cards changes or the section opens.
  }, [createObserver, flush, updateIds, expanded])
  useEffect(() => {
    // Becoming visible (panel shown, tab focused) reconsiders cards already in view.
    const onVisibility = () => void flush.current()
    document.addEventListener('visibilitychange', onVisibility)
    if (props.visible) void flush.current()
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [props.visible, flush])
  const taskById = new Map(props.tasks.map((task) => [task.id, task]))
  return (
    <section
      aria-label="Task updates"
      data-expanded={expanded || undefined}
      // Open on a phone, the list takes the chat area (the host hides the transcript); on wider
      // screens it keeps a bounded height and scrolls so the transcript stays in view.
      className={clsx('flex min-h-0 flex-col border-t border-th-border', expanded && 'flex-1 md:flex-none')}
    >
      <div className="flex shrink-0 items-center gap-2 px-3 py-1.5 text-xs">
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls="assistant-task-updates"
          className="ficus-button flex min-w-0 items-center gap-1.5 rounded-md py-1 pl-1 pr-2 text-muted hover:text-primary"
          onClick={() => {
            setExpandedOverride(!expanded)
            setLatched(false)
            setHidden(new Set())
            setRetained(new Set())
            setShowRead(false)
          }}
        >
          <ChevronRightIcon
            className={clsx(
              'h-3.5 w-3.5 shrink-0 transition-transform motion-reduce:transition-none',
              expanded && 'rotate-90'
            )}
          />
          <h3 className="font-medium">Updates</h3>
          <span className="text-muted">{`${unread} unread`}</span>
        </button>
        {ackError && (
          <span role="status" className="text-muted">
            Read state could not be saved. Retrying…
          </span>
        )}
        {unread > 0 && (
          <button
            type="button"
            disabled={marking}
            className="ficus-button ml-auto py-1 text-xs text-accent-light disabled:opacity-40"
            onClick={async () => {
              setMarking(true)
              try {
                await props.onSeenThrough(props.latestSequence)
                // Marking everything read is an explicit clear: the cards leave, the section stays open.
                setRetained(new Set())
                setAckError(false)
              } catch {
                setAckError(true)
              } finally {
                setMarking(false)
              }
            }}
          >
            Mark updates read
          </button>
        )}
      </div>
      <div
        id="assistant-task-updates"
        ref={region}
        hidden={!expanded}
        className={clsx(
          'min-h-0 overflow-y-auto overscroll-contain px-2 pb-2',
          expanded && 'flex-1 md:max-h-80 md:flex-none'
        )}
      >
        {shown.length === 0 && (
          <p className="px-2 py-3 text-xs text-muted">
            {props.updates.length === 0 ? 'No task updates yet. Delegated tasks report here.' : 'All caught up.'}
          </p>
        )}
        <ul className="space-y-1">
          {shown.map((update) => {
            const task = update.taskId ? taskById.get(update.taskId) : undefined
            return (
              <li
                key={update.messageId}
                data-update-id={update.messageId}
                data-unread={update.seenAt ? undefined : 'true'}
                className={clsx('rounded-xl px-3 py-2 text-sm', !update.seenAt && 'bg-selection')}
              >
                <AssistantUpdateCard
                  update={update}
                  taskLabel={task?.label}
                  action={
                    !update.seenAt && (
                      <button
                        type="button"
                        aria-label="Hide update"
                        title="Mark read and hide until the section is reopened"
                        className="ficus-button -my-1 shrink-0 rounded-md px-1.5 py-1 text-accent-light hover:bg-selection"
                        onClick={() => void hideCard.current(update.messageId)}
                      >
                        Hide
                      </button>
                    )
                  }
                />
              </li>
            )
          })}
        </ul>
        {(readCount > 0 || (showRead && props.hasMore && props.onLoadMore)) && (
          <div className="flex items-center gap-3 px-2 pt-2 text-[11px] text-muted">
            {readCount > 0 && (
              <button
                type="button"
                aria-pressed={showRead}
                className="ficus-button py-1 hover:text-primary"
                onClick={() => setShowRead((current) => !current)}
              >
                {showRead ? 'Hide read' : `Show read (${readCount}${props.hasMore ? '+' : ''})`}
              </button>
            )}
            {showRead && props.hasMore && props.onLoadMore && (
              <button
                type="button"
                className="ficus-button py-1 hover:text-primary"
                onClick={() => void props.onLoadMore?.()}
              >
                Load earlier updates
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  )
}
