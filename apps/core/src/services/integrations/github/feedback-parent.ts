import { createHash } from 'node:crypto'
import type { GitHubFeedbackContent } from '@ficus/shared'
import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import {
  db,
  githubFeedbackObjects,
  githubFeedbackRevisions,
  githubFeedbackSources,
  inbox,
  integrationOutputDeliveries,
  integrationOutputEvents,
  integrationOutputTriggerRuns,
  type DbTx,
} from '../../../db'
import { githubActionReviewed, hasGitHubParentText, withoutGitHubParentText } from './feedback-envelope'
import { isTrustedGitHubFeedbackContent, resolveGitHubAuthorTrust } from './feedback-trust'

type Revision = typeof githubFeedbackRevisions.$inferSelect

const sha256Hex = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')
/** Hash of stored reviewed text, computed in SQL so bodies are never materialized for this check. */
const storedTextHash = (field: 'body' | 'title') =>
  sql<
    string | null
  >`case when ${githubFeedbackRevisions.envelope} is null then null else encode(sha256(convert_to(coalesce(${githubFeedbackRevisions.envelope} #>> ${`{data,content,${field}}`}, ''), 'UTF8')), 'hex') end`

/**
 * Whether an action may carry its parent issue or PR's CURRENT title and description (capture only;
 * final acceptance rechecks the author's live trust through isTrustedGitHubFeedbackContent).
 *
 * Two conditions, both required:
 * - Trust: the parent's content author, by numeric account ID from the signed payload, is trusted in
 *   this squad right now. This is resolveGitHubAuthorTrust, the same live, uncached check as comment
 *   authors: a manual trusted author, or a linked GitHub identity whose person has squads:update here.
 * - Provenance: the text is provably that author's. GitHub's issue and PR payloads name the creator
 *   (`user`) but not who last edited the title or description, and anyone with write access may have
 *   rewritten them. So, as for the parent in managed memory reads, the LATEST captured revision of
 *   the parent with exactly this title and body decides: an automatic or human-allowed revision
 *   attributed to its creation by this same author proves it; a pending or denied one refuses it.
 *   Without such a revision, only a payload whose clock shows no change since creation
 *   (`created_at` equals `updated_at`) proves it. Anything else stays facts-only.
 */
export async function isGitHubParentTextAdmissible(
  executor: Pick<typeof db, 'select'>,
  squadId: string,
  content: Pick<GitHubFeedbackContent, 'objectKind' | 'repositoryId' | 'parentText'>
): Promise<boolean> {
  const parent = content.parentText
  if (content.objectKind !== 'action' || !parent || !content.repositoryId) return false
  if (!(await resolveGitHubAuthorTrust(executor, squadId, parent.author.accountId)).length) return false
  const [match] = await executor
    .select({
      decision: githubFeedbackRevisions.decision,
      attribution: githubFeedbackRevisions.attribution,
      author: githubFeedbackRevisions.author,
    })
    .from(githubFeedbackRevisions)
    .innerJoin(githubFeedbackObjects, eq(githubFeedbackObjects.id, githubFeedbackRevisions.objectId))
    .where(
      and(
        eq(githubFeedbackObjects.squadId, squadId),
        eq(githubFeedbackObjects.repositoryId, content.repositoryId),
        eq(githubFeedbackObjects.objectKind, parent.objectKind),
        eq(githubFeedbackObjects.nativeId, parent.nativeId),
        sql`${storedTextHash('body')} = ${sha256Hex(parent.body)}`,
        sql`${storedTextHash('title')} = ${sha256Hex(parent.title)}`
      )
    )
    .orderBy(desc(githubFeedbackRevisions.sequence))
    .limit(1)
  // Historical rows carry no decision about this text; they fall through to the payload clock.
  if (match && match.decision !== 'historical')
    return (
      ['automatic', 'allow_once', 'allow_trust'].includes(match.decision) &&
      match.attribution === 'creation' &&
      match.author?.accountId === parent.author.accountId
    )
  return parent.unchanged
}

/**
 * The parent text's author lost trust after capture, before any agent received the action: replace
 * the automatic revision with the factual message alone, as a capture would have chosen then.
 *
 * Runs under the trust authority lock with the revision row locked (release settlement, renewal).
 * Refuses (returns null, and the caller holds the revision as `trust_revoked` like any other
 * revocation) unless:
 * - the revision is automatic and carries parent text;
 * - its actor is still trusted for the factual message alone;
 * - no agent received or acted on its canonical event: no delivered inbox notice, no delivered flow
 *   delivery and no trigger run. A partial delivery is never repeated as a second message.
 *
 * The new revision is the next version of the same action object: its envelope is exactly the
 * factual delivery (the parent text removed), its hash is recomputed over that complete reviewed
 * object, and it keeps the original observation time and routing provenance. The original raw
 * source associations move to it so release materializes it from the same first observation; the
 * old revision, which the caller marks obsolete, keeps only its own canonical event.
 */
export async function supersedeGitHubParentText(tx: DbTx, revision: Revision): Promise<string | null> {
  if (
    revision.decision !== 'automatic' ||
    revision.releaseState === 'obsolete' ||
    !revision.envelope ||
    !hasGitHubParentText(revision.envelope)
  )
    return null
  const facts = withoutGitHubParentText(revision.envelope)
  if (!(await isTrustedGitHubFeedbackContent(tx, revision.squadId, { ...revision, envelope: facts }))) return null
  const canonical = await tx
    .select({ id: integrationOutputEvents.id })
    .from(integrationOutputEvents)
    .where(
      and(
        eq(integrationOutputEvents.integration, 'github'),
        eq(integrationOutputEvents.sourceKey, `github-feedback:${revision.squadId}:${revision.id}`),
        eq(integrationOutputEvents.eventKey, revision.id)
      )
    )
  const canonicalIds = canonical.map((row) => row.id)
  if (canonicalIds.length) {
    const [delivered] = await tx
      .select({ id: inbox.id })
      .from(inbox)
      .where(
        and(isNotNull(inbox.deliveredAt), inArray(sql<string>`${inbox.metadata}->>'integrationEventId'`, canonicalIds))
      )
      .limit(1)
    const [flow] = await tx
      .select({ id: integrationOutputDeliveries.id })
      .from(integrationOutputDeliveries)
      .where(
        and(
          inArray(integrationOutputDeliveries.eventId, canonicalIds),
          eq(integrationOutputDeliveries.status, 'delivered')
        )
      )
      .limit(1)
    const [trigger] = await tx
      .select({ eventId: integrationOutputTriggerRuns.eventId })
      .from(integrationOutputTriggerRuns)
      .where(inArray(integrationOutputTriggerRuns.eventId, canonicalIds))
      .limit(1)
    if (delivered || flow || trigger) return null
  }
  const [object] = await tx
    .select()
    .from(githubFeedbackObjects)
    .where(eq(githubFeedbackObjects.id, revision.objectId))
    .for('update')
  if (!object) return null
  const reviewed = githubActionReviewed(
    {
      repositoryId: object.repositoryId,
      nativeId: object.nativeId,
      author: revision.author,
      attribution: revision.attribution,
    },
    facts
  )
  const sequence = object.sequence + 1
  const [created] = await tx
    .insert(githubFeedbackRevisions)
    .values({
      objectId: object.id,
      squadId: revision.squadId,
      sequence,
      contentHash: reviewed.contentHash,
      normalizationVersion: revision.normalizationVersion,
      envelope: facts,
      byteCount: reviewed.byteCount,
      author: revision.author,
      editor: revision.editor,
      attribution: revision.attribution,
      providerVersion: revision.providerVersion,
      routingProvenance: revision.routingProvenance,
      reason: 'trusted_author',
      decision: 'automatic',
      releaseState: 'ready',
      firstObservedAt: revision.firstObservedAt,
    })
    .returning({ id: githubFeedbackRevisions.id })
  await tx
    .update(githubFeedbackObjects)
    .set({
      sequence,
      ...(object.currentRevisionId === revision.id ? { currentRevisionId: created!.id } : {}),
    })
    .where(eq(githubFeedbackObjects.id, object.id))
  await tx
    .update(githubFeedbackSources)
    .set({ revisionId: created!.id })
    .where(
      and(
        eq(githubFeedbackSources.revisionId, revision.id),
        sql`${githubFeedbackSources.eventId} IN (SELECT id FROM integration_output_events WHERE source_key NOT LIKE 'github-feedback:%')`
      )
    )
  return created!.id
}
