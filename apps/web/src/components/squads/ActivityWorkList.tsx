import clsx from 'clsx'
import { useCallback, useId, useSyncExternalStore } from 'react'
import { Link } from 'react-router'
import {
  activityWorkStreamCardState,
  type ActivityWorkStreamCard,
  type ActivityWorkStreamCardState,
} from '@ficus/shared'
import { ACTIVITY_WORK_EXPANDED_STORAGE_KEY } from '@ficus/shared/browser-keys'
import { PauseIcon } from '../icons'
import { SkeletonText } from '../loading/Skeleton'
import { GENERATED_SUMMARY_TITLE, ShowSummariesSwitch, useShowWorkStreamSummaries } from '../WorkStreamSummary'
import { webStatus } from '../../lib/statusPresentation'
import {
  ACTIVE_WORK_STATE_ORDER,
  ACTIVE_WORK_VISIBLE_ROWS,
  activityCardDeliveryLabel,
  activityWorkCounts,
  activityWorkStateLine,
  formatActivityTimestamp,
} from './squadActivityView'

export interface ActivityWorkListProps {
  cards: ActivityWorkStreamCard[]
  /** Total active streams (may exceed `cards`); drives the "All N active streams" link. */
  total: number
  selectedId: string | null
  onSelect: (id: string | null) => void
  /** The full work list. */
  moreHref: string
  /** Every agent running now in the viewer's squads, for "N other agents working". */
  workingAgentIds: ReadonlySet<string>
  countsLoading?: boolean
}

const EXPANDED_CHANGED_EVENT = 'ficus:activity-work-expanded-changed'

function readExpanded(): boolean {
  try {
    return window.localStorage.getItem(ACTIVITY_WORK_EXPANDED_STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

/** "Show N more" stays expanded across visits (and other tabs) until the person collapses it. */
function useActivityWorkExpanded(): readonly [boolean, (expanded: boolean) => void] {
  const subscribe = useCallback((notify: () => void) => {
    if (typeof window === 'undefined') return () => undefined
    const onStorage = (event: StorageEvent) => {
      if (event.key === ACTIVITY_WORK_EXPANDED_STORAGE_KEY) notify()
    }
    window.addEventListener('storage', onStorage)
    window.addEventListener(EXPANDED_CHANGED_EVENT, notify)
    return () => {
      window.removeEventListener('storage', onStorage)
      window.removeEventListener(EXPANDED_CHANGED_EVENT, notify)
    }
  }, [])
  const expanded = useSyncExternalStore(
    subscribe,
    () => (typeof window === 'undefined' ? false : readExpanded()),
    () => false
  )
  const setExpanded = useCallback((next: boolean) => {
    try {
      if (next) window.localStorage.setItem(ACTIVITY_WORK_EXPANDED_STORAGE_KEY, 'true')
      else window.localStorage.removeItem(ACTIVITY_WORK_EXPANDED_STORAGE_KEY)
    } catch {
      // Storage can be unavailable; the list still toggles for this visit through the event below.
    }
    window.dispatchEvent(new window.Event(EXPANDED_CHANGED_EVENT))
  }, [])
  return [expanded, setExpanded] as const
}

/**
 * One marker per state, each different in shape or color so a paused or waiting stream never looks
 * like a working one: working pulses blue, waiting on you is solid amber, waiting on something else is
 * a hollow ring, paused is a pause glyph, queued and idle are quiet dots.
 */
export function ActivityWorkStateMarker({ state }: { state: ActivityWorkStreamCardState }) {
  if (state === 'paused')
    return (
      <span aria-hidden data-activity-work-state={state} className="inline-flex shrink-0 text-muted">
        <PauseIcon className="h-2.5 w-2.5" />
      </span>
    )
  return (
    <span
      aria-hidden
      data-activity-work-state={state}
      className={clsx(
        'inline-block h-2 w-2 shrink-0 rounded-full',
        state === 'working' && clsx('animate-pulse', webStatus('progress').markerClass),
        state === 'needs-you' && webStatus('humanWait').markerClass,
        state === 'waiting' && clsx('border-2', webStatus('externalWait').borderClass),
        state === 'queued' && clsx('border-2', webStatus('queue').borderClass),
        state === 'idle' && 'bg-placeholder'
      )}
    />
  )
}

const COUNT_LABELS: Record<ActivityWorkStreamCardState, string> = {
  'needs-you': 'waiting on you',
  working: 'working',
  waiting: 'waiting',
  paused: 'paused',
  queued: 'queued',
  idle: 'idle',
}

/**
 * The Active work list (owner decision 2026-11-20): one compact, full-width row per active stream
 * (state marker, number and title, state and step, PR, last event) with an optional summary line
 * under it ("Summaries", on by default and remembered). The first five rows show; "Show N more"
 * expands the rest and is remembered. Clicking a row filters the feed to that stream and opens its
 * details panel; clicking it again clears the filter. The header counts the rows by state.
 */
export function ActivityWorkList({
  cards,
  total,
  selectedId,
  onSelect,
  moreHref,
  workingAgentIds,
  countsLoading = false,
}: ActivityWorkListProps) {
  const listId = useId()
  const [expanded, setExpanded] = useActivityWorkExpanded()
  const [showSummaries] = useShowWorkStreamSummaries('activity')
  let visible = expanded ? cards : cards.slice(0, ACTIVE_WORK_VISIBLE_ROWS)
  // A selected stream stays visible even when newer events push it past the cap.
  const selected = selectedId ? cards.find((card) => card.id === selectedId) : undefined
  if (selected && !visible.includes(selected)) visible = [...visible, selected]
  const hidden = cards.length - visible.length
  const unlisted = Math.max(0, total - cards.length)
  if (!cards.length) return null

  const counts = activityWorkCounts(cards)
  const onCards = new Set(cards.flatMap((card) => card.workingAgentIds))
  const otherWorking = [...workingAgentIds].filter((id) => !onCards.has(id)).length
  const countParts = ACTIVE_WORK_STATE_ORDER.filter((state) => counts[state] > 0)

  return (
    <section className="mb-2 shrink-0 px-1" aria-labelledby={`${listId}-title`} data-testid="activity-work-list">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-2 pb-1">
        <h2 id={`${listId}-title`} className="flex items-baseline gap-2 text-sm font-semibold text-secondary">
          Active work
          <span className="text-xs font-normal text-muted tabular-nums">{total}</span>
        </h2>
        <p
          className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-secondary"
          data-testid="activity-presence"
        >
          {countParts.map((state, index) => (
            <span key={state} className="inline-flex items-center gap-1.5">
              {index > 0 && (
                <span aria-hidden className="text-muted">
                  ·
                </span>
              )}
              <ActivityWorkStateMarker state={state} />
              <span
                className={clsx(
                  state === 'needs-you' && 'font-medium text-status-attention-600 dark:text-status-attention-400'
                )}
              >
                {countsLoading ? <SkeletonText className="inline-block w-3" /> : counts[state]} {COUNT_LABELS[state]}
              </span>
            </span>
          ))}
          {otherWorking > 0 && (
            <span className="inline-flex items-center gap-1.5 text-muted">
              <span aria-hidden>·</span>
              {otherWorking} other {otherWorking === 1 ? 'agent' : 'agents'} working
            </span>
          )}
        </p>
        <ShowSummariesSwitch surface="activity" className="ml-auto" />
      </div>
      <ul id={listId} className="space-y-0.5" aria-label="Active work streams">
        {visible.map((card) => {
          const isSelected = card.id === selectedId
          const state = activityWorkStreamCardState(card)
          const line = activityWorkStateLine(card)
          const stateText = [line.state, line.step].filter(Boolean).join(' · ')
          const delivery = activityCardDeliveryLabel(card)
          const summary = showSummaries ? card.summary?.trim() : undefined
          const attention = state === 'needs-you'
          return (
            <li key={card.id}>
              <button
                type="button"
                className={clsx(
                  'flex w-full cursor-pointer flex-col gap-0.5 rounded-lg px-2 py-1.5 text-left text-xs transition-colors hover:bg-surface-hover focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent',
                  isSelected && 'bg-selection hover:bg-selection'
                )}
                aria-pressed={isSelected}
                aria-label={`${isSelected ? 'Show all activity instead of' : 'Show only activity for'} #${card.number} ${card.title}. ${stateText}`}
                onClick={() => onSelect(isSelected ? null : card.id)}
                data-work-stream-card={card.number}
                data-activity-work-state={state}
              >
                <span className="flex w-full min-w-0 items-center gap-2">
                  <span className="flex w-2.5 shrink-0 justify-center">
                    <ActivityWorkStateMarker state={state} />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[13px] text-primary">
                    <span className="tabular-nums text-secondary">#{card.number}</span> {card.title}
                  </span>
                  <span
                    className={clsx(
                      'max-w-[40%] shrink-0 truncate text-secondary max-sm:hidden',
                      attention && 'font-medium text-status-attention-600 dark:text-status-attention-400'
                    )}
                    data-activity-work-column="state"
                  >
                    {stateText}
                  </span>
                  {delivery && (
                    <span
                      className={clsx(
                        'max-w-[25%] shrink-0 truncate text-muted max-md:hidden',
                        card.ci === 'failing' && 'text-status-danger-600 dark:text-status-danger-400'
                      )}
                    >
                      {delivery}
                    </span>
                  )}
                  <time dateTime={card.lastEventAt} className="w-10 shrink-0 text-right tabular-nums text-muted">
                    {formatActivityTimestamp(card.lastEventAt)}
                  </time>
                </span>
                {/* Narrow widths move the state (and PR) to their own line under the title. */}
                <span
                  className={clsx(
                    'min-w-0 truncate pl-[1.125rem] text-secondary sm:hidden',
                    attention && 'font-medium text-status-attention-600 dark:text-status-attention-400'
                  )}
                >
                  {[stateText, delivery].filter(Boolean).join(' · ')}
                </span>
                {summary && (
                  <span
                    className="min-w-0 truncate pl-[1.125rem] text-muted"
                    title={GENERATED_SUMMARY_TITLE}
                    data-testid="activity-work-summary"
                  >
                    {summary}
                  </span>
                )}
              </button>
            </li>
          )
        })}
      </ul>
      {(hidden > 0 || (expanded && cards.length > ACTIVE_WORK_VISIBLE_ROWS) || unlisted > 0) && (
        <div className="mt-0.5 flex items-center gap-3 px-2">
          {(hidden > 0 || (expanded && cards.length > ACTIVE_WORK_VISIBLE_ROWS)) && (
            <button
              type="button"
              className="ficus-button ficus-button-ghost -ml-2 rounded-md px-2 py-1 text-xs"
              aria-expanded={expanded}
              aria-controls={listId}
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? 'Show fewer' : `Show ${hidden} more`}
            </button>
          )}
          {unlisted > 0 && (
            <Link to={moreHref} className="ficus-button ficus-button-link ml-auto whitespace-nowrap text-xs">
              All {total} active streams
            </Link>
          )}
        </div>
      )}
    </section>
  )
}
