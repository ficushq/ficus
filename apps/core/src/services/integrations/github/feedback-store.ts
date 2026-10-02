import { and, eq } from 'drizzle-orm'
import {
  db,
  githubFeedbackObjects,
  githubFeedbackRevisions,
  githubFeedbackSources,
  integrationOutputEvents,
} from '../../../db'
import type { GitHubFeedbackContent } from '@ficus/shared'
import { githubContentHash } from './feedback-envelope'
import { readCurrentGitHubFeedback } from './feedback-provider'

type Event = typeof integrationOutputEvents.$inferSelect
export interface FeedbackCaptureDependencies {
  /** Must check live connection revision AND exact repository/native resource. No provider I/O under locks. */
  authorizeSource(event: Event): Promise<boolean>
  /** Authenticated current-object read. Null/mismatch/error cannot establish freshness. */
  readCurrent?(event: Event, content: GitHubFeedbackContent): Promise<{ contentHash: string } | null>
  /** Verified native delivery ID, never payload/metadata.synthetic. Poll fingerprints are not transport receipts. */
  transportKey?: string
  routingProvenance?: Array<{ kind: string; id: string }>
}

/**
 * Capture only otherwise-relevant content. Does not decide trust, send, wake, or claim triggers.
 * The immutable revision key is the future admitted event/delivery identity across all sources.
 */
export async function captureGitHubFeedback(eventId: string, deps: FeedbackCaptureDependencies) {
  const [event] = await db.select().from(integrationOutputEvents).where(eq(integrationOutputEvents.id, eventId))
  const content = event?.fact.github?.content
  if (
    !event ||
    event.integration !== 'github' ||
    event.authority.kind !== 'connection' ||
    !content ||
    !(await deps.authorizeSource(event))
  )
    throw new Error('feedback_source_unavailable')
  const squadId = event.authority.squadId
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
  const [knownHead] = beforeRead?.currentRevisionId
    ? await db
        .select({ contentHash: githubFeedbackRevisions.contentHash })
        .from(githubFeedbackRevisions)
        .where(eq(githubFeedbackRevisions.id, beforeRead.currentRevisionId))
    : []
  let currentHash: string | null = null
  if (
    beforeRead &&
    knownHead?.contentHash !== content.contentHash &&
    (!content.providerVersion || content.providerVersion === beforeRead.providerVersion)
  ) {
    try {
      currentHash = (await (deps.readCurrent ?? readCurrentGitHubFeedback)(event, content))?.contentHash ?? null
    } catch {
      /* fail uncertainty closed */
    }
  }
  // The callback's authorization is fresh immediately before entering the transaction.
  if (!(await deps.authorizeSource(event))) throw new Error('feedback_source_unavailable')
  return db.transaction(async (tx) => {
    await tx.insert(githubFeedbackObjects).values(identity).onConflictDoNothing()
    const [object] = await tx.select().from(githubFeedbackObjects).where(condition).for('update')
    if (!object) throw new Error('feedback_capture_failed')
    const [head] = object.currentRevisionId
      ? await tx.select().from(githubFeedbackRevisions).where(eq(githubFeedbackRevisions.id, object.currentRevisionId))
      : []
    let revision =
      head?.contentHash === content.contentHash && head.providerVersion === content.providerVersion ? head : undefined
    let disposition: 'created' | 'replay' | 'held' = revision ? 'replay' : 'created'
    if (transportKey) {
      const receipts = await tx
        .select({ revisionId: githubFeedbackSources.revisionId })
        .from(githubFeedbackSources)
        .innerJoin(githubFeedbackRevisions, eq(githubFeedbackRevisions.id, githubFeedbackSources.revisionId))
        .where(
          and(eq(githubFeedbackRevisions.objectId, object.id), eq(githubFeedbackSources.transportKey, transportKey))
        )
        .limit(1)
      if (receipts.length) {
        const [prior] = await tx
          .select()
          .from(githubFeedbackRevisions)
          .where(eq(githubFeedbackRevisions.id, receipts[0]!.revisionId))
        // A transport identity cannot be reused with different content, even if someone approves it.
        if (!prior || prior.contentHash !== content.contentHash) throw new Error('feedback_transport_conflict')
        revision = prior
        disposition = 'replay'
      }
    }
    if (!revision) {
      const stale = !!(
        object.providerVersion &&
        content.providerVersion &&
        Date.parse(content.providerVersion) < Date.parse(object.providerVersion)
      )
      const ambiguous =
        !!head &&
        (!content.providerVersion || content.providerVersion === object.providerVersion) &&
        (currentHash !== content.contentHash || beforeRead?.currentRevisionId !== object.currentRevisionId)
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
      revision =
        stale || ambiguous
          ? (
              await tx
                .select()
                .from(githubFeedbackRevisions)
                .where(
                  and(
                    eq(githubFeedbackRevisions.objectId, object.id),
                    eq(githubFeedbackRevisions.contentHash, content.contentHash),
                    eq(githubFeedbackRevisions.decision, 'pending'),
                    eq(githubFeedbackRevisions.reason, reason)
                  )
                )
                .limit(1)
            )[0]
          : undefined
      if (revision) disposition = 'replay'
      else {
        const sequence = object.sequence + 1
        const [created] = await tx
          .insert(githubFeedbackRevisions)
          .values({
            objectId: object.id,
            squadId,
            sequence,
            contentHash: content.contentHash,
            normalizationVersion: content.normalizationVersion,
            envelope: content.delivery,
            byteCount: content.byteCount,
            author: content.author,
            editor: content.editor,
            attribution: content.attribution,
            providerVersion: content.providerVersion,
            routingProvenance: deps.routingProvenance ?? [],
            reason,
          })
          .returning()
        revision = created!
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
    await tx
      .insert(githubFeedbackSources)
      .values({
        revisionId: revision.id,
        eventId: event.id,
        squadId,
        authority: event.authority,
        transportKey: transportKey ?? null,
      })
      .onConflictDoNothing()
    return { revision, disposition, canonicalKey: `github-feedback:${squadId}:${revision.id}` }
  })
}

/**
 * Durable delivery alias across transport/connection source rows. Materialization alone never routes.
 * Only explicit human decisions are supported here; automatic admission must first add a fresh-trust
 * guard (and final acceptance recheck) in the admission checkpoint. Markers never confer authority.
 */
export async function recordCanonicalGitHubFeedback(
  revisionId: string,
  sourceEventId: string,
  authorizeSource: (event: Event) => Promise<boolean>
) {
  const [source] = await db.select().from(integrationOutputEvents).where(eq(integrationOutputEvents.id, sourceEventId))
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
    const [revision] = await tx
      .select()
      .from(githubFeedbackRevisions)
      .where(eq(githubFeedbackRevisions.id, revisionId))
      .for('update')
    if (
      !revision ||
      revision.squadId !== association.squadId ||
      !['allow_once', 'allow_trust'].includes(revision.decision) ||
      !revision.envelope ||
      revision.reason === 'content_unavailable'
    )
      throw new Error('feedback_not_admitted')
    const sourceKey = `github-feedback:${revision.squadId}:${revision.id}`
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
      .returning()
    const event =
      inserted ??
      (
        await tx
          .select()
          .from(integrationOutputEvents)
          .where(
            and(
              eq(integrationOutputEvents.integration, 'github'),
              eq(integrationOutputEvents.sourceKey, sourceKey),
              eq(integrationOutputEvents.eventKey, revision.id)
            )
          )
      )[0]!
    await tx
      .insert(githubFeedbackSources)
      .values({ revisionId: revision.id, eventId: event.id, squadId: revision.squadId, authority: event.authority })
      .onConflictDoNothing()
    return event
  })
}
