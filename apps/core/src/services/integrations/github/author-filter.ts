import { and, eq, ne } from 'drizzle-orm'
import {
  db,
  githubFeedbackRevisions,
  githubFeedbackSources,
  githubOutputProofs,
  integrationOutputEvents,
  squads,
  type DbTx,
} from '../../../db'

type Store = typeof db | DbTx
type Event = typeof integrationOutputEvents.$inferSelect

/**
 * Fresh read of the squad's GitHub author filter; never cached. An unknown squad fails closed (ON).
 * Callers that act on the answer inside a transaction hold the squad row lock taken by
 * lockGitHubOutputAuthority, so a concurrent toggle serializes with the effect.
 */
export async function isGitHubAuthorFilterEnabled(store: Store, squadId: string): Promise<boolean> {
  const [row] = await store
    .select({ enabled: squads.githubAuthorFilter })
    .from(squads)
    .where(eq(squads.id, squadId))
    .limit(1)
  return row?.enabled ?? true
}

/**
 * With the filter OFF, GitHub events route exactly as they did before the filter existed:
 * a raw provider event is its own effect. Two exceptions keep each observation single-delivery
 * when a squad switches modes:
 * - a raw event the filter already captured or projected while ON is delivered through that
 *   capture (held captures are released when the filter is turned off), never a second time raw;
 * - review edits/dismissals were never routed before the filter and stay unrouted.
 * Status projections and approved canonical feedback created while ON remain deliverable; a denied
 * or obsolete revision never is.
 */
export async function isUnfilteredGitHubEvent(store: Store, event: Event): Promise<boolean> {
  if (event.sourceKey.startsWith('github-status:')) return true
  if (event.sourceKey.startsWith('github-feedback:')) {
    // A human deny (or a settled/obsolete release) is final in every mode.
    const revisionId = event.fact.github?.revisionId
    if (!revisionId) return false
    const [revision] = await store
      .select({ decision: githubFeedbackRevisions.decision, releaseState: githubFeedbackRevisions.releaseState })
      .from(githubFeedbackRevisions)
      .where(eq(githubFeedbackRevisions.id, revisionId))
      .limit(1)
    return (
      !!revision &&
      ['automatic', 'allow_once', 'allow_trust'].includes(revision.decision) &&
      revision.releaseState !== 'obsolete'
    )
  }
  if (event.fact.output === 'pull_request.reviewed' && ['edited', 'dismissed'].includes(String(event.fact.data.action)))
    return false
  const [captured] = await store
    .select({ id: githubFeedbackSources.eventId })
    .from(githubFeedbackSources)
    .where(eq(githubFeedbackSources.eventId, event.id))
    .limit(1)
  if (captured) return false
  const [projected] = await store
    .select({ id: githubOutputProofs.eventId })
    .from(githubOutputProofs)
    .where(and(eq(githubOutputProofs.sourceEventId, event.id), ne(githubOutputProofs.eventId, event.id)))
    .limit(1)
  return !projected
}
