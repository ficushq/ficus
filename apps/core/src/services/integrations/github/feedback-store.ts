import { and, eq, inArray, or } from 'drizzle-orm'
import {
  db,
  githubFeedbackObjects,
  githubFeedbackRevisions,
  githubFeedbackSources,
  integrationOutputEvents,
  type DbTx,
} from '../../../db'
import type { GitHubEditorVerification, GitHubFeedbackContent, IntegrationOutputFact } from '@ficus/shared'
import { readOutputEvent, readFeedbackRevision } from './feedback-pass-read'
import { githubContentHash, githubParentTextContent, withGitHubEditorVerification } from './feedback-envelope'
import { readCurrentGitHubFeedback } from './feedback-provider'
import { GitHubApiUnavailableError } from '../../github/api-client'
import { lockGitHubTrustAuthority } from './trust-authority-lock'
import { isTrustedGitHubFeedbackContent, resolveGitHubAuthorTrust } from './feedback-trust'
import {
  githubEditHistoryTarget,
  githubParentEditHistoryTarget,
  type GitHubEditHistoryTarget,
} from './feedback-edit-history'
import { isGitHubAuthorFilterEnabled } from './author-filter'
import { isGitHubQuotedParentFresh } from './feedback-parent'
import { isCurrentGitHubFeedbackRevision, obsoleteOlderGitHubFeedback } from './feedback-obsolescence'
import { squads } from '../../../db/schema'

type Event = typeof integrationOutputEvents.$inferSelect
export interface FeedbackCaptureDependencies {
  /** Internal OFF observation only. No author checks/history I/O; never grants canonical approval. */
  unfiltered?: 'content' | 'parent'
  /** Filtered: live connection AND exact native resource. OFF: local connection authority only. */
  authorizeSource(event: Event): Promise<boolean>
  /**
   * Authenticated current-object read. Null/mismatch/error cannot establish freshness. A
   * {@link GitHubApiUnavailableError} (GitHub could not answer) defers the capture instead.
   */
  readCurrent?(event: Event, content: GitHubFeedbackContent): Promise<{ contentHash: string } | null>
  /** Verified native delivery ID, never payload/metadata.synthetic. Poll fingerprints are not transport receipts. */
  transportKey?: string
  /** Storage-only quarantine when exact native ownership/access could not be witnessed. */
  holdReason?: 'source_unverified'
  routingProvenance?: Array<import('@ficus/shared').GitHubFeedbackRoute>
  /** Internal live-trust resolver, only for a new, unambiguous capture; never transported approval. */
  decideFresh?(tx: DbTx, squadId: string, content: GitHubFeedbackContent): Promise<boolean>
  /** Queue a decision-model screen for a NEW held revision, in the capture transaction. Never releases. */
  queueScreening?(tx: DbTx, revision: typeof githubFeedbackRevisions.$inferSelect): Promise<unknown>
  /**
   * Internal live trust-and-provenance check for an action's parent title/description, only for a
   * new capture under the authority lock. False (or absent) captures the factual message.
   */
  decideParent?(tx: DbTx, squadId: string, content: GitHubFeedbackContent): Promise<boolean>
  /**
   * Authenticated edit-history read for content whose editors the observation does not prove (see
   * `feedback-edit-history.ts`). Provider I/O before any lock. Null leaves the content unattributed
   * (held); a {@link GitHubApiUnavailableError} defers the capture.
   */
  verifyEditors?(event: Event, target: GitHubEditHistoryTarget): Promise<GitHubEditorVerification | null>
}

/**
 * The same immutable content as an already captured revision: same author, text and review state.
 * A later observation of it (a poll racing a webhook, a webhook redelivery, a no-op edit) is a
 * replay of that revision, never a new held version of content already decided.
 */
function sameCapturedText(
  captured: { author: { accountId: string } | null; envelope: IntegrationOutputFact | null } | undefined,
  content: GitHubFeedbackContent
): boolean {
  return (
    !!captured?.envelope &&
    !!content.delivery &&
    content.objectKind !== 'action' &&
    !!content.author &&
    captured.author?.accountId === content.author.accountId &&
    githubContentHash([captured.envelope.data.content, captured.envelope.data.state]) ===
      githubContentHash([content.delivery.data.content, content.delivery.data.state])
  )
}

/** GitHub could not answer: nothing is written; the caller retries this capture later. */
async function readProvider<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read()
  } catch (error) {
    if (error instanceof GitHubApiUnavailableError) throw new Error('feedback_provider_unavailable')
    // Any other failure is uncertainty: fail closed (held for review).
    return null
  }
}

/**
 * Capture only otherwise-relevant content. An internal live-trust resolver may decide a NEW
 * unambiguous version under the authority lock. Pending history is never upgraded on replay.
 * Does not send, wake, route, or claim triggers. The revision key is stable across source transports.
 * An action offering parent text has two candidate hashes (factual, with parent text); a replay of
 * either is the same observation, and only a NEW revision chooses between them.
 */
export async function captureGitHubFeedback(eventId: string, deps: FeedbackCaptureDependencies) {
  const event = await readOutputEvent(db, eventId)
  const unfiltered = deps.unfiltered !== undefined
  if (
    unfiltered &&
    (deps.readCurrent || deps.verifyEditors || deps.decideFresh || deps.decideParent || deps.queueScreening)
  )
    throw new Error('invalid_unfiltered_capture')
  const observed = deps.unfiltered === 'parent' ? event?.fact.github?.rawParent : event?.fact.github?.content
  if (
    !event ||
    event.integration !== 'github' ||
    event.authority.kind !== 'connection' ||
    !observed ||
    !(await deps.authorizeSource(event))
  )
    throw new Error('feedback_source_unavailable')
  const squadId = event.authority.squadId
  let content = observed
  const transportKey =
    deps.transportKey ??
    (event.fact.github?.observation?.kind === 'webhook' ? event.fact.github.observation.deliveryId : undefined)
  // Source-bound quarantine, not an inferred provider ID or username. No cross-source approval reuse.
  const identity = {
    squadId,
    repositoryId: content.repositoryId ?? `unknown:${event.id}`,
    objectKind: content.objectKind,
    nativeId: content.nativeId ?? `unknown:${event.id}`,
  }
  const condition = and(
    eq(githubFeedbackObjects.squadId, squadId),
    eq(githubFeedbackObjects.repositoryId, identity.repositoryId),
    eq(githubFeedbackObjects.objectKind, identity.objectKind),
    eq(githubFeedbackObjects.nativeId, identity.nativeId)
  )
  const [beforeRead] = await db.select().from(githubFeedbackObjects).where(condition)
  const knownHead = beforeRead?.currentRevisionId
    ? await readFeedbackRevision(db, beforeRead.currentRevisionId)
    : undefined
  if (beforeRead?.currentRevisionId && !knownHead) throw new Error('feedback_capacity_deferred')
  // Already captured text needs no provider work: the transaction replays that revision.
  const known = sameCapturedText(knownHead, content)
  // Edit history is read only when it could matter: for content (or quoted parent text) whose
  // author is trusted right now. Trust is decided again under the authority lock.
  const trusted = async (accountId: string) => (await resolveGitHubAuthorTrust(db, squadId, accountId)).length > 0
  const target =
    known || !deps.verifyEditors ? null : githubEditHistoryTarget(content, event.fact.github?.observation?.kind)
  if (target && (await trusted(target.author.accountId))) {
    const verification = await readProvider(() => deps.verifyEditors!(event, target))
    content = (verification && withGitHubEditorVerification(content, verification)) ?? content
  }
  const parentTarget = deps.verifyEditors ? githubParentEditHistoryTarget(content) : null
  if (parentTarget && content.parentText && (await trusted(parentTarget.author.accountId))) {
    const verification = await readProvider(() => deps.verifyEditors!(event, parentTarget))
    // Parent text is quoted as WRITTEN BY its author: only their own edits keep that true.
    if (verification?.editors.every((editor) => editor.accountId === parentTarget.author.accountId))
      content = { ...content, parentText: { ...content.parentText, unchanged: true } }
  }
  const withParent = githubParentTextContent(content)
  const hashes = new Set([content.contentHash, ...(withParent ? [withParent.contentHash] : [])])
  let currentHash: string | null = null
  if (
    !unfiltered &&
    beforeRead &&
    !known &&
    !hashes.has(knownHead?.contentHash ?? '') &&
    (!content.providerVersion || content.providerVersion === beforeRead.providerVersion)
  ) {
    const verified = content
    currentHash =
      (await readProvider(() => (deps.readCurrent ?? readCurrentGitHubFeedback)(event, verified)))?.contentHash ?? null
  }
  // The callback's authorization is fresh immediately before entering the transaction.
  if (!(await deps.authorizeSource(event))) throw new Error('feedback_source_unavailable')
  return db.transaction(async (tx) => {
    // Even storage-only captures must fence every final acceptance of an older revision.
    await lockGitHubTrustAuthority(tx)
    // The relevance read happened before provider I/O; a human may have turned the filter OFF
    // since. Serialize with that toggle (it updates the squad row) and never hold an event the
    // squad no longer filters: the caller routes it raw instead.
    await tx.select({ id: squads.id }).from(squads).where(eq(squads.id, squadId)).for('share')
    const enabled = await isGitHubAuthorFilterEnabled(tx, squadId)
    if (!unfiltered && !enabled) throw new Error('feedback_filter_disabled')
    if (unfiltered && enabled) throw new Error('feedback_filter_enabled')
    // OFF uses only a local authority callback; final freshness effects serialize with rotation.
    if (unfiltered && !(await deps.authorizeSource(event))) throw new Error('feedback_source_unavailable')
    await tx.insert(githubFeedbackObjects).values(identity).onConflictDoNothing()
    const [object] = await tx.select().from(githubFeedbackObjects).where(condition).for('update')
    if (!object) throw new Error('feedback_capture_failed')
    const head = object.currentRevisionId ? await readFeedbackRevision(tx, object.currentRevisionId) : undefined
    if (object.currentRevisionId && !head) throw new Error('feedback_capacity_deferred')
    let revision =
      head &&
      ((hashes.has(head.contentHash) && head.providerVersion === content.providerVersion) ||
        sameCapturedText(head, content))
        ? head
        : undefined
    let disposition: 'created' | 'replay' | 'held' = revision ? 'replay' : 'created'
    const receipts = await tx
      .select({ revisionId: githubFeedbackSources.revisionId })
      .from(githubFeedbackSources)
      .innerJoin(githubFeedbackRevisions, eq(githubFeedbackRevisions.id, githubFeedbackSources.revisionId))
      .where(
        and(
          eq(githubFeedbackRevisions.objectId, object.id),
          or(
            eq(githubFeedbackSources.eventId, event.id),
            transportKey ? eq(githubFeedbackSources.transportKey, transportKey) : undefined
          )
        )
      )
      .limit(1)
    if (receipts.length) {
      const prior = await readFeedbackRevision(tx, receipts[0]!.revisionId)
      // A stored event or transport identity cannot be reused with different content, even if someone approves it.
      // The same text attributed again (edit history read anew) is still the same delivery.
      if (!prior || (!hashes.has(prior.contentHash) && !sameCapturedText(prior, content)))
        throw new Error('feedback_transport_conflict')
      revision = prior
      disposition = 'replay'
    }

    if (!revision) {
      const stale = !!(
        object.providerVersion &&
        content.providerVersion &&
        Date.parse(content.providerVersion) < Date.parse(object.providerVersion)
      )
      const ambiguous =
        !unfiltered &&
        !!head &&
        (!content.providerVersion || content.providerVersion === object.providerVersion) &&
        (!hashes.has(currentHash ?? '') || beforeRead?.currentRevisionId !== object.currentRevisionId)
      const previouslyHeld =
        head?.decision === 'pending' &&
        head.envelope &&
        content.delivery &&
        githubContentHash([head.envelope.data.content, head.envelope.data.state]) ===
          githubContentHash([content.delivery.data.content, content.delivery.data.state])
      const reason =
        content.reason ??
        (!content.repositoryId || !content.nativeId
          ? 'unknown_identity'
          : previouslyHeld
            ? 'previously_held'
            : deps.holdReason
              ? deps.holdReason
              : stale
                ? 'stale_observation'
                : ambiguous
                  ? 'ambiguous_observation'
                  : content.attribution === 'unknown'
                    ? 'unknown_editor'
                    : !content.author
                      ? 'unknown_author'
                      : 'untrusted_author')
      // Retries of a held ambiguous/stale observation stay pending; never strengthen history.
      const priorIdentity =
        stale || ambiguous
          ? (
              await tx
                .select({ id: githubFeedbackRevisions.id })
                .from(githubFeedbackRevisions)
                .where(
                  and(
                    eq(githubFeedbackRevisions.objectId, object.id),
                    inArray(githubFeedbackRevisions.contentHash, [...hashes]),
                    eq(githubFeedbackRevisions.decision, 'pending'),
                    eq(githubFeedbackRevisions.reason, reason)
                  )
                )
                .limit(1)
            )[0]
          : undefined
      revision = priorIdentity ? await readFeedbackRevision(tx, priorIdentity.id) : undefined
      if (priorIdentity && !revision) throw new Error('feedback_capacity_deferred')
      if (revision) disposition = 'replay'
      else {
        const sequence = object.sequence + 1
        // The parent's text is captured only if its author is trusted now and provably wrote it;
        // otherwise (untrusted, unverifiable, edited by someone else) the factual message is.
        const chosen =
          !unfiltered && withParent && deps.decideParent && (await deps.decideParent(tx, squadId, content))
            ? withParent
            : content
        // Only the first capture may be automatic. Pending replay or stronger evidence never upgrades history.
        const automatic =
          !unfiltered &&
          reason === 'untrusted_author' &&
          !!chosen.delivery &&
          !!(await deps.decideFresh?.(tx, squadId, chosen))
        // Held although its author is trusted: someone in its verified edit history is not.
        const heldReason =
          !automatic &&
          reason === 'untrusted_author' &&
          deps.decideFresh &&
          chosen.attribution === 'verified_edit' &&
          (await resolveGitHubAuthorTrust(tx, squadId, chosen.author?.accountId)).length
            ? 'untrusted_editor'
            : reason
        const [created] = await tx
          .insert(githubFeedbackRevisions)
          .values({
            objectId: object.id,
            squadId,
            sequence,
            contentHash: chosen.contentHash,
            normalizationVersion: chosen.normalizationVersion,
            envelope: chosen.delivery,
            byteCount: chosen.byteCount,
            author: chosen.author,
            editor: chosen.editor,
            attribution: chosen.attribution,
            providerVersion: chosen.providerVersion,
            routingProvenance: deps.routingProvenance ?? [],
            reason: unfiltered ? 'filter_disabled' : automatic ? 'trusted_author' : heldReason,
            decision: unfiltered ? 'historical' : automatic ? 'automatic' : 'pending',
            releaseState: unfiltered ? 'retained' : automatic ? 'ready' : 'held',
          })
          .returning({ id: githubFeedbackRevisions.id })
        revision = await readFeedbackRevision(tx, created!.id)
        if (!revision) throw new Error('feedback_capacity_deferred')
        await tx
          .update(githubFeedbackObjects)
          .set({
            sequence,
            ...(!stale && !ambiguous
              ? { currentRevisionId: revision.id, providerVersion: content.providerVersion }
              : {}),
          })
          .where(eq(githubFeedbackObjects.id, object.id))
        if (stale || ambiguous) disposition = 'held'
      }
    }
    // A no-op text replay keeps its decision and immutable revision, but its newer provider clock
    // is still knowledge: delayed intermediate text must never outrank this known current content.
    if (
      disposition === 'replay' &&
      revision.id === object.currentRevisionId &&
      content.providerVersion &&
      (!object.providerVersion || Date.parse(content.providerVersion) > Date.parse(object.providerVersion))
    )
      await tx
        .update(githubFeedbackObjects)
        .set({ providerVersion: content.providerVersion })
        .where(eq(githubFeedbackObjects.id, object.id))
    const obsoleteCount = await obsoleteOlderGitHubFeedback(tx, object.id)
    const reconciled = await readFeedbackRevision(tx, revision.id)
    if (!reconciled) throw new Error('feedback_capacity_deferred')
    revision = reconciled
    if (
      disposition !== 'replay' &&
      revision.decision === 'pending' &&
      revision.releaseState !== 'obsolete' &&
      deps.queueScreening
    )
      await deps.queueScreening(tx, revision)
    await tx
      .insert(githubFeedbackSources)
      .values({
        revisionId: revision.id,
        eventId: event.id,
        squadId,
        authority: event.authority,
        transportKey: transportKey ?? null,
        unfiltered,
      })
      .onConflictDoNothing()
    return { revision, disposition, obsoleteCount, canonicalKey: `github-feedback:${squadId}:${revision.id}` }
  })
}

/**
 * Durable delivery alias across transport/connection source rows. Materialization alone never routes.
 * Human decisions bind the stored snapshot; automatic decisions additionally require live author/editor
 * trust. This is materialization, not acceptance; final effect seams must recheck. Markers confer no authority.
 */
export async function recordCanonicalGitHubFeedback(
  revisionId: string,
  sourceEventId: string,
  authorizeSource: (event: Event, store?: typeof db | DbTx) => Promise<boolean>
) {
  const source = await readOutputEvent(db, sourceEventId)
  const [association] = await db
    .select()
    .from(githubFeedbackSources)
    .where(and(eq(githubFeedbackSources.revisionId, revisionId), eq(githubFeedbackSources.eventId, sourceEventId)))
  if (
    !source ||
    source.integration !== 'github' ||
    source.authority.kind !== 'connection' ||
    !association ||
    association.squadId !== source.authority.squadId ||
    !(await authorizeSource(source))
  )
    throw new Error('feedback_source_unavailable')
  return db.transaction(async (tx) => {
    const { lockGitHubOutputAuthority } = await import('./feedback-routing')
    await lockGitHubOutputAuthority(tx, source)
    // The callback is LOCAL-only; native preparation belongs outside this transaction.
    if (!(await authorizeSource(source, tx))) throw new Error('feedback_source_unavailable')
    const revision = await readFeedbackRevision(tx, revisionId, true)
    if (
      !revision ||
      revision.squadId !== association.squadId ||
      revision.releaseState === 'obsolete' ||
      !(await isCurrentGitHubFeedbackRevision(tx, revision.id)) ||
      !(await isGitHubQuotedParentFresh(tx, revision.squadId, revision.envelope)) ||
      !['allow_once', 'allow_trust', 'screened', 'automatic'].includes(revision.decision) ||
      (revision.decision === 'automatic' && !(await isTrustedGitHubFeedbackContent(tx, revision.squadId, revision))) ||
      !revision.envelope ||
      revision.reason === 'content_unavailable'
    )
      throw new Error('feedback_not_admitted')
    const sourceKey = `github-feedback:${revision.squadId}:${revision.id}`
    const [existing] = await tx
      .select({ id: integrationOutputEvents.id })
      .from(integrationOutputEvents)
      .where(
        and(
          eq(integrationOutputEvents.integration, 'github'),
          eq(integrationOutputEvents.sourceKey, sourceKey),
          eq(integrationOutputEvents.eventKey, revision.id)
        )
      )
    // Dedupe may adopt an already-canonical original authority; a different account/material
    // cannot become the FIRST authority for an approval captured under another source.
    const pinned = revision.routingProvenance.filter((route) => route.authorityHash)
    if (
      !existing &&
      pinned.length &&
      !pinned.some((route) => route.authorityHash === githubContentHash(source.authority))
    )
      throw new Error('feedback_source_unavailable')
    const [inserted] = await tx
      .insert(integrationOutputEvents)
      .values({
        integration: 'github',
        sourceKey,
        eventKey: revision.id,
        authority: source.authority,
        createdAt: revision.firstObservedAt,
        fact: {
          ...revision.envelope,
          eventKey: revision.id,
          github: { content: null, status: null, revisionId: revision.id },
        },
      })
      .onConflictDoNothing()
      .returning({ id: integrationOutputEvents.id })
    const identity =
      inserted ??
      (
        await tx
          .select({ id: integrationOutputEvents.id })
          .from(integrationOutputEvents)
          .where(
            and(
              eq(integrationOutputEvents.integration, 'github'),
              eq(integrationOutputEvents.sourceKey, sourceKey),
              eq(integrationOutputEvents.eventKey, revision.id)
            )
          )
      )[0]!
    const event = await readOutputEvent(tx, identity.id)
    if (!event) throw new Error('feedback_capacity_deferred')
    await tx
      .insert(githubFeedbackSources)
      .values({ revisionId: revision.id, eventId: event.id, squadId: revision.squadId, authority: event.authority })
      .onConflictDoNothing()
    return event
  })
}
