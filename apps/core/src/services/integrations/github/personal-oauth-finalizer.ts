import { and, eq, isNotNull, isNull, ne, sql } from 'drizzle-orm'
import { classifyGitHubOAuthError } from '@ficus/shared/oauth-providers'
import type { GitHubOAuthClient } from '@ficus/shared/oauth-providers/github/client'
import { db } from '../../../db'
import {
  integrationAuthorizationFlowReceipts,
  integrationConnections,
  integrationCredentialCleanupJobs,
  integrationRevocationJobs,
} from '../../../db/schema'
import type { SecretStore } from '../../secrets/store'
import type { Identity } from '../../rbac/permissions'
import {
  parseOAuthCredential,
  serializeOAuthCredential,
  type OAuthCredentialBundleV1,
} from '../authorization/credential-bundle'
import type { AuthorizationFlowReceiptRepository } from '../authorization/flow-repository'
import { revocationArtifactLeaseResource } from '../authorization/connection-lease'
import type { AuthorizationServiceDependencies } from '../authorization/service'
import { AuthorizationFlowError } from '../authorization/service'
import { GitHubFeedbackError, requireGitHubHuman } from './feedback-trust'
import { saveGitHubIdentityProof } from './personal-identity'

/** Recheck at both scheduling and revocation. A personal grant may coincide with an integration token. */
export async function isGitHubIdentityTokenShared(
  credential: OAuthCredentialBundleV1,
  excludedRef: string,
  store: Pick<SecretStore, 'refreshKey' | 'get'>
): Promise<boolean> {
  const connections = await db
    .select({ ref: integrationConnections.credentialRef })
    .from(integrationConnections)
    .where(eq(integrationConnections.providerKey, 'github'))
  const staged = await db
    .select({ ref: integrationAuthorizationFlowReceipts.artifactCredentialRef })
    .from(integrationAuthorizationFlowReceipts)
    .where(
      and(
        eq(integrationAuthorizationFlowReceipts.providerKey, 'github'),
        eq(integrationAuthorizationFlowReceipts.purpose, 'integration'),
        isNotNull(integrationAuthorizationFlowReceipts.stagingStartedAt),
        isNull(integrationAuthorizationFlowReceipts.terminalAt),
        ne(integrationAuthorizationFlowReceipts.artifactCredentialRef, excludedRef)
      )
    )
  for (const ref of new Set([...connections, ...staged].map((row) => row.ref))) {
    if (ref === excludedRef) continue
    await store.refreshKey(ref)
    const raw = store.get(ref)
    if (raw === undefined) continue
    let other: OAuthCredentialBundleV1
    try {
      other = parseOAuthCredential(raw)
    } catch {
      throw new AuthorizationFlowError('shared_token_check_failed')
    }
    if (
      other.accessToken === credential.accessToken ||
      (credential.refreshToken && other.refreshToken === credential.refreshToken)
    )
      return true
  }
  return false
}

interface FinalizerDependencies {
  secrets: Pick<SecretStore, 'setWithDurableObligation' | 'refreshKey' | 'get'>
  receipts: AuthorizationFlowReceiptRepository
  client: Pick<GitHubOAuthClient, 'currentIdentity'>
  lease: { runExclusiveMany<T>(keys: readonly string[], action: () => Promise<T>): Promise<T> }
}

type PersonalInstall = Pick<
  Parameters<AuthorizationServiceDependencies['installGrant']>[0],
  'state' | 'userId' | 'exchange'
>

/** Ownership proof only. Deliberately has no integration installer, signing, assignment, or projection dependency. */
export class GitHubPersonalOAuthFinalizer {
  constructor(private readonly dependencies: FinalizerDependencies) {}

  async install(input: PersonalInstall & { identity: Identity | undefined }): Promise<void> {
    const { state } = input
    if (
      state.purpose !== 'github_identity' ||
      state.providerKey !== 'github' ||
      state.intent !== 'connect' ||
      !state.localFlowId ||
      state.userId !== input.userId ||
      !Number.isSafeInteger(state.linkGeneration) ||
      state.linkGeneration! < 0
    )
      throw new AuthorizationFlowError('identity_flow_mismatch')
    const { identity } = input
    if ((await requireGitHubHuman(db, identity)) !== input.userId)
      throw new AuthorizationFlowError('identity_flow_mismatch')
    const binding = { ...state, purpose: 'github_identity' as const }
    const initial = await this.dependencies.receipts.get(state.localFlowId, binding)
    if (!initial) throw new AuthorizationFlowError('identity_flow_mismatch')
    await this.dependencies.lease.runExclusiveMany(
      [`flow:${state.localFlowId}`, revocationArtifactLeaseResource(initial.artifactCredentialRef)],
      async () => {
        const receipt = await this.dependencies.receipts.get(state.localFlowId!, binding)
        if (!receipt) throw new AuthorizationFlowError('identity_flow_mismatch')
        if (receipt.identityProofId) return
        if (receipt.terminalCode) throw new AuthorizationFlowError(receipt.terminalCode)
        const admitted = await this.dependencies.receipts.beginStaging(receipt.localFlowId, 1)
        if (!admitted) throw new AuthorizationFlowError('flow_expired')
        const store = this.dependencies.secrets
        await store.refreshKey(receipt.artifactCredentialRef)
        let raw = store.get(receipt.artifactCredentialRef)
        if (raw === undefined) {
          const grant = await input.exchange()
          raw = serializeOAuthCredential(grant.credential as OAuthCredentialBundleV1)
          await store.setWithDurableObligation(
            receipt.artifactCredentialRef,
            raw,
            `user:${input.userId}`,
            async (tx) => {
              const [current] = await tx
                .select()
                .from(integrationAuthorizationFlowReceipts)
                .where(eq(integrationAuthorizationFlowReceipts.localFlowId, receipt.localFlowId))
                .for('update')
              if (
                !current ||
                current.terminalAt ||
                current.identityProofId ||
                current.purpose !== 'github_identity' ||
                current.initiatingUserId !== input.userId ||
                current.linkGeneration !== state.linkGeneration ||
                !current.stagingStartedAt
              )
                throw new AuthorizationFlowError('identity_flow_mismatch')
            }
          )
        }
        const credential = parseOAuthCredential(raw)
        try {
          // Never derive the proof from the exchange configuration, connected integration, or a caller profile.
          const profile = await this.dependencies.client.currentIdentity({ accessToken: credential.accessToken })
          const shared = await isGitHubIdentityTokenShared(credential, receipt.artifactCredentialRef, store)
          await saveGitHubIdentityProof({ identity, state, profile }, async (tx, proof) => {
            const [current] = await tx
              .select()
              .from(integrationAuthorizationFlowReceipts)
              .where(eq(integrationAuthorizationFlowReceipts.localFlowId, receipt.localFlowId))
              .for('update')
            if (
              !current ||
              current.identityProofId ||
              current.terminalAt ||
              current.initiatingUserId !== input.userId ||
              current.linkGeneration !== proof.generation
            )
              throw new AuthorizationFlowError('identity_flow_mismatch')
            await tx
              .update(integrationAuthorizationFlowReceipts)
              .set({
                identityProofId: proof.id,
                identityVerifiedAt: sql`clock_timestamp()`,
                updatedAt: sql`clock_timestamp()`,
                ...(shared
                  ? { cleanupRequiredAt: sql`clock_timestamp()` }
                  : { revocationRequiredAt: sql`clock_timestamp()` }),
              })
              .where(eq(integrationAuthorizationFlowReceipts.localFlowId, receipt.localFlowId))
            if (shared)
              await tx
                .insert(integrationCredentialCleanupJobs)
                .values({ authorizationFlowId: receipt.localFlowId, credentialRef: receipt.artifactCredentialRef })
                .onConflictDoNothing()
            else
              await tx
                .insert(integrationRevocationJobs)
                .values({
                  authorizationFlowId: receipt.localFlowId,
                  providerKey: 'github',
                  adapterVersion: 1,
                  clientAuthority: receipt.authority,
                  credentialRef: receipt.artifactCredentialRef,
                })
                .onConflictDoNothing()
          })
        } catch (error) {
          const code = (error as { code?: string })?.code
          if (
            code === 'shared_token_check_failed' ||
            (!(error instanceof GitHubFeedbackError) &&
              !(error instanceof AuthorizationFlowError) &&
              classifyGitHubOAuthError(error).retryable)
          )
            throw error
          // Terminal proof errors dispose only the owned staged copy; never revoke shared integration material.
          const shared = await isGitHubIdentityTokenShared(credential, receipt.artifactCredentialRef, store)
          if (shared)
            await this.dependencies.receipts.requireCleanup(receipt.localFlowId, code ?? 'identity_verification_failed')
          else
            await this.dependencies.receipts.requireRevocation({
              localFlowId: receipt.localFlowId,
              adapterVersion: 1,
              code: code ?? 'identity_verification_failed',
            })
          throw error
        }
      }
    )
  }
}
