import { and, eq, inArray, sql } from 'drizzle-orm'
import { agents, db, slotClaims, slotNotifications, slotPools } from '../../db'
import { AgentTerminatedError } from '../../entities/Agent'
import { InboxMessage } from '../../entities/InboxMessage'
import { createLogger } from '../../lib/infra/logger'
import { deliverInboxMessagesToAgent } from '../inbox/inboxDelivery'

const log = createLogger('slot-notifier')
const MAX_NOTIFICATION_CLAIM_LIMIT = 100
const DELIVERY_LEASE_MS = 60_000

export interface SlotNotificationClaim {
  notificationId: string
  poolId: string
  poolKey: string
  squadId: string
  claimId: string
  recipientAgentId: string
  kind: 'granted' | 'expired'
  idempotencyKey: string
  claimToken: string
  attempts: number
  expiresAt: Date
}

export async function claimDueSlotNotifications(input: {
  now: Date
  limit?: number
  notificationId?: string
}): Promise<SlotNotificationClaim[]> {
  const limit = input.limit ?? 32
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_NOTIFICATION_CLAIM_LIMIT) {
    throw new Error(`limit must be an integer between 1 and ${MAX_NOTIFICATION_CLAIM_LIMIT}`)
  }
  const nowIso = input.now.toISOString()
  const staleIso = new Date(input.now.getTime() - DELIVERY_LEASE_MS).toISOString()
  return db.transaction(async (tx): Promise<SlotNotificationClaim[]> => {
    const candidates = await tx.execute<{ id: string }>(sql`
      SELECT id
      FROM slot_notifications
      WHERE next_attempt_at <= ${nowIso}::timestamptz
        ${input.notificationId ? sql`AND id = ${input.notificationId}` : sql``}
        AND (status = 'pending' OR (status = 'delivering' AND claimed_at <= ${staleIso}::timestamptz))
      ORDER BY created_at, id
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    `)
    if (candidates.length === 0) return []
    const claimed = await tx
      .update(slotNotifications)
      .set({
        status: 'delivering',
        claimToken: sql`gen_random_uuid()`,
        claimedAt: input.now,
        attempts: sql`${slotNotifications.attempts} + 1`,
        updatedAt: input.now,
      })
      .where(
        inArray(
          slotNotifications.id,
          candidates.map((candidate) => candidate.id)
        )
      )
      .returning({ id: slotNotifications.id })
    const rows = await tx
      .select({
        notificationId: slotNotifications.id,
        poolId: slotNotifications.poolId,
        poolKey: slotPools.key,
        squadId: slotPools.squadId,
        claimId: slotNotifications.claimId,
        recipientAgentId: slotNotifications.recipientAgentId,
        kind: slotNotifications.kind,
        idempotencyKey: slotNotifications.idempotencyKey,
        claimToken: slotNotifications.claimToken,
        attempts: slotNotifications.attempts,
        expiresAt: slotClaims.expiresAt,
      })
      .from(slotNotifications)
      .innerJoin(slotPools, eq(slotPools.id, slotNotifications.poolId))
      .innerJoin(slotClaims, eq(slotClaims.id, slotNotifications.claimId))
      .where(
        inArray(
          slotNotifications.id,
          claimed.map((row) => row.id)
        )
      )
    return rows.map((row) => {
      if (!row.claimToken) throw new Error(`Claimed slot notification ${row.notificationId} has no token`)
      return { ...row, claimToken: row.claimToken }
    })
  })
}

export function renderSlotNotification(claim: SlotNotificationClaim): string {
  if (claim.kind === 'expired') {
    // Expiry frees capacity but cannot stop what the owner started under it.
    // Detached containers and test databases outlive the claim and silently
    // overload the shared box, so the owner must clean up explicitly.
    return [
      `Your claim ${claim.claimId} on slot pool "${claim.poolKey}" expired at ${claim.expiresAt.toISOString()} because it was not released or renewed. You no longer hold this capacity.`,
      'Ficus did not stop any work you started under this claim. Clean up now:',
      "- Stop every heavy process, container and test database you started under it: run the repository's project-scoped test:db:down (for example `bun run test:db:down`), docker stop the containers you started, and kill your background jobs.",
      `- Claim again before resuming heavy work: ficus slot claim ${claim.poolKey} --squad ${claim.squadId}`,
      '- Release claims as soon as the work is done: ficus slot release <claim-id>',
    ].join('\n')
  }
  return [
    `Your wait for slot pool "${claim.poolKey}" was granted.`,
    'YOU MUST RELEASE THIS CLAIM AS SOON AS YOU ARE DONE.',
    `Claim ID: ${claim.claimId}`,
    `Expires: ${claim.expiresAt.toISOString()}`,
    'If there is any doubt, query authoritative state before relying on this grant.',
    `Release: ficus slot release ${claim.claimId}`,
    `Renew: ficus slot renew ${claim.claimId}`,
  ].join('\n')
}

async function markDelivered(claim: SlotNotificationClaim, inboxId: string, now: Date): Promise<void> {
  await db
    .update(slotNotifications)
    .set({
      status: 'delivered',
      inboxId,
      deliveredAt: now,
      claimToken: null,
      claimedAt: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(slotNotifications.id, claim.notificationId),
        eq(slotNotifications.status, 'delivering'),
        eq(slotNotifications.claimToken, claim.claimToken)
      )
    )
}

async function settleTerminal(claim: SlotNotificationClaim, now: Date, code: string): Promise<void> {
  await db
    .update(slotNotifications)
    .set({
      status: 'delivered',
      deliveredAt: now,
      claimToken: null,
      claimedAt: null,
      lastErrorCode: code,
      updatedAt: now,
    })
    .where(
      and(
        eq(slotNotifications.id, claim.notificationId),
        eq(slotNotifications.status, 'delivering'),
        eq(slotNotifications.claimToken, claim.claimToken)
      )
    )
}

async function retryLater(claim: SlotNotificationClaim, now: Date, error: unknown): Promise<void> {
  const delay = Math.min(60_000 * 2 ** Math.max(0, claim.attempts - 1), 60 * 60_000)
  const code = error instanceof Error ? error.name.slice(0, 64) : 'unknown_error'
  await db
    .update(slotNotifications)
    .set({
      status: 'pending',
      nextAttemptAt: new Date(now.getTime() + delay),
      claimToken: null,
      claimedAt: null,
      lastErrorCode: code,
      updatedAt: now,
    })
    .where(
      and(
        eq(slotNotifications.id, claim.notificationId),
        eq(slotNotifications.status, 'delivering'),
        eq(slotNotifications.claimToken, claim.claimToken)
      )
    )
}

export interface SlotNotificationNotifierAdapter {
  sendOnce?: typeof InboxMessage.sendOnce
  afterSendOnce?: (input: { claim: SlotNotificationClaim; inboxMessageId: string }) => Promise<void>
}

export interface SlotNotificationDrainSummary {
  claimed: number
  delivered: number
  deliveryRetries: number
}

export class SlotNotificationNotifier {
  constructor(private readonly adapter: SlotNotificationNotifierAdapter = {}) {}

  async drain(input: { now: Date; limit?: number; notificationId?: string }): Promise<SlotNotificationDrainSummary> {
    const claims = await claimDueSlotNotifications(input)
    const results = await Promise.all(claims.map((claim) => this.deliver(claim, input.now)))
    return {
      claimed: claims.length,
      delivered: results.filter(Boolean).length,
      deliveryRetries: claims.filter((claim) => claim.attempts > 1).length,
    }
  }

  private async deliver(claim: SlotNotificationClaim, now: Date): Promise<boolean> {
    const [state] = await db
      .select({
        notificationStatus: slotNotifications.status,
        notificationClaimToken: slotNotifications.claimToken,
        claimStatus: slotClaims.status,
        recipientStatus: agents.status,
      })
      .from(slotNotifications)
      .innerJoin(slotClaims, eq(slotClaims.id, slotNotifications.claimId))
      .leftJoin(agents, eq(agents.id, slotNotifications.recipientAgentId))
      .where(eq(slotNotifications.id, claim.notificationId))
      .limit(1)
    if (!state || state.notificationStatus !== 'delivering' || state.notificationClaimToken !== claim.claimToken) {
      return false
    }
    if (claim.kind === 'granted' && state.claimStatus !== 'active') {
      await settleTerminal(claim, now, 'claim_inactive')
      return false
    }
    if (!state.recipientStatus || state.recipientStatus === 'terminated') {
      await settleTerminal(claim, now, state.recipientStatus ? 'recipient_terminated' : 'recipient_missing')
      return false
    }

    let inboxMessageId: string
    try {
      const result = await (this.adapter.sendOnce ?? InboxMessage.sendOnce)(
        {
          recipientType: 'agent',
          recipientId: claim.recipientAgentId,
          senderType: 'system',
          deliveryMode: 'steer',
          wakeEligible: false,
          subject:
            claim.kind === 'granted'
              ? `Slot granted: ${claim.poolKey}`
              : `Slot expired: ${claim.poolKey} (clean up now)`,
          content: renderSlotNotification(claim),
          metadata: { source: 'slot', poolId: claim.poolId, claimId: claim.claimId },
        },
        claim.idempotencyKey
      )
      inboxMessageId = result.message.id
      await deliverInboxMessagesToAgent(claim.recipientAgentId)
    } catch (error) {
      if (
        error instanceof AgentTerminatedError ||
        (error instanceof Error && /agent .*not found/i.test(error.message))
      ) {
        await settleTerminal(
          claim,
          now,
          error instanceof AgentTerminatedError ? 'recipient_terminated' : 'recipient_missing'
        )
        return false
      }
      log.warn(`Slot notification ${claim.notificationId} remains pending`, error)
      await retryLater(claim, now, error)
      return false
    }
    await this.adapter.afterSendOnce?.({ claim, inboxMessageId })
    await markDelivered(claim, inboxMessageId, now)
    return true
  }

  drainSoon(): void {
    queueMicrotask(() => {
      void this.drain({ now: new Date() }).catch((error) => log.error('Slot notification drain failed', error))
    })
  }
}

export const slotNotificationNotifier = new SlotNotificationNotifier()
