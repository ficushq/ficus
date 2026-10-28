import { and, eq, ne, not, or, sql, type SQLWrapper } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { db, githubFeedbackRevisions, githubFeedbackSources, githubOutputProofs } from '../../../db'
import { rawGitHubFactsProofSQL } from './feedback-raw-facts'
import { currentGitHubFeedbackRevisionSQL } from './feedback-obsolescence'
import { gitHubQuotedParentFreshSQL } from './feedback-parent'
import { gitHubFeedbackRevisionIdSQL, gitHubFreshnessBindingSQL } from './feedback-freshness-binding'

/** Local read admission, not author trust or a replacement for locked final acceptance.
 * Sources bind raw own/parent observations; canonical quotes use their reviewed envelope.
 * Correlated SQL keeps pagination/counts/single reads consistent without loading stale prose.
 */
export function gitHubInboxEventFreshSQL(
  eventId: SQLWrapper,
  fact: SQLWrapper,
  sourceKey: SQLWrapper,
  squadId: SQLWrapper
) {
  const revision = alias(githubFeedbackRevisions, 'inbox_feedback_revision')
  const source = alias(githubFeedbackSources, 'inbox_feedback_source')
  const freshRevision = and(
    ne(revision.releaseState, 'obsolete'),
    currentGitHubFeedbackRevisionSQL(revision.id, squadId),
    gitHubQuotedParentFreshSQL(squadId, revision.envelope)
  )
  const canonical = db
    .select({ id: revision.id })
    .from(revision)
    .where(
      and(
        eq(revision.id, gitHubFeedbackRevisionIdSQL(fact)),
        eq(revision.squadId, squadId),
        sql`${revision.envelope} is not null`,
        sql`${revision.decision} IN ('automatic', 'allow_once', 'allow_trust', 'screened')`,
        freshRevision
      )
    )
  const count = db
    .select({ count: sql`count(*)` })
    .from(source)
    .where(eq(source.eventId, eventId))
  const invalid = db
    .select({ id: revision.id })
    .from(source)
    .innerJoin(revision, eq(revision.id, source.revisionId))
    .where(
      and(
        eq(source.eventId, eventId),
        or(
          eq(source.unfiltered, false),
          sql`${source.squadId} is distinct from ${squadId}`,
          sql`${revision.squadId} is distinct from ${squadId}`,
          eq(revision.decision, 'deny'),
          not(
            and(
              ne(revision.releaseState, 'obsolete'),
              currentGitHubFeedbackRevisionSQL(revision.id, squadId),
              sql`case when ${sourceKey} LIKE 'github-raw-facts:%' then ${gitHubQuotedParentFreshSQL(squadId, fact)} else ${gitHubQuotedParentFreshSQL(squadId, revision.envelope)} end`
            )
          )
        )
      )
    )
  const projected = db
    .select({ id: githubOutputProofs.eventId })
    .from(githubOutputProofs)
    .where(and(eq(githubOutputProofs.sourceEventId, eventId), ne(githubOutputProofs.eventId, eventId)))
  return sql<boolean>`(${gitHubFreshnessBindingSQL(fact, sourceKey)}
    AND (${sourceKey} NOT LIKE 'github-raw-facts:%' OR ${rawGitHubFactsProofSQL(eventId, fact, sourceKey)}) AND case
    when ${sourceKey} LIKE 'github-status:%' then true
    when ${sourceKey} LIKE 'github-feedback:%' then exists (${canonical})
    when ${fact} #> '{github,content}' is null OR ${fact} #> '{github,content}' = 'null'::jsonb then true
    else ((${count}) = case when ${fact} #> '{github,rawParent}' is null OR ${fact} #> '{github,rawParent}' = 'null'::jsonb then 1 else 2 end
      AND NOT exists (${invalid}) AND NOT exists (${projected})) end)`
}
