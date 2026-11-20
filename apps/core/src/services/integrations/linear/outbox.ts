import { randomUUID } from 'node:crypto'
import { and, asc, count, eq, gte, inArray, lt, lte, ne, or } from 'drizzle-orm'
import { db, linearActivityOutbox, linearAgentSessions, workStreams, type DbTx } from '../../../db'
import { InboxMessage } from '../../../entities/InboxMessage'
import { createLogger } from '../../../lib/infra/logger'
import { linearActivityId } from './app-api'
import { resolveLinearConnectionById } from './resolve-connection'
import type { LinearProjectionItem } from './session-projection'
import {
  LinearWriteError,
  writeLinearActivity,
  writeLinearPullRequestAttachment,
  writeLinearSessionUrls,
  type LinearAgentActivityContent,
} from './write-api'

const log = createLogger('linear-write-back-outbox')

type Store = typeof db | DbTx
type OutboxRow = typeof linearActivityOutbox.$inferSelect

/** A quarter of Linear's standard 5,000 requests per hour, leaving room for the CLI and ingress probes. */
export const LINEAR_CONNECTION_WRITES_PER_HOUR = 1_200
/** At most this many activities per session per hour. */
export const LINEAR_SESSION_ACTIVITIES_PER_HOUR = 30
/** Collapsible progress gives up after this many failed attempts. */
export const LINEAR_OUTBOX_MAX_ATTEMPTS = 8
/**
 * Responses, errors, elicitations, attachments and session links are never collapsed or counted out:
 * they keep retrying (at most every 10 minutes) until this long after they were queued, so a token
 * that expired before the refresh worker ran or an outage of a few hours does not lose them.
 */
export const LINEAR_OUTBOX_FINAL_ITEM_MAX_AGE_MS = 24 * 3_600_000
const CONNECTION_WAIT_MS = 60_000
const FIRST_BACKOFF_MS = 5_000
const MAX_BACKOFF_MS = 10 * 60_000
/** A `sending` claim older than this was lost with its process and is retried. */
const CLAIM_LEASE_MS = 2 * 60_000
const HOUR_MS = 3_600_000
const BATCH = 25
const PROJECTION_KEY_MAX = 400

/** Backoff after a failed attempt: 5 seconds, doubling, at most 10 minutes. */
export function linearOutboxBackoffMs(attempts: number): number {
  return Math.min(MAX_BACKOFF_MS, FIRST_BACKOFF_MS * 2 ** Math.max(0, attempts - 1))
}

/** Connections Linear answered with HTTP 429: nothing is sent for them until the time passes. */
const connectionCooldown = new Map<string, number>()
export function resetLinearOutboxStateForTest() {
  connectionCooldown.clear()
}

export interface EnqueueLinearWritesInput {
  connectionId: string
  /** The session ID for session writes; `issue:<issueId>` for attachments. */
  scopeKey: string
  sessionId?: string
  workStreamId?: string
  items: LinearProjectionItem[]
}

/**
 * Inserts the items that are not yet in the outbox; an existing projection key is never sent twice.
 * Items keep their order: each gets a creation time one millisecond after the previous one.
 * Returns the projection keys that were new.
 */
export async function enqueueLinearWrites(input: EnqueueLinearWritesInput, store: Store = db): Promise<string[]> {
  // A key that does not fit the column is never written, so one bad item cannot fail the whole batch.
  const items = input.items.filter((item) => item.projectionKey.length <= PROJECTION_KEY_MAX)
  if (items.length !== input.items.length) log.warn('A Linear write-back item with an over-long key was skipped')
  if (!items.length) return []
  const base = Date.now()
  const rows = await store
    .insert(linearActivityOutbox)
    .values(
      items.map((item, index) => ({
        connectionId: input.connectionId,
        scopeKey: input.scopeKey,
        sessionId: input.sessionId ?? null,
        workStreamId: input.workStreamId ?? null,
        projectionKey: item.projectionKey,
        activityId: linearActivityId(input.scopeKey, item.projectionKey),
        kind: item.kind,
        payload: item.payload,
        collapsible: item.collapsible,
        createdAt: new Date(base + index),
        nextAttemptAt: new Date(base + index),
      }))
    )
    .onConflictDoNothing({
      target: [linearActivityOutbox.connectionId, linearActivityOutbox.scopeKey, linearActivityOutbox.projectionKey],
    })
    .returning({ projectionKey: linearActivityOutbox.projectionKey })
  return rows.map((row) => row.projectionKey)
}

/** Claims due rows, oldest first, for one drain pass. Concurrent drains never claim the same row. */
async function claimDue(now: Date, limit: number): Promise<OutboxRow[]> {
  const token = randomUUID()
  return db.transaction(async (tx) => {
    const due = await tx
      .select({ id: linearActivityOutbox.id })
      .from(linearActivityOutbox)
      .where(
        or(
          and(eq(linearActivityOutbox.status, 'pending'), lte(linearActivityOutbox.nextAttemptAt, now)),
          and(
            eq(linearActivityOutbox.status, 'sending'),
            lt(linearActivityOutbox.claimedAt, new Date(now.getTime() - CLAIM_LEASE_MS))
          )
        )
      )
      .orderBy(asc(linearActivityOutbox.createdAt))
      .limit(limit)
      .for('update', { skipLocked: true })
    if (!due.length) return []
    const claimed = await tx
      .update(linearActivityOutbox)
      .set({ status: 'sending', claimToken: token, claimedAt: now, updatedAt: now })
      .where(
        inArray(
          linearActivityOutbox.id,
          due.map((row) => row.id)
        )
      )
      .returning()
    // UPDATE ... RETURNING has no order: items are sent oldest first.
    return claimed.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
  })
}

async function sentWithinHour(where: ReturnType<typeof and>, now: Date) {
  const [row] = await db
    .select({ value: count() })
    .from(linearActivityOutbox)
    .where(
      and(
        where,
        eq(linearActivityOutbox.status, 'sent'),
        gte(linearActivityOutbox.sentAt, new Date(now.getTime() - HOUR_MS))
      )
    )
  return row?.value ?? 0
}

/** Releases a claim without counting an attempt (rate limited, or waiting behind an older item). */
async function defer(row: OutboxRow, until: Date, code?: string) {
  await db
    .update(linearActivityOutbox)
    .set({
      status: 'pending',
      claimToken: null,
      claimedAt: null,
      nextAttemptAt: until,
      ...(code ? { lastErrorCode: code } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(linearActivityOutbox.id, row.id), eq(linearActivityOutbox.claimToken, row.claimToken!)))
}

async function finish(row: OutboxRow, status: 'sent' | 'failed' | 'skipped', code?: string) {
  const now = new Date()
  await db
    .update(linearActivityOutbox)
    .set({
      status,
      claimToken: null,
      claimedAt: null,
      ...(status === 'sent' ? { sentAt: now } : {}),
      ...(code ? { lastErrorCode: code } : {}),
      updatedAt: now,
    })
    .where(and(eq(linearActivityOutbox.id, row.id), eq(linearActivityOutbox.claimToken, row.claimToken!)))
  if (status === 'sent' && row.sessionId && row.kind === 'activity')
    await db
      .update(linearAgentSessions)
      .set({ lastActivityAt: now, updatedAt: now })
      .where(eq(linearAgentSessions.id, row.sessionId))
}

/**
 * When a session's bucket is empty, its pending progress collapses to the newest item: older
 * collapsible items are skipped. Responses, errors, elicitations, attachments and session updates are
 * never collapsible, so they are never dropped.
 */
async function collapseSessionProgress(sessionId: string) {
  const pending = await db
    .select({ id: linearActivityOutbox.id })
    .from(linearActivityOutbox)
    .where(
      and(
        eq(linearActivityOutbox.sessionId, sessionId),
        eq(linearActivityOutbox.collapsible, true),
        inArray(linearActivityOutbox.status, ['pending', 'sending'])
      )
    )
    .orderBy(asc(linearActivityOutbox.createdAt))
  const older = pending.slice(0, -1).map((row) => row.id)
  if (older.length)
    await db
      .update(linearActivityOutbox)
      .set({ status: 'skipped', claimToken: null, claimedAt: null, lastErrorCode: 'collapsed', updatedAt: new Date() })
      .where(inArray(linearActivityOutbox.id, older))
}

/** An older unsent item of the same scope goes first, so Linear shows activities in order. */
async function hasOlderPending(row: OutboxRow) {
  const [older] = await db
    .select({ id: linearActivityOutbox.id })
    .from(linearActivityOutbox)
    .where(
      and(
        eq(linearActivityOutbox.connectionId, row.connectionId),
        eq(linearActivityOutbox.scopeKey, row.scopeKey),
        inArray(linearActivityOutbox.status, ['pending', 'sending']),
        lt(linearActivityOutbox.createdAt, row.createdAt),
        ne(linearActivityOutbox.id, row.id)
      )
    )
    .limit(1)
  return !!older
}

async function send(row: OutboxRow, authorization: string) {
  const payload = row.payload as Record<string, any>
  if (row.kind === 'activity')
    return writeLinearActivity(authorization, {
      agentSessionId: row.sessionId ?? row.scopeKey,
      id: row.activityId,
      content: payload.content as LinearAgentActivityContent,
      ...(payload.ephemeral ? { ephemeral: true } : {}),
      ...(payload.signal ? { signal: payload.signal } : {}),
      ...(payload.signalMetadata ? { signalMetadata: payload.signalMetadata } : {}),
    })
  if (row.kind === 'session_update')
    return writeLinearSessionUrls(authorization, row.sessionId ?? row.scopeKey, payload.addedExternalUrls ?? [])
  return writeLinearPullRequestAttachment(authorization, {
    issueId: String(payload.issueId),
    url: String(payload.url),
    linkKind: String(payload.linkKind),
    ...(payload.title ? { title: String(payload.title) } : {}),
  })
}

/**
 * Linear refused a session write for lack of access (5.8): the session is marked `inaccessible`,
 * nothing more is written to it, and the bound stream's owner hears once.
 */
async function markSessionInaccessible(sessionId: string) {
  const [session] = await db
    .update(linearAgentSessions)
    .set({ disposition: 'inaccessible', updatedAt: new Date() })
    .where(and(eq(linearAgentSessions.id, sessionId), ne(linearAgentSessions.disposition, 'inaccessible')))
    .returning()
  await db
    .update(linearActivityOutbox)
    .set({ status: 'skipped', lastErrorCode: 'session_inaccessible', claimToken: null, updatedAt: new Date() })
    .where(and(eq(linearActivityOutbox.sessionId, sessionId), inArray(linearActivityOutbox.status, ['pending'])))
  if (!session?.workStreamId) return
  const [stream] = await db
    .select({
      id: workStreams.id,
      title: workStreams.title,
      squadId: workStreams.squadId,
      owner: workStreams.ownerAgentId,
    })
    .from(workStreams)
    .where(eq(workStreams.id, session.workStreamId))
  if (!stream?.owner) return
  await InboxMessage.sendOnce(
    {
      recipientType: 'agent',
      recipientId: stream.owner,
      senderType: 'system',
      subject: 'Linear progress stopped for a work stream',
      content: [
        `Ficus can no longer write to the Linear agent session of work stream ${stream.id} ("${stream.title.slice(0, 80)}").`,
        'Linear refused access, usually because the Ficus app lost access to the issue\u2019s team. A Linear admin can grant access in the Ficus app settings; progress is no longer posted to this session.',
      ].join('\n'),
      metadata: { source: 'linear-write-back', workStreamId: stream.id, squadId: stream.squadId, sessionId },
    },
    `linear-session-inaccessible:${sessionId}`
  ).catch((error) => log.warn(`Owner notice for an inaccessible Linear session failed: ${String(error)}`))
}

export interface DrainLinearOutboxResult {
  sent: number
  deferred: number
  failed: number
}

/**
 * One drain pass: claims due items and sends each under its own connection, honoring the
 * per-connection and per-session hourly limits, Linear's `Retry-After`, and item order per session.
 */
export async function drainLinearOutbox(options: { now?: () => Date; limit?: number } = {}) {
  const now = options.now ?? (() => new Date())
  const result: DrainLinearOutboxResult = { sent: 0, deferred: 0, failed: 0 }
  const rows = await claimDue(now(), options.limit ?? BATCH)
  for (const row of rows) {
    try {
      await drainRow(row, now(), result)
    } catch (error) {
      log.warn(`Linear outbox item ${row.id} could not be processed: ${error instanceof Error ? error.name : 'error'}`)
      await defer(row, new Date(now().getTime() + FIRST_BACKOFF_MS), 'internal_error')
      result.deferred++
    }
  }
  return result
}

async function drainRow(row: OutboxRow, at: Date, result: DrainLinearOutboxResult) {
  if (row.sessionId) {
    const [session] = await db
      .select({ disposition: linearAgentSessions.disposition })
      .from(linearAgentSessions)
      .where(eq(linearAgentSessions.id, row.sessionId))
    if (!session || session.disposition === 'inaccessible') {
      await finish(row, 'skipped', 'session_inaccessible')
      return
    }
  }
  if (await hasOlderPending(row)) {
    await defer(row, new Date(at.getTime() + 1_000))
    result.deferred++
    return
  }
  const cooldown = connectionCooldown.get(row.connectionId)
  if (cooldown && cooldown > at.getTime()) {
    await defer(row, new Date(cooldown), 'rate_limited')
    result.deferred++
    return
  }
  const connectionBusy =
    (await sentWithinHour(eq(linearActivityOutbox.connectionId, row.connectionId), at)) >=
    LINEAR_CONNECTION_WRITES_PER_HOUR
  const sessionBusy =
    !!row.sessionId &&
    row.kind === 'activity' &&
    (await sentWithinHour(
      and(
        eq(linearActivityOutbox.connectionId, row.connectionId),
        eq(linearActivityOutbox.sessionId, row.sessionId),
        eq(linearActivityOutbox.kind, 'activity')
      ),
      at
    )) >= LINEAR_SESSION_ACTIVITIES_PER_HOUR
  if (connectionBusy || sessionBusy) {
    if (row.sessionId) await collapseSessionProgress(row.sessionId)
    const [current] = await db.select().from(linearActivityOutbox).where(eq(linearActivityOutbox.id, row.id))
    if (current?.status === 'skipped') return
    await defer(row, new Date(at.getTime() + 60_000), 'rate_limited')
    result.deferred++
    return
  }
  const resolved = await resolveLinearConnectionById(row.connectionId, at)
  if (!resolved) {
    // The refresh worker renews an expiring token; waiting for a usable connection costs no attempt.
    if (expired(row, at)) await giveUp(row, row.attempts, 'connection_unavailable', result)
    else {
      await defer(row, new Date(at.getTime() + CONNECTION_WAIT_MS), 'connection_unavailable')
      result.deferred++
    }
    return
  }
  try {
    await send(row, resolved.authorization)
    await finish(row, 'sent')
    result.sent++
  } catch (error) {
    const failure = error instanceof LinearWriteError ? error : new LinearWriteError('unavailable')
    if (failure.code === 'duplicate') {
      // A retry after an unknown outcome reuses the activity ID; Linear already has it.
      await finish(row, 'sent', 'duplicate')
      result.sent++
      return
    }
    if (failure.code === 'rate_limited') {
      const until = at.getTime() + Math.max(1_000, failure.retryAfterMs ?? 60_000)
      connectionCooldown.set(row.connectionId, until)
      await defer(row, new Date(until), 'rate_limited')
      result.deferred++
      return
    }
    if (failure.code === 'forbidden' && row.sessionId) {
      await finish(row, 'failed', failure.code)
      await markSessionInaccessible(row.sessionId)
      result.failed++
      return
    }
    if (failure.permanent) {
      await finish(row, 'failed', failure.code)
      result.failed++
      return
    }
    // A rejected token takes the refresh path (as for any OAuth authentication failure), then retries.
    if (failure.code === 'invalid_auth') await refreshAfterAuthenticationFailure(row.connectionId)
    await retry(row, at, failure.code, result)
  }
}

function expired(row: OutboxRow, at: Date) {
  return at.getTime() - row.createdAt.getTime() >= LINEAR_OUTBOX_FINAL_ITEM_MAX_AGE_MS
}

async function giveUp(row: OutboxRow, attempts: number, code: string, result: DrainLinearOutboxResult) {
  await db
    .update(linearActivityOutbox)
    .set({ status: 'failed', attempts, lastErrorCode: code, claimToken: null, claimedAt: null, updatedAt: new Date() })
    .where(and(eq(linearActivityOutbox.id, row.id), eq(linearActivityOutbox.claimToken, row.claimToken!)))
  log.warn(`Linear outbox item ${row.id} failed after ${attempts} attempts: ${code}`)
  result.failed++
}

async function retry(row: OutboxRow, at: Date, code: string, result: DrainLinearOutboxResult) {
  const attempts = row.attempts + 1
  // Progress may be counted out; a final item keeps retrying until its wall-clock limit.
  if (row.collapsible ? attempts >= LINEAR_OUTBOX_MAX_ATTEMPTS : expired(row, at)) {
    await giveUp(row, attempts, code, result)
    return
  }
  await db
    .update(linearActivityOutbox)
    .set({
      status: 'pending',
      attempts,
      lastErrorCode: code,
      nextAttemptAt: new Date(at.getTime() + linearOutboxBackoffMs(attempts)),
      claimToken: null,
      claimedAt: null,
      updatedAt: new Date(),
    })
    .where(and(eq(linearActivityOutbox.id, row.id), eq(linearActivityOutbox.claimToken, row.claimToken!)))
  result.deferred++
}

/** Asks the OAuth refresh service for a new token after Linear rejected the current one. */
async function refreshAfterAuthenticationFailure(connectionId: string) {
  try {
    const { integrationRefreshService } = await import('../runtime')
    await integrationRefreshService.refresh(connectionId, 'authentication_failure')
  } catch (error) {
    log.warn(
      `Linear token refresh after an authentication failure failed: ${error instanceof Error ? error.name : 'error'}`
    )
  }
}

/** Finished outbox rows are kept this long (for idempotency of late re-projections), then pruned. */
export const LINEAR_OUTBOX_RETENTION_MS = 30 * 24 * 3_600_000

/** Removes finished rows older than the retention window; pending and sending rows are never pruned. */
export async function pruneLinearOutbox(now = new Date()) {
  await db
    .delete(linearActivityOutbox)
    .where(
      and(
        inArray(linearActivityOutbox.status, ['sent', 'skipped', 'failed']),
        lt(linearActivityOutbox.updatedAt, new Date(now.getTime() - LINEAR_OUTBOX_RETENTION_MS))
      )
    )
}

/** Whether anything is due now (the drain loop runs again at once when a pass was full). */
export async function linearOutboxHasDue(now = new Date()) {
  const [row] = await db
    .select({ id: linearActivityOutbox.id })
    .from(linearActivityOutbox)
    .where(and(eq(linearActivityOutbox.status, 'pending'), lte(linearActivityOutbox.nextAttemptAt, now)))
    .limit(1)
  return !!row
}
