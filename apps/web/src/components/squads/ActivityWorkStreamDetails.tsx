import clsx from 'clsx'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { activityWorkStreamCardState, type ActivityWorkStreamCard } from '@ficus/shared'
import { formatSummaryAge, GENERATED_SUMMARY_TITLE } from '../WorkStreamSummary'
import { ActivityWorkStateMarker } from './ActivityWorkList'
import { activityExternalHref, activityWorkStateLine, formatActivityTimestamp } from './squadActivityView'

/** The element the Active work rows control (`aria-controls`). */
export const ACTIVITY_WORK_STREAM_DETAILS_ID = 'activity-work-stream-details'

export interface ActivityWorkStreamDetailsLink {
  href: string
  /** A plain click: open in place (the stream or chat modal). Modified clicks keep the link's navigation. */
  onOpen: () => void
}

export interface ActivityWorkStreamDetailsProps {
  /** Undefined when the filtered stream is no longer among the cards (finished, or past the limit). */
  card: ActivityWorkStreamCard | undefined
  stream: ActivityWorkStreamDetailsLink | null
  /** The participant to chat with: the one working now, else the one with the newest row. */
  chat: (ActivityWorkStreamDetailsLink & { agentId: string; label: string }) | null
  /** Display names of the participants running now. */
  workingLabels: string[]
  onClear: () => void
}

const plainClick = (event: ReactMouseEvent) =>
  !(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0)

const ACTION_LINK_CLASS =
  'ficus-button ficus-button-secondary rounded-md px-2.5 py-1 text-xs whitespace-nowrap focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent'

/**
 * The selected stream in full, where the filter bar used to be: the whole title and summary (never
 * clamped), the state and step, the PR and CI, who is working, and links to the stream and to a
 * participant's chat, with Clear. Everything is in the page, so nothing depends on hover.
 */
export function ActivityWorkStreamDetails({
  card,
  stream,
  chat,
  workingLabels,
  onClear,
}: ActivityWorkStreamDetailsProps) {
  const clear = (
    <button
      type="button"
      className="ficus-button ficus-button-ghost shrink-0 rounded-md px-2 py-1 text-xs"
      onClick={onClear}
      aria-label="Clear the work stream filter and show all activity"
    >
      Clear
    </button>
  )
  if (!card)
    return (
      <section
        id={ACTIVITY_WORK_STREAM_DETAILS_ID}
        className="ficus-inset mx-1 mb-2 flex shrink-0 items-center gap-3 px-3 py-2 text-xs text-secondary"
        aria-label="Selected work stream"
        data-testid="activity-work-stream-filter"
      >
        <span className="min-w-0 flex-1">Showing one work stream.</span>
        {clear}
      </section>
    )

  const state = activityWorkStreamCardState(card)
  const line = activityWorkStateLine(card)
  const pullRequestHref = card.pullRequest?.url ? activityExternalHref(card.pullRequest.url) : undefined
  const summary = card.summary?.trim()
  const titleId = `${ACTIVITY_WORK_STREAM_DETAILS_ID}-title`
  return (
    <section
      id={ACTIVITY_WORK_STREAM_DETAILS_ID}
      className="ficus-inset mx-1 mb-2 shrink-0 space-y-1.5 px-3 py-2.5 text-xs"
      aria-labelledby={titleId}
      data-testid="activity-work-stream-filter"
    >
      <div className="flex items-start gap-3">
        <h2 id={titleId} className="min-w-0 flex-1 text-sm font-medium text-primary wrap-break-word">
          <span className="sr-only">Showing only activity for </span>
          <span className="tabular-nums text-secondary">#{card.number}</span> {card.title}
        </h2>
        {clear}
      </div>
      <p
        className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-secondary"
        data-testid="activity-work-details-state"
      >
        <ActivityWorkStateMarker state={state} />
        <span
          className={clsx(
            state === 'needs-you' && 'font-medium text-status-attention-600 dark:text-status-attention-400'
          )}
        >
          {line.state}
        </span>
        {line.step && (
          <>
            <span aria-hidden className="text-muted">
              ·
            </span>
            <span>Step: {line.step}</span>
          </>
        )}
        {workingLabels.length > 0 && (
          <>
            <span aria-hidden className="text-muted">
              ·
            </span>
            <span>Working now: {workingLabels.join(', ')}</span>
          </>
        )}
        {card.pullRequest && (
          <>
            <span aria-hidden className="text-muted">
              ·
            </span>
            {pullRequestHref ? (
              <a
                href={pullRequestHref}
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent-light underline underline-offset-2 hover:text-link-hover"
              >
                PR #{card.pullRequest.number}
              </a>
            ) : (
              <span>PR #{card.pullRequest.number}</span>
            )}
            {card.pullRequest.state !== 'open' && <span>{card.pullRequest.state}</span>}
          </>
        )}
        {card.ci && (
          <span className={clsx(card.ci === 'failing' && 'text-status-danger-600 dark:text-status-danger-400')}>
            {card.ci === 'passing' ? 'CI passing' : card.ci === 'failing' ? 'CI failing' : 'CI running'}
          </span>
        )}
        {card.deliveryLabel && !(card.ci && /\bCI\b/.test(card.deliveryLabel)) && <span>{card.deliveryLabel}</span>}
        <span aria-hidden className="text-muted">
          ·
        </span>
        <span className="text-muted">
          Last event <time dateTime={card.lastEventAt}>{formatActivityTimestamp(card.lastEventAt)}</time>
        </span>
      </p>
      {summary && (
        <p className="text-[13px] text-primary wrap-break-word" data-testid="activity-work-details-summary">
          <span title={GENERATED_SUMMARY_TITLE}>{summary}</span>{' '}
          <span className="text-xs text-muted">
            Generated summary
            {card.summaryGeneratedAt && (
              <>
                {' · '}
                <time dateTime={card.summaryGeneratedAt}>updated {formatSummaryAge(card.summaryGeneratedAt)}</time>
              </>
            )}
          </span>
        </p>
      )}
      {(stream || chat) && (
        <div className="flex flex-wrap items-center gap-2 pt-0.5">
          {stream && (
            <a
              href={stream.href}
              className={ACTION_LINK_CLASS}
              onClick={(event) => {
                if (!plainClick(event)) return
                event.preventDefault()
                stream.onOpen()
              }}
            >
              Open work stream
            </a>
          )}
          {chat && (
            // The href is an agent chat link, so Shift- or Alt/Option-click opens a floating window.
            <a
              href={chat.href}
              className={ACTION_LINK_CLASS}
              aria-label={`Open chat with ${chat.label}`}
              onClick={(event) => {
                if (!plainClick(event)) return
                event.preventDefault()
                chat.onOpen()
              }}
            >
              Open chat · {chat.label}
            </a>
          )}
        </div>
      )}
    </section>
  )
}
