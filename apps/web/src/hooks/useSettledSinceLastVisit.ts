import { useEffect, useRef, useState } from 'react'
import { ACTIVITY_SETTLED_MARGIN_MS, type ActivitySettledSummary } from '@ficus/shared'
import { useQuery } from '../reactQueryHooks'
import { acknowledgeFeedVisit, type FeedVisit } from '../api/auth'
import { feedQueries } from '../queryOptions'
import { useAdjustOnChange } from './useAdjustOnChange'

/** A visit ends after this long away from the tab, the usual web analytics session timeout. */
export const FEED_VISIT_IDLE_MS = 30 * 60_000
/**
 * A visit also ends this long after it began, even in a window that never leaves the screen (as a
 * Desktop window usually doesn't): about a working day, so a window left open overnight starts a new
 * visit by morning, and a whole day of checking in stays one visit.
 */
export const FEED_VISIT_MAX_MS = 8 * 60 * 60_000

const VISIT_KEY_PREFIX = 'ficus:feed-visit:'
/** How often a mounted Feed checks its visit: a timer for the full age would pause while the device sleeps. */
const FEED_VISIT_CHECK_MS = 60_000

/** When the tab was last hidden, while it still is (or was when the page unloaded). */
export const FEED_VISIT_HIDDEN_KEY = 'ficus:feed-visit-hidden-at'

/** This tab's visit: the period read when it began, when it began here, and how far it was recorded. */
export interface SessionFeedVisit extends FeedVisit {
  /** This client's clock when the visit began, for FEED_VISIT_MAX_MS (the server's clock may differ). */
  startedAt: number
  /** The latest time recorded as this visit's end, or null before the first record. */
  recordedThrough: string | null
}

function sessionStore(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage
  } catch {
    return null
  }
}

function endSessionVisits(store: Storage | null = sessionStore()) {
  if (!store) return
  try {
    for (let index = store.length - 1; index >= 0; index--) {
      const key = store.key(index)
      if (key?.startsWith(VISIT_KEY_PREFIX)) store.removeItem(key)
    }
  } catch {
    // Storage refused: the stored visit is ignored once it is too old anyway.
  }
}

/** Past the maximum age. A clock moved back by more than that counts too, so a visit cannot get stuck. */
function visitTooOld(startedAt: number, now: number) {
  return Math.abs(now - startedAt) > FEED_VISIT_MAX_MS
}

function parseSessionFeedVisit(raw: string | null): SessionFeedVisit | null {
  const value = JSON.parse(raw ?? 'null') as Partial<SessionFeedVisit> | null
  if (
    !value ||
    typeof value.observedAt !== 'string' ||
    (value.lastVisitedAt !== null && typeof value.lastVisitedAt !== 'string') ||
    typeof value.startedAt !== 'number' ||
    (value.recordedThrough !== null && typeof value.recordedThrough !== 'string')
  )
    return null
  return {
    lastVisitedAt: value.lastVisitedAt,
    observedAt: value.observedAt,
    startedAt: value.startedAt,
    recordedThrough: value.recordedThrough,
  }
}

/**
 * The visit this tab already started for `userId`, so leaving the Feed for Activity and coming back
 * keeps the same period. A tab away for longer than FEED_VISIT_IDLE_MS, or a visit older than
 * FEED_VISIT_MAX_MS, starts a new visit.
 */
export function readSessionFeedVisit(userId: string, now = Date.now()): SessionFeedVisit | null {
  const store = sessionStore()
  if (!store) return null
  try {
    const hiddenAt = Number(store.getItem(FEED_VISIT_HIDDEN_KEY))
    if (hiddenAt && now - hiddenAt > FEED_VISIT_IDLE_MS) {
      endSessionVisits(store)
      return null
    }
    const visit = parseSessionFeedVisit(store.getItem(VISIT_KEY_PREFIX + userId))
    if (visit && visitTooOld(visit.startedAt, now)) {
      store.removeItem(VISIT_KEY_PREFIX + userId)
      return null
    }
    return visit
  } catch {
    return null
  }
}

function writeSessionFeedVisit(userId: string, visit: SessionFeedVisit) {
  try {
    sessionStore()?.setItem(VISIT_KEY_PREFIX + userId, JSON.stringify(visit))
  } catch {
    // Without session storage each Feed open is its own visit, as before.
  }
}

/** Note a recorded end on the stored visit, unless that visit has since been replaced. */
function markSessionVisitRecorded(userId: string, observedAt: string, through: string) {
  try {
    const visit = parseSessionFeedVisit(sessionStore()?.getItem(VISIT_KEY_PREFIX + userId) ?? null)
    if (!visit || visit.observedAt !== observedAt) return
    if (visit.recordedThrough && Date.parse(visit.recordedThrough) >= Date.parse(through)) return
    writeSessionFeedVisit(userId, { ...visit, recordedThrough: through })
  } catch {
    // Unreadable storage: the next Feed mount records the same end again, which changes nothing.
  }
}

/** A server time less the counts' margin; an unreadable time is kept as it is. */
function beforeMargin(time: string) {
  const at = Date.parse(time)
  return Number.isNaN(at) ? time : new Date(at - ACTIVITY_SETTLED_MARGIN_MS).toISOString()
}

const trackedDocuments = new WeakSet<Document>()

/** Note when the tab is hidden; coming back after the idle timeout ends this tab's visit. */
function trackTimeAway(doc: Document) {
  if (trackedDocuments.has(doc)) return
  trackedDocuments.add(doc)
  doc.addEventListener('visibilitychange', () => {
    const store = sessionStore()
    if (!store) return
    try {
      if (doc.visibilityState === 'hidden') {
        store.setItem(FEED_VISIT_HIDDEN_KEY, String(Date.now()))
        return
      }
      const hiddenAt = Number(store.getItem(FEED_VISIT_HIDDEN_KEY))
      store.removeItem(FEED_VISIT_HIDDEN_KEY)
      if (hiddenAt && Date.now() - hiddenAt > FEED_VISIT_IDLE_MS) endSessionVisits(store)
    } catch {
      // Storage refused: the visit simply lasts until the tab closes or reaches its maximum age.
    }
  })
}

/**
 * The account's last Feed visit and the work settled without a person since then. A visit lasts
 * for the tab session, until the tab closes, has been away for FEED_VISIT_IDLE_MS, or the visit is
 * FEED_VISIT_MAX_MS old, so following a count to Activity and coming back keeps every count. A Feed
 * that stays mounted starts the new visit when the person comes back (the tab is shown again or the
 * window regains focus) or, on screen, when the visit reaches its maximum age. Until the new visit's
 * counts load, the previous line stays on screen, so the Updates section does not jump.
 *
 * The account watermark is read once when a visit begins. Each time the counts load, the visit
 * records their end (`through`, the server time they were counted up to) as the new watermark, so
 * the next visit starts exactly where this one's line stopped: work settled during a visit is either
 * in this visit's latest counts or in the next visit's, never both and never neither. A failed load
 * records nothing and keeps the older start for next time. No watermark yet means no line, and the
 * visit's start, less the same margin the counts keep (ACTIVITY_SETTLED_MARGIN_MS), is recorded as
 * the first watermark.
 *
 * The watermark belongs to the account, so only an unfiltered Feed records it. With a squad filter
 * on, the counts (and their `through`) cover only the filtered squads; recording them would move the
 * watermark past other squads' work, which no later line would then count. A filtered Feed still
 * shows its counts from the visit's period but records nothing. Turning the filter off loads the
 * unfiltered counts for the same period and records their end, as it would have from the start.
 */
export function useSettledSinceLastVisit(
  userId: string,
  visitId: string,
  squadIds: readonly string[],
  acknowledgeVisit: typeof acknowledgeFeedVisit = acknowledgeFeedVisit
): ActivitySettledSummary | null {
  // `stored` is the visit this tab already had when this mount (or this new visit) began.
  const [visit, setVisit] = useState(() => ({ generation: 0, stored: readSessionFeedVisit(userId) }))
  const read = useQuery({
    ...feedQueries.visit(userId, `${visitId}:${visit.generation}`),
    enabled: !visit.stored,
  })
  const snapshot: FeedVisit | undefined = visit.stored ?? (read.isSuccess ? read.data : undefined)
  const observedAt = snapshot?.observedAt
  const lastVisitedAt = snapshot?.lastVisitedAt ?? null
  const storedStart = visit.stored?.startedAt
  const storedThrough = visit.stored?.recordedThrough ?? null
  // When the visit on screen began on this client.
  const started = useRef<{ observedAt: string; at: number } | null>(null)
  useEffect(() => {
    if (!observedAt || started.current?.observedAt === observedAt) return
    if (storedStart !== undefined) {
      started.current = { observedAt, at: storedStart }
      return
    }
    started.current = { observedAt, at: Date.now() }
    writeSessionFeedVisit(userId, { lastVisitedAt, observedAt, startedAt: started.current.at, recordedThrough: null })
  }, [observedAt, lastVisitedAt, storedStart, userId])

  useEffect(() => {
    if (typeof document !== 'undefined') trackTimeAway(document)
  }, [])
  // Re-rendered when the day changes, so "Since earlier today" becomes "Since yesterday" on screen.
  const [, setDay] = useState(() => new Date().toDateString())
  // Coming back after the idle timeout, or to a visit past its maximum age, starts a new visit here.
  useEffect(() => {
    if (!observedAt || typeof document === 'undefined') return
    let hiddenAt: number | null = document.visibilityState === 'hidden' ? Date.now() : null
    const startedAt = () => (started.current?.observedAt === observedAt ? started.current.at : Date.now())
    const check = () => {
      const now = Date.now()
      setDay(new Date(now).toDateString())
      if (document.visibilityState === 'hidden') {
        hiddenAt ??= now
        return
      }
      const away = hiddenAt !== null && now - hiddenAt > FEED_VISIT_IDLE_MS
      hiddenAt = null
      if (!away && !visitTooOld(startedAt(), now)) return
      endSessionVisits()
      setVisit((current) => ({ generation: current.generation + 1, stored: null }))
    }
    const timer = window.setInterval(check, FEED_VISIT_CHECK_MS)
    document.addEventListener('visibilitychange', check)
    window.addEventListener('focus', check)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', check)
      window.removeEventListener('focus', check)
    }
  }, [observedAt])

  const since = lastVisitedAt
  const settled = useQuery({ ...feedQueries.settled(userId, since ?? '', squadIds), enabled: since !== null })
  const summary = since !== null && settled.isSuccess ? (settled.data as ActivitySettledSummary | undefined) : undefined
  // How far this visit has shown: the end of its latest counts or, with no earlier visit (so no
  // counts), its own start less the counts' margin.
  const through = !observedAt ? undefined : since === null ? beforeMargin(observedAt) : summary?.through
  // Only counts over every squad may move the account watermark.
  const unfiltered = squadIds.length === 0
  const recorded = useRef<{ observedAt: string; through: string } | null>(null)
  useEffect(() => {
    if (!unfiltered || !observedAt || !through) return
    const prior = recorded.current?.observedAt === observedAt ? recorded.current.through : storedThrough
    if (prior !== null && Date.parse(through) <= Date.parse(prior)) return
    recorded.current = { observedAt, through }
    // A lost write only keeps the older start for the next visit; nothing is shown or hidden by it.
    void acknowledgeVisit(through).then(
      () => markSessionVisitRecorded(userId, observedAt, through),
      () => {}
    )
  }, [unfiltered, observedAt, through, storedThrough, acknowledgeVisit, userId])
  const current = summary?.counts ? summary : null
  // Settled for this visit: its counts loaded or failed, or there is no period to count.
  const settledForVisit = !!observedAt && (since === null || settled.isSuccess || settled.isError)
  const [previous, setPrevious] = useState<ActivitySettledSummary | null>(null)
  useAdjustOnChange(
    [current, settledForVisit],
    () => {
      if (settledForVisit) setPrevious(current)
    },
    { onMount: true }
  )
  return settledForVisit ? current : previous
}
