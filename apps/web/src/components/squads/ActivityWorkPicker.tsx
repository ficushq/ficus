import clsx from 'clsx'
import { useNavigate } from 'react-router'
import {
  activityWorkStreamCardState,
  type ActivityWorkStreamCard,
  type ActivityWorkStreamCardState,
} from '@ficus/shared'
import { ChevronDownIcon, PauseIcon } from '../icons'
import { Picker, usePopover, type PickerOption } from '../popover'
import { webStatus } from '../../lib/statusPresentation'
import { activityCardDeliveryLabel, activityWorkStateLine } from './squadActivityView'

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

/** The option that opens the full work list when the server returned fewer cards than it counted. */
const ALL_STREAMS = '__all__'
/** The option that clears the filter. */
const ALL_ACTIVITY = ''

export interface ActivityWorkPickerProps {
  cards: ActivityWorkStreamCard[]
  /** Total active streams (may exceed `cards`). */
  total: number
  selectedId: string | null
  onSelect: (id: string | null) => void
  /** The full work list, offered when `total` exceeds the cards returned. */
  moreHref: string
}

/**
 * Activity's Active work control (owner decision 2026-11-20: Activity is the agent stream, not a work
 * tracker). A pill in the presence line, "Active work 7", opens a searchable list of the active streams:
 * state marker, number and title, state and step with the PR, and the generated summary. Typing filters
 * it (number, title, state or summary), the arrows move through it, and choosing a stream filters the
 * feed to it and opens its details panel; "All activity" clears the filter.
 */
export function ActivityWorkPicker({ cards, total, selectedId, onSelect, moreHref }: ActivityWorkPickerProps) {
  const navigate = useNavigate()
  const popover = usePopover({ kind: 'dialog' })
  const selected = selectedId ? cards.find((card) => card.id === selectedId) : undefined
  const unlisted = Math.max(0, total - cards.length)
  const options: PickerOption<string>[] = [
    { value: ALL_ACTIVITY, label: 'All activity', description: 'Every agent and stream' },
    ...cards.map((card): PickerOption<string> => {
      const state = activityWorkStreamCardState(card)
      const line = activityWorkStateLine(card)
      const delivery = activityCardDeliveryLabel(card)
      return {
        value: card.id,
        label: `#${card.number} ${card.title}`,
        description: [line.state, line.step, delivery].filter(Boolean).join(' · '),
        detail: card.summary?.trim() || undefined,
        icon: (
          <span className="flex h-5 w-3 shrink-0 items-center justify-center">
            <ActivityWorkStateMarker state={state} />
          </span>
        ),
        keywords: String(card.number),
      }
    }),
    ...(unlisted > 0
      ? [{ value: ALL_STREAMS, label: `All ${total} active streams`, description: 'Open the work list' }]
      : []),
  ]
  return (
    <>
      <button
        {...popover.triggerProps}
        type="button"
        onClick={popover.toggle}
        aria-label={`Active work, ${total} ${total === 1 ? 'stream' : 'streams'}${selected ? `, showing #${selected.number}` : ''}`}
        className={clsx(
          'ficus-button ficus-button-ghost flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs whitespace-nowrap',
          selected
            ? 'bg-selection hover:bg-selection text-accent-light hover:text-accent-light'
            : 'bg-surface-secondary text-secondary'
        )}
        data-testid="activity-work-trigger"
      >
        Active work
        <span className="font-medium tabular-nums">{total}</span>
        <ChevronDownIcon className={clsx('h-3 w-3 transition-transform', popover.open && 'rotate-180')} />
      </button>
      <Picker
        {...popover.popoverProps}
        label="Active work streams"
        search={{
          label: 'Search active work',
          placeholder: 'Search by number, title, state or summary',
          empty: 'No active stream matches',
        }}
        value={selectedId ?? ALL_ACTIVITY}
        options={options}
        onChange={(value) => {
          if (value === ALL_STREAMS) navigate(moreHref)
          else onSelect(value || null)
        }}
        align="start"
        maxHeight={(viewport) => Math.min(480, 0.7 * (viewport.bottom - viewport.top))}
        className="w-[28rem] max-w-[calc(100vw-2rem)]"
      />
    </>
  )
}
