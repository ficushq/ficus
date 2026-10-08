import { and, eq, inArray, isNull, lte, ne, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import {
  db,
  githubFeedbackRevisions,
  githubFeedbackSources,
  integrationOutputEvents,
  integrationOutputDeliveries,
  integrationOutputTriggerRuns,
  inbox,
  chatSendReceipts,
} from '../../../db'
import { eventEmitter } from '../../../lib/infra/event-emitter'
import { readOutputEvent, readFeedbackRevision } from './feedback-pass-read'
import { withGitHubOutputPass, withGitHubCandidate, reserveGitHubLookahead } from './feedback-pass'
import { githubContentHash } from './feedback-envelope'
import { recordCanonicalGitHubFeedback } from './feedback-store'
import { isGitHubFeedbackAdmitted } from './feedback-admission'
import { lockGitHubTrustAuthority } from './trust-authority-lock'
import { isTrustedGitHubFeedbackContent } from './feedback-trust'

type Event = typeof integrationOutputEvents.$inferSelect
const reasons = [
  'recipient_waiting',
  'recipient_changed',
  'subscription_changed',
  'work_stream_ended',
  'paused',
  'parked',
  'unrelated_wait',
  'awaiting_acceptance',
  'no_current_recipient',
] as const
export interface GitHubFeedbackReleaseDependencies {
  /** Live material revision AND exact native resource. No I/O while holding moderation/claim locks. */
  authorizeSource(event: Event, store?: typeof db | import('../../../db').DbTx): Promise<boolean>
  /** Optional for primitive callers; production must prepare native witnesses OUTSIDE all locks. */
  prepareSource?(event: Event): Promise<boolean | { state: 'retained' | 'obsolete'; reason: (typeof reasons)[number] }>
  /** Normal output routing at release time: current recipients, every effect/acceptance seam rechecked. */
  route(event: Event): Promise<void | { state: 'retained' | 'obsolete'; reason: (typeof reasons)[number] }>
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

/**
 * Release-time routing completed and nobody currently receives the event: no notice, live flow
 * delivery or trigger receipt exists. This is terminal (nothing to retry), not a delivery claim.
 */
export async function isGitHubFeedbackRoutedNowhere(eventId: string): Promise<boolean> {
  const [event] = await db
    .select({ matchedAt: integrationOutputEvents.matchedAt })
    .from(integrationOutputEvents)
    .where(eq(integrationOutputEvents.id, eventId))
  if (!event?.matchedAt) return false
  const [notice] = await db
    .select({ id: inbox.id })
    .from(inbox)
    .where(sql`${inbox.metadata}->>'integrationEventId' = ${eventId}`)
    .limit(1)
  if (notice) return false
  const [delivery] = await db
    .select({ id: integrationOutputDeliveries.id })
    .from(integrationOutputDeliveries)
    .where(and(eq(integrationOutputDeliveries.eventId, eventId), ne(integrationOutputDeliveries.status, 'superseded')))
    .limit(1)
  if (delivery) return false
  const [trigger] = await db
    .select({ triggerId: integrationOutputTriggerRuns.triggerId })
    .from(integrationOutputTriggerRuns)
    .where(eq(integrationOutputTriggerRuns.eventId, eventId))
    .limit(1)
  return !trigger
}

/** Bounded lease/CAS worker. No timers, raw-error persistence, routing on pending history, or delivered-on-enqueue. */
export async function releaseGitHubFeedback(
  deps: GitHubFeedbackReleaseDependencies,
  options: { limit?: number; revisionIds?: string[] } = {}
): Promise<number> {
  return withGitHubOutputPass(() => releaseInPass(deps, options))
}

async function releaseInPass(
  deps: GitHubFeedbackReleaseDependencies,
  options: { limit?: number; revisionIds?: string[] }
) {
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
  const selectionLimit = reserveGitHubLookahead(limit)
  if (!selectionLimit) return 0
  // Fresh approvals (`ready`) go before rows that are retrying or retained, so a backlog of
  // releases waiting on a paused stream never delays a new human decision.
  const candidates = await db
    .select({ id: githubFeedbackRevisions.id })
    .from(githubFeedbackRevisions)
    .where(due())
    .orderBy(
      sql`CASE ${githubFeedbackRevisions.releaseState} WHEN 'ready' THEN 0 WHEN 'retry' THEN 1 ELSE 2 END`,
      sql`${githubFeedbackRevisions.nextAttemptAt} NULLS FIRST`,
      githubFeedbackRevisions.id
    )
    .limit(selectionLimit)
  let claimed = 0
  for (const { id } of candidates) {
    await withGitHubCandidate(async () => {
      const leaseToken = crypto.randomUUID()
      const before = await readFeedbackRevision(db, id)
      if (!before) return
      const [leased] = await db
        .update(githubFeedbackRevisions)
        .set({
          leaseToken,
          leaseExpiresAt: sql`clock_timestamp() + interval '60 seconds'`,
          attempts: sql`${githubFeedbackRevisions.attempts} + 1`,
          updatedAt: new Date(),
        })
        .where(and(eq(githubFeedbackRevisions.id, id), due()))
        .returning({ id: githubFeedbackRevisions.id })
      if (!leased) return
      const revision = await readFeedbackRevision(db, id)
      if (!revision) return
      claimed++
      let state: 'retained' | 'retry' | 'obsolete' | 'delivered' = 'retained'
      let reason: string | null = 'source_unavailable'
      let canonical: Event | undefined
      // Preparation may change settlement state; keep the check outside caller control-flow narrowing.
      const isObsolete = () => state === 'obsolete'
      async function prepared(event: Event) {
        const outcome = await deps.prepareSource?.(event)
        if (outcome && typeof outcome === 'object') {
          state = outcome.state
          reason = outcome.reason
          return false
        }
        return outcome !== false
      }
      try {
        const [canonicalId] = await db
          .select({ id: integrationOutputEvents.id })
          .from(integrationOutputEvents)
          .where(
            and(
              eq(integrationOutputEvents.integration, 'github'),
              eq(integrationOutputEvents.sourceKey, `github-feedback:${revision.squadId}:${revision.id}`),
              eq(integrationOutputEvents.eventKey, revision.id)
            )
          )
        canonical = canonicalId ? await readOutputEvent(db, canonicalId.id) : undefined
        // Irreversible accepted evidence is settlement, not a new effect or revocation bypass.
        if (canonical && (await hasAcceptedGitHubFeedbackReceipts(canonical.id))) {
          state = 'delivered'
          reason = null
        } else {
          if (!canonical) {
            const sources = await db
              .select({ eventId: integrationOutputEvents.id })
              .from(githubFeedbackSources)
              .innerJoin(integrationOutputEvents, eq(integrationOutputEvents.id, githubFeedbackSources.eventId))
              .where(
                and(
                  eq(githubFeedbackSources.revisionId, id),
                  sql`${integrationOutputEvents.sourceKey} NOT LIKE 'github-feedback:%'`
                )
              )
              .orderBy(githubFeedbackSources.observedAt)
              .limit(1) // original first observation only; never probe/swap another credential
            for (const { eventId } of sources) {
              const event = await readOutputEvent(db, eventId)
              if (!event) continue
              if (
                revision.routingProvenance.some((route) => route.authorityHash) &&
                !revision.routingProvenance.some((route) => route.authorityHash === githubContentHash(event.authority))
              )
                continue
              if (!(await prepared(event))) continue
              if (!(await deps.authorizeSource(event))) continue
              canonical = await recordCanonicalGitHubFeedback(revision.id, event.id, deps.authorizeSource)
              break
            }
          }
          // Another currently-readable source never blesses the canonical event's retained original authority.
          if (canonical && !isObsolete() && (await prepared(canonical)) && (await deps.authorizeSource(canonical))) {
            if (!(await isGitHubFeedbackAdmitted(db, canonical))) reason = 'feedback_not_admitted'
            else {
              const outcome = await deps.route(canonical)
              state = outcome && outcome.state === 'obsolete' ? 'obsolete' : 'retained'
              reason = outcome && reasons.includes(outcome.reason) ? outcome.reason : 'awaiting_acceptance'
              if (await hasAcceptedGitHubFeedbackReceipts(canonical.id)) {
                state = 'delivered'
                reason = null
              } else if (state !== 'obsolete' && (await isGitHubFeedbackRoutedNowhere(canonical.id))) {
                state = 'obsolete'
                reason = 'no_current_recipient'
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
      let settledSquadId: string | null = null
      await db.transaction(async (tx) => {
        await lockGitHubTrustAuthority(tx)
        const current = await readFeedbackRevision(tx, id, true)
        if (!current || current.leaseToken !== leaseToken) return // The lease was authoritatively taken over; a stale worker cannot settle it.
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
            // Exponential backoff from 30 s, doubling up to a one-hour ceiling: a retained release
            // (rotated connection, paused stream, recipient gone) must not re-check GitHub every
            // half minute for ever.
            nextAttemptAt:
              revoked || state === 'delivered' || state === 'obsolete'
                ? null
                : sql`clock_timestamp() + interval '30 seconds' * least(power(2, least(${current.attempts}, 7)), 120)`,
            updatedAt: new Date(),
          })
          .where(and(eq(githubFeedbackRevisions.id, id), eq(githubFeedbackRevisions.leaseToken, leaseToken)))
        settledSquadId = current.squadId
      })
      // Content-free, post-commit: release progress (or a trust revocation) changes human queue counts.
      if (settledSquadId) eventEmitter.emit('githubFeedback.updated', { squadId: settledSquadId })
    }, undefined)
  }
  return claimed
}
