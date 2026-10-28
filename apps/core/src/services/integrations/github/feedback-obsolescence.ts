import { and, eq, inArray, not, notInArray, or, sql } from 'drizzle-orm'
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

type ReadStore = Pick<typeof db, 'select'>

/** One ordering predicate for capture and final admission, including delivered audit rows. */
function knownNewerRevision(store: ReadStore, object: typeof githubFeedbackObjects.$inferSelect) {
  const newer = alias(githubFeedbackRevisions, 'newer_feedback_revision')
  // An identical-text replay keeps its immutable revision but may advance the object's clock.
  // Use that clock for the head on BOTH sides, lest delayed intermediate text obsolete the head.
  const version = (revision: { id: AnyPgColumn; providerVersion: AnyPgColumn }) =>
    sql`case when ${revision.id} = ${object.currentRevisionId}
      then coalesce(${object.providerVersion}::timestamptz, ${revision.providerVersion}::timestamptz)
      else ${revision.providerVersion}::timestamptz end`
  const newerVersion = version(newer)
  const olderVersion = version(githubFeedbackRevisions)
  const newerExists = store
    .select({ id: newer.id })
    .from(newer)
    .where(
      and(
        eq(newer.objectId, githubFeedbackRevisions.objectId),
        sql`case
      when ${newerVersion} is not null and ${olderVersion} is not null and ${newerVersion} <> ${olderVersion}
      then ${newerVersion} > ${olderVersion}
      else ${newer.sequence} > ${githubFeedbackRevisions.sequence}
    end`
      )
    )
  return sql`exists (${newerExists})`
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
export async function obsoleteOlderGitHubFeedback(tx: DbTx, objectId: string): Promise<number> {
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
  await tx
    .update(integrationOutputDeliveries)
    .set({
      status: 'superseded',
      reason: 'Feedback revision obsolete',
      updatedAt: new Date(),
    })
    .where(
      and(
        or(inArray(integrationOutputDeliveries.eventId, canonical), inArray(integrationOutputDeliveries.eventId, raw)),
        notInArray(integrationOutputDeliveries.status, ['delivered', 'superseded'])
      )
    )
  return obsolete.length
}
