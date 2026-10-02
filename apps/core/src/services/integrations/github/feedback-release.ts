import { and, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import {
  db,
  githubFeedbackRevisions,
  githubFeedbackSources,
  integrationOutputEvents,
  integrationOutputDeliveries,
  inbox,
  chatSendReceipts,
} from '../../../db'
import { recordCanonicalGitHubFeedback } from './feedback-store'
import { isGitHubFeedbackAdmitted } from './feedback-admission'
import { lockGitHubTrustAuthority } from './trust-authority-lock'
import { isTrustedGitHubFeedbackContent } from './feedback-trust'

type Event = typeof integrationOutputEvents.$inferSelect
const reasons = [
  'recipient_waiting',
  'routing_changed',
  'recipient_changed',
  'subscription_changed',
  'work_stream_ended',
  'paused',
  'parked',
  'unrelated_wait',
  'awaiting_acceptance',
] as const
export interface GitHubFeedbackReleaseDependencies {
  /** Live material revision AND exact native resource. No I/O while holding moderation/claim locks. */
  authorizeSource(event: Event): Promise<boolean>
  /** Must enforce stored audience provenance and recheck every effect and final acceptance seam. */
  route(
    event: Event,
    provenance: Array<import('@ficus/shared').GitHubFeedbackRoute>
  ): Promise<void | { state: 'retained' | 'obsolete'; reason: (typeof reasons)[number] }>
}

/**
 * A deliveredAt claim is NOT a delivery receipt. Require durable agent queue acceptance of every
 * non-owner target. This also closes the crash after acceptance / before release settlement gap.
 * Routing must use these stable client IDs for default mail, and the existing output ID for flow mail.
 */
export async function hasAcceptedGitHubFeedbackReceipts(eventId: string): Promise<boolean> {
  const [event] = await db
    .select({ matchedAt: integrationOutputEvents.matchedAt })
    .from(integrationOutputEvents)
    .where(eq(integrationOutputEvents.id, eventId))
  // A first successful target cannot settle a partially failed routing pass with other unseen targets.
  if (!event?.matchedAt) return false
  const notices = await db
    .select({ id: inbox.id, recipientId: inbox.recipientId, metadata: inbox.metadata })
    .from(inbox)
    .where(
      and(
        eq(inbox.senderType, 'system'),
        eq(inbox.recipientType, 'agent'),
        sql`${inbox.metadata}->>'integrationEventId' = ${eventId}`,
        sql`${inbox.metadata}->>'integrationOwnerNotice' IS DISTINCT FROM 'true'`
      )
    )
  if (!notices.length) return false
  const deliveries = await db
    .select({ status: integrationOutputDeliveries.status, targets: integrationOutputDeliveries.targets })
    .from(integrationOutputDeliveries)
    .where(eq(integrationOutputDeliveries.eventId, eventId))
  if (
    deliveries.some(
      (delivery) =>
        delivery.status !== 'superseded' &&
        (!delivery.targets.length ||
          delivery.targets.some(
            (target) => !notices.some((notice) => notice.id === target.inboxId && notice.recipientId === target.agentId)
          ))
    )
  )
    return false
  for (const notice of notices) {
    const deliveryId = notice.metadata?.integrationDeliveryId
    const clientId =
      typeof deliveryId === 'string'
        ? `integration-output:${deliveryId}:${notice.id}`
        : `github-feedback:${eventId}:${notice.id}`
    const [receipt] = await db
      .select({
        messageId: chatSendReceipts.messageId,
        executionId: chatSendReceipts.executionId,
        acceptedAt: chatSendReceipts.acceptedAt,
      })
      .from(chatSendReceipts)
      .where(
        and(
          eq(chatSendReceipts.agentId, notice.recipientId),
          eq(chatSendReceipts.clientId, clientId),
          eq(chatSendReceipts.state, 'accepted')
        )
      )
    if (!receipt?.messageId || !receipt.executionId || !receipt.acceptedAt) return false
  }
  return true
}

/** Bounded lease/CAS worker. No timers, raw-error persistence, routing on pending history, or delivered-on-enqueue. */
export async function releaseGitHubFeedback(
  deps: GitHubFeedbackReleaseDependencies,
  options: { limit?: number; revisionIds?: string[] } = {}
): Promise<number> {
  const limit = options.limit ?? 25
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 25 ||
    (options.revisionIds &&
      (options.revisionIds.length > 25 || options.revisionIds.some((id) => !z.string().uuid().safeParse(id).success)))
  )
    throw new Error('invalid_release_batch')
  if (options.revisionIds?.length === 0) return 0
  const due = () =>
    and(
      inArray(githubFeedbackRevisions.decision, ['automatic', 'allow_once', 'allow_trust']),
      inArray(githubFeedbackRevisions.releaseState, ['ready', 'retry', 'retained']),
      or(
        isNull(githubFeedbackRevisions.nextAttemptAt),
        lte(githubFeedbackRevisions.nextAttemptAt, sql`clock_timestamp()`)
      ),
      or(
        isNull(githubFeedbackRevisions.leaseExpiresAt),
        lte(githubFeedbackRevisions.leaseExpiresAt, sql`clock_timestamp()`)
      ),
      options.revisionIds ? inArray(githubFeedbackRevisions.id, options.revisionIds) : undefined
    )
  const candidates = await db
    .select({ id: githubFeedbackRevisions.id })
    .from(githubFeedbackRevisions)
    .where(due())
    .orderBy(githubFeedbackRevisions.firstObservedAt, githubFeedbackRevisions.id)
    .limit(limit)
  let claimed = 0
  for (const { id } of candidates) {
    const leaseToken = crypto.randomUUID()
    const [revision] = await db
      .update(githubFeedbackRevisions)
      .set({
        leaseToken,
        leaseExpiresAt: sql`clock_timestamp() + interval '60 seconds'`,
        attempts: sql`${githubFeedbackRevisions.attempts} + 1`,
        updatedAt: new Date(),
      })
      .where(and(eq(githubFeedbackRevisions.id, id), due()))
      .returning()
    if (!revision) continue
    claimed++
    let state: 'retained' | 'retry' | 'obsolete' | 'delivered' = 'retained'
    let reason: string | null = 'source_unavailable'
    let canonical: Event | undefined
    try {
      ;[canonical] = await db
        .select()
        .from(integrationOutputEvents)
        .where(
          and(
            eq(integrationOutputEvents.integration, 'github'),
            eq(integrationOutputEvents.sourceKey, `github-feedback:${revision.squadId}:${revision.id}`),
            eq(integrationOutputEvents.eventKey, revision.id)
          )
        )
      // Irreversible accepted evidence is settlement, not a new effect or revocation bypass.
      if (canonical && (await hasAcceptedGitHubFeedbackReceipts(canonical.id))) {
        state = 'delivered'
        reason = null
      } else {
        const sources = await db
          .select({ event: integrationOutputEvents })
          .from(githubFeedbackSources)
          .innerJoin(integrationOutputEvents, eq(integrationOutputEvents.id, githubFeedbackSources.eventId))
          .where(
            and(
              eq(githubFeedbackSources.revisionId, id),
              sql`${integrationOutputEvents.sourceKey} NOT LIKE 'github-feedback:%'`
            )
          )
          .orderBy(githubFeedbackSources.observedAt)
          .limit(8)
        for (const { event } of sources) {
          if (!(await deps.authorizeSource(event))) continue
          canonical = await recordCanonicalGitHubFeedback(revision.id, event.id, deps.authorizeSource)
          break
        }
        // Another currently-readable source never blesses the canonical event's retained original authority.
        if (canonical && (await deps.authorizeSource(canonical))) {
          if (!(await isGitHubFeedbackAdmitted(db, canonical))) reason = 'feedback_not_admitted'
          else {
            const outcome = await deps.route(canonical, revision.routingProvenance)
            state = outcome && outcome.state === 'obsolete' ? 'obsolete' : 'retained'
            reason = outcome && reasons.includes(outcome.reason) ? outcome.reason : 'awaiting_acceptance'
            if (await hasAcceptedGitHubFeedbackReceipts(canonical.id)) {
              state = 'delivered'
              reason = null
            }
          }
        }
      }
    } catch (error) {
      state = 'retry'
      reason =
        error instanceof Error && error.message === 'feedback_not_admitted'
          ? 'feedback_not_admitted'
          : 'release_routing_failed'
      if (canonical && (await hasAcceptedGitHubFeedbackReceipts(canonical.id))) {
        state = 'delivered'
        reason = null
      }
    }
    await db.transaction(async (tx) => {
      await lockGitHubTrustAuthority(tx)
      const [current] = await tx
        .select()
        .from(githubFeedbackRevisions)
        .where(and(eq(githubFeedbackRevisions.id, id), eq(githubFeedbackRevisions.leaseToken, leaseToken)))
        .for('update')
      if (!current) return // The lease was authoritatively taken over; a stale worker cannot settle it.
      const revoked =
        current.decision === 'automatic' &&
        state !== 'delivered' &&
        !(await isTrustedGitHubFeedbackContent(tx, current.squadId, current))
      await tx
        .update(githubFeedbackRevisions)
        .set({
          ...(revoked ? { decision: 'pending' as const, decisionVersion: current.decisionVersion + 1 } : {}),
          releaseState: revoked ? 'held' : state,
          reason: revoked ? 'trust_revoked' : reason,
          leaseToken: null,
          leaseExpiresAt: null,
          nextAttemptAt:
            revoked || state === 'delivered' || state === 'obsolete'
              ? null
              : sql`clock_timestamp() + interval '30 seconds'`,
          updatedAt: new Date(),
        })
        .where(and(eq(githubFeedbackRevisions.id, id), eq(githubFeedbackRevisions.leaseToken, leaseToken)))
    })
  }
  return claimed
}
