/**
 * One-line work stream summaries on the web (docs/wiki/work-stream-summaries.md): the peek card
 * shared by Feed, Home and Work list rows and graph nodes, the inline summary line, the detail
 * modal's "Now" line, and the per-surface "Summaries" switch.
 */
import clsx from 'clsx'
import {
  useCallback,
  useId,
  useMemo,
  useRef,
  useSyncExternalStore,
  type FocusEvent as ReactFocusEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react'
import { Link } from 'react-router'
import {
  activityStepLabel,
  visibleWorkStreamSummary,
  workStreamDeliveryCiState,
  workStreamTitle,
  workStreamWaitDisplayType,
  workStreamWaitNeedsHuman,
  viewerCanActOnWait,
  type AgentStatus,
  type WorkStream,
  type WorkStreamSummary,
  type WorkStreamViewer,
} from '@ficus/shared'
import { WORK_STREAM_SUMMARIES_CHANGED_EVENT, WORK_STREAM_SUMMARIES_STORAGE_PREFIX } from '@ficus/shared/browser-keys'
import { workStreamPullRequests } from '../lib/workStreamGithub'
import { AgentActivityDot } from './AgentActivityDot'
import { HoverCard } from './popover/HoverCard'
import { useHoverCard, type HoverCardState } from './popover/useHoverCard'
import { activityCardDeliveryLabel, activityCardWaitLabel } from './squads/squadActivityView'

/** Hover text wherever the line appears: it is model output, not status. */
export const GENERATED_SUMMARY_TITLE = "Generated summary of the participants' recent messages; it may be wrong"

/** Hovering a row this long opens its peek card ("about half a second"). */
export const WORK_STREAM_PEEK_OPEN_DELAY_MS = 500

/** The lists that remember their own "Summaries" choice. */
export type WorkStreamSummarySurface = 'feed' | 'home' | 'work'

export function workStreamSummariesStorageKey(surface: WorkStreamSummarySurface): string {
  return `${WORK_STREAM_SUMMARIES_STORAGE_PREFIX}${surface}`
}

/** Lists show summary lines until the person turns them off. */
const SHOW_SUMMARIES_DEFAULT = true

function readShowSummaries(surface: WorkStreamSummarySurface): boolean {
  if (typeof window === 'undefined') return SHOW_SUMMARIES_DEFAULT
  try {
    const stored = window.localStorage.getItem(workStreamSummariesStorageKey(surface))
    // Only an explicit 'false' turns them off; a missing or unreadable value keeps the default.
    return stored === 'false' ? false : stored === 'true' ? true : SHOW_SUMMARIES_DEFAULT
  } catch {
    return SHOW_SUMMARIES_DEFAULT
  }
}

/** Whether a list shows each active row's summary line; on by default, remembered per surface. */
export function useShowWorkStreamSummaries(
  surface: WorkStreamSummarySurface
): readonly [boolean, (show: boolean) => void] {
  const subscribe = useCallback(
    (notify: () => void) => {
      if (typeof window === 'undefined') return () => undefined
      const onStorage = (event: StorageEvent) => {
        if (event.key === workStreamSummariesStorageKey(surface)) notify()
      }
      const onLocalChange = (event: Event) => {
        if ((event as CustomEvent<string>).detail === surface) notify()
      }
      window.addEventListener('storage', onStorage)
      window.addEventListener(WORK_STREAM_SUMMARIES_CHANGED_EVENT, onLocalChange)
      return () => {
        window.removeEventListener('storage', onStorage)
        window.removeEventListener(WORK_STREAM_SUMMARIES_CHANGED_EVENT, onLocalChange)
      }
    },
    [surface]
  )
  const show = useSyncExternalStore(
    subscribe,
    () => readShowSummaries(surface),
    () => SHOW_SUMMARIES_DEFAULT
  )
  const setShow = useCallback(
    (next: boolean) => {
      if (typeof window === 'undefined') return
      try {
        window.localStorage.setItem(workStreamSummariesStorageKey(surface), next ? 'true' : 'false')
      } catch {
        // Storage can be unavailable in locked-down browser contexts; the list keeps its default.
      }
      window.dispatchEvent(new window.CustomEvent(WORK_STREAM_SUMMARIES_CHANGED_EVENT, { detail: surface }))
    },
    [surface]
  )
  return [show, setShow] as const
}

/**
 * The "Summaries" control every work list shows. `compact` (the default) is a small switch the height
 * of the List / Kanban / Graph control, for the Active section header (Home, Work); `row` is
 * a full-width row with a short hint, for the Feed's Filters panel. Both are labelled "Summaries" with
 * an accessible name that says what they toggle.
 */
export function ShowSummariesSwitch({
  surface,
  className,
  variant = 'compact',
}: {
  surface: WorkStreamSummarySurface
  className?: string
  variant?: 'compact' | 'row'
}) {
  const [show, setShow] = useShowWorkStreamSummaries(surface)
  const track = (
    <span
      aria-hidden
      className={clsx(
        'relative inline-flex shrink-0 items-center rounded-full transition-colors',
        variant === 'row' ? 'h-5 w-9' : 'h-3.5 w-6',
        show ? 'bg-accent' : 'bg-th-border'
      )}
    >
      <span
        className={clsx(
          'inline-block rounded-full bg-surface transition-transform',
          variant === 'row'
            ? clsx('h-4 w-4', show ? 'translate-x-[1.125rem]' : 'translate-x-0.5')
            : clsx('h-2.5 w-2.5', show ? 'translate-x-3' : 'translate-x-0.5')
        )}
      />
    </span>
  )
  const switchProps = {
    type: 'button' as const,
    role: 'switch' as const,
    'aria-checked': show,
    'aria-label': 'Show work stream summaries',
    onClick: () => setShow(!show),
    'data-testid': `show-summaries-${surface}`,
  }
  if (variant === 'row')
    return (
      <button
        {...switchProps}
        className={clsx(
          'flex w-full cursor-pointer items-center justify-between gap-4 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-surface-hover focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent',
          className
        )}
      >
        <span className="min-w-0 space-y-0.5">
          <span className="block text-xs leading-4 font-medium text-primary">Summaries</span>
          <span className="block text-[11px] leading-4 text-muted">A one-line summary under each active stream</span>
        </span>
        {track}
      </button>
    )
  return (
    <div className={clsx('inline-flex shrink-0 rounded-lg bg-surface-secondary p-0.5', className)}>
      <button
        {...switchProps}
        title={
          show
            ? 'Hide the one-line summary under each active stream'
            : 'Show a one-line summary under each active stream'
        }
        className="flex h-6 cursor-pointer items-center gap-2 whitespace-nowrap rounded-md px-2 text-xs font-medium text-secondary transition-colors hover:bg-surface-hover hover:text-primary focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent"
      >
        {track}
        {/* A line box exactly the track's height, so the label's middle is the track's middle. */}
        <span className="block leading-[0.875rem]">Summaries</span>
      </button>
    </div>
  )
}

/** The summary a stream may show here: the server's, applying the active and step rules again. */
export function workStreamSummaryFor(workStream: WorkStream): WorkStreamSummary | null {
  return visibleWorkStreamSummary(workStream.summary, workStream)
}

/** "just now", "4 min ago", "2 h ago", "3 days ago". */
export function formatSummaryAge(value: string | Date, now: number = Date.now()): string {
  const ms = now - new Date(value).getTime()
  if (!Number.isFinite(ms) || ms < 60_000) return 'just now'
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.floor(hours / 24)
  return `${days} ${days === 1 ? 'day' : 'days'} ago`
}

/** One muted, truncated summary line under a list row ("Summaries" on). */
export function WorkStreamSummaryLine({ workStream, className }: { workStream: WorkStream; className?: string }) {
  const summary = workStreamSummaryFor(workStream)
  if (!summary) return null
  return (
    <p
      className={clsx('truncate text-xs text-muted', className)}
      title={GENERATED_SUMMARY_TITLE}
      data-testid="work-stream-summary-line"
    >
      {summary.text}
    </p>
  )
}

/** The detail modal's "Now" line: the summary with its age, above the waits. */
export function WorkStreamNowLine({ workStream }: { workStream: WorkStream }) {
  const summary = workStreamSummaryFor(workStream)
  if (!summary) return null
  return (
    <p className="flex flex-wrap items-baseline gap-x-2 text-sm text-primary" data-testid="work-stream-now">
      <span className="text-xs font-medium uppercase tracking-wide text-secondary">Now</span>
      <span className="min-w-0 wrap-break-word" title={GENERATED_SUMMARY_TITLE}>
        {summary.text}
      </span>
      <span className="text-xs text-muted">
        Generated summary ·{' '}
        <time dateTime={summary.generatedAt} title={new Date(summary.generatedAt).toLocaleString()}>
          updated {formatSummaryAge(summary.generatedAt)}
        </time>
      </span>
    </p>
  )
}

/**
 * The stream's open waits and delivery, as the Active work card labels them. A wait reads "Waiting
 * on you" only when this viewer can act on it (the rule rows use); while the viewer is unknown, or
 * to anyone else, it names what it waits on ("Waiting on review").
 */
export function workStreamPeekFacts(workStream: WorkStream, viewer?: WorkStreamViewer) {
  const openWaits = workStream.openWaits ?? []
  const waits = openWaits.map((wait) => {
    const needsYou = workStreamWaitNeedsHuman(wait, { openWaits, delivery: workStream.delivery })
    return {
      type: workStreamWaitDisplayType(wait),
      needsYou,
      you: needsYou && viewerCanActOnWait(wait, workStream, viewer),
    }
  })
  const primary = workStreamPullRequests(workStream.metadata ?? {}).find((pullRequest) => pullRequest.number)
  const pullRequest = primary?.number
    ? {
        number: primary.number,
        state:
          workStream.delivery?.explanation?.pullRequests?.find((pr) => pr.number === primary.number)?.state ?? 'open',
      }
    : null
  return {
    waits,
    waitLabel: activityCardWaitLabel({ waits }),
    needsYou: waits.some((wait) => wait.you),
    deliveryLabel: activityCardDeliveryLabel({
      pullRequest: pullRequest as Parameters<typeof activityCardDeliveryLabel>[0]['pullRequest'],
      ci: workStreamDeliveryCiState(workStream.delivery),
      deliveryLabel: null,
    }),
  }
}

export interface WorkStreamPeek {
  hover: HoverCardState
  /** The peek's description, always in the row: the row's focusable element is described by it. */
  descriptionId: string
  /** Spread on the element the pointer hovers (the row, the card, the graph node). */
  pointerHandlers: {
    onPointerEnter: (event: ReactPointerEvent<HTMLElement | SVGElement>) => void
    onMouseEnter: () => void
    onMouseLeave: () => void
  }
  /** Spread on the element that takes keyboard focus. */
  focusHandlers: {
    onFocus: (event: ReactFocusEvent<HTMLElement | SVGElement>) => void
    onBlur: () => void
    'aria-describedby': string
  }
}

/**
 * Hover and focus intent for one row's peek card: a mouse resting on the row opens it after
 * {@link WORK_STREAM_PEEK_OPEN_DELAY_MS}; keyboard focus opens it at once; Escape and blur close it.
 * Touch and pen never open it: a tap opens the detail modal, which shows the summary at the top.
 */
export function useWorkStreamPeek(): WorkStreamPeek {
  const hover = useHoverCard({ openDelay: WORK_STREAM_PEEK_OPEN_DELAY_MS, closeDelay: 150 })
  const descriptionId = useId()
  const touch = useRef(false)
  const { anchorHandlers } = hover
  return useMemo(
    () => ({
      hover,
      descriptionId,
      pointerHandlers: {
        onPointerEnter: (event) => {
          touch.current = event.pointerType !== 'mouse'
        },
        onMouseEnter: () => {
          if (!touch.current) anchorHandlers.onMouseEnter()
        },
        onMouseLeave: anchorHandlers.onMouseLeave,
      },
      focusHandlers: {
        onFocus: (event) => anchorHandlers.onFocus(event as ReactFocusEvent<HTMLElement>),
        onBlur: anchorHandlers.onBlur,
        'aria-describedby': descriptionId,
      },
    }),
    [hover, descriptionId, anchorHandlers]
  )
}

export interface PeekAgent {
  id: string
  agentTypeId: string
  status: AgentStatus
}

function typeLabel(typeId: string, names?: Map<string, string>): string {
  return names?.get(typeId) ?? typeId.replace(/[-_]+/g, ' ').replace(/^\w/, (letter) => letter.toUpperCase())
}

/**
 * The peek card for one work stream, plus its always-present screen-reader description. Render it
 * inside the row; it portals the card itself.
 */
export function WorkStreamPeekCard({
  peek,
  workStream,
  anchor,
  agentMap,
  agentTypeNames,
  squadSlug,
  viewer,
}: {
  peek: WorkStreamPeek
  workStream: WorkStream
  anchor: RefObject<HTMLElement | null>
  agentMap?: Map<string, PeekAgent>
  agentTypeNames?: Map<string, string>
  /** The stream's squad slug for participant chat links; squad routes also accept the id. */
  squadSlug?: string
  /** Who is looking, as the row knows them; without one the waits never say "you". */
  viewer?: WorkStreamViewer
}) {
  const summary = workStreamSummaryFor(workStream)
  const facts = workStreamPeekFacts(workStream, viewer)
  const step = activityStepLabel(workStream.step) ?? (workStream.status === 'queued' ? 'Queued' : null)
  const participants = (workStream.agentIds ?? []).flatMap((id) => {
    const agent = agentMap?.get(id)
    return agent ? [agent] : []
  })
  const description = [
    summary && `Generated summary: ${summary.text}`,
    step && `Step: ${step}`,
    facts.waitLabel,
    facts.deliveryLabel,
  ]
    .filter(Boolean)
    .join('. ')
  return (
    <>
      <span id={peek.descriptionId} className="sr-only">
        {description}
      </span>
      <HoverCard
        hover={peek.hover}
        anchor={anchor}
        label={`${workStreamTitle(workStream)} at a glance`}
        className="ficus-overlay w-72 space-y-2 p-3 text-[13px] leading-5 text-primary"
      >
        <div data-testid="work-stream-peek">
          {summary ? (
            <p className="wrap-break-word text-primary" title={GENERATED_SUMMARY_TITLE}>
              {summary.text}
            </p>
          ) : (
            <p className="text-muted">No summary yet.</p>
          )}
          {summary && (
            <p className="text-xs text-muted">
              Generated summary ·{' '}
              <time dateTime={summary.generatedAt}>updated {formatSummaryAge(summary.generatedAt)}</time>
            </p>
          )}
        </div>
        <dl className="space-y-1 border-t border-th-border pt-2 text-xs">
          {(step || facts.waitLabel) && (
            <div className="flex gap-2">
              <dt className="w-20 shrink-0 text-muted">Step</dt>
              <dd className="min-w-0 text-secondary">
                {step ?? 'No step'}
                {facts.waitLabel && (
                  <>
                    {' · '}
                    <span
                      className={clsx(
                        facts.needsYou && 'font-medium text-status-attention-600 dark:text-status-attention-400'
                      )}
                    >
                      {facts.waitLabel}
                    </span>
                  </>
                )}
              </dd>
            </div>
          )}
          {facts.deliveryLabel && (
            <div className="flex gap-2">
              <dt className="w-20 shrink-0 text-muted">Delivery</dt>
              <dd className="min-w-0 text-secondary">{facts.deliveryLabel}</dd>
            </div>
          )}
          {participants.length > 0 && (
            <div className="flex gap-2">
              <dt className="w-20 shrink-0 text-muted">Participants</dt>
              <dd className="flex min-w-0 flex-wrap gap-x-2 gap-y-0.5 text-secondary">
                {participants.map((agent) => {
                  const name = typeLabel(agent.agentTypeId, agentTypeNames)
                  return (
                    // The same agent chat link as a row's subtitle: a plain click opens the chat, and
                    // Shift- or Alt/Option-click opens it in a floating window (FloatingWindows).
                    <Link
                      key={agent.id}
                      to={`/squads/${squadSlug ?? workStream.squadId}/agents?agent=${agent.id}`}
                      className="inline-flex cursor-pointer items-center gap-1 rounded-xs hover:text-link-hover hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent"
                      title={`Open ${name} agent thread`}
                      data-testid="work-stream-peek-participant"
                      onClick={(event) => {
                        // The card is portaled from inside the row: keep the row's own click (open the
                        // stream) from running too, and close the card as following a link would.
                        event.stopPropagation()
                        peek.hover.hide()
                      }}
                    >
                      <AgentActivityDot status={agent.status} />
                      {name}
                    </Link>
                  )
                })}
              </dd>
            </div>
          )}
          <div className="flex gap-2">
            <dt className="w-20 shrink-0 text-muted">Last update</dt>
            <dd className="text-secondary">
              <time dateTime={new Date(workStream.updatedAt).toISOString()}>
                {formatSummaryAge(workStream.updatedAt)}
              </time>
            </dd>
          </div>
        </dl>
      </HoverCard>
    </>
  )
}
