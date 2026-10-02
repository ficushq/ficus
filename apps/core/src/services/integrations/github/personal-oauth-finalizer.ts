import { eq, sql } from 'drizzle-orm'
import { classifyGitHubOAuthError } from '@ficus/shared/oauth-providers'
import type { GitHubOAuthClient } from '@ficus/shared/oauth-providers/github/client'
import { db } from '../../../db'
import { integrationAuthorizationFlowReceipts, integrationCredentialCleanupJobs } from '../../../db/schema'
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
import { requireGitHubIdentityGeneration, saveGitHubIdentityProof } from './personal-identity'

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

/**
 * Ownership proof only: no integration installer, signing, assignment, or projection dependency.
 * Dispose the staged copy locally. Neither broker nor local app credentials prove token exclusivity
 * across other Core instances/consumers, so this flow must never authorize a remote token/grant revoke.
 */
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
        try {
          await requireGitHubIdentityGeneration(identity, state.linkGeneration!)
        } catch (error) {
          if (error instanceof GitHubFeedbackError) {
            const disposition = receipt.stagingStartedAt
              ? await this.dependencies.receipts.requireCleanup(receipt.localFlowId, error.code)
              : await this.dependencies.receipts.markTerminal(receipt.localFlowId, error.code)
            if (!disposition?.terminalAt) throw new AuthorizationFlowError('flow_finalization_failed')
          }
          throw error
        }
        const admitted = await this.dependencies.receipts.beginStaging(receipt.localFlowId, 1)
        if (!admitted) throw new AuthorizationFlowError('flow_expired')
        const store = this.dependencies.secrets
        await store.refreshKey(receipt.artifactCredentialRef)
        let raw = store.get(receipt.artifactCredentialRef)
        if (raw === undefined) {
          let grant: Awaited<ReturnType<PersonalInstall['exchange']>>
          try {
            grant = await input.exchange()
          } catch (error) {
            if (error instanceof AuthorizationFlowError && error.code === 'local_authorization_restart_required') {
              const disposition = await this.dependencies.receipts.requireCleanup(receipt.localFlowId, error.code)
              if (!disposition?.terminalAt) throw new AuthorizationFlowError('flow_finalization_failed')
            }
            throw error
          }
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
                cleanupRequiredAt: sql`clock_timestamp()`,
              })
              .where(eq(integrationAuthorizationFlowReceipts.localFlowId, receipt.localFlowId))
            // Core cannot prove provider-token exclusivity across tenants/consumers. Dispose only this copy.
            await tx
              .insert(integrationCredentialCleanupJobs)
              .values({ authorizationFlowId: receipt.localFlowId, credentialRef: receipt.artifactCredentialRef })
              .onConflictDoNothing()
          })
        } catch (error) {
          const code = (error as { code?: string })?.code
          if (
            !(error instanceof GitHubFeedbackError) &&
            !(error instanceof AuthorizationFlowError) &&
            classifyGitHubOAuthError(error).retryable
          )
            throw error
          // No proof failure/unlink/expiry may remotely invalidate an out-of-domain shared token.
          await this.dependencies.receipts.requireCleanup(receipt.localFlowId, code ?? 'identity_verification_failed')
          throw error
        }
      }
    )
  }
}
