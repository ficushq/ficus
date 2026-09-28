import { eq, and, sql } from 'drizzle-orm'
import type { InferSelectModel, SQL } from 'drizzle-orm'
import { db } from '../db'
import { outbox } from '../db/schema'
import type { AmtpEnvelope } from '@ficus/shared'

export type OutboxRow = InferSelectModel<typeof outbox>
export type OutboxStatus = 'pending' | 'delivering' | 'delivered' | 'failed'

/** A claimed `delivering` row is reclaimable after this window (presumed-dead worker). */
export const OUTBOX_CLAIM_STALE_MS = 5 * 60 * 1000

/** Base retry window; doubled per attempt. Mirrors services/provider-health/auto-restart.ts. */
const OUTBOX_BACKOFF_BASE_MS = 5000
/** Absolute cap on a single retry window. */
const OUTBOX_BACKOFF_MAX_MS = 300000
/** Max delivery attempts before a row is dead-lettered (failed terminal). */
export const OUTBOX_MAX_ATTEMPTS = 16

export interface EnqueueOutboxInput {
  peerInstanceId: string
  toAddress: string
  envelope: AmtpEnvelope
  idempotencyKey: string
}

export interface OutboxClaimExecutor {
  execute(query: SQL): Promise<unknown>
}

export class Outbox {
  id!: string
  peerInstanceId!: string
  toAddress!: string
  envelopeJson!: AmtpEnvelope
  idempotencyKey!: string
  status!: OutboxStatus
  attempts!: number
  nextAttemptAt!: Date
  lastError!: string | null
  claimToken!: string | null
  claimedAt!: Date | null
  createdAt!: Date

  constructor(row: OutboxRow) {
    Object.assign(this, row)
  }

  toJson() {
    return {
      id: this.id,
      peerInstanceId: this.peerInstanceId,
      toAddress: this.toAddress,
      envelopeJson: this.envelopeJson,
      idempotencyKey: this.idempotencyKey,
      status: this.status,
      attempts: this.attempts,
      nextAttemptAt: this.nextAttemptAt,
      lastError: this.lastError,
      claimToken: this.claimToken,
      claimedAt: this.claimedAt,
      createdAt: this.createdAt,
    }
  }

  /** Insert; on idempotencyKey conflict return the existing row (idempotent enqueue). */
  static async enqueue(input: EnqueueOutboxInput): Promise<Outbox> {
    const [inserted] = await db
      .insert(outbox)
      .values({
        peerInstanceId: input.peerInstanceId,
        toAddress: input.toAddress,
        envelopeJson: input.envelope,
        idempotencyKey: input.idempotencyKey,
      })
      .onConflictDoNothing({ target: outbox.idempotencyKey })
      .returning()
    if (inserted) return new Outbox(inserted)

    const [existing] = await db.select().from(outbox).where(eq(outbox.idempotencyKey, input.idempotencyKey)).limit(1)
    return new Outbox(existing)
  }

  /**
   * Atomically claim up to `limit` due-pending or stale-delivering rows.
   * Candidate selection is materialized once and its rows remain locked until the
   * same statement updates them. `SKIP LOCKED` partitions ownership among claimers,
   * while `next_attempt_at, id` provides deterministic ordering. The database clock
   * owns both eligibility and the resulting claim timestamp.
   */
  static async claimBatch(limit: number, staleMs: number, executor: OutboxClaimExecutor = db): Promise<Outbox[]> {
    const claimToken = crypto.randomUUID()
    const rows = await executor.execute(sql`
      WITH candidates AS MATERIALIZED (
        SELECT candidate.id
        FROM outbox AS candidate
        WHERE
          (candidate.status = 'pending' AND candidate.next_attempt_at <= now())
          OR (
            candidate.status = 'delivering'
            AND candidate.claimed_at < now() - ${staleMs} * interval '1 millisecond'
          )
        ORDER BY candidate.next_attempt_at, candidate.id
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE outbox AS claimed
      SET
        status = 'delivering',
        claim_token = ${claimToken},
        claimed_at = now()
      FROM candidates
      WHERE claimed.id = candidates.id
      RETURNING
        claimed.id,
        claimed.peer_instance_id AS "peerInstanceId",
        claimed.to_address AS "toAddress",
        claimed.envelope_json AS "envelopeJson",
        claimed.idempotency_key AS "idempotencyKey",
        claimed.status,
        claimed.attempts,
        claimed.next_attempt_at AS "nextAttemptAt",
        claimed.last_error AS "lastError",
        claimed.claim_token AS "claimToken",
        claimed.claimed_at AS "claimedAt",
        claimed.created_at AS "createdAt"
    `)

    return (rows as OutboxRow[]).map(
      (row) =>
        new Outbox({
          ...row,
          nextAttemptAt: new Date(row.nextAttemptAt),
          claimedAt: row.claimedAt === null ? null : new Date(row.claimedAt),
          createdAt: new Date(row.createdAt),
        })
    )
  }

  /**
   * Mark a row as delivered. Gates on `claimToken` so a zombie worker whose row
   * was stale-reclaimed by another worker cannot clobber the new owner's state.
   * Returns `true` iff the row was actually updated (token matched).
   */
  static async markDelivered(id: string, claimToken: string): Promise<boolean> {
    const updated = await db
      .update(outbox)
      .set({ status: 'delivered' })
      .where(and(eq(outbox.id, id), eq(outbox.claimToken, claimToken)))
      .returning({ id: outbox.id })
    return updated.length > 0
  }

  /**
   * Mark a row as permanently failed. Gates on `claimToken`.
   * Returns `true` iff the row was actually updated (token matched).
   */
  static async markFailedTerminal(id: string, claimToken: string, error: string): Promise<boolean> {
    const updated = await db
      .update(outbox)
      .set({ status: 'failed', lastError: error })
      .where(and(eq(outbox.id, id), eq(outbox.claimToken, claimToken)))
      .returning({ id: outbox.id })
    return updated.length > 0
  }

  /**
   * Returns true iff an outbox row destined for `peerInstanceId` advertises
   * `attachmentId` in its envelope's `attachments` array. Used by the
   * attachment-serve route to enforce default-deny: a peer may pull only
   * attachments tau actually sent to it.
   */
  static async hasOutboundAttachmentForPeer(peerInstanceId: string, attachmentId: string): Promise<boolean> {
    const rows = await db
      .select({ one: sql`1` })
      .from(outbox)
      .where(
        and(
          eq(outbox.peerInstanceId, peerInstanceId),
          sql`${outbox.envelopeJson} -> 'attachments' @> ${JSON.stringify([{ id: attachmentId }])}::jsonb`
        )
      )
      .limit(1)
    return rows.length > 0
  }

  /**
   * Schedule a retry. Gates on `claimToken`. Atomically increments `attempts`
   * in SQL and computes `nextAttemptAt` from the incremented value so there is
   * no read-then-write race.
   * Returns `true` iff the row was actually updated (token matched).
   */
  static async markRetry(id: string, claimToken: string, error: string): Promise<boolean> {
    const updated = await db
      .update(outbox)
      .set({
        status: 'pending',
        attempts: sql`${outbox.attempts} + 1`,
        claimToken: null,
        nextAttemptAt: sql`now() + LEAST(${OUTBOX_BACKOFF_BASE_MS} * power(2, LEAST(${outbox.attempts} + 1, 16)), ${OUTBOX_BACKOFF_MAX_MS}) * interval '1 millisecond'`,
        lastError: error,
      })
      .where(and(eq(outbox.id, id), eq(outbox.claimToken, claimToken)))
      .returning({ id: outbox.id })
    return updated.length > 0
  }
}
