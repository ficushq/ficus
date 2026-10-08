import { and, eq, sql } from 'drizzle-orm'
import { db, integrationOutputEvents, githubOutputProofs, githubFeedbackRevisions, inbox, type DbTx } from '../../../db'
import { githubOutputPass, GITHUB_PASS_READ_LIMIT } from './feedback-pass'

type Store = typeof db | DbTx
type Event = typeof integrationOutputEvents.$inferSelect

/** A cache stores immutable payloads, NEVER authorization. Each reuse verifies the current row
 * locally (also in acceptance transactions), then callers recheck trust/material/route/native TTL.
 * A changed snapshot waits for a new pass; it cannot replace reviewed content in this pass.
 */
export function outputSnapshotMatches(event: Event) {
  return and(
    eq(integrationOutputEvents.id, event.id),
    eq(integrationOutputEvents.integration, event.integration),
    eq(integrationOutputEvents.sourceKey, event.sourceKey),
    eq(integrationOutputEvents.eventKey, event.eventKey),
    sql`${integrationOutputEvents.fact} = ${JSON.stringify(event.fact)}::jsonb`,
    sql`${integrationOutputEvents.authority} = ${JSON.stringify(event.authority)}::jsonb`
  )
}

/** This reader materializes at most 25 full event rows per root pass, including raw aliases.
 * ID/equality queries return no body. No network calls or cached decisions occur here.
 */
export async function readOutputEvent(store: Store, id: string): Promise<Event | undefined> {
  const pass = githubOutputPass()
  const key = `event:${id}`
  const cached = pass?.bodies.get(key)
  if (cached) {
    const [current] = await store
      .select({
        id: integrationOutputEvents.id,
        matchedAt: integrationOutputEvents.matchedAt,
        lastErrorCode: integrationOutputEvents.lastErrorCode,
      })
      .from(integrationOutputEvents)
      .where(outputSnapshotMatches(cached))
    return current ? { ...structuredClone(cached), ...current } : undefined
  }
  const [identity] = await store
    .select({ integration: integrationOutputEvents.integration })
    .from(integrationOutputEvents)
    .where(eq(integrationOutputEvents.id, id))
  if (!identity) return undefined
  if (identity.integration === 'github' && !reserveOutputBody()) return undefined
  const [event] = await store
    .select()
    .from(integrationOutputEvents)
    .where(and(eq(integrationOutputEvents.id, id), eq(integrationOutputEvents.integration, identity.integration)))
  if (event?.integration === 'github' && pass) pass.bodies.set(key, structuredClone(event))
  return event
}

/** Materialize a candidate and its ORIGINAL source together, not 25 projections followed by
 * zero remaining source slots. This is preparation only: no access or routing decision is cached.
 */
export async function readOutputCandidate(store: Store, id: string) {
  const pass = githubOutputPass()
  const [identity] = await store
    .select({
      integration: integrationOutputEvents.integration,
      revisionId: sql<string | null>`${integrationOutputEvents.fact}->'github'->>'revisionId'`,
    })
    .from(integrationOutputEvents)
    .where(eq(integrationOutputEvents.id, id))
  if (!identity) return undefined
  const [proof] =
    identity.integration === 'github'
      ? await store
          .select({ sourceId: githubOutputProofs.sourceEventId })
          .from(githubOutputProofs)
          .where(eq(githubOutputProofs.eventId, id))
      : []
  if (identity.integration === 'github' && pass) {
    const ids = new Set([id, ...(proof ? [proof.sourceId] : [])])
    const needed =
      [...ids].filter((eventId) => !pass.bodies.has(`event:${eventId}`)).length +
      (identity.revisionId && !pass.revisions.has(identity.revisionId) ? 1 : 0)
    if (pass.bodyRows + needed > GITHUB_PASS_READ_LIMIT) return undefined
  }
  const event = await readOutputEvent(store, id)
  if (event?.integration === 'github') {
    if (identity.revisionId && !(await readFeedbackRevision(store, identity.revisionId))) return undefined
    if (proof && !(await readOutputEvent(store, proof.sourceId))) return undefined
  }
  return event
}

/** Charge logical full images before I/O, regardless of whether SQL joins/RETURNING could
 * pack several images into one result row. Point identity/equality queries return no bodies.
 */
export function reserveOutputBody(): boolean {
  const pass = githubOutputPass()
  if (!pass) return true
  if (pass.bodyRows >= GITHUB_PASS_READ_LIMIT) return false
  pass.bodyRows++
  return true
}

type Revision = typeof githubFeedbackRevisions.$inferSelect
const mutableRevision = {
  decision: githubFeedbackRevisions.decision,
  decisionVersion: githubFeedbackRevisions.decisionVersion,
  decidedByUserId: githubFeedbackRevisions.decidedByUserId,
  decidedAt: githubFeedbackRevisions.decidedAt,
  releaseState: githubFeedbackRevisions.releaseState,
  reason: githubFeedbackRevisions.reason,
  attempts: githubFeedbackRevisions.attempts,
  nextAttemptAt: githubFeedbackRevisions.nextAttemptAt,
  leaseToken: githubFeedbackRevisions.leaseToken,
  leaseExpiresAt: githubFeedbackRevisions.leaseExpiresAt,
  updatedAt: githubFeedbackRevisions.updatedAt,
}

function revisionSnapshotMatches(revision: Revision) {
  return and(
    eq(githubFeedbackRevisions.id, revision.id),
    eq(githubFeedbackRevisions.objectId, revision.objectId),
    eq(githubFeedbackRevisions.squadId, revision.squadId),
    eq(githubFeedbackRevisions.sequence, revision.sequence),
    eq(githubFeedbackRevisions.contentHash, revision.contentHash),
    eq(githubFeedbackRevisions.normalizationVersion, revision.normalizationVersion),
    eq(githubFeedbackRevisions.byteCount, revision.byteCount),
    eq(githubFeedbackRevisions.attribution, revision.attribution),
    sql`date_trunc('milliseconds', ${githubFeedbackRevisions.firstObservedAt}) = ${revision.firstObservedAt.toISOString()}::timestamptz`,
    sql`${githubFeedbackRevisions.providerVersion} IS NOT DISTINCT FROM ${revision.providerVersion}`,
    sql`${githubFeedbackRevisions.envelope} IS NOT DISTINCT FROM ${revision.envelope === null ? null : JSON.stringify(revision.envelope)}::jsonb`,
    sql`${githubFeedbackRevisions.author} IS NOT DISTINCT FROM ${revision.author === null ? null : JSON.stringify(revision.author)}::jsonb`,
    sql`${githubFeedbackRevisions.editor} IS NOT DISTINCT FROM ${revision.editor === null ? null : JSON.stringify(revision.editor)}::jsonb`,
    sql`${githubFeedbackRevisions.routingProvenance} = ${JSON.stringify(revision.routingProvenance)}::jsonb`
  )
}

/** Immutable reviewed payload cache with fresh decision/lease/retention AND exact immutable
 * equality on EVERY reuse in the caller's transaction. Never caches trust or admission.
 */
export async function readFeedbackRevision(store: Store, id: string, lock = false): Promise<Revision | undefined> {
  const pass = githubOutputPass()
  const cached = pass?.revisions.get(id)
  if (cached) {
    const query = store.select(mutableRevision).from(githubFeedbackRevisions).where(revisionSnapshotMatches(cached))
    const [current] = await (lock ? query.for('update') : query)
    return current ? { ...structuredClone(cached), ...current } : undefined
  }
  if (!reserveOutputBody()) return undefined
  const query = store.select().from(githubFeedbackRevisions).where(eq(githubFeedbackRevisions.id, id))
  const [revision] = await (lock ? query.for('update') : query)
  if (revision && pass) pass.revisions.set(id, structuredClone(revision))
  return revision
}

const UUID_PATTERN = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'

/**
 * The inbox row's integration event id as a uuid, or NULL when the metadata holds no uuid-shaped
 * value. Comparing as uuid lets the events' primary-key index serve every inbox read and write;
 * a `::text` comparison on the key column forced a sequential scan of the whole events table.
 */
export function inboxIntegrationEventId() {
  return sql`(CASE WHEN ${inbox.metadata}->>'integrationEventId' ~ ${UUID_PATTERN} THEN (${inbox.metadata}->>'integrationEventId')::uuid END)`
}

/** The squad id stored in an output event's authority, as a uuid (NULL when absent or malformed). */
export function eventAuthoritySquadId(alias: string) {
  return sql`(CASE WHEN ${sql.raw(alias)}.authority->>'squadId' ~ ${UUID_PATTERN} THEN (${sql.raw(alias)}.authority->>'squadId')::uuid END)`
}

/** Derive the provider from the original server event, never a transported metadata flag. */
export function githubInboxCondition() {
  return sql`EXISTS (SELECT 1 FROM integration_output_events WHERE id = ${inboxIntegrationEventId()} AND integration = 'github')`
}

/** Persisted notification images count too. Cache payload only; every caller still verifies
 * current route/trust/native authority and exact rendered payload under its required locks.
 */
export async function readOutputInbox(store: Store, id: string) {
  const pass = githubOutputPass()
  const cached = pass?.inboxBodies.get(id)
  if (cached) {
    const [current] = await store
      .select({ readAt: inbox.readAt, deliveredAt: inbox.deliveredAt })
      .from(inbox)
      .where(
        and(
          eq(inbox.id, id),
          eq(inbox.recipientType, cached.recipientType),
          eq(inbox.recipientId, cached.recipientId),
          eq(inbox.senderType, cached.senderType),
          sql`${inbox.senderId} IS NOT DISTINCT FROM ${cached.senderId}`,
          sql`${inbox.subject} IS NOT DISTINCT FROM ${cached.subject}`,
          eq(inbox.content, cached.content),
          eq(inbox.deliveryMode, cached.deliveryMode),
          sql`${inbox.idempotencyKey} IS NOT DISTINCT FROM ${cached.idempotencyKey}`,
          sql`${inbox.metadata} IS NOT DISTINCT FROM ${cached.metadata === null ? null : JSON.stringify(cached.metadata)}::jsonb`,
          sql`date_trunc('milliseconds', ${inbox.createdAt}) = ${cached.createdAt.toISOString()}::timestamptz`
        )
      )
    return current ? { ...structuredClone(cached), ...current } : undefined
  }
  const [identity] = await store.select({ github: githubInboxCondition() }).from(inbox).where(eq(inbox.id, id))
  if (!identity || (identity.github && !reserveOutputBody())) return undefined
  const [message] = await store.select().from(inbox).where(eq(inbox.id, id))
  if (message && identity.github && pass) pass.inboxBodies.set(id, structuredClone(message))
  return message
}
