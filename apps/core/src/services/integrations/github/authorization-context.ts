import { createHash } from 'node:crypto'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { db } from '../../../db'
import { integrationAuthorizationFlowReceipts } from '../../../db/schema'
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
