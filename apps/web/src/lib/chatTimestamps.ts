/**
 * Pure time, grouping and day-divider helpers for the chat transcript.
 *
 * Times are local clock times (never relative), shown once per group: a group is
 * a run of consecutive messages of the same kind and sender, each within
 * GROUP_WINDOW_MS of the previous one, on the same local calendar day.
 */

/** Consecutive messages further apart than this start a new group. */
export const GROUP_WINDOW_MS = 5 * 60 * 1000

/** A persisted message's time, or null when it has none (optimistic/streaming items) or it is invalid. */
export function toMessageDate(value: Date | string | number | null | undefined): Date | null {
  if (value == null || value === '') return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

/** The earliest valid time among several (a reply merged from several rows uses its first). */
export function earliestMessageDate(values: Array<Date | string | number | null | undefined>): Date | null {
  let earliest: Date | null = null
  for (const value of values) {
    const date = toMessageDate(value)
    if (date && (!earliest || date.getTime() < earliest.getTime())) earliest = date
  }
  return earliest
}

/** Clock time for the group-head meta line, e.g. `3:42 PM`. */
export function messageTimeLabel(date: Date): string {
  return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

/** Full date and time for the hover tooltip, e.g. `Tue, Sep 29, 2026, 3:42:10 PM`. */
export function fullTimestamp(date: Date): string {
  return date.toLocaleString(undefined, {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  })
}

/** Stable key for a local calendar day. */
export function localDayKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`
}

export function isSameLocalDay(a: Date, b: Date): boolean {
  return localDayKey(a) === localDayKey(b)
}

/** Day divider label: `Today`, `Yesterday`, `Sep 28`, or `Sep 28, 2025` outside the current year. */
export function dayLabel(date: Date, now: Date): string {
  if (isSameLocalDay(date, now)) return 'Today'
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
  if (isSameLocalDay(date, yesterday)) return 'Yesterday'
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  })
}

/** One human or agent message as the grouping sees it. */
export interface TimestampGroupEntry {
  kind: 'human' | 'agent'
  /** Sender identity within the kind (human: `metadata.sender.userId`; absent sender is null). */
  senderKey: string | null
  at: Date | null
}

/**
 * Does `next` start a new group after `prev`? A missing previous entry (start of
 * the transcript or after a reset), a kind or sender change, a missing time, a
 * local day change, or a gap over five minutes each start a new group.
 */
export function startsGroup(prev: TimestampGroupEntry | null, next: TimestampGroupEntry): boolean {
  if (!prev) return true
  if (prev.kind !== next.kind || prev.senderKey !== next.senderKey) return true
  if (!prev.at || !next.at) return true
  if (!isSameLocalDay(prev.at, next.at)) return true
  // Absolute: human rows may be ordered by consumption time, not creation time.
  return Math.abs(next.at.getTime() - prev.at.getTime()) > GROUP_WINDOW_MS
}
