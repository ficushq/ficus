import { and, eq, ne } from 'drizzle-orm'
import {
  db,
  githubFeedbackSources,
  githubFeedbackRevisions,
  githubOutputProofs,
  integrationOutputEvents,
  squads,
  type DbTx,
} from '../../../db'

import { rawGitHubFactsOrigin } from './feedback-raw-facts'
import { hasGitHubFreshnessBinding, rawGitHubFactsSourceId } from './feedback-freshness-binding'
import { outputSnapshotMatches, readFeedbackRevision } from './feedback-pass-read'
import { isCurrentGitHubFeedbackRevision } from './feedback-obsolescence'
import { isGitHubQuotedParentFresh } from './feedback-parent'

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
 * a raw provider event is its own effect. Freshness-only observations fence known-older text
 * independently of author trust; unbound legacy raw prose fails closed in every mode. These exceptions keep each observation single-delivery
 * when a squad switches modes:
 * - a raw event the filter already captured or projected while ON is delivered through that
 *   capture (held captures are released when the filter is turned off), never a second time raw;
 * - review edits/dismissals were never routed before the filter and stay unrouted.
 * Status projections and approved canonical feedback created while ON remain deliverable; a denied
 * or obsolete revision never is.
 */
export async function isUnfilteredGitHubEvent(store: Store, event: Event): Promise<boolean> {
  if (!hasGitHubFreshnessBinding(event)) return false
  if (rawGitHubFactsSourceId(event) && !(await rawGitHubFactsOrigin(store, event))) return false
  if (event.sourceKey.startsWith('github-status:')) return true
  if (event.sourceKey.startsWith('github-feedback:')) {
    // A human deny (or a settled/obsolete release) is final in every mode.
    const revisionId = event.fact.github?.revisionId
    if (!revisionId) return false
    const revision = await readFeedbackRevision(store, revisionId)
    return (
      !!revision &&
      !!revision.envelope &&
      event.authority.kind === 'connection' &&
      revision.squadId === event.authority.squadId &&
      ['automatic', 'allow_once', 'allow_trust', 'screened'].includes(revision.decision) &&
      revision.releaseState !== 'obsolete' &&
      (await isCurrentGitHubFeedbackRevision(store, revisionId)) &&
      (await isGitHubQuotedParentFresh(store, revision.squadId, revision.envelope))
    )
  }
  if (event.fact.output === 'pull_request.reviewed' && ['edited', 'dismissed'].includes(String(event.fact.data.action)))
    return false
  const [snapshot] = await store
    .select({ id: integrationOutputEvents.id })
    .from(integrationOutputEvents)
    .where(outputSnapshotMatches(event))
  if (!snapshot) return false
  const captured = await store
    .select({
      unfiltered: githubFeedbackSources.unfiltered,
      revisionId: githubFeedbackSources.revisionId,
      squadId: githubFeedbackSources.squadId,
      decision: githubFeedbackRevisions.decision,
      releaseState: githubFeedbackRevisions.releaseState,
    })
    .from(githubFeedbackSources)
    .innerJoin(githubFeedbackRevisions, eq(githubFeedbackRevisions.id, githubFeedbackSources.revisionId))
    .innerJoin(integrationOutputEvents, eq(integrationOutputEvents.id, githubFeedbackSources.eventId))
    .where(and(eq(githubFeedbackSources.eventId, event.id), outputSnapshotMatches(event)))
  const expected = event.fact.github?.content ? (event.fact.github.rawParent ? 2 : 1) : 0
  if (
    captured.length !== expected ||
    (event.fact.github?.content?.objectKind === 'action' &&
      !event.fact.github.rawParent &&
      !rawGitHubFactsSourceId(event))
  )
    return false
  for (const observation of captured) {
    if (
      !observation.unfiltered ||
      event.authority.kind !== 'connection' ||
      observation.squadId !== event.authority.squadId ||
      observation.decision === 'deny' ||
      observation.releaseState === 'obsolete' ||
      !(await isCurrentGitHubFeedbackRevision(store, observation.revisionId))
    )
      return false
  }
  const [projected] = await store
    .select({ id: githubOutputProofs.eventId })
    .from(githubOutputProofs)
    .where(and(eq(githubOutputProofs.sourceEventId, event.id), ne(githubOutputProofs.eventId, event.id)))
    .limit(1)
  return !projected
}
