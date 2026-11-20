import { and, asc, eq, gte, or, sql } from 'drizzle-orm'
import { db, linearAgentSessions } from '../../../db'
import { acknowledgeLinearSession, type LinearSessionRow } from './session-acknowledger'
import { postLinearSessionDisposition, storedLinearSessionDisposition } from './session-disposition'

/**
 * Recovery for sessions Ficus received but could not answer (design 5.7: a pending session gets the
 * acknowledgment and the disposition, however late). The delivery receipt is completed once a
 * session was routed, so a failed acknowledgment or disposition post is not redone by processing
 * the session again; the polling fallback retries it here instead, without routing it a second time.
 */

/** Sessions older than this are no longer retried. */
export const LINEAR_SESSION_RETRY_WINDOW_MS = 6 * 3_600_000
/** At most this many sessions are retried per connection and poll. */
export const LINEAR_SESSION_RETRY_LIMIT = 5

/**
 * Unfinished sessions of a connection that are due for another attempt: the disposition post
 * failed, or the acknowledgment failed and no disposition was ever posted. A session is due when
 * its last attempt is at least a minute old and at least a quarter of its age old, so attempts
 * thin out (about a dozen over the six-hour window) instead of repeating every poll.
 */
export async function listUnfinishedLinearSessions(
  connectionId: string,
  limit = LINEAR_SESSION_RETRY_LIMIT
): Promise<LinearSessionRow[]> {
  return db
    .select()
    .from(linearAgentSessions)
    .where(
      and(
        eq(linearAgentSessions.connectionId, connectionId),
        gte(linearAgentSessions.createdAt, sql`now() - (${LINEAR_SESSION_RETRY_WINDOW_MS} * interval '1 millisecond')`),
        or(
          eq(linearAgentSessions.dispositionState, 'failed'),
          and(sql`${linearAgentSessions.ackState} <> 'sent'`, eq(linearAgentSessions.dispositionState, 'pending'))
        ),
        sql`${linearAgentSessions.updatedAt} <= now() - greatest(interval '1 minute', (now() - ${linearAgentSessions.createdAt}) / 4)`
      )
    )
    .orderBy(asc(linearAgentSessions.createdAt))
    .limit(limit)
}

/**
 * One more attempt for an unfinished session: the acknowledgment first when it was never sent, then
 * the stored disposition when its post failed. A disposition is not posted while the
 * acknowledgment still fails, so Linear shows them in order. Returns whether the session is done.
 */
export async function retryLinearSession(row: LinearSessionRow, authorization: string): Promise<boolean> {
  let current = row
  if (current.ackState !== 'sent') {
    const acknowledged = await acknowledgeLinearSession({
      connectionId: current.connectionId,
      organizationId: current.organizationId,
      authorization,
      // The recorded session stands in for the webhook payload; there is no delivery time to meet.
      payload: {
        agentSession: {
          id: current.id,
          ...(current.issueId ? { issueId: current.issueId } : {}),
          ...(current.rootCommentId ? { commentId: current.rootCommentId } : {}),
        },
      },
    })
    // A failed attempt stamps `updatedAt`, which spaces out the next one.
    if (!acknowledged || acknowledged.ackState !== 'sent') return false
    current = acknowledged
  }
  if (current.dispositionState !== 'failed') return true
  const disposition = storedLinearSessionDisposition(current)
  if (!disposition) return false
  return postLinearSessionDisposition({ sessionId: current.id, authorization, disposition })
}
