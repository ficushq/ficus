import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useLocation, useNavigate } from 'react-router'
import type { PendingAction } from '@ficus/shared'
import { PUSH_SUBSCRIPTION_ID_STORAGE_KEY } from '@ficus/shared/browser-keys'
import { usePendingActions } from '../hooks/usePendingActions'
import { useAdjustOnChange } from '../hooks/useAdjustOnChange'
import { queries } from '../queryOptions'
import { desktopBridge } from '../lib/desktop'
import { isWebKitEngine } from '../lib/needsYouPush'
import {
  isNeedsYouItemOpen,
  mergeNeedsYouNotices,
  needsYouNoticeCategory,
  needsYouNoticeContent,
  needsYouNoticeDestination,
  needsYouNoticesAllowed,
  NEEDS_YOU_NOTICE_TIMEOUT_MS,
  type NeedsYouNoticePreferences,
} from '../lib/needsYouNotices'
import { FicusLogo } from './FicusLogo'
import { CloseIcon } from './icons'

/** After a pause, a card stays at least this long so it does not vanish as the pointer leaves. */
const MIN_REMAINING_AFTER_PAUSE_MS = 2000

/**
 * True when this browser will show an OS notification for the same item even while focused: a
 * WebKit browser subscribed to web push here (WebKit revokes subscriptions whose pushes show
 * nothing, so its service worker never skips one). The card stays away there; see lib/needsYouPush.
 */
function osNotificationReplacesCard(): boolean {
  if (desktopBridge() || typeof Notification === 'undefined') return false
  if (Notification.permission !== 'granted') return false
  if (!localStorage.getItem(PUSH_SUBSCRIPTION_ID_STORAGE_KEY)) return false
  return isWebKitEngine(navigator.userAgent)
}

function documentVisible(): boolean {
  return document.visibilityState === 'visible'
}

interface NeedsYouNotificationsDependencies {
  usePendingActions: () => { data?: PendingAction[] }
  usePreferences: () => NeedsYouNoticePreferences | undefined
  /** False while the page is hidden: the OS notification is the notice then. */
  documentVisible: () => boolean
  osNotificationReplacesCard: () => boolean
  timeoutMs: number
}

function useMyNotificationPreferences(): NeedsYouNoticePreferences | undefined {
  return useQuery(queries.notificationConfig.mine()).data
}

interface NoticeState {
  /** Every pending item already accounted for; null until the first list arrives (its items are old news). */
  seen: ReadonlySet<string> | null
  notices: PendingAction[]
}

/**
 * The in-app "Needs you" notice: when a question or a review/approval gate starts needing the
 * signed-in user while the app is open, a card appears at the top right of every page. Clicking it
 * opens the item; closing it, or its timeout, only hides the card. Rules: lib/needsYouNotices.ts.
 */
export function NeedsYouNotifications({
  dependencies = {},
}: {
  dependencies?: Partial<NeedsYouNotificationsDependencies>
}) {
  const {
    usePendingActions: usePending = usePendingActions,
    usePreferences = useMyNotificationPreferences,
    documentVisible: isDocumentVisible = documentVisible,
    osNotificationReplacesCard: osNotificationShows = osNotificationReplacesCard,
    timeoutMs = NEEDS_YOU_NOTICE_TIMEOUT_MS,
  } = dependencies
  const { data: actions } = usePending()
  const preferences = usePreferences()
  const location = useLocation()
  const navigate = useNavigate()
  const [state, setState] = useState<NoticeState>({ seen: null, notices: [] })

  // Each new pending list: announce the items not seen before, once each.
  useAdjustOnChange(
    [actions],
    () => {
      if (!actions) return
      const ids = actions.map((action) => action.id)
      if (state.seen === null) {
        setState({ seen: new Set(ids), notices: [] })
        return
      }
      const seen = state.seen
      const fresh = actions.filter((action) => !seen.has(action.id))
      if (fresh.length === 0) return
      const announce =
        isDocumentVisible() && !osNotificationShows()
          ? fresh.filter((action) => {
              const category = needsYouNoticeCategory(action)
              return (
                category !== null &&
                needsYouNoticesAllowed(preferences, category) &&
                !isNeedsYouItemOpen(action, location)
              )
            })
          : []
      setState({ seen: new Set([...seen, ...ids]), notices: mergeNeedsYouNotices(state.notices, announce) })
    },
    { onMount: true }
  )

  // A card leaves once its item is settled elsewhere, opened, or its category muted.
  const pendingIds = new Set(actions?.map((action) => action.id))
  const visible = state.notices.filter((action) => {
    const category = needsYouNoticeCategory(action)
    return (
      pendingIds.has(action.id) &&
      category !== null &&
      needsYouNoticesAllowed(preferences, category) &&
      !isNeedsYouItemOpen(action, location)
    )
  })

  const dismiss = useCallback(
    (id: string) => setState((current) => ({ ...current, notices: current.notices.filter((n) => n.id !== id) })),
    []
  )

  return (
    <section
      aria-label="Needs you notifications"
      aria-live="polite"
      className="pointer-events-none absolute inset-x-3 top-3 z-70 flex flex-col items-stretch gap-2 sm:left-auto sm:w-96"
    >
      {visible.map((action) => (
        <NeedsYouNoticeCard
          key={action.id}
          action={action}
          timeoutMs={timeoutMs}
          onDismiss={dismiss}
          onOpen={() => {
            dismiss(action.id)
            void navigate(needsYouNoticeDestination(action, location))
          }}
        />
      ))}
    </section>
  )
}

function NeedsYouNoticeCard({
  action,
  timeoutMs,
  onDismiss,
  onOpen,
}: {
  action: PendingAction
  timeoutMs: number
  onDismiss: (id: string) => void
  onOpen: () => void
}) {
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const paused = hovered || focused
  const remaining = useRef(timeoutMs)
  const pausedBefore = useRef(false)
  const { id } = action

  useEffect(() => {
    if (paused) {
      pausedBefore.current = true
      return
    }
    if (pausedBefore.current) remaining.current = Math.max(remaining.current, MIN_REMAINING_AFTER_PAUSE_MS)
    const started = performance.now()
    const timer = setTimeout(() => onDismiss(id), remaining.current)
    return () => {
      clearTimeout(timer)
      remaining.current = Math.max(0, remaining.current - (performance.now() - started))
    }
  }, [paused, onDismiss, id])

  const content = needsYouNoticeContent(action)
  return (
    <div
      data-testid="needs-you-notice"
      className="ficus-overlay pointer-events-auto flex items-start gap-3 p-3"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false)
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.stopPropagation()
        onDismiss(id)
      }}
    >
      <FicusLogo decorative className="mt-0.5 h-6 w-6 shrink-0" />
      <button type="button" onClick={onOpen} className="min-w-0 flex-1 rounded-md text-left">
        <span className="block text-xs text-muted">Needs you</span>
        <span className="block text-sm font-medium text-primary">{content.headline}</span>
        {content.detail && <span className="mt-0.5 block text-sm text-secondary line-clamp-2">{content.detail}</span>}
        {content.context && <span className="mt-0.5 block truncate text-xs text-muted">{content.context}</span>}
      </button>
      <button
        type="button"
        onClick={() => onDismiss(id)}
        aria-label={`Dismiss: ${content.headline}`}
        className="ficus-button ficus-button-ghost -my-1 -mr-1 shrink-0 p-1.5"
      >
        <CloseIcon className="h-4 w-4" />
      </button>
    </div>
  )
}
