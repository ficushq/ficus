import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { db } from '../../../db'
import {
  githubIdentityProofs,
  integrationAuthorizationFlowReceipts,
  integrationCredentialCleanupJobs,
  integrationOauthStates,
  integrationRevocationJobs,
  integrationAuditEvents,
  users,
} from '../../../db/schema'
import { createTestGitHubConnection } from '../../../test-utils/github-connection'
import { getSecretStore } from '../../secrets'
import { GitHubOAuthError } from '@ficus/shared/oauth-providers/github/client'
import { DbOAuthStateRepository } from '../authorization/db-state-repository'
import {
  DbAuthorizationFlowReceiptRepository,
  authorizationCredentialReference,
} from '../authorization/flow-repository'
import { ConnectionAuthorizationLease } from '../authorization/connection-lease'
import { beginGitHubIdentityLink, getGitHubPersonalIdentity, unlinkGitHubIdentity } from './personal-identity'
import { serializeOAuthCredential } from '../authorization/credential-bundle'
import { DbIntegrationRevocationRepository, IntegrationRevocationWorker } from '../authorization/revocation-worker'

const finalizerModule = await import('./personal-oauth-finalizer').catch(() => null)

async function fixture(shared = false) {
  const connection = await createTestGitHubConnection()
  const userId = crypto.randomUUID()
  const flowId = crypto.randomUUID()
  const states = new DbOAuthStateRepository()
  const receipts = new DbAuthorizationFlowReceiptRepository()
  const store = getSecretStore()
  const credentialRef = authorizationCredentialReference(flowId)
  await db.insert(users).values({ id: userId, email: `${userId}@identity-finalizer.test` })
  const identity = { type: 'user' as const, userId }
  const generation = await beginGitHubIdentityLink(identity)
  await states.create({
    stateHash: new Bun.CryptoHasher('sha256').update(flowId).digest('hex'),
    localFlowId: flowId,
    authority: 'platform_broker',
    providerKey: 'github',
    userId,
    purpose: 'github_identity',
    linkGeneration: generation,
    intent: 'connect',
    connectionId: null,
    expectedMaterialRevision: null,
    redirectUri: 'https://ficus.test/callback',
    returnTo: '/settings',
    expiresAt: new Date(Date.now() + 60_000),
  })
  const state = (await states.claimByFlow({
    localFlowId: flowId,
    providerKey: 'github',
    userId,
    authority: 'platform_broker',
    handleHash: 'a'.repeat(64),
  }))!
  const token = shared ? `test-access-${connection.id}` : `proof-access-${flowId}`
  let exchanges = 0,
    profiles = 0,
    transient = false
  let profileHook = async () => {}
  const finalizer = new finalizerModule!.GitHubPersonalOAuthFinalizer({
    secrets: store,
    receipts,
    lease: new ConnectionAuthorizationLease(),
    client: {
      currentIdentity: async ({ accessToken }) => {
        profiles++
        await profileHook()
        expect(accessToken).toBe(token)
        if (transient) throw new GitHubOAuthError('provider_unavailable')
        return { id: 101, login: 'alice', type: 'User' as const }
      },
    },
  })
  const input = {
    state,
    userId,
    identity,
    exchange: async () => {
      exchanges++
      return {
        configuration: { version: 1, userId: 999, login: 'UNVERIFIED_CONFIG_SENTINEL' },
        credential: { version: 1, tokenRevision: 1, accessToken: token, refreshToken: null, expiresAt: null },
        displayName: 'UNVERIFIED_CONFIG_SENTINEL',
      }
    },
  }
  return {
    finalizer,
    input,
    identity,
    flowId,
    credentialRef,
    connection,
    counters: () => ({ exchanges, profiles }),
    beforeProfile(action: () => Promise<void>) {
      profileHook = action
    },
    transient(value: boolean) {
      transient = value
    },
    async close() {
      await db.delete(integrationRevocationJobs).where(eq(integrationRevocationJobs.authorizationFlowId, flowId))
      await db
        .delete(integrationCredentialCleanupJobs)
        .where(eq(integrationCredentialCleanupJobs.authorizationFlowId, flowId))
      await db.delete(integrationOauthStates).where(eq(integrationOauthStates.localFlowId, flowId))
      await db
        .delete(integrationAuthorizationFlowReceipts)
        .where(eq(integrationAuthorizationFlowReceipts.localFlowId, flowId))
      await db.delete(integrationAuditEvents).where(eq(integrationAuditEvents.userId, userId))
      await db.delete(users).where(eq(users.id, userId))
      await store.delete(credentialRef)
      await connection.dispose()
    },
  }
}

test('personal OAuth uses authenticated /user, stages disposal durably, and never installs a connection or signs commits', async () => {
  expect(finalizerModule?.GitHubPersonalOAuthFinalizer).toBeDefined()
  const h = await fixture()
  try {
    await h.finalizer.install(h.input)
    expect(h.counters()).toEqual({ exchanges: 1, profiles: 1 })
    const [receipt] = await db
      .select()
      .from(integrationAuthorizationFlowReceipts)
      .where(eq(integrationAuthorizationFlowReceipts.localFlowId, h.flowId))
    expect(typeof receipt!.identityProofId).toBe('string')
    expect(receipt!.revocationRequiredAt).toBeInstanceOf(Date)
    expect(receipt).toMatchObject({ installedConnectionId: null, installKind: null, terminalAt: null })
    const [proof] = await db
      .select()
      .from(githubIdentityProofs)
      .where(eq(githubIdentityProofs.id, receipt!.identityProofId!))
    expect(proof).toMatchObject({ accountId: '101', login: 'alice' })
    expect(JSON.stringify(proof)).not.toContain('proof-access')
    expect(JSON.stringify(proof)).not.toContain('UNVERIFIED_CONFIG_SENTINEL')
    expect(await getGitHubPersonalIdentity(h.identity)).toBeNull() // Explicit human confirmation still required.
    await h.finalizer.install(h.input)
    expect(h.counters()).toEqual({ exchanges: 1, profiles: 1 })
    const jobs = await db
      .select()
      .from(integrationRevocationJobs)
      .where(eq(integrationRevocationJobs.authorizationFlowId, h.flowId))
    expect(jobs).toHaveLength(1)
    expect(jobs[0]!.credentialRef).toBe(h.credentialRef)
  } finally {
    await h.close()
  }
})

test('transient profile failure retries the staged grant without exchanging again or exposing a proof', async () => {
  expect(finalizerModule?.GitHubPersonalOAuthFinalizer).toBeDefined()
  const h = await fixture()
  try {
    h.transient(true)
    await expect(h.finalizer.install(h.input)).rejects.toMatchObject({ code: 'provider_unavailable' })
    expect(h.counters()).toEqual({ exchanges: 1, profiles: 1 })
    const [before] = await db
      .select()
      .from(integrationAuthorizationFlowReceipts)
      .where(eq(integrationAuthorizationFlowReceipts.localFlowId, h.flowId))
    expect(before).toMatchObject({ identityProofId: null, terminalAt: null, stagingStartedAt: expect.any(Date) })
    h.transient(false)
    await h.finalizer.install(h.input)
    expect(h.counters()).toEqual({ exchanges: 1, profiles: 2 })
  } finally {
    await h.close()
  }
})

test('a coincident integration token is locally disposed, never scheduled for remote revocation', async () => {
  expect(finalizerModule?.GitHubPersonalOAuthFinalizer).toBeDefined()
  const h = await fixture(true)
  try {
    await h.finalizer.install(h.input)
    expect(
      await db
        .select()
        .from(integrationRevocationJobs)
        .where(eq(integrationRevocationJobs.authorizationFlowId, h.flowId))
    ).toHaveLength(0)
    const cleanup = await db
      .select()
      .from(integrationCredentialCleanupJobs)
      .where(eq(integrationCredentialCleanupJobs.authorizationFlowId, h.flowId))
    expect(cleanup).toHaveLength(1)
    expect(cleanup[0]!.credentialRef).toBe(h.credentialRef)
    expect(getSecretStore().get(h.connection.credentialRef)).toBeDefined()
  } finally {
    await h.close()
  }
})

test('unlink during provider verification cannot resurrect a proof and persists immediate staged-token disposal', async () => {
  const h = await fixture()
  try {
    h.beforeProfile(async () => {
      await unlinkGitHubIdentity(h.identity)
    })
    await expect(h.finalizer.install(h.input)).rejects.toMatchObject({ code: 'identity_generation_changed' })
    const [receipt] = await db
      .select()
      .from(integrationAuthorizationFlowReceipts)
      .where(eq(integrationAuthorizationFlowReceipts.localFlowId, h.flowId))
    expect(receipt!.identityProofId).toBeNull()
    expect(receipt!.revocationRequiredAt).toBeInstanceOf(Date)
    expect(receipt!.terminalCode).toBe('identity_generation_changed')
    expect(await getGitHubPersonalIdentity(h.identity)).toBeNull()
    const proofs = await db
      .select()
      .from(githubIdentityProofs)
      .where(eq(githubIdentityProofs.userId, h.identity.userId))
    expect(proofs).toHaveLength(0)
  } finally {
    await h.close()
  }
})

test('the revocation worker rechecks a newly shared personal token before any remote revoke', async () => {
  const h = await fixture()
  try {
    await h.finalizer.install(h.input)
    const store = getSecretStore()
    const raw = serializeOAuthCredential({
      version: 1,
      accessToken: `proof-access-${h.flowId}`,
      refreshToken: null,
      expiresAt: null,
      tokenRevision: 1,
    })
    // Model an integration adopting the token after proof creation but before the queued disposal runs.
    await store.set(h.connection.credentialRef, raw, 'test')
    let revokes = 0
    const worker = new IntegrationRevocationWorker({
      repository: new DbIntegrationRevocationRepository([h.credentialRef]),
      credentials: store,
      resolvePlugin: () => ({
        authorization: { kind: 'oauth2', adapter: 'github' },
        classifyError: () => ({ code: 'provider_error', retryable: true }),
      }),
      revocationTransports: {
        resolve: () => ({
          authority: 'platform_broker',
          revoke: async () => {
            revokes++
          },
        }),
      },
    })
    expect(await worker.runOnce()).toBe(true)
    expect(revokes).toBe(0)
    expect(store.get(h.connection.credentialRef)).toBe(raw)
    const cleanup = await db
      .select()
      .from(integrationCredentialCleanupJobs)
      .where(eq(integrationCredentialCleanupJobs.authorizationFlowId, h.flowId))
    expect(cleanup).toHaveLength(1)
    expect(cleanup[0]!.credentialRef).toBe(h.credentialRef)
  } finally {
    await h.close()
  }
})

test('an owner-bound personal callback still requires the literal human requester before exchanging a grant', async () => {
  const h = await fixture()
  try {
    for (const identity of [
      undefined,
      { type: 'agent' as const, agentId: crypto.randomUUID(), squadId: crypto.randomUUID(), userId: h.identity.userId },
    ]) {
      await expect(h.finalizer.install({ ...h.input, identity })).rejects.toMatchObject({ code: 'human_required' })
    }
    expect(h.counters()).toEqual({ exchanges: 0, profiles: 0 })
    const [receipt] = await db
      .select()
      .from(integrationAuthorizationFlowReceipts)
      .where(eq(integrationAuthorizationFlowReceipts.localFlowId, h.flowId))
    expect(receipt!.stagingStartedAt).toBeNull()
  } finally {
    await h.close()
  }
})
