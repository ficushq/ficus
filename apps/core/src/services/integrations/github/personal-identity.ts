import { and, eq, isNull, sql } from 'drizzle-orm'
import { db, type DbTx } from '../../../db'
import { githubIdentityProofs, githubPersonalIdentities, integrationAuditEvents } from '../../../db/schema'
import type { Identity } from '../../rbac/permissions'
import type { OAuthStateRecord } from '../authorization/state-repository'
import { GitHubFeedbackError, lockGitHubHuman, parseGitHubAccount, requireGitHubHuman } from './feedback-trust'

const PROOF_TTL_SECONDS = 600

async function identityGeneration(tx: DbTx, userId: string) {
  await tx
    .insert(githubPersonalIdentities)
    .values({ userId, accountId: null, login: null, linkedAt: null, unlinkedAt: sql`clock_timestamp()` })
    .onConflictDoNothing()
  const [row] = await tx
    .select()
    .from(githubPersonalIdentities)
    .where(eq(githubPersonalIdentities.userId, userId))
    .for('update')
  return row!
}

/** A persisted tombstone fences even callbacks started before the user's first link. */
export async function beginGitHubIdentityLink(identity: Identity | undefined): Promise<number> {
  return db.transaction(async (tx) => {
    await lockGitHubHuman(tx, identity)
    const userId = await requireGitHubHuman(tx, identity)
    return (await identityGeneration(tx, userId)).generation
  })
}

/** Internal OAuth finalizer boundary. Never expose profile/state as an HTTP mutation body. */
export async function saveGitHubIdentityProof(input: {
  identity: Identity | undefined
  state: OAuthStateRecord
  profile: unknown
}) {
  const userId = await requireGitHubHuman(db, input.identity)
  const { state } = input
  if (
    state.purpose !== 'github_identity' ||
    state.providerKey !== 'github' ||
    state.intent !== 'connect' ||
    state.userId !== userId ||
    state.connectionId !== null ||
    state.expectedMaterialRevision !== null ||
    !Number.isSafeInteger(state.linkGeneration) ||
    state.linkGeneration! < 0 ||
    !/^[0-9a-f]{64}$/.test(state.stateHash)
  )
    throw new GitHubFeedbackError('identity_flow_mismatch', 409)
  const account = parseGitHubAccount(input.profile)
  if (!account || account.accountType !== 'User') throw new GitHubFeedbackError('unverified_personal_account', 409)
  return db.transaction(async (tx) => {
    await lockGitHubHuman(tx, input.identity)
    await requireGitHubHuman(tx, input.identity)
    const [clock] = await tx.execute<{ now: Date }>(sql`SELECT clock_timestamp() AS now`)
    const now = new Date(clock!.now)
    if ((state.recoveryExpiresAt ?? state.expiresAt) <= now) throw new GitHubFeedbackError('identity_flow_expired', 409)
    const [current] = await tx
      .select()
      .from(githubPersonalIdentities)
      .where(eq(githubPersonalIdentities.userId, userId))
      .for('update')
    if (!current || current.generation !== state.linkGeneration)
      throw new GitHubFeedbackError('identity_generation_changed', 409)
    await tx
      .insert(githubIdentityProofs)
      .values({
        userId,
        flowKey: state.stateHash,
        generation: current.generation,
        accountId: account.accountId,
        login: account.login,
        verifiedAt: now,
        expiresAt: new Date(now.getTime() + PROOF_TTL_SECONDS * 1000),
      })
      .onConflictDoNothing({ target: githubIdentityProofs.flowKey })
    const [proof] = await tx
      .select()
      .from(githubIdentityProofs)
      .where(eq(githubIdentityProofs.flowKey, state.stateHash))
    if (
      !proof ||
      proof.userId !== userId ||
      proof.generation !== current.generation ||
      proof.accountId !== account.accountId ||
      proof.login !== account.login ||
      proof.consumedAt ||
      proof.invalidatedAt ||
      proof.expiresAt <= now
    )
      throw new GitHubFeedbackError('identity_proof_changed', 409)
    return {
      id: proof.id,
      accountId: proof.accountId,
      login: proof.login,
      generation: proof.generation,
      expiresAt: proof.expiresAt.toISOString(),
    }
  })
}

export async function getGitHubPersonalIdentity(identity: Identity | undefined) {
  const userId = await requireGitHubHuman(db, identity)
  const [row] = await db
    .select()
    .from(githubPersonalIdentities)
    .where(and(eq(githubPersonalIdentities.userId, userId), isNull(githubPersonalIdentities.unlinkedAt)))
  return row?.accountId && row.login
    ? { accountId: row.accountId, login: row.login, linkedAt: row.linkedAt?.toISOString() }
    : null
}

export async function confirmGitHubIdentityProof(identity: Identity | undefined, proofId: string) {
  try {
    return await db.transaction(async (tx) => {
      await lockGitHubHuman(tx, identity)
      const userId = await requireGitHubHuman(tx, identity)
      const [proof] = await tx
        .select()
        .from(githubIdentityProofs)
        .where(
          and(
            eq(githubIdentityProofs.id, proofId),
            eq(githubIdentityProofs.userId, userId),
            isNull(githubIdentityProofs.consumedAt),
            isNull(githubIdentityProofs.invalidatedAt),
            sql`${githubIdentityProofs.expiresAt} > clock_timestamp()`
          )
        )
        .for('update')
      const current = await identityGeneration(tx, userId)
      if (!proof || proof.generation !== current.generation)
        throw new GitHubFeedbackError('identity_proof_changed', 409)
      await tx
        .update(githubPersonalIdentities)
        .set({
          accountId: proof.accountId,
          login: proof.login,
          generation: current.generation + 1,
          linkedAt: sql`clock_timestamp()`,
          unlinkedAt: null,
        })
        .where(eq(githubPersonalIdentities.userId, userId))
      await tx
        .update(githubIdentityProofs)
        .set({ consumedAt: sql`clock_timestamp()` })
        .where(eq(githubIdentityProofs.id, proof.id))
      await tx.insert(integrationAuditEvents).values({
        userId,
        actorKey: `user:${userId}`,
        action: 'github.identity.link',
        outcome: 'allowed',
        targetKind: 'github_account',
        targetId: proof.accountId,
      })
      return { accountId: proof.accountId, login: proof.login }
    })
  } catch (error) {
    // Active-account uniqueness, not a username check, settles competing confirmations.
    if ((error as { cause?: { code?: string } })?.cause?.code === '23505')
      throw new GitHubFeedbackError('github_account_already_linked', 409)
    throw error
  }
}

/** Removes future dynamic trust only; manual squad grants and integration credentials are untouched. */
export async function unlinkGitHubIdentity(identity: Identity | undefined): Promise<void> {
  await db.transaction(async (tx) => {
    await lockGitHubHuman(tx, identity)
    const userId = await requireGitHubHuman(tx, identity)
    const current = await identityGeneration(tx, userId)
    await tx
      .update(githubPersonalIdentities)
      .set({ unlinkedAt: sql`clock_timestamp()`, generation: current.generation + 1 })
      .where(eq(githubPersonalIdentities.userId, userId))
    await tx
      .update(githubIdentityProofs)
      .set({ invalidatedAt: sql`clock_timestamp()` })
      .where(
        and(
          eq(githubIdentityProofs.userId, userId),
          isNull(githubIdentityProofs.consumedAt),
          isNull(githubIdentityProofs.invalidatedAt)
        )
      )
    await tx.insert(integrationAuditEvents).values({
      userId,
      actorKey: `user:${userId}`,
      action: 'github.identity.unlink',
      outcome: 'allowed',
      targetKind: 'github_identity',
      targetId: userId,
    })
  })
}
