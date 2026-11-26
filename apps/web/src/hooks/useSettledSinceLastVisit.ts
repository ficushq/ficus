import { useEffect, useRef } from 'react'
import type { ActivitySettledSummary } from '@ficus/shared'
import { useQuery } from '../reactQueryHooks'
import { acknowledgeFeedVisit } from '../api/auth'
import { feedQueries } from '../queryOptions'

/**
 * The account's last Feed visit, read once per Feed mount, and the work settled without a person
 * since then. The visit is recorded (at the server time of the read) only after the counts loaded,
 * so a failed load keeps the older start for next time. No watermark yet means no line.
 */
export function useSettledSinceLastVisit(
  userId: string,
  visitId: string,
  squadIds: readonly string[],
  acknowledgeVisit: typeof acknowledgeFeedVisit = acknowledgeFeedVisit
): ActivitySettledSummary | null {
  const visit = useQuery(feedQueries.visit(userId, visitId))
  const since = visit.data?.lastVisitedAt ?? null
  const settled = useQuery({ ...feedQueries.settled(userId, since ?? '', squadIds), enabled: since !== null })
  const loaded = visit.isSuccess && (since === null || settled.isSuccess)
  const observedAt = visit.data?.observedAt
  const recorded = useRef(false)
  useEffect(() => {
    if (recorded.current || !loaded || !observedAt) return
    recorded.current = true
    // A lost write only keeps the older start for the next visit; nothing is shown or hidden by it.
    void acknowledgeVisit(observedAt).catch(() => {})
  }, [loaded, observedAt, acknowledgeVisit])
  const summary = settled.data as ActivitySettledSummary | undefined
  return since !== null && summary?.counts ? summary : null
}
