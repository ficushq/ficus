import { createHash } from 'node:crypto'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { db } from '../../../db'
import {
  integrationAuthorizationFlowReceipts,
  integrationOauthStates,
  integrationDeviceAuthorizations,
} from '../../../db/schema'
import type { OAuthAuthorizationPurpose } from '../authorization/state-repository'
import { z } from 'zod'
import type { Identity } from '../../rbac'
import type { AuthorizationFlowReceiptRepository } from '../authorization/flow-repository'
import { AuthorizationFlowError, BROKER_COMPLETION_HANDLE_PATTERN } from '../authorization/service'
import { requireGitHubHuman } from './feedback-trust'
import type { GitHubPersonalOAuthFinalizer } from './personal-oauth-finalizer'

/** Recover only a self-owned local proof copy/result. Never retry an already-consumed provider code. */
export async function resumeLocalGitHubIdentity(input: {
  identity: Identity | undefined
  nonce: string
  finalizer: Pick<GitHubPersonalOAuthFinalizer, 'install'>
  receipts: AuthorizationFlowReceiptRepository
}): Promise<{ returnTo: string } | null> {
  const userId = await requireGitHubHuman(db, input.identity)
  if (!BROKER_COMPLETION_HANDLE_PATTERN.test(input.nonce)) throw new AuthorizationFlowError('malformed_state')
  const stateHash = createHash('sha256').update(input.nonce).digest('hex')
  const [row] = await db
    .select({ id: integrationAuthorizationFlowReceipts.localFlowId })
    .from(integrationAuthorizationFlowReceipts)
    .where(
      and(
        eq(integrationAuthorizationFlowReceipts.completionHandleHash, stateHash),
        eq(integrationAuthorizationFlowReceipts.initiatingUserId, userId),
        eq(integrationAuthorizationFlowReceipts.providerKey, 'github'),
        eq(integrationAuthorizationFlowReceipts.purpose, 'github_identity'),
        eq(integrationAuthorizationFlowReceipts.authority, 'local'),
        eq(integrationAuthorizationFlowReceipts.intent, 'connect'),
        isNull(integrationAuthorizationFlowReceipts.sourceConnectionId),
        isNull(integrationAuthorizationFlowReceipts.sourceMaterialRevision),
        sql`${integrationAuthorizationFlowReceipts.recoveryExpiresAt} > clock_timestamp()`
      )
    )
    .limit(1)
  if (!row) return null
  const receipt = await input.receipts.getRecoverable(row.id)
  if (
    !receipt ||
    receipt.completionHandleHash !== stateHash ||
    receipt.initiatingUserId !== userId ||
    receipt.providerKey !== 'github' ||
    receipt.authority !== 'local' ||
    receipt.purpose !== 'github_identity' ||
    receipt.intent !== 'connect' ||
    receipt.sourceConnectionId !== null ||
    receipt.sourceMaterialRevision !== null
  )
    throw new AuthorizationFlowError('identity_flow_mismatch')
  // The finalizer serializes recovery against the original callback and other retries. Even an
  // unstarted receipt cannot be marked terminal outside that lease while its first callback runs.
  await input.finalizer.install({
    identity: input.identity,
    userId,
    state: {
      stateHash,
      localFlowId: receipt.localFlowId,
      authority: receipt.authority,
      completionHandleHash: receipt.completionHandleHash,
      recoveryExpiresAt: receipt.recoveryExpiresAt,
      providerKey: receipt.providerKey,
      userId,
      intent: 'connect',
      purpose: 'github_identity',
      linkGeneration: receipt.linkGeneration,
      connectionId: null,
      expectedMaterialRevision: null,
      // Recovery never exchanges a code; no reconstructed redirect URI can reach a provider.
      redirectUri: '',
      returnTo: receipt.returnTo,
      expiresAt: receipt.recoveryExpiresAt,
      createdAt: new Date(),
    },
    exchange: async () => {
      throw new AuthorizationFlowError('local_authorization_restart_required')
    },
  })
  return { returnTo: receipt.returnTo }
}

export type GitHubAuthorizationSource =
  | { kind: 'callback'; state: string }
  | { kind: 'complete'; localFlowId: string }
  | { kind: 'device'; id: string }

/** Internal routing metadata only. The HTTP guard supplies the authenticated user, not a body owner. */
export async function resolveStoredGitHubPurpose(input: {
  providerKey: string
  userId: string
  source: GitHubAuthorizationSource
}): Promise<OAuthAuthorizationPurpose | null> {
  if (input.providerKey !== 'github') return null
  const { source } = input
  if (source.kind === 'device') {
    if (!z.string().uuid().safeParse(source.id).success) return null
    // Metadata-only join: do not decrypt the device code merely to select a permission family.
    const [row] = await db
      .select({ purpose: integrationAuthorizationFlowReceipts.purpose })
      .from(integrationDeviceAuthorizations)
      .innerJoin(
        integrationAuthorizationFlowReceipts,
        eq(integrationAuthorizationFlowReceipts.localFlowId, integrationDeviceAuthorizations.id)
      )
      .where(
        and(
          eq(integrationDeviceAuthorizations.id, source.id),
          eq(integrationDeviceAuthorizations.userId, input.userId),
          eq(integrationAuthorizationFlowReceipts.initiatingUserId, input.userId),
          eq(integrationAuthorizationFlowReceipts.providerKey, 'github'),
          eq(integrationAuthorizationFlowReceipts.authority, 'local')
        )
      )
      .limit(1)
    return row?.purpose === 'github_identity' || row?.purpose === 'integration' ? row.purpose : null
  }
  if (source.kind === 'callback' && !BROKER_COMPLETION_HANDLE_PATTERN.test(source.state)) return null
  if (source.kind === 'complete' && !z.string().uuid().safeParse(source.localFlowId).success) return null
  const authority = source.kind === 'callback' ? 'local' : 'platform_broker'
  const stateHash = source.kind === 'callback' ? createHash('sha256').update(source.state).digest('hex') : null
  const [state] = await db
    .select({ purpose: integrationOauthStates.purpose })
    .from(integrationOauthStates)
    .where(
      and(
        eq(integrationOauthStates.userId, input.userId),
        eq(integrationOauthStates.providerKey, 'github'),
        eq(integrationOauthStates.authority, authority),
        source.kind === 'callback'
          ? eq(integrationOauthStates.stateHash, stateHash!)
          : eq(integrationOauthStates.localFlowId, source.localFlowId)
      )
    )
    .limit(1)
  const [receipt] = await db
    .select({ purpose: integrationAuthorizationFlowReceipts.purpose })
    .from(integrationAuthorizationFlowReceipts)
    .where(
      and(
        eq(integrationAuthorizationFlowReceipts.initiatingUserId, input.userId),
        eq(integrationAuthorizationFlowReceipts.providerKey, 'github'),
        eq(integrationAuthorizationFlowReceipts.authority, authority),
        source.kind === 'callback'
          ? eq(integrationAuthorizationFlowReceipts.completionHandleHash, stateHash!)
          : eq(integrationAuthorizationFlowReceipts.localFlowId, source.localFlowId)
      )
    )
    .limit(1)
  if (state && receipt && state.purpose !== receipt.purpose) throw new AuthorizationFlowError('identity_flow_mismatch')
  const purpose = state?.purpose ?? receipt?.purpose
  return purpose === 'github_identity' || purpose === 'integration' ? purpose : null
}
