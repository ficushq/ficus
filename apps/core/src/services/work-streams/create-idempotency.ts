/**
 * Idempotent work stream creation.
 *
 * A client may send `Idempotency-Key` with `POST /api/workstreams`. The first
 * request with a key claims it for (squad, requester, key) before anything is
 * provisioned; a repeat with the same key and the same request body gets the
 * stream the first request created instead of a second stream and worktree.
 *
 * Claims are rows in `work_stream_create_requests`:
 * - pending (`work_stream_id` null): the owner renews a short lease while it
 *   provisions. A repeat waits for the owner to finish. If the owner's process
 *   dies, the lease expires and the repeat takes the claim over.
 * - bound: the owner set `work_stream_id` inside the creation transaction, so
 *   the stream and its claim commit together. Repeats return that stream.
 * - gone: the owner deleted the claim because creation failed, so a repeat
 *   starts a fresh create (and sees the same validation errors, if any).
 *
 * Lease comparisons use the database clock so Core processes on different
 * hosts agree on expiry.
 */
import { createHash } from 'node:crypto'
import { and, eq, isNull, lt, sql } from 'drizzle-orm'
import { db } from '../../db'
import { workStreamCreateRequests } from '../../db/schema'
import { createLogger } from '../../lib/infra/logger'
import type { Identity } from '../rbac/permissions'

const log = createLogger('work-stream-create')

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key'
const KEY_PATTERN = /^[\x21-\x7e]{1,200}$/

/** How long a pending claim survives without a renewal. */
export const CREATE_CLAIM_LEASE_MS = 60_000
/** How often the owner renews its claim. */
export const CREATE_CLAIM_RENEW_MS = 20_000
/**
 * How long a repeat waits for an in-progress create before answering 409 `create_in_progress`.
 * Kept well under the CLI's default budget (150 s) so the CLI sees the answer and retries.
 */
export const CREATE_CLAIM_WAIT_MS = 45_000
/** Claims older than this are pruned; a key is only meaningful for retries, not forever. */
const CREATE_CLAIM_RETENTION_DAYS = 30

export class InvalidIdempotencyKeyError extends Error {
  readonly status = 400
  readonly code = 'invalid_idempotency_key'
  constructor() {
    super(`${IDEMPOTENCY_KEY_HEADER} must be 1 to 200 printable ASCII characters without spaces`)
    this.name = 'InvalidIdempotencyKeyError'
  }
}

/** The key was already used for a different request body. */
export class IdempotencyKeyConflictError extends Error {
  readonly status = 409
  readonly code = 'idempotency_key_conflict'
  constructor() {
    super(
      'This idempotency key was already used for a different work stream create request; use a new key for a new request'
    )
    this.name = 'IdempotencyKeyConflictError'
  }
}

/** Another request with this key is still creating the stream. Retrying later with the same key is safe. */
export class CreateInProgressError extends Error {
  readonly status = 409
  readonly code = 'create_in_progress'
  constructor() {
    super(
      'A create request with this idempotency key is still in progress; retry with the same key to get its work stream'
    )
    this.name = 'CreateInProgressError'
  }
}

/** The owner lost its claim (its lease expired and another request took over), so it must not commit. */
export class CreateClaimLostError extends Error {
  readonly status = 409
  readonly code = 'create_claim_lost'
  constructor() {
    super('Idempotency claim was taken over by another request; this create was rolled back')
    this.name = 'CreateClaimLostError'
  }
}

/** Thrown by WorkStream.create when the key already produced a stream. */
export class WorkStreamCreateReplayError extends Error {
  constructor(public readonly workStreamId: string) {
    super(`This idempotency key already created work stream ${workStreamId}`)
    this.name = 'WorkStreamCreateReplayError'
  }
}

export interface CreateIdempotencyInput {
  squadId: string
  requesterKey: string
  key: string
  fingerprint: string
}

/** Undefined when the header is absent; throws for a malformed key. */
export function parseIdempotencyKey(value: string | undefined | null): string | undefined {
  if (value === undefined || value === null) return undefined
  if (!KEY_PATTERN.test(value)) throw new InvalidIdempotencyKeyError()
  return value
}

/** Keys are scoped to the authenticated identity, so one caller can never collide with another's key. */
export function requesterKeyFor(identity: Identity): string {
  switch (identity.type) {
    case 'user':
      return `user:${identity.userId}`
    case 'agent':
      return `agent:${identity.agentId}`
    case 'system':
      return `system:${identity.systemTokenId}`
    default:
      return 'legacy'
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/**
 * Stable across key order and absent fields, so a client retry with the same body always matches.
 *
 * `metadata.sources[*].addedAt` is left out: clients (the CLI's --from-url, --from-slack,
 * --from-memory and --source-link) stamp it with the current time, so a re-run of the same
 * command with the same key would otherwise never match its first attempt.
 */
export function fingerprintCreateRequest(body: unknown): string {
  return createHash('sha256')
    .update(canonicalJson(withoutSourceTimestamps(body)))
    .digest('hex')
}

function withoutSourceTimestamps(body: unknown): unknown {
  if (!body || typeof body !== 'object') return body
  const metadata = (body as { metadata?: unknown }).metadata
  if (!metadata || typeof metadata !== 'object') return body
  const sources = (metadata as { sources?: unknown }).sources
  if (!Array.isArray(sources)) return body
  return {
    ...body,
    metadata: {
      ...metadata,
      sources: sources.map((source) => {
        if (!source || typeof source !== 'object') return source
        const { addedAt: _addedAt, ...rest } = source as Record<string, unknown>
        return rest
      }),
    },
  }
}

export interface CreateClaim {
  readonly id: string
  readonly token: string
  /** Renew the lease until the returned stop function runs. */
  keepAlive(): () => void
  /** Record the created stream in the creation transaction; throws {@link CreateClaimLostError} if taken over. */
  bind(tx: DbTransaction, workStreamId: string): Promise<void>
  /** Delete the pending claim after a failed create so a retry starts fresh. */
  release(): Promise<void>
}

export type ClaimResult = { kind: 'claimed'; claim: CreateClaim } | { kind: 'existing'; workStreamId: string }

export interface ClaimOptions {
  waitMs?: number
  leaseMs?: number
  renewMs?: number
  signal?: AbortSignal
  sleep?: (ms: number) => Promise<void>
}

const leaseUntil = (ms: number) => sql`now() + make_interval(secs => ${ms / 1000})`

function claimHandle(id: string, token: string, options: Required<Pick<ClaimOptions, 'leaseMs' | 'renewMs'>>) {
  const owned = and(
    eq(workStreamCreateRequests.id, id),
    eq(workStreamCreateRequests.claimToken, token),
    isNull(workStreamCreateRequests.workStreamId)
  )
  const claim: CreateClaim = {
    id,
    token,
    keepAlive() {
      const timer = setInterval(() => {
        db.update(workStreamCreateRequests)
          .set({ leaseExpiresAt: leaseUntil(options.leaseMs) })
          .where(owned)
          .catch((error: unknown) => log.warn(`Could not renew work stream create claim ${id}:`, error))
      }, options.renewMs)
      timer.unref?.()
      return () => clearInterval(timer)
    },
    async bind(tx, workStreamId) {
      const rows = await tx
        .update(workStreamCreateRequests)
        .set({ workStreamId })
        .where(owned)
        .returning({ id: workStreamCreateRequests.id })
      if (rows.length === 0) throw new CreateClaimLostError()
    },
    async release() {
      await db
        .delete(workStreamCreateRequests)
        .where(owned)
        .catch((error: unknown) => log.warn(`Could not release work stream create claim ${id}:`, error))
    },
  }
  return claim
}

/**
 * Claim `input.key`, or find the stream it already created. A pending claim
 * held by a live owner is waited on (up to `waitMs`); one whose lease expired
 * is taken over.
 */
export async function claimCreateRequest(
  input: CreateIdempotencyInput,
  options: ClaimOptions = {}
): Promise<ClaimResult> {
  const waitMs = options.waitMs ?? CREATE_CLAIM_WAIT_MS
  const leaseMs = options.leaseMs ?? CREATE_CLAIM_LEASE_MS
  const renewMs = options.renewMs ?? CREATE_CLAIM_RENEW_MS
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms))
  const deadline = Date.now() + waitMs
  const scope = and(
    eq(workStreamCreateRequests.squadId, input.squadId),
    eq(workStreamCreateRequests.requesterKey, input.requesterKey),
    eq(workStreamCreateRequests.idempotencyKey, input.key)
  )
  let pause = 100
  for (;;) {
    options.signal?.throwIfAborted()
    const token = crypto.randomUUID()
    const [inserted] = await db
      .insert(workStreamCreateRequests)
      .values({
        squadId: input.squadId,
        requesterKey: input.requesterKey,
        idempotencyKey: input.key,
        requestFingerprint: input.fingerprint,
        claimToken: token,
        leaseExpiresAt: leaseUntil(leaseMs),
      })
      .onConflictDoNothing()
      .returning({ id: workStreamCreateRequests.id })
    if (inserted) {
      await pruneExpiredClaims()
      return { kind: 'claimed', claim: claimHandle(inserted.id, token, { leaseMs, renewMs }) }
    }

    const [existing] = await db
      .select({
        id: workStreamCreateRequests.id,
        fingerprint: workStreamCreateRequests.requestFingerprint,
        claimToken: workStreamCreateRequests.claimToken,
        workStreamId: workStreamCreateRequests.workStreamId,
        expired: sql<boolean>`${workStreamCreateRequests.leaseExpiresAt} < now()`,
      })
      .from(workStreamCreateRequests)
      .where(scope)
      .limit(1)
    // Released between our insert and read: try to claim again.
    if (!existing) continue
    if (existing.fingerprint !== input.fingerprint) throw new IdempotencyKeyConflictError()
    if (existing.workStreamId) return { kind: 'existing', workStreamId: existing.workStreamId }
    if (existing.expired) {
      const [taken] = await db
        .update(workStreamCreateRequests)
        .set({ claimToken: token, leaseExpiresAt: leaseUntil(leaseMs) })
        .where(
          and(
            eq(workStreamCreateRequests.id, existing.id),
            eq(workStreamCreateRequests.claimToken, existing.claimToken),
            isNull(workStreamCreateRequests.workStreamId),
            lt(workStreamCreateRequests.leaseExpiresAt, sql`now()`)
          )
        )
        .returning({ id: workStreamCreateRequests.id })
      if (taken) {
        log.warn(`Took over an expired work stream create claim ${existing.id}; its first request did not finish`)
        return { kind: 'claimed', claim: claimHandle(taken.id, token, { leaseMs, renewMs }) }
      }
      continue
    }
    if (Date.now() >= deadline) throw new CreateInProgressError()
    await sleep(Math.min(pause, Math.max(0, deadline - Date.now())))
    pause = Math.min(pause * 2, 1_000)
  }
}

async function pruneExpiredClaims(): Promise<void> {
  await db
    .execute(
      sql`DELETE FROM ${workStreamCreateRequests} WHERE ${workStreamCreateRequests.id} IN (
        SELECT ${workStreamCreateRequests.id} FROM ${workStreamCreateRequests}
        WHERE ${workStreamCreateRequests.createdAt} < now() - make_interval(days => ${CREATE_CLAIM_RETENTION_DAYS})
          AND ${workStreamCreateRequests.leaseExpiresAt} < now()
        LIMIT 100)`
    )
    .catch((error: unknown) => log.warn('Could not prune old work stream create claims:', error))
}
