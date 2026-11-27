import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useLocation, useNavigate } from 'react-router'
import type { PendingAction } from '@ficus/shared'
import { PUSH_SUBSCRIPTION_ID_STORAGE_KEY } from '@ficus/shared/browser-keys'
import { usePendingActions } from '../hooks/usePendingActions'
import { useAdjustOnChange } from '../hooks/useAdjustOnChange'
import { queries } from '../queryOptions'
import { desktopBridge } from '../lib/desktop'
import { isWebKitEngine, subscribeNeedsYouPushChecks } from '../lib/needsYouPush'
import { useStableRef } from '../hooks/useStableRef'
import {
  isNeedsYouItemOpen,
  mergeNeedsYouNotices,
  needsYouNoticeCategory,
  needsYouNoticeContent,
  needsYouNoticeDestination,
  needsYouNoticesAllowed,
  NEEDS_YOU_NOTICE_TIMEOUT_MS,
  NEEDS_YOU_REFOCUS_GRACE_MS,
  type NeedsYouNoticePreferences,
} from '../lib/needsYouNotices'
import { FicusLogo } from './FicusLogo'
import { CloseIcon } from './icons'
import { useAgentTypeNames } from '../hooks/useAgentTypeNames'

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

/** Where the window's focus stands: cards appear only in a focused, visible window. */
export interface WindowFocus {
  /** Read when a list arrives (never tracked from blur events; see popupDismissal.guard.test.ts). */
  isFocused: () => boolean
  /** When focus was last regained (ms since the epoch); 0 when it has not been since mount. */
  since: number
}

function readWindowFocus(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus()
}

function useWindowFocus(): WindowFocus {
  const [since, setSince] = useState(0)
  useEffect(() => {
    const regained = () => {
      if (readWindowFocus()) setSince(Date.now())
    }
    window.addEventListener('focus', regained)
    document.addEventListener('visibilitychange', regained)
    return () => {
      window.removeEventListener('focus', regained)
      document.removeEventListener('visibilitychange', regained)
    }
  }, [])
  return { isFocused: readWindowFocus, since }
}

interface PendingActionsResult {
  data?: PendingAction[]
  /** When the list was fetched (ms since the epoch), as react-query reports it. */
  dataUpdatedAt?: number
  refetch?: () => Promise<unknown>
}

interface NeedsYouNotificationsDependencies {
  usePendingActions: () => PendingActionsResult
  usePreferences: () => NeedsYouNoticePreferences | undefined
  /** Cards appear only while the window is focused; otherwise the OS notification is the notice. */
  useWindowFocus: () => WindowFocus
  osNotificationReplacesCard: () => boolean
  /** Answers the service worker's "do you show a card for this push?" (lib/needsYouPush.ts). */
  subscribePushChecks: (handler: (actionId: string) => Promise<boolean>) => () => void
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

const CONFIRM_POLL_MS = 50
const CONFIRM_ATTEMPTS = 12

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
    useWindowFocus: useFocus = useWindowFocus,
    osNotificationReplacesCard: osNotificationShows = osNotificationReplacesCard,
    subscribePushChecks = subscribeNeedsYouPushChecks,
    timeoutMs = NEEDS_YOU_NOTICE_TIMEOUT_MS,
  } = dependencies
  const { data: actions, dataUpdatedAt, refetch } = usePending()
  const preferences = usePreferences()
  const focus = useFocus()
  const location = useLocation()
  const navigate = useNavigate()
  const [state, setState] = useState<NoticeState>({ seen: null, notices: [] })

  // Each new pending list: announce the items not seen before, once each. A list fetched while the
  // window was away, or right as it came back, only records its items: they arrived while the user
  // was elsewhere and got their OS notification then.
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
      const away =
        !focus.isFocused() ||
        (focus.since > 0 && (dataUpdatedAt ?? Number.POSITIVE_INFINITY) < focus.since + NEEDS_YOU_REFOCUS_GRACE_MS)
      const announce =
        !away && !osNotificationShows()
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

  // A card shows its item as it is now, and leaves once the item is settled elsewhere, opened, no
  // longer card-eligible (an answered question whose delivery failed), or its category muted.
  const current = new Map(actions?.map((action) => [action.id, action]))
  const visible = state.notices
    .flatMap((notice) => {
      const action = current.get(notice.id)
      return action ? [action] : []
    })
    .filter((action) => {
      const category = needsYouNoticeCategory(action)
      return category !== null && needsYouNoticesAllowed(preferences, category) && !isNeedsYouItemOpen(action, location)
    })

  // Every item this page has put on screen, dismissed or not. The service worker skips a push's OS
  // notification only for one of these that is STILL a card-eligible item in the current list: a
  // later push can reuse the id for something that never gets a card (an answered question whose
  // delivery failed carries the question's own `agent-question:<id>`), and that must still alert.
  const shown = useRef(new Set<string>())
  useEffect(() => {
    for (const action of visible) shown.current.add(action.id)
  })
  const refetchRef = useStableRef(refetch)
  const actionsRef = useStableRef(actions)
  useEffect(() => {
    const confirmed = (actionId: string) => {
      if (!shown.current.has(actionId)) return false
      const current = actionsRef.current?.find((action) => action.id === actionId)
      return current !== undefined && needsYouNoticeCategory(current) !== null
    }
    return subscribePushChecks(async (actionId) => {
      // The push usually lands before the next poll: fetch the list, then let it render.
      await refetchRef.current?.()
      for (let attempt = 0; attempt < CONFIRM_ATTEMPTS && !confirmed(actionId); attempt++)
        await new Promise((resolve) => setTimeout(resolve, CONFIRM_POLL_MS))
      return confirmed(actionId)
    })
  }, [subscribePushChecks, refetchRef, actionsRef])

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

  const typeNames = useAgentTypeNames()
  const content = needsYouNoticeContent(action, typeNames)
  return (
    <div
      data-testid="needs-you-notice"
      className="ficus-overlay pointer-events-auto flex items-start gap-3 p-3"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        // Moving between the card's own buttons keeps the timer paused: check where focus landed
        // once it has settled, after this blur's task.
        const card = event.currentTarget
        setTimeout(() => setFocused(card.contains(document.activeElement)))
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
