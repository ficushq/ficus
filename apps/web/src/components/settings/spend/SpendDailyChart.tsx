import type { SpendSeriesPoint } from '@ficus/shared'
import { daysInRange, formatUsd } from './spendUi'

const HEIGHT = 120
/** Share of each day's slot the bar fills, leaving a gap between days. */
const BAR_FILL = 0.8

/**
 * Billed spend per UTC day as bars. With the preview on, each day also shows its list-price equivalent as
 * a faint bar behind it. Colors come from theme text tokens via currentColor.
 */
export function SpendDailyChart({
  series,
  from,
  to,
  showList = false,
}: {
  series: SpendSeriesPoint[]
  from: string
  to: string
  showList?: boolean
}) {
  const byDay = new Map(series.map((point) => [point.day, point]))
  const days = daysInRange(from, to)
  const max = Math.max(
    0,
    ...series.map((point) => (showList ? Math.max(point.billedUsd, point.listUsd) : point.billedUsd))
  )
  if (days.length === 0) return null
  const total = series.reduce((sum, point) => sum + point.billedUsd, 0)
  const busiest = series.reduce<SpendSeriesPoint | undefined>(
    (best, point) => (!best || point.billedUsd > best.billedUsd ? point : best),
    undefined
  )
  const width = 100 / days.length
  const scale = (usd: number) => (max > 0 ? (usd / max) * HEIGHT : 0)
  return (
    <figure className="space-y-1">
      <svg
        role="img"
        aria-label={
          max > 0
            ? `Daily spend, ${days.length} days, ${formatUsd(total)} billed${busiest ? `; highest ${formatUsd(busiest.billedUsd)} on ${busiest.day}` : ''}`
            : `Daily spend, ${days.length} days, no spend`
        }
        viewBox={`0 0 100 ${HEIGHT}`}
        preserveAspectRatio="none"
        className="h-32 w-full text-accent"
      >
        {days.map((day, index) => {
          const point = byDay.get(day)
          const billed = scale(point?.billedUsd ?? 0)
          const list = showList ? scale(point?.listUsd ?? 0) : 0
          const x = index * width
          const barWidth = width * BAR_FILL
          return (
            <g key={day} data-day={day}>
              <title>
                {`${day}: ${formatUsd(point?.billedUsd ?? 0)} billed${showList ? `, ${formatUsd(point?.listUsd ?? 0)} at list price` : ''}, ${(point?.calls ?? 0).toLocaleString('en-US')} calls`}
              </title>
              {list > 0 && (
                <rect x={x} y={HEIGHT - list} width={barWidth} height={list} fill="currentColor" opacity={0.25} />
              )}
              <rect x={x} y={HEIGHT - billed} width={barWidth} height={billed} fill="currentColor" />
            </g>
          )
        })}
      </svg>
      <figcaption className="flex justify-between text-xs text-muted">
        <span>{days[0]}</span>
        {max > 0 ? <span>Peak {formatUsd(max)} a day</span> : <span>No spend in this period</span>}
        <span>{days[days.length - 1]}</span>
      </figcaption>
    </figure>
  )
}
