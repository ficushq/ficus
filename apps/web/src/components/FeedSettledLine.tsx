import clsx from 'clsx'
import { Fragment } from 'react'
import { Link } from 'react-router'
import type { ActivitySettledSummary } from '@ficus/shared'
import { settledActivityHref, settledLineParts, settledPeriodLabel } from '../lib/settledActivity'
import { FEED_ROW_TEXT_INSET_CLASS } from './feedSectionLayout'

/**
 * One quiet line in the Feed's Updates: "Since yesterday: 4 questions settled by agents, 2 reviews
 * done by agents". Each count opens Activity filtered to its rows, with a light dotted underline so
 * the links can be found without making the line loud. Absent when every count is zero.
 */
export function FeedSettledLine({
  summary,
  squadIds,
  now,
}: {
  summary: ActivitySettledSummary | null
  squadIds: readonly string[]
  now?: Date
}) {
  const parts = settledLineParts(summary)
  if (!summary || parts.length === 0) return null
  return (
    <p className={clsx(FEED_ROW_TEXT_INSET_CLASS, 'text-xs text-muted')} data-testid="feed-settled-line">
      {settledPeriodLabel(summary.since, now)}:{' '}
      {parts.map((part, index) => (
        <Fragment key={part.kind}>
          {index > 0 && ', '}
          <Link
            to={settledActivityHref(part.kind, summary.since, squadIds)}
            className="rounded-sm underline decoration-dotted underline-offset-2 hover:text-secondary hover:decoration-solid focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent"
          >
            {part.label}
          </Link>
        </Fragment>
      ))}
    </p>
  )
}
