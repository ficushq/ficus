/**
 * Core's durable record of managed shared BigBrain vaults. Core is the vault authority: each row
 * is the desired state (name, owner, desired generation, the pending host action) and the last
 * host receipt applied to it. The worker reconciler drains pending actions through the local
 * root helper; this store never invents host progress, it records requests, applies receipts
 * monotonically and keeps a secret-free replay ledger.
 */
import { createHash } from 'node:crypto'
import { and, asc, eq, isNotNull, isNull, lte, ne, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import {
  managedBigbrainHostReceiptSchema,
  managedBigbrainLimitsSchema,
  managedBigbrainOwnerSchema,
  managedBigbrainReadHandoffObjectSchema,
  managedBigbrainVaultShortId,
  type ManagedBigbrainHostReceipt,
} from '@ficus/shared/managed-bigbrain'
import { db, managedBigbrainOperations, managedBigbrainVaults, type DbTx } from '../../../../db'

export type ManagedVault = typeof managedBigbrainVaults.$inferSelect
export type ManagedVaultAction = 'create' | 'rename' | 'read-revoke' | 'read-reconnect' | 'delete'
/** The imported host read handoff minus its token: identity/binding facts that are safe to
 * persist. The token itself is stored only in the credential store. */
export const managedReadMaterialSchema = managedBigbrainReadHandoffObjectSchema.omit({ token: true })
export type ManagedReadMaterial = z.infer<typeof managedReadMaterialSchema>
export type ManagedVaultStoreCode =
  | 'invalid_request'
  | 'request_conflict'
  | 'name_conflict'
  | 'identity_mismatch'
  | 'not_found'
  | 'generation_conflict'
  | 'capacity'
  /** The new vault UUID's 12-hex short id is already used by another vault (any state): the
   * caller must mint a new UUID (and origin) and retry. Nothing was created. */
  | 'short_id_conflict'

export class ManagedVaultStoreError extends Error {
  constructor(
    readonly code: ManagedVaultStoreCode,
    /** The vault's current desired generation on races, so a client can re-read and retry. */
    readonly currentGeneration?: number
  ) {
    super(code)
    this.name = 'ManagedVaultStoreError'
  }
}

const uuid = z.string().uuid()
const label = z
  .string()
  .min(1)
  .max(120)
  .refine((v) => v === v.trim() && !/\p{Cc}/u.test(v))
export const managedCreateRecipeSchema = z
  .object({
    origin: z.string().max(253),
    limits: managedBigbrainLimitsSchema,
    upstreamCommit: z.string().regex(/^[0-9a-f]{40}$/),
    artifactDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  })
  .strict()
export type ManagedCreateRecipe = z.infer<typeof managedCreateRecipeSchema>
const createRequestSchema = z
  .object({
    vaultId: uuid.optional(),
    requestId: uuid,
    displayName: label,
    hostOwnerUserId: uuid,
    ownerHandle: managedBigbrainOwnerSchema.shape.handle,
    ownerDisplay: managedBigbrainOwnerSchema.shape.display,
    actorUserId: uuid,
    recipe: managedCreateRecipeSchema,
    /** Live vaults allowed on this host; checked under a lock with the insert. */
    maxLive: z.number().int().min(1).optional(),
  })
  .strict()
export type ManagedVaultCreateRequest = z.infer<typeof createRequestSchema>
const operationRequestSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('rename'),
      requestId: uuid,
      expectedGeneration: z.number().int().min(1),
      displayName: label,
    })
    .strict(),
  z
    .object({
      action: z.enum(['read-revoke', 'read-reconnect', 'delete']),
      requestId: uuid,
      expectedGeneration: z.number().int().min(1),
    })
    .strict(),
])
export type ManagedVaultOperationRequest = z.infer<typeof operationRequestSchema>

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
/** Retry backoff for a retryable host failure: 5 s, 30 s, 2 min, then every 10 min. */
export const MANAGED_VAULT_BACKOFF_MS = [5_000, 30_000, 120_000, 600_000] as const
function backoff(attempts: number): number {
  return MANAGED_VAULT_BACKOFF_MS[Math.min(attempts, MANAGED_VAULT_BACKOFF_MS.length) - 1] ?? 5_000
}

function uniqueViolation(error: unknown): string | null {
  const cause = (error as { cause?: unknown })?.cause ?? error
  const record = cause as { code?: unknown; constraint?: unknown; constraint_name?: unknown }
  if (record?.code !== '23505') return null
  return String(record.constraint ?? record.constraint_name ?? '')
}

async function lockRow(tx: DbTx, vaultId: string): Promise<ManagedVault> {
  const [row] = await tx.select().from(managedBigbrainVaults).where(eq(managedBigbrainVaults.id, vaultId)).for('update')
  if (!row) throw new ManagedVaultStoreError('not_found')
  return row
}

export const managedVaultStore = {
  /** Create (or replay) a vault request. The vault UUID is minted here exactly once per request
   * ID; the host create recipe is snapshotted so retries send the identical request. */
  async request(input: ManagedVaultCreateRequest): Promise<ManagedVault> {
    const parsed = createRequestSchema.safeParse(input)
    if (!parsed.success) throw new ManagedVaultStoreError('invalid_request')
    const request = parsed.data
    const inputHash = hash([
      request.displayName,
      request.hostOwnerUserId,
      request.ownerHandle,
      request.ownerDisplay,
      request.recipe.limits,
      request.recipe.upstreamCommit,
    ])
    const replay = async (): Promise<ManagedVault | null> => {
      const [existing] = await db
        .select()
        .from(managedBigbrainVaults)
        .where(eq(managedBigbrainVaults.createRequestId, request.requestId))
      if (!existing) return null
      if (existing.createRequestHash !== inputHash) throw new ManagedVaultStoreError('request_conflict')
      return existing
    }
    const prior = await replay()
    if (prior) return prior
    const id = request.vaultId ?? crypto.randomUUID()
    try {
      const inserted = await db.transaction(async (tx) => {
        // Serialize creates so two concurrent requests cannot both pass the capacity or short-id checks.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext('managed_bigbrain_vaults:create'))`)
        // Tenant-prefixed hostnames carry only 12 hex of the UUID: no two vaults of this tenant
        // (including deleted ones whose DNS record may linger) may share them.
        const shortId = managedBigbrainVaultShortId(id)
        const [taken] = await tx
          .select({ id: managedBigbrainVaults.id })
          .from(managedBigbrainVaults)
          .where(sql`left(replace(${managedBigbrainVaults.id}::text, '-', ''), 12) = ${shortId}`)
          .limit(1)
        if (taken) throw new ManagedVaultStoreError('short_id_conflict')
        if (request.maxLive !== undefined) {
          const [live] = await tx
            .select({ n: sql<number>`count(*)::int` })
            .from(managedBigbrainVaults)
            .where(ne(managedBigbrainVaults.state, 'deleted'))
          if ((live?.n ?? 0) >= request.maxLive) throw new ManagedVaultStoreError('capacity')
        }
        const [row] = await tx
          .insert(managedBigbrainVaults)
          .values({
            id,
            hostOwnerUserId: request.hostOwnerUserId,
            ownerHandle: request.ownerHandle,
            ownerDisplay: request.ownerDisplay,
            displayName: request.displayName,
            createRequestId: request.requestId,
            createRequestHash: inputHash,
            createRecipe: request.recipe,
            origin: request.recipe.origin,
            state: 'provisioning',
            desiredAction: 'create',
            operationRequestId: request.requestId,
            operationHash: inputHash,
            nextAttemptAt: sql`now()`,
            createdByUserId: request.actorUserId,
          })
          .onConflictDoNothing({ target: managedBigbrainVaults.createRequestId })
          .returning()
        if (!row) return null
        await tx.insert(managedBigbrainOperations).values({
          requestId: request.requestId,
          vaultId: row.id,
          action: 'create',
          inputHash,
          expectedGeneration: 0,
          generation: 1,
        })
        return row
      })
      if (inserted) return inserted
    } catch (error) {
      if (uniqueViolation(error) !== 'uq_managed_bigbrain_vaults_live_display_name') throw error
      // The live name is taken — possibly by a concurrent replay of THIS request, which converges.
      const concurrent = await replay()
      if (concurrent) return concurrent
      throw new ManagedVaultStoreError('name_conflict')
    }
    const winner = await replay()
    if (!winner) throw new ManagedVaultStoreError('request_conflict')
    return winner
  },

  /** Record a human operation on an existing vault: fenced on the desired generation, applied
   * to Core's intent at once (rename's name, revoke's access fence, delete's `deleting` state),
   * then executed on the host by the reconciler. The same request ID replays; a different body
   * under that ID conflicts. */
  async requestOperation(vaultId: string, input: ManagedVaultOperationRequest): Promise<ManagedVault> {
    const parsed = operationRequestSchema.safeParse(input)
    if (!parsed.success || !uuid.safeParse(vaultId).success) throw new ManagedVaultStoreError('invalid_request')
    const request = parsed.data
    const inputHash = hash([vaultId, request])
    try {
      return await db.transaction(async (tx) => {
        const row = await lockRow(tx, vaultId)
        const [ledger] = await tx
          .select()
          .from(managedBigbrainOperations)
          .where(eq(managedBigbrainOperations.requestId, request.requestId))
        if (ledger) {
          if (ledger.inputHash !== inputHash || ledger.vaultId !== vaultId)
            throw new ManagedVaultStoreError('request_conflict')
          return row
        }
        if (row.state === 'deleted' || (row.state === 'deleting' && request.action !== 'delete'))
          throw new ManagedVaultStoreError('not_found')
        if (row.desiredGeneration !== request.expectedGeneration)
          throw new ManagedVaultStoreError('generation_conflict', row.desiredGeneration)
        // Only delete may replace a pending action; everything else needs the host caught up.
        if (row.desiredAction !== null && request.action !== 'delete')
          throw new ManagedVaultStoreError('generation_conflict', row.desiredGeneration)
        if (request.action !== 'delete' && row.state !== 'ready' && row.state !== 'degraded')
          throw new ManagedVaultStoreError('generation_conflict', row.desiredGeneration)
        const generation = row.desiredGeneration + 1
        const [updated] = await tx
          .update(managedBigbrainVaults)
          .set({
            desiredGeneration: generation,
            desiredAction: request.action,
            operationRequestId: request.requestId,
            operationHash: inputHash,
            attempts: 0,
            nextAttemptAt: sql`now()`,
            lastErrorCode: null,
            retryable: false,
            ...(request.action === 'rename' ? { displayName: request.displayName } : {}),
            ...(request.action === 'read-revoke' ? { readAccess: 'revoked', readMaterial: null } : {}),
            ...(request.action === 'read-reconnect' ? { readAccess: 'pending' } : {}),
            ...(request.action === 'delete' ? { state: 'deleting', readMaterial: null } : {}),
            updatedAt: sql`now()`,
          })
          .where(eq(managedBigbrainVaults.id, vaultId))
          .returning()
        await tx.insert(managedBigbrainOperations).values({
          requestId: request.requestId,
          vaultId,
          action: request.action,
          inputHash,
          expectedGeneration: request.expectedGeneration,
          generation,
        })
        return updated!
      })
    } catch (error) {
      if (uniqueViolation(error) === 'uq_managed_bigbrain_vaults_live_display_name')
        throw new ManagedVaultStoreError('name_conflict')
      throw error
    }
  },

  /** Re-arm a paused (terminally failed) pending operation: same request, same recipe. Never a
   * new identity or invite. */
  async retry(vaultId: string, input: { requestId: string; expectedGeneration: number }): Promise<ManagedVault> {
    if (!uuid.safeParse(vaultId).success || !uuid.safeParse(input.requestId).success)
      throw new ManagedVaultStoreError('invalid_request')
    const inputHash = hash([vaultId, 'retry', input.expectedGeneration])
    return db.transaction(async (tx) => {
      const row = await lockRow(tx, vaultId)
      const [ledger] = await tx
        .select()
        .from(managedBigbrainOperations)
        .where(eq(managedBigbrainOperations.requestId, input.requestId))
      if (ledger) {
        if (ledger.inputHash !== inputHash) throw new ManagedVaultStoreError('request_conflict')
        return row
      }
      if (row.state === 'deleted') throw new ManagedVaultStoreError('not_found')
      if (row.desiredGeneration !== input.expectedGeneration)
        throw new ManagedVaultStoreError('generation_conflict', row.desiredGeneration)
      if (row.desiredAction === null) throw new ManagedVaultStoreError('generation_conflict', row.desiredGeneration)
      const [updated] = await tx
        .update(managedBigbrainVaults)
        .set({
          attempts: 0,
          nextAttemptAt: sql`now()`,
          retryable: false,
          lastErrorCode: null,
          ...(row.desiredAction === 'create' ? { state: 'provisioning' } : {}),
          updatedAt: sql`now()`,
        })
        .where(eq(managedBigbrainVaults.id, vaultId))
        .returning()
      await tx.insert(managedBigbrainOperations).values({
        requestId: input.requestId,
        vaultId,
        action: 'retry',
        inputHash,
        expectedGeneration: input.expectedGeneration,
        generation: row.desiredGeneration,
      })
      return updated!
    })
  },

  async get(id: string): Promise<ManagedVault | null> {
    if (!uuid.safeParse(id).success) return null
    const [row] = await db.select().from(managedBigbrainVaults).where(eq(managedBigbrainVaults.id, id))
    return row ?? null
  },

  /** Live (non-tombstoned) vaults, oldest first. */
  list(): Promise<ManagedVault[]> {
    return db
      .select()
      .from(managedBigbrainVaults)
      .where(ne(managedBigbrainVaults.state, 'deleted'))
      .orderBy(managedBigbrainVaults.createdAt, managedBigbrainVaults.id)
  },

  /** Read connections of live (non-tombstoned) vaults: the only managed connections Ficus offers,
   * lists or shows as attached. A deleted vault's connection (and its squad attachments) is kept
   * for a restore, but stays out of every list until its vault is live again. */
  async liveConnectionIds(): Promise<Set<string>> {
    const rows = await db
      .select({ connectionId: managedBigbrainVaults.connectionId })
      .from(managedBigbrainVaults)
      .where(and(ne(managedBigbrainVaults.state, 'deleted'), isNotNull(managedBigbrainVaults.connectionId)))
    return new Set(rows.flatMap((row) => (row.connectionId ? [row.connectionId] : [])))
  },

  /** Every row the reconciler may need to sweep, including tombstones (a restored host may still
   * run a vault Core deleted after the backup). */
  all(): Promise<ManagedVault[]> {
    return db.select().from(managedBigbrainVaults).orderBy(managedBigbrainVaults.createdAt, managedBigbrainVaults.id)
  },

  /** Pending operations due now, oldest first. */
  due(now: Date, limit = 1): Promise<ManagedVault[]> {
    return db
      .select()
      .from(managedBigbrainVaults)
      .where(
        and(
          isNotNull(managedBigbrainVaults.desiredAction),
          isNotNull(managedBigbrainVaults.nextAttemptAt),
          lte(managedBigbrainVaults.nextAttemptAt, now)
        )
      )
      .orderBy(asc(managedBigbrainVaults.nextAttemptAt), asc(managedBigbrainVaults.id))
      .limit(limit)
  },

  /**
   * Apply a host receipt (reply to a create/rename/read/delete/status). Generations never go
   * down. When the host reaches the desired generation the pending action is complete. A receipt
   * from a newer generation than Core asked for (a restored host) is adopted. A tombstone is final.
   */
  async applyReceipt(value: ManagedBigbrainHostReceipt): Promise<ManagedVault> {
    const parsed = managedBigbrainHostReceiptSchema.safeParse(value)
    if (!parsed.success) throw new ManagedVaultStoreError('invalid_request')
    const receipt = parsed.data
    return db.transaction(async (tx) => {
      const row = await lockRow(tx, receipt.vaultId)
      if (row.state === 'deleted') return row
      if (
        row.upstreamVaultId !== null &&
        receipt.upstreamVaultId !== null &&
        row.upstreamVaultId !== receipt.upstreamVaultId
      )
        throw new ManagedVaultStoreError('identity_mismatch')
      if (receipt.generation < row.appliedGeneration) return row
      const caughtUp = receipt.generation >= row.desiredGeneration
      const adopted = receipt.generation > row.desiredGeneration
      const deleted = receipt.state === 'deleted'
      const [updated] = await tx
        .update(managedBigbrainVaults)
        .set({
          appliedGeneration: receipt.generation,
          ...(adopted ? { desiredGeneration: receipt.generation } : {}),
          upstreamVaultId: receipt.upstreamVaultId ?? row.upstreamVaultId,
          artifactDigest: receipt.artifactDigest,
          hostReceiptId: receipt.receiptId,
          hostDisplayName: receipt.displayName,
          ...(receipt.backup ? { backup: receipt.backup } : {}),
          ...(receipt.origin ? { origin: receipt.origin } : {}),
          // A pending delete keeps `deleting` until the host reports it deleted.
          state: deleted ? 'deleted' : row.desiredAction === 'delete' && !caughtUp ? 'deleting' : receipt.state,
          // Pending read intent wins until the host reaches it; then the host's state is truth.
          readAccess:
            !caughtUp && (row.desiredAction === 'read-revoke' || row.desiredAction === 'read-reconnect')
              ? row.readAccess
              : receipt.readAccess,
          ...(caughtUp
            ? { desiredAction: null, nextAttemptAt: null, attempts: 0, lastErrorCode: null, retryable: false }
            : {}),
          ...(receipt.readAccess !== 'active' || deleted ? { readMaterial: null } : {}),
          updatedAt: sql`now()`,
        })
        .where(eq(managedBigbrainVaults.id, row.id))
        .returning()
      if (caughtUp && row.operationRequestId)
        await tx
          .update(managedBigbrainOperations)
          .set({ status: 'applied' })
          .where(eq(managedBigbrainOperations.requestId, row.operationRequestId))
      return updated!
    })
  },

  /** A failed host attempt for the pending operation. Retryable failures back off; anything
   * else pauses the operation (`retryable:false`) until a human retries. A failed create marks
   * the vault failed. */
  async recordFailure(
    vaultId: string,
    operationRequestId: string,
    failure: { code: string; retryable: boolean; now?: Date }
  ): Promise<ManagedVault | null> {
    const code = /^[a-z_]{1,64}$/.test(failure.code) ? failure.code : 'operation_failed'
    return db.transaction(async (tx) => {
      const row = await lockRow(tx, vaultId)
      if (row.operationRequestId !== operationRequestId || row.desiredAction === null) return row
      const attempts = row.attempts + 1
      const now = failure.now ?? new Date()
      const [updated] = await tx
        .update(managedBigbrainVaults)
        .set({
          attempts,
          lastErrorCode: code,
          retryable: failure.retryable,
          nextAttemptAt: failure.retryable ? new Date(now.getTime() + backoff(attempts)) : null,
          ...(!failure.retryable && row.desiredAction === 'create' ? { state: 'failed' } : {}),
          updatedAt: sql`now()`,
        })
        .where(eq(managedBigbrainVaults.id, vaultId))
        .returning()
      if (!failure.retryable)
        await tx
          .update(managedBigbrainOperations)
          .set({ status: 'failed', code })
          .where(eq(managedBigbrainOperations.requestId, operationRequestId))
      return updated!
    })
  },

  /** The host has no record of a vault Core believes exists (e.g. created after the backup this
   * host was restored from). Not retryable: a human deletes it. */
  async markHostMissing(vaultId: string): Promise<void> {
    await db
      .update(managedBigbrainVaults)
      .set({
        state: 'failed',
        lastErrorCode: 'storage_unavailable',
        retryable: false,
        desiredAction: null,
        nextAttemptAt: null,
        readMaterial: null,
        updatedAt: sql`now()`,
      })
      .where(and(eq(managedBigbrainVaults.id, vaultId), ne(managedBigbrainVaults.state, 'deleted')))
  },

  /** Finalize a delete the host has completed (or never had): a permanent tombstone. */
  async finalizeTombstone(vaultId: string): Promise<ManagedVault | null> {
    const [updated] = await db
      .update(managedBigbrainVaults)
      .set({
        state: 'deleted',
        appliedGeneration: sql`${managedBigbrainVaults.desiredGeneration}`,
        desiredAction: null,
        nextAttemptAt: null,
        attempts: 0,
        lastErrorCode: null,
        retryable: false,
        readMaterial: null,
        updatedAt: sql`now()`,
      })
      .where(eq(managedBigbrainVaults.id, vaultId))
      .returning()
    if (updated?.operationRequestId)
      await db
        .update(managedBigbrainOperations)
        .set({ status: 'applied' })
        .where(eq(managedBigbrainOperations.requestId, updated.operationRequestId))
    return updated ?? null
  },

  /** A Core-authoritative follow-up the reconciler starts itself (host name drift, deleting a
   * vault a restored host still runs). Only when nothing is pending. */
  async scheduleFollowUp(vaultId: string, action: 'rename' | 'delete'): Promise<ManagedVault | null> {
    const requestId = crypto.randomUUID()
    return db.transaction(async (tx) => {
      const row = await lockRow(tx, vaultId)
      if (row.desiredAction !== null) return row
      const generation = row.desiredGeneration + 1
      const inputHash = hash([vaultId, 'follow-up', action, generation])
      const [updated] = await tx
        .update(managedBigbrainVaults)
        .set({
          desiredGeneration: generation,
          desiredAction: action,
          operationRequestId: requestId,
          operationHash: inputHash,
          attempts: 0,
          nextAttemptAt: sql`now()`,
          updatedAt: sql`now()`,
        })
        .where(eq(managedBigbrainVaults.id, vaultId))
        .returning()
      await tx.insert(managedBigbrainOperations).values({
        requestId,
        vaultId,
        action,
        inputHash,
        expectedGeneration: row.desiredGeneration,
        generation,
      })
      return updated!
    })
  },

  async getByConnection(connectionId: string): Promise<ManagedVault | null> {
    if (!uuid.safeParse(connectionId).success) return null
    const [row] = await db
      .select()
      .from(managedBigbrainVaults)
      .where(eq(managedBigbrainVaults.connectionId, connectionId))
    return row ?? null
  },

  /** Record imported read material (token-free) for a ready, readable vault. Refused unless the
   * vault is ready with active read access and the material is not from a generation Core has
   * not observed. */
  async recordReadMaterial(vaultId: string, value: ManagedReadMaterial): Promise<ManagedVault> {
    const material = managedReadMaterialSchema.safeParse(value)
    if (!material.success || material.data.vaultId !== vaultId) throw new ManagedVaultStoreError('invalid_request')
    const [updated] = await db
      .update(managedBigbrainVaults)
      .set({ readMaterial: material.data, updatedAt: sql`now()` })
      .where(
        and(
          eq(managedBigbrainVaults.id, vaultId),
          or(eq(managedBigbrainVaults.state, 'ready'), eq(managedBigbrainVaults.state, 'degraded')),
          eq(managedBigbrainVaults.readAccess, 'active'),
          eq(managedBigbrainVaults.upstreamVaultId, material.data.upstreamVaultId),
          sql`${managedBigbrainVaults.appliedGeneration} >= ${material.data.generation}`
        )
      )
      .returning()
    if (updated) return updated
    throw new ManagedVaultStoreError((await this.get(vaultId)) ? 'generation_conflict' : 'not_found')
  },

  /** Bind the vault's one pool connection, exactly once (compare-and-set on an unbound row). */
  async bindConnection(vaultId: string, connectionId: string): Promise<ManagedVault> {
    const [updated] = await db
      .update(managedBigbrainVaults)
      .set({ connectionId, updatedAt: sql`now()` })
      .where(and(eq(managedBigbrainVaults.id, vaultId), isNull(managedBigbrainVaults.connectionId)))
      .returning()
    if (updated) return updated
    const current = await this.get(vaultId)
    if (current?.connectionId === connectionId) return current
    throw new ManagedVaultStoreError(current ? 'generation_conflict' : 'not_found')
  },

  /** A failed read-credential synchronization: its safe code and when to try again. Not a
   * lifecycle change, so `updatedAt` is left alone. */
  async recordReadSyncFailure(vaultId: string, code: string, nextAt: Date): Promise<void> {
    await db
      .update(managedBigbrainVaults)
      .set({
        readSyncErrorCode: code.slice(0, 64),
        readSyncAttempts: sql`${managedBigbrainVaults.readSyncAttempts} + 1`,
        readSyncNextAt: nextAt,
      })
      .where(eq(managedBigbrainVaults.id, vaultId))
  },

  /** The read credential synchronized (or no longer applies): clear any failure and backoff. */
  async clearReadSyncFailure(vaultId: string): Promise<void> {
    await db
      .update(managedBigbrainVaults)
      .set({ readSyncErrorCode: null, readSyncAttempts: 0, readSyncNextAt: null })
      .where(
        and(
          eq(managedBigbrainVaults.id, vaultId),
          or(
            isNotNull(managedBigbrainVaults.readSyncErrorCode),
            ne(managedBigbrainVaults.readSyncAttempts, 0),
            isNotNull(managedBigbrainVaults.readSyncNextAt)
          )
        )
      )
  },

  /** Forget imported material (revocation, deletion, restore): reads stop resolving at once. */
  async clearReadMaterial(vaultId: string): Promise<void> {
    if (!uuid.safeParse(vaultId).success) return
    await db
      .update(managedBigbrainVaults)
      .set({ readMaterial: null, updatedAt: sql`now()` })
      .where(eq(managedBigbrainVaults.id, vaultId))
  },
}
