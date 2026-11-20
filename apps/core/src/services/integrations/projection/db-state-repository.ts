import { and, asc, eq, gt, isNull, lte, ne, or, sql } from 'drizzle-orm'
import { db, integrationProjectionStates } from '../../../db'
import type {
  ClaimedIntegrationProjection,
  IntegrationProjectionState,
  IntegrationProjectionStateRepository,
} from './state-repository'

export class DbIntegrationProjectionStateRepository implements IntegrationProjectionStateRepository {
  async sweepMissing(now: Date): Promise<void> {
    await db.execute(sql`
      INSERT INTO ${integrationProjectionStates} (squad_id, provider_key, next_attempt_at, updated_at)
      SELECT assignment.squad_id, assignment.provider_key,
        ${now.toISOString()}::timestamptz, ${now.toISOString()}::timestamptz
      FROM integration_connection_assignments assignment
      ON CONFLICT (squad_id, provider_key) DO NOTHING
    `)
  }

  async invalidate(input: {
    squadId: string
    providerKey: string
    credentialRevision?: bigint | null
    desiredFingerprint?: string | null
    now: Date
  }): Promise<IntegrationProjectionState> {
    const [row] = await db
      .insert(integrationProjectionStates)
      .values({
        squadId: input.squadId,
        providerKey: input.providerKey,
        desiredCredentialRevision: input.credentialRevision ?? null,
        desiredFingerprint: input.desiredFingerprint ?? null,
        nextAttemptAt: input.now,
        updatedAt: input.now,
      })
      .onConflictDoUpdate({
        target: [integrationProjectionStates.squadId, integrationProjectionStates.providerKey],
        set: {
          generation: sql`${integrationProjectionStates.generation} + 1`,
          status: 'pending',
          desiredCredentialRevision: input.credentialRevision ?? null,
          desiredFingerprint: input.desiredFingerprint ?? null,
          nextAttemptAt: input.now,
          leaseToken: null,
          leaseExpiresAt: null,
          lastErrorCode: null,
          updatedAt: input.now,
        },
      })
      .returning()
    return map(row!)
  }

  async claim(now: Date, leaseExpiresAt: Date, leaseToken: string): Promise<ClaimedIntegrationProjection | null> {
    return db.transaction(async (tx) => {
      const [candidate] = await tx
        .select()
        .from(integrationProjectionStates)
        .where(
          and(
            ne(integrationProjectionStates.status, 'ready'),
            lte(integrationProjectionStates.nextAttemptAt, now),
            or(isNull(integrationProjectionStates.leaseToken), lte(integrationProjectionStates.leaseExpiresAt, now))
          )
        )
        .orderBy(asc(integrationProjectionStates.nextAttemptAt), asc(integrationProjectionStates.squadId))
        .for('update', { skipLocked: true })
        .limit(1)
      if (!candidate) return null
      const [row] = await tx
        .update(integrationProjectionStates)
        .set({ status: 'installing', leaseToken, leaseExpiresAt, updatedAt: now })
        .where(
          and(
            eq(integrationProjectionStates.squadId, candidate.squadId),
            eq(integrationProjectionStates.providerKey, candidate.providerKey),
            eq(integrationProjectionStates.generation, candidate.generation)
          )
        )
        .returning()
      return row ? ({ ...map(row), leaseToken, leaseExpiresAt } as ClaimedIntegrationProjection) : null
    })
  }

  async renew(input: {
    squadId: string
    providerKey: string
    generation: bigint
    leaseToken: string
    leaseExpiresAt: Date
    now: Date
  }): Promise<boolean> {
    const rows = await db
      .update(integrationProjectionStates)
      .set({ leaseExpiresAt: input.leaseExpiresAt, updatedAt: input.now })
      .where(fence(input))
      .returning({ squadId: integrationProjectionStates.squadId })
    return rows.length === 1
  }

  async complete(input: {
    squadId: string
    providerKey: string
    generation: bigint
    leaseToken: string
    fingerprint: string
    credentialRevision: bigint | null
    now: Date
  }): Promise<boolean> {
    const rows = await db
      .update(integrationProjectionStates)
      .set({
        status: 'ready',
        appliedFingerprint: input.fingerprint,
        appliedCredentialRevision: input.credentialRevision,
        attempts: 0,
        leaseToken: null,
        leaseExpiresAt: null,
        lastErrorCode: null,
        updatedAt: input.now,
      })
      .where(fence(input))
      .returning({ squadId: integrationProjectionStates.squadId })
    return rows.length === 1
  }

  async fail(input: {
    squadId: string
    providerKey: string
    generation: bigint
    leaseToken: string
    code: string
    nextAttemptAt: Date
    now: Date
  }): Promise<boolean> {
    const code = /^[a-z0-9][a-z0-9_-]{0,63}$/.test(input.code) ? input.code : 'projection_failed'
    const rows = await db
      .update(integrationProjectionStates)
      .set({
        status: 'degraded',
        attempts: sql`${integrationProjectionStates.attempts} + 1`,
        nextAttemptAt: input.nextAttemptAt,
        leaseToken: null,
        leaseExpiresAt: null,
        lastErrorCode: code,
        updatedAt: input.now,
      })
      .where(fence(input))
      .returning({ squadId: integrationProjectionStates.squadId })
    return rows.length === 1
  }

  async listReady(
    limit = 100,
    after: { squadId: string; providerKey: string } | null = null
  ): Promise<readonly IntegrationProjectionState[]> {
    const rows = await db
      .select()
      .from(integrationProjectionStates)
      .where(
        and(
          eq(integrationProjectionStates.status, 'ready'),
          after
            ? or(
                gt(integrationProjectionStates.squadId, after.squadId),
                and(
                  eq(integrationProjectionStates.squadId, after.squadId),
                  gt(integrationProjectionStates.providerKey, after.providerKey)
                )
              )
            : undefined
        )
      )
      .orderBy(asc(integrationProjectionStates.squadId), asc(integrationProjectionStates.providerKey))
      .limit(limit)
    return rows.map(map)
  }

  async get(squadId: string, providerKey: string): Promise<IntegrationProjectionState | null> {
    const [row] = await db
      .select()
      .from(integrationProjectionStates)
      .where(
        and(eq(integrationProjectionStates.squadId, squadId), eq(integrationProjectionStates.providerKey, providerKey))
      )
    return row ? map(row) : null
  }
}

function fence(input: { squadId: string; providerKey: string; generation: bigint; leaseToken: string }) {
  return and(
    eq(integrationProjectionStates.squadId, input.squadId),
    eq(integrationProjectionStates.providerKey, input.providerKey),
    eq(integrationProjectionStates.generation, input.generation),
    eq(integrationProjectionStates.leaseToken, input.leaseToken)
  )
}

function map(row: typeof integrationProjectionStates.$inferSelect): IntegrationProjectionState {
  return {
    squadId: row.squadId,
    providerKey: row.providerKey,
    generation: row.generation,
    status: row.status,
    desiredFingerprint: row.desiredFingerprint,
    appliedFingerprint: row.appliedFingerprint,
    desiredCredentialRevision: row.desiredCredentialRevision,
    appliedCredentialRevision: row.appliedCredentialRevision,
    attempts: row.attempts,
    nextAttemptAt: row.nextAttemptAt,
    leaseToken: row.leaseToken,
    leaseExpiresAt: row.leaseExpiresAt,
    lastErrorCode: row.lastErrorCode,
  }
}
