import { and, eq, gt, isNull, lte, or, sql } from 'drizzle-orm'
import { db, integrationAuthorizationFlowReceipts, integrationOauthStates } from '../../../db'
import { authorizationCredentialReference, sweepExpiredAuthorizationFlows } from './flow-repository'
import type { NewOAuthStateRecord, OAuthStateRecord, OAuthStateRepository } from './state-repository'

const RECOVERY_HOURS = 24

export class DbOAuthStateRepository implements OAuthStateRepository {
  async create(state: NewOAuthStateRecord): Promise<void> {
    await db.insert(integrationOauthStates).values(state)
  }

  async consume(input: { stateHash: string; providerKey: string; userId: string }): Promise<OAuthStateRecord | null> {
    const [row] = await db
      .delete(integrationOauthStates)
      .where(
        and(
          eq(integrationOauthStates.stateHash, input.stateHash),
          eq(integrationOauthStates.providerKey, input.providerKey),
          eq(integrationOauthStates.userId, input.userId),
          gt(integrationOauthStates.expiresAt, sql`now()`)
        )
      )
      .returning()
    return mapState(row)
  }

  async claimByFlow(input: {
    localFlowId: string
    providerKey: string
    userId: string
    authority: 'platform_broker'
    handleHash: string
  }): Promise<OAuthStateRecord | null> {
    return db.transaction(async (tx) => {
      const [row] = await tx
        .update(integrationOauthStates)
        .set({
          completionHandleHash: sql`coalesce(${integrationOauthStates.completionHandleHash}, ${input.handleHash})`,
          recoveryExpiresAt: sql`coalesce(${integrationOauthStates.recoveryExpiresAt}, now() + (${RECOVERY_HOURS} * interval '1 hour'))`,
        })
        .where(
          and(
            eq(integrationOauthStates.localFlowId, input.localFlowId),
            eq(integrationOauthStates.providerKey, input.providerKey),
            eq(integrationOauthStates.userId, input.userId),
            eq(integrationOauthStates.authority, input.authority),
            or(
              and(
                isNull(integrationOauthStates.completionHandleHash),
                gt(integrationOauthStates.expiresAt, sql`now()`)
              ),
              and(
                eq(integrationOauthStates.completionHandleHash, input.handleHash),
                gt(integrationOauthStates.recoveryExpiresAt, sql`now()`)
              )
            )
          )
        )
        .returning()
      const state = mapState(row)
      if (!state?.localFlowId || !state.recoveryExpiresAt) return null

      const artifactCredentialRef = authorizationCredentialReference(state.localFlowId)
      await tx
        .insert(integrationAuthorizationFlowReceipts)
        .values({
          localFlowId: state.localFlowId,
          providerKey: state.providerKey,
          purpose: state.purpose ?? 'integration',
          linkGeneration: state.linkGeneration ?? null,
          authority: state.authority,
          intent: state.intent,
          initiatingUserId: state.userId,
          returnTo: state.returnTo,
          completionHandleHash: input.handleHash,
          sourceConnectionId: state.connectionId,
          sourceMaterialRevision: state.expectedMaterialRevision,
          artifactCredentialRef,
          recoveryExpiresAt: state.recoveryExpiresAt,
          retainUntil: state.recoveryExpiresAt,
        })
        .onConflictDoNothing({ target: integrationAuthorizationFlowReceipts.localFlowId })
      const [receipt] = await tx
        .select()
        .from(integrationAuthorizationFlowReceipts)
        .where(eq(integrationAuthorizationFlowReceipts.localFlowId, state.localFlowId))
      if (
        !receipt ||
        receipt.providerKey !== state.providerKey ||
        receipt.purpose !== (state.purpose ?? 'integration') ||
        receipt.linkGeneration !== (state.linkGeneration ?? null) ||
        receipt.authority !== state.authority ||
        receipt.intent !== state.intent ||
        receipt.initiatingUserId !== state.userId ||
        receipt.returnTo !== state.returnTo ||
        receipt.completionHandleHash !== input.handleHash ||
        receipt.sourceConnectionId !== state.connectionId ||
        receipt.sourceMaterialRevision !== state.expectedMaterialRevision ||
        receipt.artifactCredentialRef !== artifactCredentialRef ||
        receipt.recoveryExpiresAt.getTime() !== state.recoveryExpiresAt.getTime() ||
        receipt.retainUntil.getTime() < state.recoveryExpiresAt.getTime()
      ) {
        throw new Error('Authorization flow receipt identity mismatch')
      }
      return state
    })
  }

  async finishByFlow(input: { localFlowId: string; handleHash: string }): Promise<boolean> {
    return this.#deleteClaim(input, 'installed')
  }

  async burnByFlow(input: { localFlowId: string; handleHash: string }): Promise<boolean> {
    return this.#deleteClaim(input, 'terminal')
  }

  async flowExists(localFlowId: string): Promise<boolean> {
    const [row] = await db
      .select({ stateHash: integrationOauthStates.stateHash })
      .from(integrationOauthStates)
      .where(eq(integrationOauthStates.localFlowId, localFlowId))
      .limit(1)
    return Boolean(row)
  }

  async #deleteClaim(
    input: { localFlowId: string; handleHash: string },
    disposition: 'installed' | 'terminal'
  ): Promise<boolean> {
    return db.transaction(async (tx) => {
      const [receipt] = await tx
        .select()
        .from(integrationAuthorizationFlowReceipts)
        .where(eq(integrationAuthorizationFlowReceipts.localFlowId, input.localFlowId))
        .for('update')
      const compatible =
        disposition === 'installed'
          ? Boolean(receipt?.installKind || receipt?.identityProofId)
          : receipt?.terminalAt !== null ||
            receipt?.revocationRequiredAt !== null ||
            receipt?.cleanupRequiredAt !== null
      if (!receipt || !compatible) return false

      const rows = await tx
        .delete(integrationOauthStates)
        .where(
          and(
            eq(integrationOauthStates.localFlowId, input.localFlowId),
            eq(integrationOauthStates.completionHandleHash, input.handleHash)
          )
        )
        .returning({ stateHash: integrationOauthStates.stateHash })
      return rows.length === 1
    })
  }

  async deleteExpired(): Promise<number> {
    await sweepExpiredAuthorizationFlows()
    const rows = await db
      .delete(integrationOauthStates)
      .where(
        lte(sql`coalesce(${integrationOauthStates.recoveryExpiresAt}, ${integrationOauthStates.expiresAt})`, sql`now()`)
      )
      .returning({ stateHash: integrationOauthStates.stateHash })
    return rows.length
  }
}

function mapState(row: typeof integrationOauthStates.$inferSelect | undefined): OAuthStateRecord | null {
  if (
    !row ||
    (row.intent !== 'connect' && row.intent !== 'reconnect') ||
    (row.purpose !== 'integration' && row.purpose !== 'github_identity') ||
    (row.authority !== 'local' && row.authority !== 'platform_broker')
  ) {
    return null
  }
  return { ...row, purpose: row.purpose, intent: row.intent, authority: row.authority }
}
