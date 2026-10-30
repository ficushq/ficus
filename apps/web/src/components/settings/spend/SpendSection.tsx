import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { SPEND_DIMENSION_FILTER, type SpendDimension, type SpendFilters } from '@ficus/shared'
import { usePermissions } from '../../../hooks/usePermissions'
import { queries } from '../../../queryOptions'
import { SegmentedControl } from '../../SegmentedControl'
import { SpendBreakdownTable } from './SpendBreakdownTable'
import { SpendDailyChart } from './SpendDailyChart'
import { SpendRetentionSetting } from './SpendRetentionSetting'
import { SpendTotals } from './SpendTotals'
import { SubscriptionAccounts } from './SubscriptionAccounts'
import { DIMENSION_LABELS, periodRange, SPEND_PERIOD_LABELS, SPEND_PERIODS, utcDay, type SpendPeriod } from './spendUi'

type ActiveFilters = Partial<Record<SpendDimension, { key: string | null; label: string }>>

function toQueryFilters(active: ActiveFilters): SpendFilters {
  const filters: SpendFilters = {}
  for (const [dimension, value] of Object.entries(active) as Array<[SpendDimension, { key: string | null }]>) {
    // An empty value asks for calls with no value (no squad, no agent, ...).
    ;(filters as Record<string, string>)[SPEND_DIMENSION_FILTER[dimension]] = value.key ?? ''
  }
  return filters
}

/** Settings → Spend: what model usage costs, from the inference cost ledger. Needs usage:read. */
export function SpendSection() {
  const { can } = usePermissions()
  const [period, setPeriod] = useState<SpendPeriod>('30d')
  const today = utcDay(Date.now())
  const [custom, setCustom] = useState({ from: today, to: today })
  const [active, setActive] = useState<ActiveFilters>({})
  const [by, setBy] = useState<SpendDimension>('feature')
  const [by2, setBy2] = useState<SpendDimension | undefined>(undefined)
  const [preview, setPreview] = useState(false)

  const range = useMemo(
    () => periodRange(period, new Date(`${today}T12:00:00Z`), custom),
    // Recomputed per UTC day, so query keys stay stable within a day.
    [period, today, custom]
  )
  const query = useMemo(() => ({ ...range, filters: toQueryFilters(active) }), [range, active])
  const summary = useQuery(queries.spend.summary(query))
  const breakdown = useQuery(queries.spend.breakdown({ ...query, by, by2, limit: 50 }))
  const topWorkStreams = useQuery(queries.spend.breakdown({ ...query, by: 'workStream', limit: 5 }))
  const topAgents = useQuery(queries.spend.breakdown({ ...query, by: 'agent', limit: 5 }))

  const addFilter = (dimension: SpendDimension, key: string | null, label?: string) =>
    setActive((current) => ({ ...current, [dimension]: { key, label: label ?? key ?? 'none' } }))
  const filterFrom = (source: typeof breakdown.data) => (dimension: SpendDimension, key: string | null) => {
    if (!source) return addFilter(dimension, key)
    const first = dimension === source.by
    const row = source.rows.find((candidate) => (first ? candidate.key : candidate.key2) === key)
    addFilter(dimension, key, first ? row?.label : row?.label2)
  }

  const periodLabel = period === 'custom' ? `${custom.from} – ${custom.to}` : SPEND_PERIOD_LABELS[period].toLowerCase()

  return (
    // min-w-0 throughout: nothing on this page may widen it past a phone's viewport. Wide tables scroll inside
    // their own container instead.
    <section className="min-w-0 space-y-6" aria-labelledby="spend-heading">
      <div className="space-y-1">
        <h2 id="spend-heading" className="text-lg font-semibold text-primary">
          Spend
        </h2>
        <p className="text-sm text-secondary">
          What model calls cost across this instance, by squad, work stream, agent, person, feature, model and account.
          Subscription fees count as their own line.
        </p>
      </div>

      <div className="flex min-w-0 flex-wrap items-center gap-3">
        {/* On a phone the six periods are wider than the screen: they wrap inside their tray. */}
        <SegmentedControl
          ariaLabel="Period"
          size="compact"
          className="max-w-full flex-wrap"
          options={SPEND_PERIODS.map((value) => ({ value, label: SPEND_PERIOD_LABELS[value] }))}
          value={period}
          onChange={setPeriod}
        />
        {period === 'custom' && (
          <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
            <label className="flex items-center gap-1">
              <span className="text-secondary">From</span>
              <input
                type="date"
                className="ficus-field px-2 py-1"
                value={custom.from}
                max={custom.to}
                onChange={(event) => event.target.value && setCustom((c) => ({ ...c, from: event.target.value }))}
              />
            </label>
            <label className="flex items-center gap-1">
              <span className="text-secondary">to</span>
              <input
                type="date"
                className="ficus-field px-2 py-1"
                value={custom.to}
                min={custom.from}
                onChange={(event) => event.target.value && setCustom((c) => ({ ...c, to: event.target.value }))}
              />
            </label>
          </div>
        )}
      </div>

      {Object.keys(active).length > 0 && (
        <div className="flex flex-wrap items-center gap-2" aria-label="Filters">
          {(Object.entries(active) as Array<[SpendDimension, { label: string }]>).map(([dimension, value]) => (
            <span
              key={dimension}
              className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-full border border-th-border px-2 py-0.5 text-xs text-primary"
            >
              <span className="min-w-0 break-words">
                {DIMENSION_LABELS[dimension]}: {value.label}
              </span>
              <button
                type="button"
                className="ficus-button ficus-button-ghost px-1 text-xs"
                aria-label={`Remove the ${DIMENSION_LABELS[dimension]} filter`}
                onClick={() =>
                  setActive((current) => {
                    const next = { ...current }
                    delete next[dimension]
                    return next
                  })
                }
              >
                ✕
              </button>
            </span>
          ))}
          <button
            type="button"
            className="ficus-button ficus-button-ghost px-2 py-0.5 text-xs"
            onClick={() => setActive({})}
          >
            Clear filters
          </button>
        </div>
      )}

      {summary.isError ? (
        <p role="alert" className="text-sm text-status-danger-400">
          {summary.error.message}
        </p>
      ) : !summary.data ? (
        <p className="text-sm text-muted">Loading spend…</p>
      ) : (
        <>
          <SpendTotals
            summary={summary.data}
            periodLabel={periodLabel}
            preview={preview}
            onPreviewChange={setPreview}
          />
          <SpendDailyChart series={summary.data.series} from={range.from} to={range.to} showList={preview} />
        </>
      )}

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <SpendBreakdownTable
          title="Top work streams"
          breakdown={topWorkStreams.data}
          loading={topWorkStreams.isPending}
          showList={false}
          onFilter={filterFrom(topWorkStreams.data)}
        />
        <SpendBreakdownTable
          title="Top agents"
          breakdown={topAgents.data}
          loading={topAgents.isPending}
          showList={false}
          onFilter={filterFrom(topAgents.data)}
        />
      </div>

      <div data-setting-target="spend-breakdown">
        <SpendBreakdownTable
          title="Breakdown"
          breakdown={breakdown.data}
          loading={breakdown.isPending}
          showList={preview}
          by={by}
          by2={by2}
          onByChange={(next) => {
            setBy(next)
            if (by2 === next) setBy2(undefined)
          }}
          onBy2Change={setBy2}
          onFilter={filterFrom(breakdown.data)}
        />
      </div>

      {summary.data && (
        <SubscriptionAccounts
          subscriptions={summary.data.subscriptions}
          feesIncluded={summary.data.meta.feesIncluded}
          canWrite={can('provider-auth:write')}
        />
      )}

      {summary.data && can('settings:write') && <SpendRetentionSetting days={summary.data.meta.retentionDays} />}
    </section>
  )
}
