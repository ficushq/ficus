import { and, eq } from 'drizzle-orm'
import { db, githubFeedbackRevisions, githubFeedbackSources, integrationOutputEvents, type DbTx } from '../../../db'
import { githubContentHash } from './feedback-envelope'
import { captureGitHubFeedback, type FeedbackCaptureDependencies } from './feedback-store'
import { isTrustedGitHubFeedbackContent } from './feedback-trust'

type Event = typeof integrationOutputEvents.$inferSelect

/** Called only after query-only relevance and exact-resource authorization. Never upgrades pending history. */
export function captureRelevantGitHubFeedback(event: Event, deps: Omit<FeedbackCaptureDependencies, 'decideFresh'>) {
  return captureGitHubFeedback(event.id, { ...deps, decideFresh: isTrustedGitHubFeedbackContent })
}

/**
 * Content-only admission predicate. Does not authorize repository access or routing/recipient changes.
 * Caller must recheck those independently and serialize final acceptance with trust authority changes.
 * No transported approved/trusted Boolean, revision marker, or native source row is authority.
 */
export async function isGitHubFeedbackAdmitted(store: typeof db | DbTx, event: Event): Promise<boolean> {
  if (event.integration !== 'github') return true
  const revisionId = event.fact.github?.revisionId
  if (!revisionId || event.authority.kind !== 'connection') return false
  const [row] = await store
    .select({ revision: githubFeedbackRevisions, source: githubFeedbackSources })
    .from(githubFeedbackSources)
    .innerJoin(githubFeedbackRevisions, eq(githubFeedbackRevisions.id, githubFeedbackSources.revisionId))
    .where(and(eq(githubFeedbackSources.eventId, event.id), eq(githubFeedbackSources.revisionId, revisionId)))
  if (!row) return false
  const { revision, source } = row
  if (
    revision.squadId !== event.authority.squadId ||
    source.squadId !== revision.squadId ||
    githubContentHash(source.authority) !== githubContentHash(event.authority) ||
    event.sourceKey !== `github-feedback:${revision.squadId}:${revision.id}` ||
    event.eventKey !== revision.id ||
    !revision.envelope ||
    !['allow_once', 'allow_trust', 'automatic'].includes(revision.decision)
  )
    return false
  const expected = {
    ...revision.envelope,
    eventKey: revision.id,
    github: { content: null, status: null, revisionId: revision.id },
  }
  if (githubContentHash(event.fact) !== githubContentHash(expected)) return false
  return revision.decision !== 'automatic' || isTrustedGitHubFeedbackContent(store, revision.squadId, revision)
}
