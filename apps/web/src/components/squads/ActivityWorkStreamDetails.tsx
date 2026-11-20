import clsx from 'clsx'
import type { MouseEvent as ReactMouseEvent } from 'react'
import {
  activityWorkStreamCardState,
  type ActivityWorkStreamCard,
  type ActivityWorkStreamCardState,
  type StatusRole,
} from '@ficus/shared'
import { Badge } from '../Badge'
import { formatSummaryAge, GENERATED_SUMMARY_TITLE } from '../WorkStreamSummary'
import { ActivityWorkStateMarker } from './ActivityWorkPicker'
import { activityExternalHref, activityWorkStateLine, formatActivityTimestamp } from './squadActivityView'

/** The element the Active work rows control (`aria-controls`). */
export const ACTIVITY_WORK_STREAM_DETAILS_ID = 'activity-work-stream-details'

export interface ActivityWorkStreamDetailsLink {
  href: string
  /** A plain click: open in place (the stream or chat modal). Modified clicks keep the link's navigation. */
  onOpen: () => void
}

export type ActivityWorkStreamDetailsAgentLink = ActivityWorkStreamDetailsLink & { agentId: string; label: string }

export interface ActivityWorkStreamDetailsProps {
  /** Undefined when the filtered stream is no longer among the cards (finished, or past the limit). */
  card: ActivityWorkStreamCard | undefined
  stream: ActivityWorkStreamDetailsLink | null
  /** The participant to chat with: the one working now, else the one with the newest row. */
  chat: ActivityWorkStreamDetailsAgentLink | null
  /** The participants running now, each linking to its chat. */
  working: ActivityWorkStreamDetailsAgentLink[]
  onClear: () => void
}

const plainClick = (event: ReactMouseEvent) =>
  !(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0)

/** Open in place on a plain click; Cmd/Ctrl, Shift and Alt/Option clicks keep the link's own navigation. */
const openInPlace = (link: ActivityWorkStreamDetailsLink) => (event: ReactMouseEvent) => {
  if (!plainClick(event)) return
  event.preventDefault()
  link.onOpen()
}

const ACTION_LINK_CLASS =
  'ficus-button ficus-button-secondary inline-flex items-center rounded-md px-2.5 py-1 text-xs whitespace-nowrap focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent'

/** The state chip's color, the same status roles as the state markers. */
const STATE_ROLES: Record<ActivityWorkStreamCardState, StatusRole> = {
  'needs-you': 'humanWait',
  working: 'progress',
  waiting: 'externalWait',
  queued: 'queue',
  paused: 'neutral',
  idle: 'neutral',
}

const CI: Record<NonNullable<ActivityWorkStreamCard['ci']>, { label: string; role: StatusRole }> = {
  passing: { label: 'CI passing', role: 'success' },
  failing: { label: 'CI failing', role: 'danger' },
  pending: { label: 'CI running', role: 'progress' },
}

/** A chip's quiet field name ahead of its value ("Step Implement"), with a real space between them. */
function ChipText({ label, value }: { label: string; value: string }) {
  return (
    <span>
      <span className="font-normal opacity-70">{label}</span> {value}
    </span>
  )
}

/**
 * The selected stream in full, above the filtered feed: everything the Active work rows leave out
 * (owner decision 2026-11-20). A title row (number, whole title, Clear); one row of chips for the state
 * with its marker, the step, each participant working now (a chat link, so Shift- or Alt/Option-click
 * floats it), the PR and CI; the generated summary as body text with its age underneath; then the
 * actions and the last event time. Nothing is clamped or depends on hover.
 */
export function ActivityWorkStreamDetails({ card, stream, chat, working, onClear }: ActivityWorkStreamDetailsProps) {
  const clear = (
    <button
      type="button"
      className="ficus-button ficus-button-ghost -my-1 -mr-1.5 shrink-0 rounded-md px-2 py-1 text-xs"
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
        className="ficus-inset mx-1 mb-2 flex shrink-0 items-center gap-3 px-3 py-2.5 text-xs text-secondary"
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
  const pullRequestLabel = card.pullRequest
    ? `PR #${card.pullRequest.number}${card.pullRequest.state === 'open' ? '' : ` ${card.pullRequest.state}`}`
    : null
  // The CI chip already says what a CI delivery label would.
  const deliveryLabel =
    card.deliveryLabel && !(card.ci && /\bCI\b/.test(card.deliveryLabel)) ? card.deliveryLabel : null
  const summary = card.summary?.trim()
  const titleId = `${ACTIVITY_WORK_STREAM_DETAILS_ID}-title`
  return (
    <section
      id={ACTIVITY_WORK_STREAM_DETAILS_ID}
      className="ficus-inset mx-1 mb-2 shrink-0 px-3 py-3 text-xs"
      aria-labelledby={titleId}
      data-testid="activity-work-stream-filter"
    >
      <div className="flex items-start gap-3">
        <h2 id={titleId} className="min-w-0 flex-1 text-sm leading-5 font-medium text-primary wrap-break-word">
          <span className="sr-only">Showing only activity for </span>
          <span className="font-normal tabular-nums text-muted">#{card.number}</span> {card.title}
        </h2>
        {clear}
      </div>

      <ul className="mt-2 flex flex-wrap items-center gap-1.5" data-testid="activity-work-details-state">
        <li>
          <Badge color={STATE_ROLES[state]} className="gap-1.5">
            <ActivityWorkStateMarker state={state} />
            {line.state}
          </Badge>
        </li>
        {line.step && (
          <li>
            <Badge>
              <ChipText label="Step" value={line.step} />
            </Badge>
          </li>
        )}
        {working.map((agent) => (
          <li key={agent.agentId}>
            {/* An agent chat link: Shift- or Alt/Option-click opens it in a floating window. */}
            <Badge
              to={agent.href}
              onClick={openInPlace(agent)}
              aria-label={`Open chat with ${agent.label}, working now`}
              title="Working now"
            >
              <ChipText label="Working" value={agent.label} />
            </Badge>
          </li>
        ))}
        {pullRequestLabel && (
          <li>
            {pullRequestHref ? (
              <Badge href={pullRequestHref}>{pullRequestLabel}</Badge>
            ) : (
              <Badge>{pullRequestLabel}</Badge>
            )}
          </li>
        )}
        {card.ci && (
          <li>
            <Badge color={CI[card.ci].role}>{CI[card.ci].label}</Badge>
          </li>
        )}
        {deliveryLabel && (
          <li>
            <Badge>{deliveryLabel}</Badge>
          </li>
        )}
      </ul>

      {summary && (
        <div className="mt-2.5" data-testid="activity-work-details-summary">
          <p className="text-[13px] leading-5 text-primary wrap-break-word" title={GENERATED_SUMMARY_TITLE}>
            {summary}
          </p>
          <p className="mt-0.5 text-[11px] text-muted">
            Generated summary
            {card.summaryGeneratedAt && (
              <>
                {' · '}
                <time dateTime={card.summaryGeneratedAt}>updated {formatSummaryAge(card.summaryGeneratedAt)}</time>
              </>
            )}
          </p>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-2">
        {stream && (
          <a href={stream.href} className={ACTION_LINK_CLASS} onClick={openInPlace(stream)}>
            Open work stream
          </a>
        )}
        {chat && (
          // The href is an agent chat link, so Shift- or Alt/Option-click opens a floating window.
          <a
            href={chat.href}
            className={ACTION_LINK_CLASS}
            aria-label={`Open chat with ${chat.label}`}
            onClick={openInPlace(chat)}
          >
            Open chat · {chat.label}
          </a>
        )}
        <span className={clsx('text-[11px] text-muted', (stream || chat) && 'ml-auto')}>
          Last event <time dateTime={card.lastEventAt}>{formatActivityTimestamp(card.lastEventAt)}</time>
        </span>
      </div>
    </section>
  )
}
