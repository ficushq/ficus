import { workStreamNeedsHumanAttention, workStreamWaitNeedsHuman, type WorkStream } from '@ficus/shared'

/**
 * Running executions still accruing time. Older servers send only
 * `activeCount`, which also counts sandbox waits.
 */
function workingCount(ws: WorkStream): number {
  return ws.runtime?.workingCount ?? ws.runtime?.activeCount ?? 0
}

/**
 * Time worked on a work stream, in ms: the summed duration of the executions
 * that did its work, as computed by Core (`workStreamRuntimesSql`). Nothing
 * accrues while no agent is executing, so a stream parked on a review or a
 * question stops counting, and an execution left open stops at its last sign
 * of activity.
 *
 * While executions are working, extrapolates from the backend-computed total
 * using the supplied `now` timestamp.
 */
export function computeWorkStreamElapsedMs(ws: WorkStream, now: number): number {
  const rt = ws.runtime
  if (!rt) return 0
  const working = workingCount(ws)
  if (working <= 0) return rt.totalMs
  const computedAt = new Date(rt.computedAt).getTime()
  const delta = Math.max(0, now - computedAt)
  return rt.totalMs + working * delta
}

/** Tooltip/definition shared by every surface that shows time worked. */
export const TIME_WORKED_DEFINITION = 'Time worked: total time agents spent executing on this work stream'

/** "45s", "12m", "3h 5m", "7d 2h": the two largest units, for time worked. */
export function formatWorkStreamDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  if (hours < 24) return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`
  const days = Math.floor(hours / 24)
  const remainingHours = hours % 24
  return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`
}

/** "<1m", "12m", "3h", "7d": one coarse unit, for how long a person has been waited on. */
export function formatWaitedDuration(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000)
  if (minutes < 1) return '<1m'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

/**
 * When the stream started waiting on a person: the oldest open wait that asks
 * a human to act (a question, an actionable review, or a human blocker).
 * Null when nobody is being waited on — including paused or finished streams,
 * and delivery states that carry no open wait to date them from.
 */
export function workStreamWaitingOnPersonSince(ws: WorkStream): Date | null {
  if (!workStreamNeedsHumanAttention(ws)) return null
  let oldest: number | null = null
  for (const wait of ws.openWaits ?? []) {
    if (!workStreamWaitNeedsHuman(wait, ws)) continue
    const openedAt = new Date(wait.openedAt).getTime()
    if (!Number.isFinite(openedAt)) continue
    if (oldest === null || openedAt < oldest) oldest = openedAt
  }
  return oldest === null ? null : new Date(oldest)
}

export type WorkStreamTimeDisplay =
  | { kind: 'waiting'; text: string; title: string; waitingMs: number; workedMs: number }
  | { kind: 'worked'; text: string; title: string; workedMs: number }

/**
 * The one time a work stream row shows. While a person is being waited on,
 * how long they have been waited on ("Waiting on you 7d") replaces time worked,
 * which stays in the tooltip; otherwise time worked, once it passes a second.
 */
export function workStreamTimeDisplay(ws: WorkStream, now: number): WorkStreamTimeDisplay | null {
  const workedMs = computeWorkStreamElapsedMs(ws, now)
  const waitingSince = workStreamWaitingOnPersonSince(ws)
  if (waitingSince) {
    const waitingMs = Math.max(0, now - waitingSince.getTime())
    const since = waitingSince.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
    return {
      kind: 'waiting',
      text: `Waiting on you ${formatWaitedDuration(waitingMs)}`,
      title: `Waiting on you since ${since}. Time worked: ${formatWorkStreamDuration(workedMs)}`,
      waitingMs,
      workedMs,
    }
  }
  if (workedMs <= 1000) return null
  return { kind: 'worked', text: formatWorkStreamDuration(workedMs), title: TIME_WORKED_DEFINITION, workedMs }
}

/**
 * How often a row's time needs re-rendering: every second while an execution
 * runs, every minute while a person is waited on, otherwise never.
 */
export function workStreamTimeTickMs(ws: WorkStream): number | null {
  if (workingCount(ws) > 0) return 1000
  if (workStreamWaitingOnPersonSince(ws)) return 60_000
  return null
}
