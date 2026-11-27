import { useEffect, useRef, useState } from 'react'
import type { ActivitySettledSummary } from '@ficus/shared'
import { useQuery } from '../reactQueryHooks'
import { acknowledgeFeedVisit, type FeedVisit } from '../api/auth'
import { feedQueries } from '../queryOptions'

/** A visit ends after this long away from the tab, the usual web analytics session timeout. */
export const FEED_VISIT_IDLE_MS = 30 * 60_000

const VISIT_KEY_PREFIX = 'ficus:feed-visit:'
/** When the tab was last hidden, while it still is (or was when the page unloaded). */
export const FEED_VISIT_HIDDEN_KEY = 'ficus:feed-visit-hidden-at'

/** This tab's visit: the period start read when it began, and whether it was recorded yet. */
export interface SessionFeedVisit extends FeedVisit {
  recorded: boolean
}

function sessionStore(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage
  } catch {
    return null
  }
}

function endSessionVisits(store: Storage) {
  for (let index = store.length - 1; index >= 0; index--) {
    const key = store.key(index)
    if (key?.startsWith(VISIT_KEY_PREFIX)) store.removeItem(key)
  }
}

/**
 * The visit this tab already started for `userId`, so leaving the Feed for Activity and coming back
 * keeps the same period. A tab away for longer than FEED_VISIT_IDLE_MS starts a new visit.
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
    const value = JSON.parse(store.getItem(VISIT_KEY_PREFIX + userId) ?? 'null') as Partial<SessionFeedVisit> | null
    if (
      !value ||
      typeof value.observedAt !== 'string' ||
      (value.lastVisitedAt !== null && typeof value.lastVisitedAt !== 'string') ||
      typeof value.recorded !== 'boolean'
    )
      return null
    return { lastVisitedAt: value.lastVisitedAt, observedAt: value.observedAt, recorded: value.recorded }
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
      // Storage refused: the visit simply lasts until the tab closes.
    }
  })
}

/**
 * The account's last Feed visit and the work settled without a person since then. A visit lasts
 * for the tab session (until the tab closes or has been away for FEED_VISIT_IDLE_MS), so following
 * a count to Activity and coming back keeps every count. The account watermark is read once when a
 * visit begins and recorded (at the server time of that read) only after the counts loaded, so a
 * failed load keeps the older start for next time. No watermark yet means no line.
 */
export function useSettledSinceLastVisit(
  userId: string,
  visitId: string,
  squadIds: readonly string[],
  acknowledgeVisit: typeof acknowledgeFeedVisit = acknowledgeFeedVisit
): ActivitySettledSummary | null {
  const [stored] = useState(() => readSessionFeedVisit(userId))
  useEffect(() => {
    if (typeof document !== 'undefined') trackTimeAway(document)
  }, [])
  const visit = useQuery({ ...feedQueries.visit(userId, visitId), enabled: !stored })
  const read = !stored && visit.isSuccess ? visit.data : undefined
  useEffect(() => {
    if (read) writeSessionFeedVisit(userId, { ...read, recorded: false })
  }, [read, userId])
  const snapshot = stored ?? read
  const since = snapshot?.lastVisitedAt ?? null
  const settled = useQuery({ ...feedQueries.settled(userId, since ?? '', squadIds), enabled: since !== null })
  const loaded = !!snapshot && (since === null || settled.isSuccess)
  const recorded = useRef(stored?.recorded ?? false)
  useEffect(() => {
    if (recorded.current || !loaded || !snapshot) return
    recorded.current = true
    const { lastVisitedAt, observedAt } = snapshot
    // A lost write only keeps the older start for the next visit; nothing is shown or hidden by it.
    void acknowledgeVisit(observedAt).then(
      () => writeSessionFeedVisit(userId, { lastVisitedAt, observedAt, recorded: true }),
      () => {}
    )
  }, [loaded, snapshot, acknowledgeVisit, userId])
  const summary = settled.data as ActivitySettledSummary | undefined
  return since !== null && summary?.counts ? summary : null
}
