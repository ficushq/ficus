import { createHash } from 'node:crypto'
import type { GitHubFeedbackContent, IntegrationOutputFact } from '@ficus/shared'
import { and, desc, eq, inArray, isNotNull, or, sql, type SQLWrapper } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import {
  db,
  chatSendReceipts,
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
import {
  currentGitHubFeedbackRevisionSQL,
  gitHubFeedbackVersionSQL,
  isCurrentGitHubFeedbackRevision,
} from './feedback-obsolescence'
import { isTrustedGitHubFeedbackContent, resolveGitHubAuthorTrust } from './feedback-trust'

type Revision = typeof githubFeedbackRevisions.$inferSelect

const sha256Hex = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')
/** Hash of stored reviewed text, computed in SQL so bodies are never materialized for this check. */
const storedTextHash = (field: 'body' | 'title', envelope: SQLWrapper = githubFeedbackRevisions.envelope) =>
  sql<
    string | null
  >`case when ${envelope} is null then null else encode(sha256(convert_to(coalesce(${envelope} #>> ${`{data,content,${field}}`}, ''), 'UTF8')), 'hex') end`

/**
 * Whether an action may carry its parent issue or PR's CURRENT title and description at capture.
 * Final acceptance separately rechecks quoted-parent freshness and the author's live trust.
 *
 * Two conditions, both required:
 * - Trust: the parent's content author, by numeric account ID from the signed payload, is trusted in
 *   this squad right now. This is resolveGitHubAuthorTrust, the same live, uncached check as comment
 *   authors: a manual trusted author, or a linked GitHub identity whose person has squads:update here.
 * - Provenance: the text is provably that author's. GitHub's issue and PR payloads name the creator
 *   (`user`) but not who last edited the title or description, and anyone with write access may have
 *   rewritten them. So, as for the parent in managed memory reads, the LATEST captured revision of
 *   the parent with exactly this title and body decides: an automatic or human-allowed revision
 *   attributed to this same author, by its creation or by a verified edit history in which only
 *   that author edited it, proves it; a pending or denied one refuses it. Without such a revision,
 *   only `parentText.unchanged` proves it: the payload's clock shows no change since creation, or
 *   capture read GitHub's edit history and found only the author's own edits. Anything else stays
 *   facts-only.
 */
export async function isGitHubParentTextAdmissible(
  executor: Pick<typeof db, 'select'>,
  squadId: string,
  content: Pick<GitHubFeedbackContent, 'objectKind' | 'repositoryId' | 'parentText'>
): Promise<boolean> {
  const parent = content.parentText
  if (content.objectKind !== 'action' || !parent || !content.repositoryId) return false
  if (!(await isGitHubQuotedParentFresh(executor, squadId, parent.delivery))) return false
  if (!(await resolveGitHubAuthorTrust(executor, squadId, parent.author.accountId)).length) return false
  const [match] = await executor
    .select({
      id: githubFeedbackRevisions.id,
      decision: githubFeedbackRevisions.decision,
      releaseState: githubFeedbackRevisions.releaseState,
      attribution: githubFeedbackRevisions.attribution,
      author: githubFeedbackRevisions.author,
      editors: sql<unknown>`${githubFeedbackRevisions.envelope} #> '{data,editors}'`,
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
      match.releaseState !== 'obsolete' &&
      (await isCurrentGitHubFeedbackRevision(executor, match.id)) &&
      ['automatic', 'allow_once', 'allow_trust'].includes(match.decision) &&
      match.author?.accountId === parent.author.accountId &&
      (match.attribution === 'creation' ||
        (match.attribution === 'verified_edit' &&
          Array.isArray(match.editors) &&
          match.editors.length > 0 &&
          match.editors.every(
            (editor) => (editor as { accountId?: unknown } | null)?.accountId === parent.author.accountId
          )))
    )
  return parent.unchanged
}

/**
 * The parent text's author lost trust after capture, before any agent received the action: replace
 * the automatic revision with the factual message alone, as a capture would have chosen then.
 *
 * Runs under the trust authority lock with the revision row locked (release settlement, renewal).
 * Refuses (returns null, and the caller holds the old quotation for review) unless:
 * - the revision is automatic and carries parent text;
 * - its actor is still trusted for the factual message alone;
 * - no agent received or acted on its canonical event or tracked raw observation: no delivered inbox notice/flow delivery,
 *   trigger run or durable Agent queue acceptance. A partial effect is never repeated.
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
  if (!(await resolveGitHubAuthorTrust(tx, revision.squadId, revision.author?.accountId)).length) return null
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
  const raw = await tx
    .select({ id: githubFeedbackSources.eventId })
    .from(githubFeedbackSources)
    .where(and(eq(githubFeedbackSources.revisionId, revision.id), eq(githubFeedbackSources.unfiltered, true)))
  const effectIds = [...new Set([...canonical, ...raw].map((row) => row.id))]
  if (effectIds.length) {
    const [delivered] = await tx
      .select({ id: inbox.id })
      .from(inbox)
      .where(
        and(isNotNull(inbox.deliveredAt), inArray(sql<string>`${inbox.metadata}->>'integrationEventId'`, effectIds))
      )
      .limit(1)
    const [flow] = await tx
      .select({ id: integrationOutputDeliveries.id })
      .from(integrationOutputDeliveries)
      .where(
        and(
          inArray(integrationOutputDeliveries.eventId, effectIds),
          eq(integrationOutputDeliveries.status, 'delivered')
        )
      )
      .limit(1)
    const [trigger] = await tx
      .select({ eventId: integrationOutputTriggerRuns.eventId })
      .from(integrationOutputTriggerRuns)
      .where(inArray(integrationOutputTriggerRuns.eventId, effectIds))
      .limit(1)
    // Inbox/flow acknowledgements can lag durable Agent queue acceptance. Any accepted target
    // prevents a factual replacement, even when the overall routing pass was only partial.
    const [accepted] = await tx
      .select({ id: inbox.id })
      .from(inbox)
      .innerJoin(chatSendReceipts, sql`${chatSendReceipts.agentId}::text = ${inbox.recipientId}`)
      .where(
        and(
          inArray(sql<string>`${inbox.metadata}->>'integrationEventId'`, effectIds),
          eq(chatSendReceipts.state, 'accepted'),
          or(
            sql`${chatSendReceipts.clientId} = 'github-feedback:' || (${inbox.metadata}->>'integrationEventId') || ':' || ${inbox.id}::text`,
            sql`${chatSendReceipts.clientId} = 'integration-output:' || (${inbox.metadata}->>'integrationDeliveryId') || ':' || ${inbox.id}::text`
          )
        )
      )
      .limit(1)
    if (delivered || flow || trigger || accepted) return null
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

/**
 * A quoted parent is a CURRENT-text claim, not a receipt. Recheck at every final effect even for
 * human approvals and filter OFF. New envelopes bind provider-native identity/clock into the hash;
 * legacy unbound quotations fail closed. Known different text at an equal/unknown/later clock
 * invalidates the quote, including ambiguous captures and an identical-text head watermark.
 * This predicate is shared by final effects and unaccepted inbox reads; no trust/provider I/O.
 */
export function gitHubQuotedParentFreshSQL(squadId: SQLWrapper, envelope: SQLWrapper) {
  const parent = sql`(${envelope} #> '{data,parentContent}')`
  const object = alias(githubFeedbackObjects, 'quoted_parent_object')
  const revision = alias(githubFeedbackRevisions, 'quoted_parent_revision')
  const identity = and(
    eq(object.squadId, squadId),
    sql`${object.repositoryId} = ${envelope} #>> '{data,repositoryId}'`,
    sql`${object.objectKind} = ${parent}->>'objectKind'`,
    sql`${object.nativeId} = ${parent}->>'nativeId'`
  )
  const hash = (field: 'body' | 'title') => sql`encode(sha256(convert_to(${parent}->>${field}, 'UTF8')), 'hex')`
  const matches = db
    .select({ id: revision.id })
    .from(object)
    .innerJoin(revision, eq(revision.objectId, object.id))
    .where(
      and(
        identity,
        sql`${storedTextHash('body', revision.envelope)} = ${hash('body')}`,
        sql`${storedTextHash('title', revision.envelope)} = ${hash('title')}`
      )
    )
    .orderBy(desc(revision.sequence))
    .limit(1)
  // Only normalized finite provider clocks can authorize the timestamp fallback. A malformed
  // legacy clock is unknown, not a throwing cast or an inferred current time (e.g. "now").
  const iso = String.raw`^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$`
  const clock = sql`case when ${parent}->>'providerVersion' ~ ${iso}
    AND pg_input_is_valid(${parent}->>'providerVersion', 'timestamp with time zone')
    then (${parent}->>'providerVersion')::timestamptz end`
  const currentClock = gitHubFeedbackVersionSQL(revision, object)
  const different = db
    .select({ id: revision.id })
    .from(object)
    .innerJoin(revision, eq(revision.objectId, object.id))
    .where(
      and(
        identity,
        or(
          sql`${storedTextHash('body', revision.envelope)} is distinct from ${hash('body')}`,
          sql`${storedTextHash('title', revision.envelope)} is distinct from ${hash('title')}`
        ),
        sql`(${clock} is null or ${currentClock} is null or ${currentClock} >= ${clock})`
      )
    )
  return sql<boolean>`(
    NOT coalesce(${envelope} #>> '{data,projection}' = 'action' AND (${envelope}->'data') ? 'parentContent', false)
    OR (coalesce(
      ${parent}->>'objectKind' IN ('issue', 'pull_request')
      AND jsonb_typeof(${parent}->'nativeId') = 'string' AND ${parent}->>'nativeId' ~ '^[1-9][0-9]*$'
      AND jsonb_typeof(${parent}->'body') = 'string' AND jsonb_typeof(${parent}->'title') = 'string'
      AND ${envelope} #>> '{data,repositoryId}' ~ '^[1-9][0-9]*$', false)
      AND (${currentGitHubFeedbackRevisionSQL(sql`(${matches})`, squadId)} OR NOT exists (${different})))
  )`
}

export async function isGitHubQuotedParentFresh(
  store: Pick<typeof db, 'select'>,
  squadId: string,
  envelope: IntegrationOutputFact | null
): Promise<boolean> {
  if (!envelope || !hasGitHubParentText(envelope)) return true
  const [result] = await store
    .select({ fresh: gitHubQuotedParentFreshSQL(sql`${squadId}::uuid`, sql`${JSON.stringify(envelope)}::jsonb`) })
    .from(sql`(values (1)) as quoted_parent_read(dummy)`)
  return result?.fresh === true
}

/** Stale quotation settlement; never transfers a human approval to a different reviewed hash. */
export async function settleStaleGitHubParentText(tx: DbTx, revision: Revision): Promise<boolean> {
  if (
    ['obsolete', 'delivered'].includes(revision.releaseState) ||
    !['automatic', 'allow_once', 'allow_trust', 'screened'].includes(revision.decision) ||
    (await isGitHubQuotedParentFresh(tx, revision.squadId, revision.envelope))
  )
    return false
  const replaced = revision.decision === 'automatic' && !!(await supersedeGitHubParentText(tx, revision))
  await tx
    .update(githubFeedbackRevisions)
    .set({
      ...(replaced ? {} : { decision: 'pending' as const, decidedByUserId: null, decidedAt: null }),
      decisionVersion: revision.decisionVersion + 1,
      releaseState: replaced ? 'obsolete' : 'held',
      reason: 'parent_content_stale',
      leaseToken: null,
      leaseExpiresAt: null,
      nextAttemptAt: null,
      updatedAt: new Date(),
    })
    .where(eq(githubFeedbackRevisions.id, revision.id))
  return true
}
