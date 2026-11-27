/**
 * Planning for motion on live list changes (LiveListMotion): which rows slide to a new place, which
 * arrived, and whose status changed. Pure, so the rules are testable without a layout engine.
 */

export const LIVE_ROW_ATTRIBUTE = 'data-live-row'
export const LIVE_STATUS_ATTRIBUTE = 'data-live-status'
export const LIVE_EMPHASIS_ATTRIBUTE = 'data-live-emphasis'

/**
 * Marks a row for LiveListMotion. `status` is what the row's status badge says; a change to it
 * emphasizes the row's `liveEmphasisProps` element. The row must be positioned (`relative`) and
 * rounded like its hover fill, so the arrival wash fits it.
 */
export function liveRowProps(key: string, status?: string | null): Record<string, string> {
  return status == null ? { [LIVE_ROW_ATTRIBUTE]: key } : { [LIVE_ROW_ATTRIBUTE]: key, [LIVE_STATUS_ATTRIBUTE]: status }
}

/** Marks the element inside a row that gets the brief emphasis when the row's status changes. */
export const liveEmphasisProps = { [LIVE_EMPHASIS_ATTRIBUTE]: '' } as const

/** A row as measured just before a commit. */
export interface LiveRowBefore {
  top: number
  left: number
  status: string | null
}

/** A row's identity: its key and the status it shows, if any. */
export interface LiveRowIdentity {
  key: string
  status: string | null
}

/** A row as measured just after the same commit. */
export interface LiveRowAfter extends LiveRowIdentity {
  top: number
  left: number
  /** Whether the row's new place is within the viewport (moves off screen are not animated). */
  visible: boolean
}

export interface LiveMove {
  key: string
  dx: number
  dy: number
}

export interface LiveMotionPlan {
  moves: LiveMove[]
  arrivals: string[]
  statusChanges: string[]
}

/** About 300 ms: long enough to follow a row to its new place, short enough not to wait for it. */
export const LIVE_MOVE_DURATION_MS = 300
export const LIVE_MOVE_EASING = 'cubic-bezier(0.2, 0, 0, 1)'

/**
 * More rows than this arriving in one update is a reload (a page of results, a refetch after a
 * filter change), not a live change, so nothing animates.
 */
export const LIVE_MAX_ARRIVALS = 6

const EMPTY_PLAN: LiveMotionPlan = { moves: [], arrivals: [], statusChanges: [] }

/** True when the rows' order, membership and statuses are unchanged. */
export function sameLiveRows(before: ReadonlyMap<string, LiveRowBefore>, after: readonly LiveRowIdentity[]): boolean {
  if (before.size !== after.length) return false
  let index = 0
  for (const [key, row] of before) {
    const next = after[index++]
    if (!next || next.key !== key || next.status !== row.status) return false
  }
  return true
}

export function planLiveListMotion(
  before: ReadonlyMap<string, LiveRowBefore>,
  after: readonly LiveRowAfter[],
  {
    maxArrivals = LIVE_MAX_ARRIVALS,
    maxDistance = Number.POSITIVE_INFINITY,
  }: {
    maxArrivals?: number
    /** A row coming from far away starts at most this far from its new place (the viewport height). */
    maxDistance?: number
  } = {}
): LiveMotionPlan {
  if (sameLiveRows(before, after)) return EMPTY_PLAN
  const arrivals = after.filter((row) => !before.has(row.key)).map((row) => row.key)
  if (arrivals.length > maxArrivals) return EMPTY_PLAN

  const moves: LiveMove[] = []
  const statusChanges: string[] = []
  for (const row of after) {
    const previous = before.get(row.key)
    if (!previous) continue
    if (previous.status !== null && row.status !== null && previous.status !== row.status) statusChanges.push(row.key)
    const dx = clamp(previous.left - row.left, maxDistance)
    const dy = clamp(previous.top - row.top, maxDistance)
    if (row.visible && (Math.abs(dx) >= 1 || Math.abs(dy) >= 1)) moves.push({ key: row.key, dx, dy })
  }
  return { moves, arrivals, statusChanges }
}

function clamp(delta: number, limit: number): number {
  return Math.max(-limit, Math.min(limit, delta))
}
