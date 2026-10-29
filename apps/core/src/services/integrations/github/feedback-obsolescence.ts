import { and, eq, inArray, not, notInArray, or, sql, type SQLWrapper } from 'drizzle-orm'
import { alias, type AnyPgColumn } from 'drizzle-orm/pg-core'
import {
  db,
  githubFeedbackObjects,
  githubFeedbackRevisions,
  githubFeedbackSources,
  integrationOutputDeliveries,
  integrationOutputEvents,
  type DbTx,
} from '../../../db'

import { rawGitHubFactsSourceIdSQL } from './feedback-freshness-binding'
import {
  GITHUB_FEEDBACK_OBSOLETE,
  GITHUB_FACTUAL_RECOVERY_PENDING,
  preserveRawGitHubActionFacts,
} from './feedback-raw-facts'

type ReadStore = Pick<typeof db, 'select'>

type FeedbackClock = {
  currentRevisionId: string | null | AnyPgColumn
  providerVersion: string | null | AnyPgColumn
}
type RevisionColumns = Record<'id' | 'objectId' | 'providerVersion' | 'sequence', AnyPgColumn>

/** Effective clock includes identical-text observations without changing their immutable revision. */
export function gitHubFeedbackVersionSQL(revision: RevisionColumns, object: FeedbackClock) {
  return sql`case when ${revision.id} = ${object.currentRevisionId}
    then coalesce(${object.providerVersion}::timestamptz, ${revision.providerVersion}::timestamptz)
    else ${revision.providerVersion}::timestamptz end`
}

/** One ordering predicate for capture, final admission and pure inbox reads. */
function knownNewerRevision(store: ReadStore, object: FeedbackClock, older: RevisionColumns = githubFeedbackRevisions) {
  const newer = alias(githubFeedbackRevisions, 'newer_feedback_revision')
  const newerVersion = gitHubFeedbackVersionSQL(newer, object)
  const olderVersion = gitHubFeedbackVersionSQL(older, object)
  const newerExists = store
    .select({ id: newer.id })
    .from(newer)
    .where(
      and(
        eq(newer.objectId, older.objectId),
        sql`case
      when ${newerVersion} is not null and ${olderVersion} is not null and ${newerVersion} <> ${olderVersion}
      then ${newerVersion} > ${olderVersion}
      else ${newer.sequence} > ${older.sequence}
    end`
      )
    )
  return sql`exists (${newerExists})`
}

/** Composable local currentness: one snapshot for list/page/search/count without body materialization. */
export function currentGitHubFeedbackRevisionSQL(revisionId: SQLWrapper, squadId: SQLWrapper) {
  const revision = alias(githubFeedbackRevisions, 'current_feedback_revision')
  const object = alias(githubFeedbackObjects, 'current_feedback_object')
  const current = db
    .select({ id: revision.id })
    .from(revision)
    .innerJoin(object, eq(object.id, revision.objectId))
    .where(
      and(eq(revision.id, revisionId), eq(revision.squadId, squadId), not(knownNewerRevision(db, object, revision)))
    )
  return sql`exists (${current})`
}

/** Local freshness, independent of delivery settlement. Call under the authority lock for effects. */
export async function isCurrentGitHubFeedbackRevision(store: ReadStore, revisionId: string): Promise<boolean> {
  const [row] = await store
    .select({ object: githubFeedbackObjects })
    .from(githubFeedbackRevisions)
    .innerJoin(githubFeedbackObjects, eq(githubFeedbackObjects.id, githubFeedbackRevisions.objectId))
    .where(eq(githubFeedbackRevisions.id, revisionId))
  if (!row) return false
  const [current] = await store
    .select({ id: githubFeedbackRevisions.id })
    .from(githubFeedbackRevisions)
    .where(and(eq(githubFeedbackRevisions.id, revisionId), not(knownNewerRevision(store, row.object))))
  return !!current
}

/**
 * Reconcile ALL known versions, not just currentRevisionId (ambiguous captures do not advance it).
 * Runs under the trust-authority lock and object row lock, serializing with final agent acceptance,
 * moderation, screening and release settlement. Provider I/O must already have finished.
 *
 * Provider clocks win when both are present and differ; equal/missing clocks use capture sequence.
 * An out-of-order capture is therefore immediately obsolete even behind an already delivered row.
 * Keep the original decision, hold reason and immutable snapshot as audit evidence. Invalidate the
 * decision version and release lease so a displayed selection or in-flight worker cannot revive it.
 */
export async function obsoleteOlderGitHubFeedback(
  tx: DbTx,
  objectId: string,
  afterCommit: Array<() => void> = []
): Promise<number> {
  const [object] = await tx.select().from(githubFeedbackObjects).where(eq(githubFeedbackObjects.id, objectId))
  if (!object) throw new Error('feedback_capture_failed')
  const newerExists = knownNewerRevision(tx, object)
  const older = await tx
    .select({ id: githubFeedbackRevisions.id })
    .from(githubFeedbackRevisions)
    .where(and(eq(githubFeedbackRevisions.objectId, objectId), newerExists))
  if (!older.length) return 0
  const obsolete = await tx
    .update(githubFeedbackRevisions)
    .set({
      releaseState: 'obsolete',
      decisionVersion: sql`${githubFeedbackRevisions.decisionVersion} + 1`,
      leaseToken: null,
      leaseExpiresAt: null,
      nextAttemptAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(githubFeedbackRevisions.objectId, objectId),
        notInArray(githubFeedbackRevisions.releaseState, ['delivered', 'obsolete']),
        inArray(
          githubFeedbackRevisions.id,
          older.map(({ id }) => id)
        )
      )
    )
    .returning({ id: githubFeedbackRevisions.id })
  // Also supersede unfinished work for previously delivered revisions. Their accepted receipts
  // and delivered settlement remain audit evidence, not authority for another effect.
  // Only canonical content events, never a raw event's separate lifecycle/status projection.
  const canonical = tx
    .select({ id: integrationOutputEvents.id })
    .from(integrationOutputEvents)
    .where(
      and(
        eq(integrationOutputEvents.integration, 'github'),
        sql`${integrationOutputEvents.sourceKey} = 'github-feedback:' || (${integrationOutputEvents.authority}->>'squadId') || ':' || ${integrationOutputEvents.eventKey}`,
        inArray(
          integrationOutputEvents.eventKey,
          older.map(({ id }) => id)
        )
      )
    )
  const raw = tx
    .select({ id: githubFeedbackSources.eventId })
    .from(githubFeedbackSources)
    .where(
      and(
        eq(githubFeedbackSources.unfiltered, true),
        inArray(
          githubFeedbackSources.revisionId,
          older.map(({ id }) => id)
        )
      )
    )
  const rawActions = await tx
    .select({ id: integrationOutputEvents.id })
    .from(integrationOutputEvents)
    .where(
      and(
        inArray(integrationOutputEvents.id, raw),
        sql`${integrationOutputEvents.fact} #>> '{github,content,objectKind}' = 'action'`,
        sql`${integrationOutputEvents.fact} #> '{github,rawParent}' IS NOT NULL`,
        sql`${integrationOutputEvents.lastErrorCode} IS DISTINCT FROM ${GITHUB_FEEDBACK_OBSOLETE}`
      )
    )
  const deferred: string[] = []
  for (const source of rawActions) {
    try {
      await preserveRawGitHubActionFacts(tx, source.id, afterCommit)
    } catch (error) {
      if (error instanceof Error && error.message === 'feedback_capacity_deferred') deferred.push(source.id)
      else throw error
    }
  }
  await tx
    .update(integrationOutputEvents)
    .set({
      lastErrorCode: sql`case when ${inArray(integrationOutputEvents.id, deferred)} then ${GITHUB_FACTUAL_RECOVERY_PENDING} else ${GITHUB_FEEDBACK_OBSOLETE} end`,
      // Factual aliases bind only their own action revision, not the discarded parent.
      // Once that action is obsolete they can never route; retire unmatched aliases now
      // instead of reserving their event and source bodies on every reconciliation pass.
      matchedAt: sql`case when ${rawGitHubFactsSourceIdSQL(integrationOutputEvents.sourceKey)} is not null
        then coalesce(${integrationOutputEvents.matchedAt}, now()) else ${integrationOutputEvents.matchedAt} end`,
    })
    .where(inArray(integrationOutputEvents.id, raw))
  await tx
    .update(integrationOutputDeliveries)
    .set({
      status: 'superseded',
      reason: GITHUB_FEEDBACK_OBSOLETE,
      updatedAt: new Date(),
    })
    .where(
      and(
        or(inArray(integrationOutputDeliveries.eventId, canonical), inArray(integrationOutputDeliveries.eventId, raw)),
        notInArray(integrationOutputDeliveries.eventId, deferred),
        notInArray(integrationOutputDeliveries.status, ['delivered', 'superseded'])
      )
    )
  return obsolete.length
}
