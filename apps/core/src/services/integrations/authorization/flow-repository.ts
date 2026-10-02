import { and, eq, gt, isNotNull, isNull, lte, or, sql } from 'drizzle-orm'
import {
  db,
  integrationAuthorizationFlowReceipts,
  integrationConnections,
  integrationCredentialCleanupJobs,
  integrationOauthStates,
  integrationRevocationJobs,
  secrets,
} from '../../../db'
import type { OAuthAuthority } from './authority'
import type { OAuthAuthorizationPurpose } from './state-repository'
import { connectionAuthorizationLeaseKey } from './connection-lease'

export type AuthorizationInstallKind = 'connect' | 'reconnect_same' | 'reconnect_distinct'

export interface AuthorizationFlowReceipt {
  localFlowId: string
  providerKey: string
  authority: OAuthAuthority
  intent: 'connect' | 'reconnect'
  initiatingUserId: string
  purpose?: OAuthAuthorizationPurpose
  linkGeneration?: number | null
  returnTo: string
  completionHandleHash: string
  adapterVersion: number | null
  sourceConnectionId: string | null
  sourceMaterialRevision: string | null
  artifactCredentialRef: string
  stagingStartedAt: Date | null
  installKind: AuthorizationInstallKind | null
  installedConnectionId: string | null
  installedMaterialRevision: string | null
  installedAt: Date | null
  terminalCode: string | null
  terminalAt: Date | null
  revocationRequiredAt: Date | null
  revocationSettledAt: Date | null
  cleanupRequiredAt: Date | null
  cleanupSettledAt: Date | null
  recoveryExpiresAt: Date
  retainUntil: Date
}

export interface AuthorizationFlowBinding {
  providerKey: string
  authority: OAuthAuthority
  intent: 'connect' | 'reconnect'
  userId: string
  purpose?: OAuthAuthorizationPurpose
  linkGeneration?: number | null
  connectionId: string | null
  expectedMaterialRevision: string | null
}

export interface AuthorizationFlowReceiptRepository {
  get(localFlowId: string, binding?: AuthorizationFlowBinding): Promise<AuthorizationFlowReceipt | null>
  getRecoverable(localFlowId: string): Promise<AuthorizationFlowReceipt | null>
  beginStaging(localFlowId: string, adapterVersion: number): Promise<AuthorizationFlowReceipt | null>
  markTerminal(localFlowId: string, code: string): Promise<AuthorizationFlowReceipt | null>
  requireRevocation(input: {
    localFlowId: string
    adapterVersion: number
    code: string
  }): Promise<AuthorizationFlowReceipt | null>
  requireCleanup(localFlowId: string, code: string): Promise<AuthorizationFlowReceipt | null>
}

export class DbAuthorizationFlowReceiptRepository implements AuthorizationFlowReceiptRepository {
  async get(localFlowId: string, binding?: AuthorizationFlowBinding): Promise<AuthorizationFlowReceipt | null> {
    const [row] = await db
      .select()
      .from(integrationAuthorizationFlowReceipts)
      .where(eq(integrationAuthorizationFlowReceipts.localFlowId, localFlowId))
      .limit(1)
    const receipt = mapReceipt(row)
    if (
      binding &&
      (!receipt ||
        receipt.providerKey !== binding.providerKey ||
        (receipt.purpose ?? 'integration') !== (binding.purpose ?? 'integration') ||
        (receipt.linkGeneration ?? null) !== (binding.linkGeneration ?? null) ||
        receipt.authority !== binding.authority ||
        receipt.intent !== binding.intent ||
        receipt.initiatingUserId !== binding.userId ||
        receipt.sourceConnectionId !== binding.connectionId ||
        receipt.sourceMaterialRevision !== binding.expectedMaterialRevision)
    ) {
      return null
    }
    return receipt
  }

  async getRecoverable(localFlowId: string): Promise<AuthorizationFlowReceipt | null> {
    const [row] = await db
      .select()
      .from(integrationAuthorizationFlowReceipts)
      .where(
        and(
          eq(integrationAuthorizationFlowReceipts.localFlowId, localFlowId),
          sql`${integrationAuthorizationFlowReceipts.recoveryExpiresAt} > clock_timestamp()`
        )
      )
      .limit(1)
    return mapReceipt(row)
  }

  async beginStaging(localFlowId: string, adapterVersion: number): Promise<AuthorizationFlowReceipt | null> {
    const [row] = await db
      .update(integrationAuthorizationFlowReceipts)
      .set({
        stagingStartedAt: sql`coalesce(${integrationAuthorizationFlowReceipts.stagingStartedAt}, now())`,
        adapterVersion: sql`coalesce(${integrationAuthorizationFlowReceipts.adapterVersion}, ${adapterVersion})`,
        retainUntil: sql`greatest(${integrationAuthorizationFlowReceipts.retainUntil}, now() + interval '24 hours')`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(integrationAuthorizationFlowReceipts.localFlowId, localFlowId),
          or(
            gt(integrationAuthorizationFlowReceipts.recoveryExpiresAt, sql`clock_timestamp()`),
            isNotNull(integrationAuthorizationFlowReceipts.stagingStartedAt)
          ),
          isNull(integrationAuthorizationFlowReceipts.installKind),
          isNull(integrationAuthorizationFlowReceipts.terminalAt),
          isNull(integrationAuthorizationFlowReceipts.revocationRequiredAt),
          isNull(integrationAuthorizationFlowReceipts.cleanupRequiredAt),
          sql`(${integrationAuthorizationFlowReceipts.adapterVersion} IS NULL OR ${integrationAuthorizationFlowReceipts.adapterVersion} = ${adapterVersion})`
        )
      )
      .returning()
    return mapReceipt(row)
  }

  async markTerminal(localFlowId: string, code: string): Promise<AuthorizationFlowReceipt | null> {
    const now = sql`transaction_timestamp()`
    const [row] = await db
      .update(integrationAuthorizationFlowReceipts)
      .set({
        terminalCode: sql`coalesce(${integrationAuthorizationFlowReceipts.terminalCode}, ${code})`,
        terminalAt: sql`coalesce(${integrationAuthorizationFlowReceipts.terminalAt}, ${now})`,
        updatedAt: now,
      })
      .where(
        and(
          eq(integrationAuthorizationFlowReceipts.localFlowId, localFlowId),
          isNull(integrationAuthorizationFlowReceipts.installKind),
          sql`(${integrationAuthorizationFlowReceipts.stagingStartedAt} IS NULL OR ${integrationAuthorizationFlowReceipts.revocationRequiredAt} IS NOT NULL OR ${integrationAuthorizationFlowReceipts.cleanupRequiredAt} IS NOT NULL)`
        )
      )
      .returning()
    return mapReceipt(row)
  }

  async requireRevocation(input: {
    localFlowId: string
    adapterVersion: number
    code: string
  }): Promise<AuthorizationFlowReceipt | null> {
    return db.transaction(async (tx) => {
      const [receipt] = await tx
        .select()
        .from(integrationAuthorizationFlowReceipts)
        .where(eq(integrationAuthorizationFlowReceipts.localFlowId, input.localFlowId))
        .for('update')
      if (
        !receipt ||
        receipt.installKind ||
        !receipt.stagingStartedAt ||
        receipt.adapterVersion !== input.adapterVersion
      ) {
        return null
      }
      const now = sql`transaction_timestamp()`
      await tx
        .update(integrationAuthorizationFlowReceipts)
        .set({
          terminalCode: receipt.terminalCode ?? input.code,
          terminalAt: receipt.terminalAt ?? now,
          revocationRequiredAt: receipt.revocationRequiredAt ?? now,
          updatedAt: now,
        })
        .where(eq(integrationAuthorizationFlowReceipts.localFlowId, input.localFlowId))
      const [artifact] = await tx
        .select({ key: secrets.key })
        .from(secrets)
        .where(eq(secrets.key, receipt.artifactCredentialRef))
        .limit(1)
      if (artifact) {
        await tx
          .insert(integrationRevocationJobs)
          .values({
            providerKey: receipt.providerKey,
            adapterVersion: input.adapterVersion,
            clientAuthority: receipt.authority,
            authorizationFlowId: receipt.localFlowId,
            credentialRef: receipt.artifactCredentialRef,
          })
          .onConflictDoNothing({ target: integrationRevocationJobs.credentialRef })
      } else {
        await tx
          .update(integrationAuthorizationFlowReceipts)
          .set({
            revocationSettledAt: now,
            cleanupRequiredAt: now,
            cleanupSettledAt: now,
            updatedAt: now,
          })
          .where(eq(integrationAuthorizationFlowReceipts.localFlowId, input.localFlowId))
      }
      const [updated] = await tx
        .select()
        .from(integrationAuthorizationFlowReceipts)
        .where(eq(integrationAuthorizationFlowReceipts.localFlowId, input.localFlowId))
      return mapReceipt(updated)
    })
  }

  async requireCleanup(localFlowId: string, code: string): Promise<AuthorizationFlowReceipt | null> {
    return db.transaction(async (tx) => {
      const [receipt] = await tx
        .select()
        .from(integrationAuthorizationFlowReceipts)
        .where(eq(integrationAuthorizationFlowReceipts.localFlowId, localFlowId))
        .for('update')
      if (!receipt || receipt.installKind || !receipt.stagingStartedAt) return null
      const now = sql`transaction_timestamp()`
      await tx
        .update(integrationAuthorizationFlowReceipts)
        .set({
          terminalCode: receipt.terminalCode ?? code,
          terminalAt: receipt.terminalAt ?? now,
          cleanupRequiredAt: receipt.cleanupRequiredAt ?? now,
          updatedAt: now,
        })
        .where(eq(integrationAuthorizationFlowReceipts.localFlowId, localFlowId))
      const [artifact] = await tx
        .select({ key: secrets.key })
        .from(secrets)
        .where(eq(secrets.key, receipt.artifactCredentialRef))
        .limit(1)
      if (artifact) {
        await tx
          .insert(integrationCredentialCleanupJobs)
          .values({ authorizationFlowId: receipt.localFlowId, credentialRef: receipt.artifactCredentialRef })
          .onConflictDoNothing({ target: integrationCredentialCleanupJobs.credentialRef })
      } else {
        await tx
          .update(integrationAuthorizationFlowReceipts)
          .set({ cleanupSettledAt: now, updatedAt: now })
          .where(eq(integrationAuthorizationFlowReceipts.localFlowId, localFlowId))
      }
      const [updated] = await tx
        .select()
        .from(integrationAuthorizationFlowReceipts)
        .where(eq(integrationAuthorizationFlowReceipts.localFlowId, localFlowId))
      return mapReceipt(updated)
    })
  }
}

export function authorizationCredentialReference(localFlowId: string): string {
  return `__integration-credential:authorization-flow:${localFlowId}:bearer`
}

export async function sweepExpiredAuthorizationFlows(): Promise<void> {
  const candidates = await db
    .select({ localFlowId: integrationAuthorizationFlowReceipts.localFlowId })
    .from(integrationAuthorizationFlowReceipts)
    .where(lte(integrationAuthorizationFlowReceipts.recoveryExpiresAt, sql`clock_timestamp()`))
    .orderBy(
      integrationAuthorizationFlowReceipts.updatedAt,
      integrationAuthorizationFlowReceipts.recoveryExpiresAt,
      integrationAuthorizationFlowReceipts.localFlowId
    )
    .limit(100)
  for (const candidate of candidates) {
    await db.transaction(async (tx) => {
      const key = connectionAuthorizationLeaseKey(`flow:${candidate.localFlowId}`)
      const [lock] = await tx
        .select({ acquired: sql<boolean>`pg_try_advisory_xact_lock(hashtextextended(${key}, 0))` })
        .from(integrationAuthorizationFlowReceipts)
        .where(eq(integrationAuthorizationFlowReceipts.localFlowId, candidate.localFlowId))
        .limit(1)
      if (!lock?.acquired) return
      const [receipt] = await tx
        .select()
        .from(integrationAuthorizationFlowReceipts)
        .where(
          and(
            eq(integrationAuthorizationFlowReceipts.localFlowId, candidate.localFlowId),
            lte(integrationAuthorizationFlowReceipts.recoveryExpiresAt, sql`clock_timestamp()`)
          )
        )
        .for('update')
      if (!receipt) return
      if (!receipt.installKind && !receipt.terminalAt) {
        const now = sql`transaction_timestamp()`
        await tx
          .update(integrationAuthorizationFlowReceipts)
          .set({
            terminalCode: 'flow_expired',
            terminalAt: now,
            ...(receipt.stagingStartedAt ? { revocationRequiredAt: now } : {}),
            updatedAt: now,
          })
          .where(eq(integrationAuthorizationFlowReceipts.localFlowId, receipt.localFlowId))
      }
      const [current] = await tx
        .select()
        .from(integrationAuthorizationFlowReceipts)
        .where(eq(integrationAuthorizationFlowReceipts.localFlowId, receipt.localFlowId))
      if (!current) return
      if (!current.installKind && current.terminalAt) {
        await tx
          .delete(integrationConnections)
          .where(
            and(
              eq(integrationConnections.authorizationFlowId, current.localFlowId),
              eq(integrationConnections.credentialRef, current.artifactCredentialRef),
              eq(integrationConnections.enabled, false)
            )
          )
      }
      const [secret] = await tx
        .select({ key: secrets.key })
        .from(secrets)
        .where(eq(secrets.key, current.artifactCredentialRef))
        .limit(1)
      if (current.revocationRequiredAt && !current.revocationSettledAt) {
        if (secret) {
          await tx
            .insert(integrationRevocationJobs)
            .values({
              providerKey: current.providerKey,
              adapterVersion: current.adapterVersion!,
              clientAuthority: current.authority,
              authorizationFlowId: current.localFlowId,
              credentialRef: current.artifactCredentialRef,
            })
            .onConflictDoNothing({ target: integrationRevocationJobs.credentialRef })
        } else {
          const now = sql`transaction_timestamp()`
          await tx
            .update(integrationAuthorizationFlowReceipts)
            .set({
              revocationSettledAt: now,
              cleanupRequiredAt: sql`coalesce(${integrationAuthorizationFlowReceipts.cleanupRequiredAt}, ${now})`,
              cleanupSettledAt: sql`coalesce(${integrationAuthorizationFlowReceipts.cleanupSettledAt}, ${now})`,
              updatedAt: now,
            })
            .where(eq(integrationAuthorizationFlowReceipts.localFlowId, current.localFlowId))
        }
      } else if (current.cleanupRequiredAt && !current.cleanupSettledAt) {
        if (secret) {
          await tx
            .insert(integrationCredentialCleanupJobs)
            .values({ authorizationFlowId: current.localFlowId, credentialRef: current.artifactCredentialRef })
            .onConflictDoNothing({ target: integrationCredentialCleanupJobs.credentialRef })
        } else {
          await tx
            .update(integrationAuthorizationFlowReceipts)
            .set({ cleanupSettledAt: sql`transaction_timestamp()`, updatedAt: sql`transaction_timestamp()` })
            .where(eq(integrationAuthorizationFlowReceipts.localFlowId, current.localFlowId))
        }
      }
      await tx
        .update(integrationAuthorizationFlowReceipts)
        .set({ updatedAt: sql`transaction_timestamp()` })
        .where(eq(integrationAuthorizationFlowReceipts.localFlowId, current.localFlowId))
      await tx.delete(integrationOauthStates).where(eq(integrationOauthStates.localFlowId, current.localFlowId))
    })
  }
  await deleteSettledAuthorizationReceipts()
}

function deletableReceiptPredicate() {
  return and(
    lte(integrationAuthorizationFlowReceipts.retainUntil, sql`clock_timestamp()`),
    sql`(
      (${integrationAuthorizationFlowReceipts.installedAt} IS NOT NULL OR ${integrationAuthorizationFlowReceipts.terminalAt} IS NOT NULL)
      AND (${integrationAuthorizationFlowReceipts.revocationRequiredAt} IS NULL OR ${integrationAuthorizationFlowReceipts.revocationSettledAt} IS NOT NULL)
      AND (${integrationAuthorizationFlowReceipts.cleanupRequiredAt} IS NULL OR ${integrationAuthorizationFlowReceipts.cleanupSettledAt} IS NOT NULL)
    )`,
    sql`NOT EXISTS (
      SELECT 1 FROM ${integrationRevocationJobs}
      WHERE ${integrationRevocationJobs.authorizationFlowId} = ${integrationAuthorizationFlowReceipts.localFlowId}
    )`,
    sql`NOT EXISTS (
      SELECT 1 FROM ${integrationCredentialCleanupJobs}
      WHERE ${integrationCredentialCleanupJobs.authorizationFlowId} = ${integrationAuthorizationFlowReceipts.localFlowId}
    )`,
    sql`NOT EXISTS (
      SELECT 1 FROM ${integrationConnections}
      WHERE ${integrationConnections.authorizationFlowId} = ${integrationAuthorizationFlowReceipts.localFlowId}
        AND ${integrationConnections.credentialRef} = ${integrationAuthorizationFlowReceipts.artifactCredentialRef}
    )`,
    sql`NOT EXISTS (
      SELECT 1 FROM ${secrets}
      WHERE ${secrets.key} = ${integrationAuthorizationFlowReceipts.artifactCredentialRef}
    )`
  )
}

export async function deleteSettledAuthorizationReceipts(): Promise<number> {
  const candidates = await db
    .select({ localFlowId: integrationAuthorizationFlowReceipts.localFlowId })
    .from(integrationAuthorizationFlowReceipts)
    .where(deletableReceiptPredicate())
    .orderBy(integrationAuthorizationFlowReceipts.retainUntil, integrationAuthorizationFlowReceipts.localFlowId)
    .limit(100)
  let deleted = 0
  for (const candidate of candidates) {
    deleted += await db.transaction(async (tx) => {
      const key = connectionAuthorizationLeaseKey(`flow:${candidate.localFlowId}`)
      const [lock] = await tx
        .select({ acquired: sql<boolean>`pg_try_advisory_xact_lock(hashtextextended(${key}, 0))` })
        .from(integrationAuthorizationFlowReceipts)
        .where(eq(integrationAuthorizationFlowReceipts.localFlowId, candidate.localFlowId))
        .limit(1)
      if (!lock?.acquired) return 0
      const rows = await tx
        .delete(integrationAuthorizationFlowReceipts)
        .where(
          and(eq(integrationAuthorizationFlowReceipts.localFlowId, candidate.localFlowId), deletableReceiptPredicate())
        )
        .returning({ localFlowId: integrationAuthorizationFlowReceipts.localFlowId })
      return rows.length
    })
  }
  return deleted
}

function mapReceipt(
  row: typeof integrationAuthorizationFlowReceipts.$inferSelect | undefined
): AuthorizationFlowReceipt | null {
  if (
    !row ||
    (row.authority !== 'local' && row.authority !== 'platform_broker') ||
    (row.intent !== 'connect' && row.intent !== 'reconnect') ||
    (row.purpose !== 'integration' && row.purpose !== 'github_identity')
  ) {
    return null
  }
  return row as AuthorizationFlowReceipt
}
