import { and, eq, inArray, notInArray, sql } from 'drizzle-orm'
import { alias, type AnyPgColumn } from 'drizzle-orm/pg-core'
import {
  githubFeedbackObjects,
  githubFeedbackRevisions,
  integrationOutputDeliveries,
  integrationOutputEvents,
  type DbTx,
} from '../../../db'

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
  const newer = alias(githubFeedbackRevisions, 'newer_feedback_revision')
  // An identical-text replay keeps its immutable revision but may advance the object's clock.
  // Use that clock for the head on BOTH sides, lest delayed intermediate text obsolete the head.
  const version = (revision: { id: AnyPgColumn; providerVersion: AnyPgColumn }) =>
    sql`case when ${revision.id} = ${object.currentRevisionId}
      then coalesce(${object.providerVersion}::timestamptz, ${revision.providerVersion}::timestamptz)
      else ${revision.providerVersion}::timestamptz end`
  const newerVersion = version(newer)
  const olderVersion = version(githubFeedbackRevisions)
  const newerExists = tx
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
        sql`exists (${newerExists})`
      )
    )
    .returning({ id: githubFeedbackRevisions.id })
  if (!obsolete.length) return 0
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
          obsolete.map(({ id }) => id)
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
        inArray(integrationOutputDeliveries.eventId, canonical),
        notInArray(integrationOutputDeliveries.status, ['delivered', 'superseded'])
      )
    )
  return obsolete.length
}
