import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { db } from '../../../db'
import { getPostgresError } from '../../../db/errors'
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
  sweepExpiredAuthorizationFlows,
} from '../authorization/flow-repository'
import { ConnectionAuthorizationLease } from '../authorization/connection-lease'
import { beginGitHubIdentityLink, getGitHubPersonalIdentity, unlinkGitHubIdentity } from './personal-identity'
import { serializeOAuthCredential } from '../authorization/credential-bundle'
import { DbIntegrationRevocationRepository, IntegrationRevocationWorker } from '../authorization/revocation-worker'
import {
  DbIntegrationCredentialCleanupRepository,
  IntegrationCredentialCleanupWorker,
} from '../credential-cleanup-worker'

const finalizerModule = await import('./personal-oauth-finalizer').catch(() => null)

async function fixture(shared = false, local = false) {
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
  const nonce = new Bun.CryptoHasher('sha256').update(flowId).digest('base64url')
  const stateHash = new Bun.CryptoHasher('sha256').update(local ? nonce : flowId).digest('hex')
  await states.create({
    stateHash,
    localFlowId: flowId,
    authority: local ? 'local' : 'platform_broker',
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
  const state = (
    local
      ? await states.consume({ stateHash, providerKey: 'github', userId })
      : await states.claimByFlow({
          localFlowId: flowId,
          providerKey: 'github',
          userId,
          authority: 'platform_broker',
          handleHash: 'a'.repeat(64),
        })
  )!
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
    nonce,
    receipts,
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
      await db.delete(integrationRevocationJobs).where(eq(integrationRevocationJobs.credentialRef, credentialRef))
      await db
        .delete(integrationCredentialCleanupJobs)
        .where(eq(integrationCredentialCleanupJobs.credentialRef, credentialRef))
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
    expect(receipt!.cleanupRequiredAt).toBeInstanceOf(Date)
    expect(receipt!.revocationRequiredAt).toBeNull()
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
    expect(jobs).toHaveLength(0)
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
    expect(receipt!.cleanupRequiredAt).toBeInstanceOf(Date)
    expect(receipt!.revocationRequiredAt).toBeNull()
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

test('legacy personal revocation obligations are locally disposed even if another integration adopts the token', async () => {
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
    // Model an old/reaper-produced revocation obligation and an adoption after proof creation.
    await new DbAuthorizationFlowReceiptRepository().requireRevocation({
      localFlowId: h.flowId,
      adapterVersion: 1,
      code: 'legacy_proof_disposal',
    })
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
    const cleanup = await db
      .select()
      .from(integrationCredentialCleanupJobs)
      .where(eq(integrationCredentialCleanupJobs.authorizationFlowId, h.flowId))
    expect(cleanup).toHaveLength(1)
    expect(cleanup[0]!.credentialRef).toBe(h.credentialRef)
    let entered!: () => void, release!: () => void
    const atCleanup = new Promise<void>((done) => {
      entered = done
    })
    const continueCleanup = new Promise<void>((done) => {
      release = done
    })
    const cleanupWorker = new IntegrationCredentialCleanupWorker(
      new DbIntegrationCredentialCleanupRepository([h.credentialRef]),
      {
        deleteWithDurableMutation: async (key, mutation) => {
          expect(key).toBe(h.credentialRef)
          entered()
          await continueCleanup
          await store.deleteWithDurableMutation(key, mutation)
        },
      }
    )
    const cleaning = cleanupWorker.runOnce()
    await atCleanup
    try {
      await store.set(h.connection.credentialRef, raw, 'test')
    } finally {
      release()
    }
    expect(await cleaning).toBe(true)
    expect(store.get(h.credentialRef)).toBeUndefined()
    expect(store.get(h.connection.credentialRef)).toBe(raw)
    await h.finalizer.install(h.input)
    expect(h.counters()).toEqual({ exchanges: 1, profiles: 1 })
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

test.each(['local', 'platform_broker'] as const)(
  'failed %s proof disposal cannot revoke a token reused outside this database',
  async (authority) => {
    const h = await fixture()
    try {
      if (authority === 'local') {
        // The same receipt semantics are used by local device coordination; broker ownership is not assumed.
        await db
          .update(integrationAuthorizationFlowReceipts)
          .set({ authority })
          .where(eq(integrationAuthorizationFlowReceipts.localFlowId, h.flowId))
        h.input.state.authority = authority
      }
      h.transient(true)
      await expect(h.finalizer.install(h.input)).rejects.toMatchObject({ code: 'provider_unavailable' })
      await new DbAuthorizationFlowReceiptRepository().requireRevocation({
        localFlowId: h.flowId,
        adapterVersion: 1,
        code: 'flow_expired',
      })
      const store = getSecretStore()
      const integrationBefore = store.get(h.connection.credentialRef)
      let externalConsumerActive = true,
        revokes = 0
      const worker = new IntegrationRevocationWorker({
        repository: new DbIntegrationRevocationRepository([h.credentialRef]),
        credentials: store,
        resolvePlugin: () => ({
          authorization: { kind: 'oauth2', adapter: 'github' },
          classifyError: () => ({ code: 'provider_error', retryable: true }),
        }),
        revocationTransports: {
          resolve: () => ({
            authority,
            revoke: async () => {
              revokes++
              externalConsumerActive = false
            },
          }),
        },
      })
      expect(await worker.runOnce()).toBe(true)
      expect(revokes).toBe(0)
      expect(externalConsumerActive).toBe(true)
      const cleanupWorker = new IntegrationCredentialCleanupWorker(
        new DbIntegrationCredentialCleanupRepository([h.credentialRef]),
        store
      )
      expect(await cleanupWorker.runOnce()).toBe(true)
      expect(store.get(h.credentialRef)).toBeUndefined()
      expect(store.get(h.connection.credentialRef)).toBe(integrationBefore)
      const [receipt] = await db
        .select()
        .from(integrationAuthorizationFlowReceipts)
        .where(eq(integrationAuthorizationFlowReceipts.localFlowId, h.flowId))
      expect(receipt!.revocationSettledAt).toBeInstanceOf(Date)
      expect(receipt!.cleanupSettledAt).toBeInstanceOf(Date)
      expect(receipt!.identityProofId).toBeNull()
    } finally {
      await h.close()
    }
  }
)

test('expiry sweeping of a staged personal grant cannot indirectly call provider or broker revocation', async () => {
  const h = await fixture()
  try {
    h.transient(true)
    await expect(h.finalizer.install(h.input)).rejects.toMatchObject({ code: 'provider_unavailable' })
    await db
      .update(integrationAuthorizationFlowReceipts)
      .set({ recoveryExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(integrationAuthorizationFlowReceipts.localFlowId, h.flowId))
    await sweepExpiredAuthorizationFlows()
    let resolves = 0
    const worker = new IntegrationRevocationWorker({
      repository: new DbIntegrationRevocationRepository([h.credentialRef]),
      credentials: getSecretStore(),
      resolvePlugin: () => undefined,
      revocationTransports: {
        resolve: () => {
          resolves++
          throw new Error('must not resolve an external revocation transport')
        },
      },
    })
    expect(await worker.runOnce()).toBe(true)
    expect(resolves).toBe(0)
    const cleanup = new IntegrationCredentialCleanupWorker(
      new DbIntegrationCredentialCleanupRepository([h.credentialRef]),
      getSecretStore()
    )
    expect(await cleanup.runOnce()).toBe(true)
    expect(getSecretStore().get(h.credentialRef)).toBeUndefined()
    const [receipt] = await db
      .select()
      .from(integrationAuthorizationFlowReceipts)
      .where(eq(integrationAuthorizationFlowReceipts.localFlowId, h.flowId))
    expect(receipt!.terminalCode).toBe('flow_expired')
    expect(receipt!.cleanupSettledAt).toBeInstanceOf(Date)
  } finally {
    await h.close()
  }
})

test('a pending personal disposal obligation retains its purpose receipt until locally settled', async () => {
  const h = await fixture()
  try {
    h.transient(true)
    await expect(h.finalizer.install(h.input)).rejects.toMatchObject({ code: 'provider_unavailable' })
    await new DbAuthorizationFlowReceiptRepository().requireRevocation({
      localFlowId: h.flowId,
      adapterVersion: 1,
      code: 'flow_expired',
    })
    const deletionCode = await db
      .delete(integrationAuthorizationFlowReceipts)
      .where(eq(integrationAuthorizationFlowReceipts.localFlowId, h.flowId))
      .execute()
      .then(
        () => 'deleted',
        (error) => getPostgresError(error)?.code
      )
    expect(deletionCode).toBe('23001') // PostgreSQL restrict_violation: retained disposal provenance.
    let revokes = 0
    const worker = new IntegrationRevocationWorker({
      repository: new DbIntegrationRevocationRepository([h.credentialRef]),
      credentials: getSecretStore(),
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
    const jobs = await db
      .select()
      .from(integrationRevocationJobs)
      .where(eq(integrationRevocationJobs.credentialRef, h.credentialRef))
    expect(jobs).toHaveLength(0)
    const [receipt] = await db
      .select()
      .from(integrationAuthorizationFlowReceipts)
      .where(eq(integrationAuthorizationFlowReceipts.localFlowId, h.flowId))
    expect(receipt!.purpose).toBe('github_identity')
    expect(receipt!.revocationSettledAt).toBeInstanceOf(Date)
    const cleanup = new IntegrationCredentialCleanupWorker(
      new DbIntegrationCredentialCleanupRepository([h.credentialRef]),
      getSecretStore()
    )
    expect(await cleanup.runOnce()).toBe(true)
    expect(getSecretStore().get(h.credentialRef)).toBeUndefined()
  } finally {
    await h.close()
  }
})

test('ordinary GitHub integration revocation still invokes its persisted-authority transport', async () => {
  const h = await fixture()
  try {
    await db
      .update(integrationAuthorizationFlowReceipts)
      .set({ purpose: 'integration', linkGeneration: null })
      .where(eq(integrationAuthorizationFlowReceipts.localFlowId, h.flowId))
    const receipts = new DbAuthorizationFlowReceiptRepository()
    await receipts.beginStaging(h.flowId, 1)
    const store = getSecretStore()
    const credential = {
      version: 1 as const,
      accessToken: `integration-access-${h.flowId}`,
      refreshToken: null,
      expiresAt: null,
      tokenRevision: 1,
    }
    await store.set(h.credentialRef, serializeOAuthCredential(credential), 'test')
    await receipts.requireRevocation({ localFlowId: h.flowId, adapterVersion: 1, code: 'grant_abandoned' })
    let revokes = 0
    const worker = new IntegrationRevocationWorker({
      repository: new DbIntegrationRevocationRepository([h.credentialRef]),
      credentials: store,
      resolvePlugin: () => ({
        authorization: { kind: 'oauth2', adapter: 'github' },
        classifyError: () => ({ code: 'provider_error', retryable: true }),
      }),
      revocationTransports: {
        resolve: (authority) => {
          expect(authority).toBe('platform_broker')
          return {
            authority,
            revoke: async (input) => {
              expect(input.token).toBe(credential.accessToken)
              revokes++
            },
          }
        },
      },
    })
    expect(await worker.runOnce()).toBe(true)
    expect(revokes).toBe(1)
    const cleanup = new IntegrationCredentialCleanupWorker(
      new DbIntegrationCredentialCleanupRepository([h.credentialRef]),
      store
    )
    expect(await cleanup.runOnce()).toBe(true)
    expect(store.get(h.credentialRef)).toBeUndefined()
  } finally {
    await h.close()
  }
})

test('unlink before finalization rejects the old generation before exchange or authenticated profile I/O', async () => {
  const h = await fixture()
  try {
    await unlinkGitHubIdentity(h.identity)
    await expect(h.finalizer.install(h.input)).rejects.toMatchObject({ code: 'identity_generation_changed' })
    expect(h.counters()).toEqual({ exchanges: 0, profiles: 0 })
    const receipt = await new DbAuthorizationFlowReceiptRepository().get(h.flowId)
    expect(receipt!.terminalCode).toBe('identity_generation_changed')
    expect(receipt!.terminalAt).toBeInstanceOf(Date)
    expect(receipt!.cleanupRequiredAt).toBeNull()
    expect(receipt!.revocationRequiredAt).toBeNull()
  } finally {
    await h.close()
  }
})

test('confirmed personal result remains safely replayable after confirmation increments the generation', async () => {
  const { confirmGitHubIdentityProof } = await import('./personal-identity')
  const h = await fixture()
  try {
    await h.finalizer.install(h.input)
    const receipt = await new DbAuthorizationFlowReceiptRepository().get(h.flowId)
    await confirmGitHubIdentityProof(h.identity, receipt!.identityProofId!)
    await h.finalizer.install(h.input)
    expect(h.counters()).toEqual({ exchanges: 1, profiles: 1 })
    expect(await getGitHubPersonalIdentity(h.identity)).toMatchObject({ accountId: '101' })
  } finally {
    await h.close()
  }
})

test('preflight failure cannot claim terminal settlement if its durable write is not acknowledged', async () => {
  const h = await fixture()
  try {
    await unlinkGitHubIdentity(h.identity)
    h.receipts.markTerminal = async () => null
    await expect(h.finalizer.install(h.input)).rejects.toMatchObject({ code: 'flow_finalization_failed' })
    expect(h.counters()).toEqual({ exchanges: 0, profiles: 0 })
  } finally {
    await h.close()
  }
})

test('local personal callback resumes the staged proof and replays results without reexchanging a consumed code', async () => {
  const context = await import('./authorization-context').catch(() => null)
  expect(context?.resumeLocalGitHubIdentity).toBeDefined()
  const h = await fixture(false, true)
  const otherUserId = crypto.randomUUID()
  try {
    h.transient(true)
    await expect(h.finalizer.install(h.input)).rejects.toMatchObject({ code: 'provider_unavailable' })
    await db.insert(users).values({ id: otherUserId, email: `${otherUserId}@local-replay.test` })
    expect(
      await context!.resumeLocalGitHubIdentity({
        identity: { type: 'user', userId: otherUserId },
        nonce: h.nonce,
        finalizer: h.finalizer,
        receipts: h.receipts,
      })
    ).toBeNull()
    await expect(
      context!.resumeLocalGitHubIdentity({
        identity: {
          type: 'agent',
          agentId: crypto.randomUUID(),
          squadId: crypto.randomUUID(),
          userId: h.identity.userId,
        },
        nonce: h.nonce,
        finalizer: h.finalizer,
        receipts: h.receipts,
      })
    ).rejects.toMatchObject({ code: 'human_required' })
    h.transient(false)
    const input = { identity: h.identity, nonce: h.nonce, finalizer: h.finalizer, receipts: h.receipts }
    expect(
      await Promise.all([context!.resumeLocalGitHubIdentity(input), context!.resumeLocalGitHubIdentity(input)])
    ).toEqual([{ returnTo: '/settings' }, { returnTo: '/settings' }])
    expect(h.counters()).toEqual({ exchanges: 1, profiles: 2 })
    const cleanup = new IntegrationCredentialCleanupWorker(
      new DbIntegrationCredentialCleanupRepository([h.credentialRef]),
      getSecretStore()
    )
    expect(await cleanup.runOnce()).toBe(true)
    expect(getSecretStore().get(h.credentialRef)).toBeUndefined()
    expect(await context!.resumeLocalGitHubIdentity(input)).toEqual({ returnTo: '/settings' })
    expect(h.counters()).toEqual({ exchanges: 1, profiles: 2 })
  } finally {
    await db.delete(users).where(eq(users.id, otherUserId))
    await h.close()
  }
})

test('local recovery with no staged grant requires restart and never mints/reexchanges provider credentials', async () => {
  const context = await import('./authorization-context').catch(() => null)
  expect(context?.resumeLocalGitHubIdentity).toBeDefined()
  const h = await fixture(false, true)
  try {
    await expect(
      context!.resumeLocalGitHubIdentity({
        identity: h.identity,
        nonce: h.nonce,
        finalizer: h.finalizer,
        receipts: h.receipts,
      })
    ).rejects.toMatchObject({ code: 'local_authorization_restart_required' })
    expect(h.counters()).toEqual({ exchanges: 0, profiles: 0 })
    expect((await h.receipts.get(h.flowId))!.terminalCode).toBe('local_authorization_restart_required')
  } finally {
    await h.close()
  }
})

test.each(['expired', 'broker', 'integration'] as const)(
  'local proof recovery excludes %s receipts even with the correct human and nonce hash',
  async (excluded) => {
    const context = await import('./authorization-context')
    const h = await fixture(false, true)
    try {
      await db
        .update(integrationAuthorizationFlowReceipts)
        .set(
          excluded === 'expired'
            ? { recoveryExpiresAt: new Date(Date.now() - 1) }
            : excluded === 'broker'
              ? { authority: 'platform_broker' }
              : { purpose: 'integration', linkGeneration: null }
        )
        .where(eq(integrationAuthorizationFlowReceipts.localFlowId, h.flowId))
      expect(
        await context.resumeLocalGitHubIdentity({
          identity: h.identity,
          nonce: h.nonce,
          finalizer: h.finalizer,
          receipts: h.receipts,
        })
      ).toBeNull()
      expect(h.counters()).toEqual({ exchanges: 0, profiles: 0 })
    } finally {
      await h.close()
    }
  }
)

test('local recovery serializes with an in-flight original callback rather than verifying twice', async () => {
  const context = await import('./authorization-context')
  const h = await fixture(false, true)
  let entered!: () => void, release!: () => void
  const atProfile = new Promise<void>((resolve) => {
    entered = resolve
  })
  const continueProfile = new Promise<void>((resolve) => {
    release = resolve
  })
  let first: Promise<void> | undefined
  let recovered: Promise<{ returnTo: string } | null> | undefined
  try {
    h.beforeProfile(async () => {
      entered()
      await continueProfile
    })
    first = h.finalizer.install(h.input)
    await atProfile
    recovered = context.resumeLocalGitHubIdentity({
      identity: h.identity,
      nonce: h.nonce,
      finalizer: h.finalizer,
      receipts: h.receipts,
    })
    release()
    await first
    expect(await recovered).toEqual({ returnTo: '/settings' })
    expect(h.counters()).toEqual({ exchanges: 1, profiles: 1 })
  } finally {
    release()
    await Promise.allSettled([first, recovered])
    await h.close()
  }
})
