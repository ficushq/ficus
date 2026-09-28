/**
 * DB state machine for pending human/steer/follow-up message delivery — the
 * durable exactly-once queue behind both the initial-prompt claim and the
 * live-session intervention drain.
 */
import { and, asc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm'
import { db, messages } from '../../db'
import { jsonbObjectRecovered } from '../../db/jsonb'
import { Message, MessageMetadata } from '@ficus/shared'
import { eventEmitter } from '../../lib/infra/event-emitter'
import { mapMessage } from '../../entities/message-mapper'
import { messageEventData } from '../../entities/message-event'

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
type DbExecutor = typeof db | DbTransaction

/** Advisory-lock namespace serializing same-agent initial claims. Exported so
 * tests can contend for the identical lock rather than approximate it. */
export const PENDING_CLAIM_LOCK_NAMESPACE = 421_101

function messageFifoOrder() {
  return [asc(messages.createdAt), asc(messages.enqueueOrder)] as const
}

function pendingSessionDeliveryOrder() {
  return [
    sql`CASE ${messages.metadata}->>'deliveryMode' WHEN 'follow-up' THEN 1 ELSE 0 END`,
    ...messageFifoOrder(),
  ] as const
}

/**
 * Try to confirm a pending human message already claimed by the DB-backed
 * drain (injectedAt != null) and then processed by the SDK.
 * If content is provided, first looks for a claimed pending message with exact
 * content. If no content match is found and content is omitted (for example,
 * an image-only persisted SDK user message), falls back to DB-backed SDK
 * processing order: steer first, then follow-up, then other pending messages;
 * FIFO within each group. A neutral prompt persisted by the SDK must not
 * confirm unrelated unclaimed rows.
 * Returns the confirmed message, or null if none found.
 * @param content - Optional SDK user message content to match exactly.
 * @returns The confirmed message, or null if none found.
 */
export interface ResponseGroupIdentity {
  executionId: string
  streamGroupId: string
}

export async function tryConfirmPendingMessage(
  agentId: string,
  content?: string,
  identity?: ResponseGroupIdentity
): Promise<Message | null> {
  const ordering = pendingSessionDeliveryOrder()

  const baseCondition = and(
    eq(messages.agentId, agentId),
    eq(messages.role, 'human'),
    eq(messages.pending, true),
    isNotNull(messages.injectedAt)
  )

  const [contentMatch] =
    content === undefined
      ? []
      : await db
          .select()
          .from(messages)
          .where(and(baseCondition, eq(messages.content, content)))
          .orderBy(...ordering)
          .limit(1)

  if (content !== undefined) {
    return contentMatch ? confirmPendingMessage(agentId, contentMatch.id, db, identity) : null
  }

  const [pending] = await db
    .select()
    .from(messages)
    .where(baseCondition)
    .orderBy(...ordering)
    .limit(1)
  if (!pending) return null

  return confirmPendingMessage(agentId, pending.id, db, identity)
}

/**
 * Confirm a specific pending human message for this agent.
 * Active-session control messages use this with the persisted message id so
 * steer/follow-up confirmation follows SDK processing order, not DB creation order.
 * Returns the confirmed message, or null if the message is not pending for this agent.
 * @param messageId - The pending message id to confirm.
 * @param executor - Optional caller-owned transaction for composing the state transition.
 * @returns The confirmed message, or null if none was confirmed.
 */
export async function confirmPendingMessage(
  agentId: string,
  messageId: string,
  executor: DbExecutor = db,
  identity?: ResponseGroupIdentity
): Promise<Message | null> {
  // Creation time is immutable. Consumption is stamped by PostgreSQL so it has
  // the same clock authority and precision as the row's DB-authored createdAt.
  // Keeping every eligibility predicate on this update makes confirmation an
  // atomic compare-and-set: concurrent/idempotent callers cannot both win.
  const [updated] = await executor
    .update(messages)
    .set({
      pending: false,
      metadata: identity
        ? sql<MessageMetadata>`jsonb_set(
            jsonb_set(
              jsonb_set(
                ${jsonbObjectRecovered(messages.metadata)},
                '{consumedAt}',
                to_jsonb(statement_timestamp()),
                true
              ),
              '{executionId}',
              to_jsonb(${identity.executionId}::text),
              true
            ),
            '{streamGroupId}',
            to_jsonb(${identity.streamGroupId}::text),
            true
          )`
        : sql<MessageMetadata>`jsonb_set(
            ${jsonbObjectRecovered(messages.metadata)},
            '{consumedAt}',
            to_jsonb(statement_timestamp()),
            true
          )`,
    })
    .where(
      and(
        eq(messages.id, messageId),
        eq(messages.agentId, agentId),
        eq(messages.role, 'human'),
        eq(messages.pending, true)
      )
    )

    .returning()

  if (!updated) return null

  const message = mapMessage(updated)
  // A caller-owned transaction may still roll back, so its owner is responsible
  // for publishing after commit. Standalone confirmations publish immediately.
  if (executor === db) {
    eventEmitter.emit('message.updated', messageEventData(message))
  }
  return message
}

/**
 * Confirm all pending human messages for the agent.
 * Called after sendPrompt when multiple messages may have been queued.
 * @returns The number of messages confirmed.
 */
export async function confirmAllPendingMessages(agentId: string): Promise<number> {
  const pending = await db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.agentId, agentId),
        eq(messages.role, 'human'),
        eq(messages.pending, true),
        // Follow-up messages are queued for a future turn and must stay
        // pending until session_message_persisted confirms the specific row
        // the SDK actually consumed. Stranded-retried follow-ups are confirmed
        // here because the retry is being processed in a new execution.
        or(
          sql`(${messages.metadata}->>'deliveryMode') IS DISTINCT FROM 'follow-up'`,
          sql`COALESCE((${messages.metadata}->>'strandedPendingRetryCount')::int, 0) > 0`
        )
      )
    )
    .orderBy(...messageFifoOrder())

  let count = 0
  for (const row of pending) {
    if (await confirmPendingMessage(agentId, row.id)) count++
  }

  return count
}

/**
 * List pending human messages for the agent.
 * Used as a defensive guard when a running turn settles without consuming a
 * steer/follow-up that was persisted in the DB.
 */
export async function listPendingHumanMessages(agentId: string): Promise<Message[]> {
  const rows = await db
    .select()
    .from(messages)
    .where(and(eq(messages.agentId, agentId), eq(messages.role, 'human'), eq(messages.pending, true)))
    .orderBy(...messageFifoOrder())

  return rows.map(mapMessage)
}

/**
 * Atomically claim the pending human rows that should start a fresh SDK turn.
 *
 * Selection follows the SDK queue semantics: claim every immediate/steer row
 * first (including normal user rows without an explicit deliveryMode). If no
 * such rows are available, claim exactly the first follow-up row. The CTE uses
 * row locks plus the injectedAt CAS marker so two workers cannot deliver the
 * same pending row.
 */
export async function claimInitialPendingMessagesForSessionDelivery(agentId: string): Promise<Message[]> {
  const rows = (await db.execute(sql`
    WITH agent_lock AS MATERIALIZED (
      SELECT pg_advisory_xact_lock(${PENDING_CLAIM_LOCK_NAMESPACE}, hashtext(${agentId}))
    ),
    steer_rows AS (
      SELECT id, created_at, enqueue_order, 0 AS delivery_priority
      FROM ${messages}, agent_lock
      WHERE ${messages.agentId} = ${agentId}
        AND ${messages.role} = 'human'
        AND ${messages.pending} = true
        AND ${messages.injectedAt} IS NULL
        AND COALESCE(${messages.metadata}->>'deliveryMode', 'steer') <> 'follow-up'
      ORDER BY created_at ASC, enqueue_order ASC
      FOR UPDATE SKIP LOCKED
    ),
    follow_up_row AS (
      SELECT id, created_at, enqueue_order, 1 AS delivery_priority
      FROM ${messages}
      WHERE ${messages.agentId} = ${agentId}
        AND ${messages.role} = 'human'
        AND ${messages.pending} = true
        AND ${messages.injectedAt} IS NULL
        AND ${messages.metadata}->>'deliveryMode' = 'follow-up'
        AND NOT EXISTS (SELECT 1 FROM steer_rows)
      ORDER BY created_at ASC, enqueue_order ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    ),
    selected AS (
      SELECT * FROM steer_rows
      UNION ALL
      SELECT * FROM follow_up_row
    ),
    updated AS (
      UPDATE ${messages} m
      SET injected_at = NOW()
      FROM selected
      WHERE m.id = selected.id
        AND m.agent_id = ${agentId}
        AND m.role = 'human'
        AND m.pending = true
        AND m.injected_at IS NULL
      RETURNING m.id, m.agent_id, m.role, m.content, m.metadata, m.pending, m.injected_at, m.created_at, m.enqueue_order
    )
    SELECT
      updated.id,
      updated.agent_id AS "agentId",
      updated.role,
      updated.content,
      updated.metadata,
      updated.pending,
      updated.injected_at AS "injectedAt",
      updated.created_at AS "createdAt",
      updated.enqueue_order AS "enqueueOrder"
    FROM updated
    JOIN selected ON selected.id = updated.id
    ORDER BY selected.delivery_priority ASC, selected.created_at ASC, selected.enqueue_order ASC
  `)) as unknown as Array<typeof messages.$inferSelect>

  const claimed = rows.map((row) =>
    mapMessage({
      ...row,
      injectedAt: row.injectedAt ? new Date(row.injectedAt) : null,
      createdAt: new Date(row.createdAt),
    })
  )
  for (const message of claimed) {
    eventEmitter.emit('message.updated', messageEventData(message))
  }
  return claimed
}

/**
 * List pending human rows that have not yet been accepted by a live SDK
 * session. These rows are the durable queue for the runner-local
 * pending-message drain instead of treating the control signal as source of truth.
 */
export async function listPendingInterventionsForSessionDelivery(agentId: string): Promise<Message[]> {
  const rows = await db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.agentId, agentId),
        eq(messages.role, 'human'),
        eq(messages.pending, true),
        isNull(messages.injectedAt)
      )
    )
    .orderBy(...pendingSessionDeliveryOrder())

  return rows.map(mapMessage)
}

/**
 * Atomically claim a pending human message for delivery to a live SDK session.
 * Returns null if another consumer already claimed/confirmed it.
 */
export async function claimPendingInterventionForSessionDelivery(
  agentId: string,
  messageId: string
): Promise<Message | null> {
  const [updated] = await db
    .update(messages)
    .set({ injectedAt: new Date() })
    .where(
      and(
        eq(messages.id, messageId),
        eq(messages.agentId, agentId),
        eq(messages.role, 'human'),
        eq(messages.pending, true),
        isNull(messages.injectedAt)
      )
    )
    .returning()

  if (!updated) return null

  const message = mapMessage(updated)
  eventEmitter.emit('message.updated', messageEventData(message))
  return message
}

/**
 * Reset a claimed pending message so a future queue drain can retry it.
 * Used when the SDK rejects delivery after the injectedAt CAS claim.
 */
export async function resetPendingInterventionSessionDelivery(agentId: string, messageId: string): Promise<void> {
  const updated = await db
    .update(messages)
    .set({ injectedAt: null })
    .where(
      and(
        eq(messages.id, messageId),
        eq(messages.agentId, agentId),
        eq(messages.role, 'human'),
        eq(messages.pending, true)
      )
    )
    .returning()

  if (updated[0]) {
    eventEmitter.emit('message.updated', messageEventData(mapMessage(updated[0])))
  }
}

/**
 * Mark pending human messages as having received a stranded-pending retry.
 * This provides explicit loop-guard provenance for runner-created retries and
 * clears injectedAt so the retry is visible to the DB-backed delivery queue.
 */
export async function markPendingHumanMessagesStrandedRetry(agentId: string, messageIds: string[]): Promise<void> {
  if (messageIds.length === 0) return

  const pending = await db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.agentId, agentId),
        eq(messages.role, 'human'),
        eq(messages.pending, true),
        inArray(messages.id, messageIds)
      )
    )

  for (const row of pending) {
    const metadata = ((row.metadata as MessageMetadata | null) ?? {}) as MessageMetadata
    const retryCount = metadata.strandedPendingRetryCount ?? 0
    const [updated] = await db
      .update(messages)
      .set({ metadata: { ...metadata, strandedPendingRetryCount: retryCount + 1 }, injectedAt: null })
      .where(eq(messages.id, row.id))
      .returning()
    if (updated) eventEmitter.emit('message.updated', messageEventData(mapMessage(updated)))
  }
}

/**
 * Delete all pending human messages for the agent.
 * Called when clearing the steer/follow-up queue.
 * @returns The number of messages deleted.
 */
export async function deletePendingMessages(agentId: string): Promise<number> {
  const result = await db
    .delete(messages)
    .where(and(eq(messages.agentId, agentId), eq(messages.role, 'human'), eq(messages.pending, true)))
    .returning()
  return result.length
}
