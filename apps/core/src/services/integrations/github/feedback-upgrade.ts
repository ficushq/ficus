import { sql } from 'drizzle-orm'
import { inbox } from '../../../db'
import { eventAuthoritySquadId, inboxIntegrationEventId } from './feedback-pass-read'

/**
 * Rollout fence for GitHub notification mail that no model has received yet.
 *
 * The trust gate needs no data backfill. The 0204 migration leaves existing squads with the author
 * filter OFF, so they keep pre-feature routing. A squad with the filter ON (new squads, or one a
 * human switched ON) admits GitHub prose only through a capture, decision and projection proof.
 * Rows persisted before that (pre-feature mail, or mail queued while the filter was OFF) have none,
 * so they:
 * - fail final acceptance (`isGitHubOutputAdmitted`): no wake, batch or steer delivers them;
 * - are hidden by this predicate from every agent-inbox list, page, search, count and single
 *   read while undelivered.
 *
 * Mail the filter admitted is also hidden until final acceptance sets `deliveredAt`; acceptance
 * is the model read. If the author's trust is revoked first, the row stays fenced.
 *
 * The fence is a pure, fresh read: no rewrite, tombstone or replay. Original rows, receipts and
 * idempotency keys stay intact. Evaluating it again (restart, partial rollout, repeated reads)
 * changes nothing. Turning the filter OFF restores pre-feature visibility and turning it ON fences
 * again. Delivered (`deliveredAt`) rows are history: they stay readable and are never re-sent.
 * Verified status projections (`github-status:`, structured merge/CI facts with no prose) and
 * other providers are not fenced. A missing or unknown squad fails closed (filter ON).
 */
export function withheldGitHubInboxCondition() {
  return sql`(${inbox.recipientType} = 'agent' AND ${inbox.deliveredAt} IS NULL AND EXISTS (
    SELECT 1 FROM integration_output_events fenced_event
    WHERE fenced_event.id = ${inboxIntegrationEventId()}
      AND fenced_event.integration = 'github'
      AND fenced_event.source_key NOT LIKE 'github-status:%'
      AND COALESCE(
        (SELECT fenced_squad.github_author_filter FROM squads fenced_squad
          WHERE fenced_squad.id = ${eventAuthoritySquadId('fenced_event')}),
        true
      )
  ))`
}

/** Agent-facing inbox reads: everything except fenced GitHub mail. */
export function visibleInboxCondition() {
  return sql`NOT ${withheldGitHubInboxCondition()}`
}
