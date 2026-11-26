import {
  ACTIVITY_SETTLED_KINDS,
  activitySettledCountLabel,
  type ActivitySettledFilter,
  type ActivitySettledKind,
  type ActivitySettledSummary,
} from '@ficus/shared'

const DAY_MS = 86_400_000

/** Local calendar days between two instants (0 = same day). */
function calendarDaysBetween(earlier: Date, later: Date): number {
  const start = new Date(earlier.getFullYear(), earlier.getMonth(), earlier.getDate())
  const end = new Date(later.getFullYear(), later.getMonth(), later.getDate())
  return Math.round((end.getTime() - start.getTime()) / DAY_MS)
}

/** "Since earlier today", "Since yesterday", "Since Monday", "Since Oct 27". */
export function settledPeriodLabel(since: string, now = new Date()): string {
  const start = new Date(since)
  const days = calendarDaysBetween(start, now)
  if (days <= 0) return 'Since earlier today'
  if (days === 1) return 'Since yesterday'
  if (days < 7) return `Since ${start.toLocaleDateString(undefined, { weekday: 'long' })}`
  return `Since ${start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
}

/** Activity filtered to exactly the rows behind one count, in the same squads. */
export function settledActivityHref(kind: ActivitySettledKind, since: string, squadIds: readonly string[]): string {
  const params = new URLSearchParams({ settled: kind, since })
  for (const squadId of [...new Set(squadIds)].sort()) params.append('squad', squadId)
  return `/activity?${params.toString()}`
}

/** The counts the line shows, in order; zero counts are left out. */
export function settledLineParts(summary: ActivitySettledSummary | null | undefined) {
  if (!summary?.counts) return []
  return ACTIVITY_SETTLED_KINDS.flatMap((kind) => {
    const count = summary.counts[kind]
    return Number.isInteger(count) && count > 0 ? [{ kind, count, label: activitySettledCountLabel(kind, count) }] : []
  })
}

/** Activity's banner title for one settled filter. */
export const SETTLED_FILTER_TITLES: Record<ActivitySettledKind, string> = {
  questions: 'Questions settled by managers',
  reviews: 'Reviews done by agents',
  completed: 'Streams completed',
}

/**
 * The Feed's settled counts link to Activity as `?settled=<kind>&since=<ISO>&squad=<id>`: the rows
 * behind one count, in the same squads. Anything malformed is ignored, so the page shows everything.
 */
export function parseSettledActivityParams(params: URLSearchParams): {
  settled?: ActivitySettledFilter
  squadIds: string[]
} {
  const kind = params.get('settled')
  const since = params.get('since')
  const sinceDate = since ? new Date(since) : null
  if (
    !kind ||
    !ACTIVITY_SETTLED_KINDS.includes(kind as ActivitySettledKind) ||
    !sinceDate ||
    isNaN(sinceDate.valueOf())
  )
    return { squadIds: [] }
  return {
    settled: { kind: kind as ActivitySettledKind, since: sinceDate.toISOString() },
    squadIds: [...new Set(params.getAll('squad'))].sort(),
  }
}
