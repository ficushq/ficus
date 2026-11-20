import clsx from 'clsx'
import { Link } from 'react-router'
import type { ActivityWorkStreamCard } from '@ficus/shared'
import {
  ACTIVE_WORK_VISIBLE_CARDS,
  activityCardDeliveryLabel,
  activityCardWaitLabel,
  formatActivityTimestamp,
} from './squadActivityView'

export interface ActivityWorkStripProps {
  cards: ActivityWorkStreamCard[]
  /** Total active streams (may exceed `cards`); drives "+N more". */
  total: number
  selectedId: string | null
  onSelect: (id: string | null) => void
  /** The full work list ("+N more"). */
  moreHref: string
}

/**
 * Active work strip (2026-11-20): one compact card per active stream. A card click
 * filters the feed to that stream; clicking it again clears the filter. Narrow widths
 * scroll the cards horizontally; from `lg` they sit in a three-column grid (six on 2xl).
 */
export function ActivityWorkStrip({ cards, total, selectedId, onSelect, moreHref }: ActivityWorkStripProps) {
  let visible = cards.slice(0, ACTIVE_WORK_VISIBLE_CARDS)
  // A selected stream stays visible even when newer events push it past the cap.
  const selected = selectedId ? cards.find((card) => card.id === selectedId) : undefined
  if (selected && !visible.includes(selected)) visible = [...visible, selected]
  const more = Math.max(0, total - visible.length)
  if (!visible.length) return null
  return (
    <div className="mb-2 shrink-0 px-1" data-testid="activity-work-strip">
      <h2 className="sr-only">Active work</h2>
      <ul
        className="flex snap-x gap-2 overflow-x-auto pb-1 lg:grid lg:grid-cols-3 lg:overflow-visible lg:pb-0 2xl:grid-cols-6"
        aria-label="Active work"
      >
        {visible.map((card) => {
          const isSelected = card.id === selectedId
          const waits = activityCardWaitLabel(card)
          const delivery = activityCardDeliveryLabel(card)
          return (
            <li key={card.id} className="w-64 shrink-0 snap-start lg:w-auto">
              <button
                type="button"
                className={clsx(
                  'ficus-inset flex h-full w-full cursor-pointer flex-col gap-0.5 px-3 py-2 text-left text-xs transition-colors hover:bg-surface-hover focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent',
                  isSelected && 'bg-selection ring-1 ring-accent'
                )}
                aria-pressed={isSelected}
                aria-label={`${isSelected ? 'Show all activity instead of' : 'Show only activity for'} #${card.number} ${card.title}`}
                onClick={() => onSelect(isSelected ? null : card.id)}
                data-work-stream-card={card.number}
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  {card.workingAgentIds.length > 0 && (
                    <span className="flex shrink-0 items-center gap-0.5" title="Working now">
                      {card.workingAgentIds.slice(0, 3).map((agentId) => (
                        <span
                          key={agentId}
                          aria-hidden
                          className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-status-progress-500"
                        />
                      ))}
                      <span className="sr-only">{card.workingAgentIds.length} working</span>
                    </span>
                  )}
                  <span className="min-w-0 truncate text-[13px] font-medium text-primary">
                    #{card.number} {card.title}
                  </span>
                </span>
                <span className="flex min-w-0 items-center gap-1 text-secondary">
                  <span className="min-w-0 truncate">
                    {card.step ?? (card.status === 'queued' ? 'Queued' : 'No step')}
                    {waits && (
                      <>
                        {' · '}
                        <span
                          className={clsx(
                            card.waits.some((wait) => wait.needsYou) &&
                              'font-medium text-status-attention-600 dark:text-status-attention-400'
                          )}
                        >
                          {waits}
                        </span>
                      </>
                    )}
                  </span>
                </span>
                {card.summary && <span className="line-clamp-1 text-secondary">{card.summary}</span>}
                <span className="flex min-w-0 items-center gap-2 text-muted">
                  <span
                    className={clsx(
                      'min-w-0 flex-1 truncate',
                      card.ci === 'failing' && 'text-status-danger-600 dark:text-status-danger-400'
                    )}
                  >
                    {delivery ?? ' '}
                  </span>
                  <time dateTime={card.lastEventAt} className="shrink-0 tabular-nums" title="Last event">
                    {formatActivityTimestamp(card.lastEventAt)}
                  </time>
                </span>
              </button>
            </li>
          )
        })}
      </ul>
      {more > 0 && (
        <div className="mt-1 flex justify-end">
          <Link to={moreHref} className="ficus-button ficus-button-link whitespace-nowrap text-xs">
            +{more} more
          </Link>
        </div>
      )}
    </div>
  )
}
