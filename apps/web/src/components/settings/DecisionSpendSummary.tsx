import { useQuery } from '@tanstack/react-query'
import type { DecisionSpend } from '@ficus/shared'
import { queries } from '../../queryOptions'
import { formatSpend, formatUsd, SPEND_ESTIMATE_NOTE } from './decisionUi'

const PERIOD_LABEL: Record<number, string> = { 1: 'the last 24 hours', 7: 'the last 7 days', 30: 'the last 30 days' }

/** Total decision spend for the chosen period, and a month's projection from the last week. */
export function DecisionSpendSummary({ spend }: { spend?: DecisionSpend }) {
  // The projection always uses the last 7 days, whatever period is shown.
  const { data: week } = useQuery(queries.decisions.spend(7))
  if (!spend) return null
  const monthly = week ? (week.totalUsd * 30) / 7 : undefined
  return (
    <div className="space-y-0.5" role="status" aria-label="Decision model spend">
      <p className="text-sm text-primary">
        <span className="font-semibold tabular-nums" title={spend.approximate ? SPEND_ESTIMATE_NOTE : undefined}>
          {formatSpend(spend.totalUsd, spend.approximate)}
        </span>{' '}
        <span className="text-secondary">in {PERIOD_LABEL[spend.days] ?? `the last ${spend.days} days`}</span>
        {monthly !== undefined && monthly > 0 && (
          <span className="text-muted">
            {' '}
            · about <span className="tabular-nums">{formatUsd(monthly)}</span> a month at this rate
          </span>
        )}
      </p>
      {(spend.approximate || week?.approximate) && <p className="text-xs text-muted">≈ {SPEND_ESTIMATE_NOTE}</p>}
    </div>
  )
}
