import {
  TIME_WORKED_DEFINITION,
  computeWorkStreamElapsedMs,
  formatWaitedDuration,
  formatWorkStreamDuration,
  workStreamPersonWait,
  type WorkStream,
  type WorkStreamViewer,
} from '@ficus/shared'

export type WorkStreamTimeDisplay =
  | { kind: 'waiting'; text: string; title: string; waitingMs: number; workedMs: number }
  | { kind: 'worked'; text: string; title: string; workedMs: number }

/**
 * The one time a work stream row shows, built on the shared time-worked and person-wait rules in
 * `@ficus/shared`. While a person is being waited on, how long ("Waiting on you 7d", or "Waiting
 * on review 7d" to someone who cannot act on it) replaces time worked, which stays in the tooltip;
 * otherwise time worked, once it passes a second.
 */
export function workStreamTimeDisplay(
  ws: WorkStream,
  now: number,
  viewer?: WorkStreamViewer
): WorkStreamTimeDisplay | null {
  const workedMs = computeWorkStreamElapsedMs(ws, now)
  const waiting = workStreamPersonWait(ws, viewer)
  if (waiting) {
    const waitingMs = Math.max(0, now - waiting.since.getTime())
    const since = waiting.since.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
    return {
      kind: 'waiting',
      text: `${waiting.label} ${formatWaitedDuration(waitingMs)}`,
      title: `${waiting.label} since ${since}. Time worked: ${formatWorkStreamDuration(workedMs)}`,
      waitingMs,
      workedMs,
    }
  }
  if (workedMs <= 1000) return null
  return { kind: 'worked', text: formatWorkStreamDuration(workedMs), title: TIME_WORKED_DEFINITION, workedMs }
}
