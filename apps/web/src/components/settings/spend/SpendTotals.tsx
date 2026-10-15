import type { SpendSummary } from '@ficus/shared'
import { formatSpend, formatUsd, SPEND_APPROXIMATE_NOTE } from './spendUi'

/**
 * The period's total: what calls billed plus each subscription's fee as its own line, so a month's total is
 * what was actually paid. "Preview without subscriptions" is deliberately low-key: it prices every call at
 * list price instead, for comparing plans with API keys.
 */
export function SpendTotals({
  summary,
  periodLabel,
  preview,
  onPreviewChange,
}: {
  summary: SpendSummary
  periodLabel: string
  preview: boolean
  onPreviewChange: (preview: boolean) => void
}) {
  const { totals, subscriptions } = summary
  return (
    <section aria-labelledby="spend-total-heading" className="space-y-3" data-setting-target="spend-overview">
      <div>
        <h3 id="spend-total-heading" className="text-sm font-medium text-secondary">
          Total for {periodLabel}
        </h3>
        <p
          className="whitespace-nowrap text-3xl font-semibold tabular-nums text-primary"
          title={totals.approximate ? SPEND_APPROXIMATE_NOTE : undefined}
        >
          {formatSpend(totals.totalUsd, totals.approximate)}
        </p>
        {summary.projection.monthUsd !== null && summary.projection.monthUsd > 0 && (
          <p className="text-xs text-muted">
            About <span className="tabular-nums">{formatUsd(summary.projection.monthUsd)}</span> this month at this
            month’s rate, with full subscription fees.
          </p>
        )}
      </div>
      <ul
        className="divide-y divide-th-border border-y border-th-border text-sm"
        aria-label="What the total is made of"
      >
        <li className="flex items-baseline justify-between gap-4 py-2">
          <span className="min-w-0 text-primary">
            Model usage billed per call
            <span className="block text-xs text-muted">
              {totals.calls.toLocaleString('en-US')} {totals.calls === 1 ? 'call' : 'calls'} · API keys; subscription,
              self-hosted and before-tracking calls bill $0 each
            </span>
          </span>
          <span className="shrink-0 whitespace-nowrap tabular-nums text-primary">
            {formatSpend(totals.billedUsd, totals.approximate)}
          </span>
        </li>
        {subscriptions.map((line) => (
          <li key={`${line.provider}/${line.accountId}`} className="flex items-baseline justify-between gap-4 py-2">
            <span className="min-w-0 break-words text-primary">
              {line.needsChoice
                ? `${line.label}: subscription, plan unknown`
                : `${line.label}: ${line.planLabel ?? line.plan ?? 'subscription'}`}
              <span className="block text-xs text-muted">
                {line.needsChoice ? (
                  <a className="ficus-button ficus-button-link" href="#spend-subscriptions">
                    Choose its plan or price to count its fee
                  </a>
                ) : (
                  <>
                    {formatUsd(line.monthlyPriceUsd ?? 0)}/month, counted by day for this period ·{' '}
                    {line.calls.toLocaleString('en-US')} {line.calls === 1 ? 'call' : 'calls'}
                  </>
                )}
              </span>
            </span>
            <span className="shrink-0 whitespace-nowrap tabular-nums text-primary">
              {line.needsChoice ? '—' : formatUsd(line.feeUsd)}
            </span>
          </li>
        ))}
      </ul>
      {!summary.meta.feesIncluded && (
        <p className="text-xs text-muted">
          Subscription fees are left out while the view is narrowed to part of the calls they pay for.
        </p>
      )}
      {totals.approximate && <p className="text-xs text-muted">≈ {SPEND_APPROXIMATE_NOTE}</p>}
      <div className="text-xs text-muted">
        <button
          type="button"
          className="ficus-button ficus-button-link text-xs"
          aria-expanded={preview}
          onClick={() => onPreviewChange(!preview)}
        >
          {preview ? 'Hide preview' : 'Preview without subscriptions'}
        </button>
        {preview && (
          <p className="mt-1" role="status">
            <span className="tabular-nums">{formatSpend(totals.listUsd, totals.approximate)}</span> if every call in
            this period were billed at list price, with no subscription fees.
          </p>
        )}
      </div>
    </section>
  )
}
