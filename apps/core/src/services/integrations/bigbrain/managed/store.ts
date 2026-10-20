/**
 * Core's durable record of managed shared BigBrain vaults: the idempotent create request and the
 * last Platform summary applied to it. Platform and the root host own provisioning; this store
 * never invents progress, only records requests and monotonically applies authoritative replies.
 */
import { createHash } from 'node:crypto'
import { and, eq, isNull, ne, sql } from 'drizzle-orm'
import { z } from 'zod'
import {
  managedBigbrainOwnerSchema,
  managedBigbrainReadHandoffSchema,
  managedBigbrainVaultSummarySchema,
  type ManagedBigbrainState,
  type ManagedBigbrainVaultSummary,
} from '@ficus/shared/managed-bigbrain'
import { db, managedBigbrainVaults } from '../../../../db'

export type ManagedVault = typeof managedBigbrainVaults.$inferSelect
/** The imported host read handoff minus its token: identity/binding facts that are safe to
 * persist. The token itself is stored only in the credential store. */
export const managedReadMaterialSchema = managedBigbrainReadHandoffSchema.innerType().omit({ token: true })
export type ManagedReadMaterial = z.infer<typeof managedReadMaterialSchema>
export type ManagedVaultStoreCode =
  | 'invalid_request'
  | 'request_conflict'
  | 'name_conflict'
  | 'identity_mismatch'
  | 'not_found'
  | 'generation_conflict'

export class ManagedVaultStoreError extends Error {
  constructor(readonly code: ManagedVaultStoreCode) {
    super(code)
    this.name = 'ManagedVaultStoreError'
  }
}

const createRequestSchema = z
  .object({
    requestId: z.string().uuid(),
    displayName: managedBigbrainVaultSummarySchema.innerType().shape.displayName,
    ownerUserId: z.string().uuid(),
    ownerHandle: managedBigbrainOwnerSchema.shape.handle,
    ownerDisplay: managedBigbrainOwnerSchema.shape.display,
    actorUserId: z.string().uuid(),
  })
  .strict()
export type ManagedVaultCreateRequest = z.infer<typeof createRequestSchema>

/** The fields that define WHAT was requested: a replay must match them exactly. */
function requestHash(input: ManagedVaultCreateRequest): string {
  return createHash('sha256')
    .update(JSON.stringify([input.displayName, input.ownerUserId, input.ownerHandle, input.ownerDisplay]))
    .digest('hex')
}

function uniqueViolation(error: unknown): string | null {
  const cause = (error as { cause?: unknown })?.cause ?? error
  const record = cause as { code?: unknown; constraint?: unknown; constraint_name?: unknown }
  if (record?.code !== '23505') return null
  return String(record.constraint ?? record.constraint_name ?? '')
}

export const managedVaultStore = {
  /** Create (or replay) a vault request. The vault UUID is minted here exactly once per request ID. */
  async request(input: ManagedVaultCreateRequest): Promise<ManagedVault> {
    const parsed = createRequestSchema.safeParse(input)
    if (!parsed.success) throw new ManagedVaultStoreError('invalid_request')
    const request = parsed.data
    const hash = requestHash(request)
    const replay = async (): Promise<ManagedVault | null> => {
      const [existing] = await db
        .select()
        .from(managedBigbrainVaults)
        .where(eq(managedBigbrainVaults.createRequestId, request.requestId))
      if (!existing) return null
      if (existing.createRequestHash !== hash) throw new ManagedVaultStoreError('request_conflict')
      return existing
    }
    const prior = await replay()
    if (prior) return prior
    try {
      const [inserted] = await db
        .insert(managedBigbrainVaults)
        .values({
          id: crypto.randomUUID(),
          ownerUserId: request.ownerUserId,
          ownerHandle: request.ownerHandle,
          ownerDisplay: request.ownerDisplay,
          displayName: request.displayName,
          createRequestId: request.requestId,
          createRequestHash: hash,
          createdByUserId: request.actorUserId,
        })
        .onConflictDoNothing({ target: managedBigbrainVaults.createRequestId })
        .returning()
      if (inserted) return inserted
    } catch (error) {
      if (uniqueViolation(error) !== 'uq_managed_bigbrain_vaults_live_display_name') throw error
      // The live name is taken — possibly by a concurrent replay of THIS request, which converges.
      const concurrent = await replay()
      if (concurrent) return concurrent
      throw new ManagedVaultStoreError('name_conflict')
    }
    // A concurrent identical request won the insert: converge on its row.
    const winner = await replay()
    if (!winner) throw new ManagedVaultStoreError('request_conflict')
    return winner
  },

  async get(id: string): Promise<ManagedVault | null> {
    if (!z.string().uuid().safeParse(id).success) return null
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

  /**
   * Apply an authoritative Platform summary. Ordering is (desiredGeneration, appliedGeneration):
   * an older or equal-progress reply is ignored, so a late in-flight response never rolls state
   * back. A tombstone is final. The owner can never change through a summary.
   */
  async applySummary(value: ManagedBigbrainVaultSummary): Promise<ManagedVault> {
    const parsed = managedBigbrainVaultSummarySchema.safeParse(value)
    if (!parsed.success) throw new ManagedVaultStoreError('invalid_request')
    const summary = parsed.data
    return db
      .transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(managedBigbrainVaults)
          .where(eq(managedBigbrainVaults.id, summary.vaultId))
          .for('update')
        if (!row) throw new ManagedVaultStoreError('not_found')
        if (row.ownerUserId !== summary.ownerUserId) throw new ManagedVaultStoreError('identity_mismatch')
        const observedAt = new Date(summary.updatedAt)
        const order = [
          summary.desiredGeneration - row.desiredGeneration,
          summary.appliedGeneration - row.appliedGeneration,
          row.platformUpdatedAt ? observedAt.getTime() - row.platformUpdatedAt.getTime() : 1,
        ].find((delta) => delta !== 0)
        if (row.state === 'deleted' || order === undefined || order < 0) return row
        const [updated] = await tx
          .update(managedBigbrainVaults)
          .set({
            displayName: summary.displayName,
            state: summary.state satisfies ManagedBigbrainState,
            readAccess: summary.readAccess,
            desiredGeneration: summary.desiredGeneration,
            appliedGeneration: summary.appliedGeneration,
            upstreamVaultId: summary.upstreamVaultId,
            operationId: summary.operationId,
            lastErrorCode: summary.lastErrorCode,
            retryable: summary.retryable,
            origin: summary.origin,
            platformUpdatedAt: observedAt,
            updatedAt: sql`now()`,
          })
          .where(eq(managedBigbrainVaults.id, row.id))
          .returning()
        return updated!
      })
      .catch((error: unknown) => {
        if (uniqueViolation(error) === 'uq_managed_bigbrain_vaults_live_display_name')
          throw new ManagedVaultStoreError('name_conflict')
        throw error
      })
  },

  async getByConnection(connectionId: string): Promise<ManagedVault | null> {
    if (!z.string().uuid().safeParse(connectionId).success) return null
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
          eq(managedBigbrainVaults.state, 'ready'),
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

  /** Forget imported material (revocation, deletion, restore): reads stop resolving at once. */
  async clearReadMaterial(vaultId: string): Promise<void> {
    if (!z.string().uuid().safeParse(vaultId).success) return
    await db
      .update(managedBigbrainVaults)
      .set({ readMaterial: null, updatedAt: sql`now()` })
      .where(eq(managedBigbrainVaults.id, vaultId))
  },

  /** Compare-and-set the desired generation before sending a mutation that requires it. */
  async advanceGeneration(id: string, expectedGeneration: number): Promise<ManagedVault> {
    if (!z.string().uuid().safeParse(id).success) throw new ManagedVaultStoreError('not_found')
    const [updated] = await db
      .update(managedBigbrainVaults)
      .set({ desiredGeneration: sql`${managedBigbrainVaults.desiredGeneration} + 1`, updatedAt: sql`now()` })
      .where(
        and(
          eq(managedBigbrainVaults.id, id),
          eq(managedBigbrainVaults.desiredGeneration, expectedGeneration),
          ne(managedBigbrainVaults.state, 'deleted')
        )
      )
      .returning()
    if (updated) return updated
    throw new ManagedVaultStoreError((await this.get(id)) ? 'generation_conflict' : 'not_found')
  },
}
