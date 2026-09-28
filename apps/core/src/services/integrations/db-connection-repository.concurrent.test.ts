import { useEnabledIntegrationFixtures } from '../../test-utils/enabled-integrations'
useEnabledIntegrationFixtures('bigbrain', 'notion')
import { afterEach, expect, test } from 'bun:test'
import { eq, inArray, sql } from 'drizzle-orm'
import {
  db,
  integrationAuthorizationFlowReceipts,
  integrationConnectionAssignments,
  integrationConnections,
  integrationCredentialCleanupJobs,
  integrationProjectionStates,
  integrationRevocationJobs,
  secrets,
  users,
  squads,
} from '../../db'
import { DbIntegrationConnectionRepository } from './db-connection-repository'
import { IntegrationConnectionService } from './connection-service'
import { DbIntegrationRevocationRepository, IntegrationRevocationWorker } from './authorization/revocation-worker'
import {
  DbIntegrationCredentialCleanupRepository,
  IntegrationCredentialCleanupWorker,
} from './credential-cleanup-worker'
import { deleteSettledAuthorizationReceipts } from './authorization/flow-repository'
import { AuthorizationFlowRecoveryWorker } from './authorization/flow-recovery-worker'
import { DbOAuthStateRepository } from './authorization/db-state-repository'
import { ConnectionAuthorizationLease, revocationArtifactLeaseResource } from './authorization/connection-lease'
import { serializeOAuthCredential } from './authorization/credential-bundle'
import type { SecretStoreTransaction } from '../secrets/store'
import { resolveAssignedIntegrationRefs } from './projection/agent-refs'
import { loadEffectiveToolchain } from './projection/load-effective-toolchain'
import { loadProtectedIntegrationBindings } from './projection/protected-env'

const actorIds: string[] = []
async function createActor(): Promise<string> {
  const id = crypto.randomUUID()
  await db.insert(users).values({ id, email: `integration-actor-${id}@example.test` })
  actorIds.push(id)
  return id
}
afterEach(async () => {
  if (!actorIds.length) return
  await db.delete(integrationConnections).where(inArray(integrationConnections.updatedByUserId, actorIds))
  await db.delete(users).where(inArray(users.id, actorIds))
  actorIds.length = 0
})

function pending(id = crypto.randomUUID()) {
  return {
    id,
    providerKey: 'bigbrain',
    adapterVersion: 1,
    clientAuthority: 'local' as const,
    displayName: `Brain ${id}`,
    configuration: { version: 1, apiBase: 'https://brain.example' },
    credentialRef: `test:${id}`,
    materialRevision: crypto.randomUUID(),
  }
}

async function installedFlowConnection(repository: DbIntegrationConnectionRepository) {
  const localFlowId = crypto.randomUUID()
  const connectionId = crypto.randomUUID()
  const materialRevision = crypto.randomUUID()
  const credentialRef = `__integration-credential:authorization-flow:${localFlowId}:bearer`
  await db.insert(secrets).values({ key: credentialRef, encryptedValue: 'ciphertext', iv: 'iv' })
  await db.insert(integrationAuthorizationFlowReceipts).values({
    localFlowId,
    providerKey: 'notion',
    authority: 'platform_broker',
    intent: 'connect',
    initiatingUserId: crypto.randomUUID(),
    returnTo: '/settings',
    completionHandleHash: 'c'.repeat(64),
    adapterVersion: 1,
    artifactCredentialRef: credentialRef,
    stagingStartedAt: new Date(),
    installKind: 'connect',
    installedConnectionId: connectionId,
    installedMaterialRevision: materialRevision,
    installedAt: new Date(),
    recoveryExpiresAt: new Date(Date.now() + 60_000),
    retainUntil: new Date(Date.now() + 60_000),
  })
  await repository.createPending({
    id: connectionId,
    providerKey: 'notion',
    adapterVersion: 1,
    clientAuthority: 'platform_broker',
    authorizationFlowId: localFlowId,
    displayName: 'Installed Workspace',
    configuration: { version: 1, workspaceId: 'workspace-1' },
    credentialRef,
    materialRevision,
  })
  await db
    .update(integrationConnections)
    .set({ enabled: true, authState: 'authenticated', healthState: 'healthy' })
    .where(eq(integrationConnections.id, connectionId))
  return { localFlowId, connectionId, materialRevision, credentialRef }
}

test('connect enable atomically records an immutable authorization receipt', async () => {
  const repository = new DbIntegrationConnectionRepository()
  const localFlowId = crypto.randomUUID()
  const connectionId = crypto.randomUUID()
  const materialRevision = crypto.randomUUID()
  const credentialRef = `__integration-credential:authorization-flow:${localFlowId}:bearer`
  await db.insert(secrets).values({ key: credentialRef, encryptedValue: 'ciphertext', iv: 'iv' })
  await db.insert(integrationAuthorizationFlowReceipts).values({
    localFlowId,
    providerKey: 'notion',
    authority: 'platform_broker',
    intent: 'connect',
    initiatingUserId: crypto.randomUUID(),
    returnTo: '/settings',
    completionHandleHash: 'a'.repeat(64),
    adapterVersion: 1,
    artifactCredentialRef: credentialRef,
    stagingStartedAt: new Date(),
    recoveryExpiresAt: new Date(Date.now() + 60_000),
    retainUntil: new Date(Date.now() + 60_000),
  })
  await repository.createPending({
    ...pending(connectionId),
    providerKey: 'notion',
    configuration: { version: 1, workspaceId: 'workspace-1' },
    clientAuthority: 'platform_broker',
    authorizationFlowId: localFlowId,
    credentialRef,
    materialRevision,
  })
  const now = new Date()
  try {
    const [clock] = await db.execute<{ before_install: string }>(sql`SELECT clock_timestamp() AS before_install`)
    expect(
      await repository.enableValidated({
        id: connectionId,
        materialRevision,
        validation: { ok: true, grantedScopes: [] },
        now,
        expiresAt: new Date(now.getTime() + 60_000),
        authorizationFlowId: localFlowId,
      })
    ).toBe(true)
    expect(
      await db
        .select({
          installKind: integrationAuthorizationFlowReceipts.installKind,
          installedConnectionId: integrationAuthorizationFlowReceipts.installedConnectionId,
          installedMaterialRevision: integrationAuthorizationFlowReceipts.installedMaterialRevision,
          retainUntil: integrationAuthorizationFlowReceipts.retainUntil,
        })
        .from(integrationAuthorizationFlowReceipts)
        .where(eq(integrationAuthorizationFlowReceipts.localFlowId, localFlowId))
    ).toEqual([
      {
        installKind: 'connect',
        installedConnectionId: connectionId,
        installedMaterialRevision: materialRevision,
        retainUntil: expect.any(Date),
      },
    ])
    const [installedReceipt] = await db
      .select({ retainUntil: integrationAuthorizationFlowReceipts.retainUntil })
      .from(integrationAuthorizationFlowReceipts)
      .where(eq(integrationAuthorizationFlowReceipts.localFlowId, localFlowId))
    expect(installedReceipt!.retainUntil.getTime()).toBeGreaterThanOrEqual(
      new Date(clock!.before_install).getTime() + 24 * 60 * 60_000
    )
    await repository.disable(connectionId)
    expect(
      await repository.enableValidated({
        id: connectionId,
        materialRevision,
        validation: { ok: true, grantedScopes: [] },
        now: new Date(now.getTime() + 1_000),
        expiresAt: new Date(now.getTime() + 61_000),
        authorizationFlowId: localFlowId,
      })
    ).toBe(true)
    expect(await repository.get(connectionId)).toMatchObject({ enabled: false })
    expect(
      await repository.enableValidated({
        id: connectionId,
        materialRevision,
        validation: { ok: true, grantedScopes: [] },
        now: new Date(now.getTime() + 2_000),
        expiresAt: new Date(now.getTime() + 62_000),
      })
    ).toBe(true)
    expect(await repository.get(connectionId)).toMatchObject({ enabled: true })
    await repository.disable(connectionId)
    const laterRevision = crypto.randomUUID()
    await db
      .update(integrationConnections)
      .set({ materialRevision: laterRevision, authState: 'invalid' })
      .where(eq(integrationConnections.id, connectionId))
    expect(
      await repository.enableValidated({
        id: connectionId,
        materialRevision: laterRevision,
        validation: { ok: true, grantedScopes: [] },
        now: new Date(now.getTime() + 3_000),
        expiresAt: new Date(now.getTime() + 63_000),
      })
    ).toBe(true)
    expect(await repository.get(connectionId)).toMatchObject({ enabled: true, materialRevision: laterRevision })
    expect(
      await db
        .select({ installKind: integrationAuthorizationFlowReceipts.installKind })
        .from(integrationAuthorizationFlowReceipts)
        .where(eq(integrationAuthorizationFlowReceipts.localFlowId, localFlowId))
    ).toEqual([{ installKind: 'connect' }])
    await db.delete(integrationConnections).where(eq(integrationConnections.id, connectionId))
    expect(
      await db
        .select({ installKind: integrationAuthorizationFlowReceipts.installKind })
        .from(integrationAuthorizationFlowReceipts)
        .where(eq(integrationAuthorizationFlowReceipts.localFlowId, localFlowId))
    ).toEqual([{ installKind: 'connect' }])
  } finally {
    await db.delete(integrationConnections).where(eq(integrationConnections.id, connectionId))
    await db
      .delete(integrationAuthorizationFlowReceipts)
      .where(eq(integrationAuthorizationFlowReceipts.localFlowId, localFlowId))
    await db.delete(secrets).where(eq(secrets.key, credentialRef))
  }
})

test('terminal enable preserves broker receipt and local staged revocation ownership', async () => {
  const repository = new DbIntegrationConnectionRepository()
  const localFlowId = crypto.randomUUID()
  const broker = {
    ...pending(),
    providerKey: 'notion',
    clientAuthority: 'platform_broker' as const,
    authorizationFlowId: localFlowId,
    credentialRef: `__integration-credential:authorization-flow:${localFlowId}:bearer`,
  }
  const local = { ...pending(), providerKey: 'notion', clientAuthority: 'local' as const }
  try {
    await db.insert(secrets).values([
      { key: broker.credentialRef, encryptedValue: 'ciphertext', iv: 'iv' },
      { key: local.credentialRef, encryptedValue: 'ciphertext', iv: 'iv' },
    ])
    await db.insert(integrationAuthorizationFlowReceipts).values({
      localFlowId,
      providerKey: 'notion',
      authority: 'platform_broker',
      intent: 'connect',
      initiatingUserId: crypto.randomUUID(),
      returnTo: '/settings',
      completionHandleHash: 'e'.repeat(64),
      adapterVersion: 1,
      artifactCredentialRef: broker.credentialRef,
      stagingStartedAt: new Date(),
      recoveryExpiresAt: new Date(Date.now() + 60_000),
      retainUntil: new Date(Date.now() + 60_000),
    })
    await db.insert(integrationRevocationJobs).values({
      providerKey: 'notion',
      adapterVersion: 1,
      clientAuthority: 'local',
      credentialRef: local.credentialRef,
    })
    const brokerConnection = await repository.createPending(broker)
    const localConnection = await repository.createPending({ ...local, adoptStagedRevocationRef: local.credentialRef })
    for (const connection of [brokerConnection, localConnection]) {
      expect(
        await repository.markReauthorizationRequired({
          id: connection.id,
          materialRevision: connection.materialRevision,
          code: 'client_authority_mismatch',
        })
      ).toBe(true)
      expect(
        await repository.enableValidated({
          id: connection.id,
          materialRevision: connection.materialRevision,
          validation: { ok: true, grantedScopes: [] },
          now: new Date(),
          expiresAt: new Date(Date.now() + 60_000),
          ...(connection.id === brokerConnection.id ? { authorizationFlowId: localFlowId } : {}),
        })
      ).toBe(false)
    }
    const [receipt] = await db
      .select()
      .from(integrationAuthorizationFlowReceipts)
      .where(eq(integrationAuthorizationFlowReceipts.localFlowId, localFlowId))
    expect(receipt.installKind).toBeNull()
    expect(await repository.hasRevocation(local.credentialRef)).toBe(true)
  } finally {
    await db.delete(integrationConnections).where(inArray(integrationConnections.id, [broker.id, local.id]))
    await db
      .delete(integrationAuthorizationFlowReceipts)
      .where(eq(integrationAuthorizationFlowReceipts.localFlowId, localFlowId))
    await db.delete(integrationRevocationJobs).where(eq(integrationRevocationJobs.credentialRef, local.credentialRef))
    await db.delete(secrets).where(inArray(secrets.key, [broker.credentialRef, local.credentialRef]))
  }
})

test('public enable rejects an unresolved flow connection and expiry drains its artifact', async () => {
  const repository = new DbIntegrationConnectionRepository()
  const localFlowId = crypto.randomUUID()
  const connectionId = crypto.randomUUID()
  const materialRevision = crypto.randomUUID()
  const credentialRef = `__integration-credential:authorization-flow:${localFlowId}:bearer`
  const expiredAt = new Date('2000-01-01T00:00:00.000Z')
  await db.insert(secrets).values({ key: credentialRef, encryptedValue: 'ciphertext', iv: 'iv' })
  await db.insert(integrationAuthorizationFlowReceipts).values({
    localFlowId,
    providerKey: 'notion',
    authority: 'platform_broker',
    intent: 'connect',
    initiatingUserId: crypto.randomUUID(),
    returnTo: '/settings',
    completionHandleHash: 'e'.repeat(64),
    adapterVersion: 1,
    artifactCredentialRef: credentialRef,
    stagingStartedAt: expiredAt,
    recoveryExpiresAt: expiredAt,
    retainUntil: expiredAt,
  })
  await repository.createPending({
    id: connectionId,
    providerKey: 'notion',
    adapterVersion: 1,
    clientAuthority: 'platform_broker',
    authorizationFlowId: localFlowId,
    displayName: 'Unresolved Workspace',
    configuration: { version: 1, workspaceId: 'workspace-pending' },
    credentialRef,
    materialRevision,
  })
  try {
    const service = new IntegrationConnectionService({
      repository,
      assignments: { usage: async () => ({ squadCount: 0, squads: [] }) },
      credentials: {
        get: () =>
          serializeOAuthCredential({
            version: 1,
            accessToken: 'pending-access',
            refreshToken: null,
            expiresAt: null,
            tokenRevision: 1,
          }),
        set: async () => {},
        delete: async () => {},
      },
      resolveProvider: () => ({
        key: 'notion',
        adapterVersion: 1,
        parseConfig: (value) => value as { workspaceId: string },
        validate: async () => ({ ok: true, grantedScopes: [] }),
        capabilities: {},
      }),
    })
    await expect(service.enable(connectionId)).rejects.toThrow('Connection changed during validation')
    expect(await repository.get(connectionId)).toMatchObject({ enabled: false, authState: 'pending' })

    await new AuthorizationFlowRecoveryWorker(new DbOAuthStateRepository()).runOnce()
    expect(await repository.get(connectionId)).toBeNull()
    expect(
      await db
        .select({ authorizationFlowId: integrationRevocationJobs.authorizationFlowId })
        .from(integrationRevocationJobs)
        .where(eq(integrationRevocationJobs.credentialRef, credentialRef))
    ).toEqual([{ authorizationFlowId: localFlowId }])
    const revocation = new IntegrationRevocationWorker({
      repository: new DbIntegrationRevocationRepository(),
      credentials: {
        refreshKey: async () => {},
        get: () =>
          serializeOAuthCredential({
            version: 1,
            accessToken: 'pending-access',
            refreshToken: null,
            expiresAt: null,
            tokenRevision: 1,
          }),
      },
      resolvePlugin: () => ({
        authorization: { kind: 'oauth2', adapter: 'notion' },
        classifyError: () => ({ code: 'provider_unavailable', retryable: true }),
      }),
      revocationTransports: {
        resolve: (authority) => ({ authority, revoke: async () => {} }),
      },
    })
    expect(await revocation.runOnce()).toBe(true)
    const cleanup = new IntegrationCredentialCleanupWorker(new DbIntegrationCredentialCleanupRepository(), {
      deleteWithDurableMutation: async (key: string, mutation: (tx: SecretStoreTransaction) => Promise<void>) =>
        db.transaction(async (tx) => {
          await mutation(tx)
          await tx.delete(secrets).where(eq(secrets.key, key))
        }),
    })
    expect(await cleanup.runOnce()).toBe(true)
    expect(
      await db
        .select({
          revocationSettledAt: integrationAuthorizationFlowReceipts.revocationSettledAt,
          cleanupSettledAt: integrationAuthorizationFlowReceipts.cleanupSettledAt,
        })
        .from(integrationAuthorizationFlowReceipts)
        .where(eq(integrationAuthorizationFlowReceipts.localFlowId, localFlowId))
    ).toEqual([{ revocationSettledAt: expect.any(Date), cleanupSettledAt: expect.any(Date) }])
    await deleteSettledAuthorizationReceipts()
    expect(
      await db
        .select()
        .from(integrationAuthorizationFlowReceipts)
        .where(eq(integrationAuthorizationFlowReceipts.localFlowId, localFlowId))
    ).toHaveLength(0)
  } finally {
    await db.delete(integrationConnections).where(eq(integrationConnections.id, connectionId))
    await db.delete(integrationRevocationJobs).where(eq(integrationRevocationJobs.credentialRef, credentialRef))
    await db
      .delete(integrationCredentialCleanupJobs)
      .where(eq(integrationCredentialCleanupJobs.credentialRef, credentialRef))
    await db
      .delete(integrationAuthorizationFlowReceipts)
      .where(eq(integrationAuthorizationFlowReceipts.localFlowId, localFlowId))
    await db.delete(secrets).where(eq(secrets.key, credentialRef))
  }
})

test('ordinary enable ignores a dangling historical receipt marker after receipt GC and material change', async () => {
  const repository = new DbIntegrationConnectionRepository()
  const installed = await installedFlowConnection(repository)
  const nextRevision = crypto.randomUUID()
  try {
    await db
      .delete(integrationAuthorizationFlowReceipts)
      .where(eq(integrationAuthorizationFlowReceipts.localFlowId, installed.localFlowId))
    await db
      .update(integrationConnections)
      .set({ materialRevision: nextRevision, enabled: false, authState: 'invalid' })
      .where(eq(integrationConnections.id, installed.connectionId))
    const now = new Date()
    expect(
      await repository.enableValidated({
        id: installed.connectionId,
        materialRevision: nextRevision,
        validation: { ok: true, grantedScopes: [] },
        now,
        expiresAt: new Date(now.getTime() + 60_000),
      })
    ).toBe(true)
    expect(await repository.get(installed.connectionId)).toMatchObject({
      enabled: true,
      authState: 'authenticated',
      materialRevision: nextRevision,
    })
  } finally {
    await db.delete(integrationConnections).where(eq(integrationConnections.id, installed.connectionId))
    await db.delete(secrets).where(eq(secrets.key, installed.credentialRef))
  }
})

test('installed receipt deletion links and drains revocation plus cleanup obligations', async () => {
  const repository = new DbIntegrationConnectionRepository()
  const installed = await installedFlowConnection(repository)
  try {
    expect(await repository.disable(installed.connectionId)).toMatchObject({ status: 'updated' })
    await db
      .update(integrationAuthorizationFlowReceipts)
      .set({
        recoveryExpiresAt: new Date('2000-01-01T00:00:00.000Z'),
        retainUntil: new Date('2000-01-01T00:00:00.000Z'),
      })
      .where(eq(integrationAuthorizationFlowReceipts.localFlowId, installed.localFlowId))
    await new AuthorizationFlowRecoveryWorker(new DbOAuthStateRepository()).runOnce()
    expect(await repository.get(installed.connectionId)).toMatchObject({
      authorizationFlowId: installed.localFlowId,
      enabled: false,
      credentialRef: installed.credentialRef,
      materialRevision: installed.materialRevision,
    })
    await deleteSettledAuthorizationReceipts()
    expect(
      await db
        .select({ localFlowId: integrationAuthorizationFlowReceipts.localFlowId })
        .from(integrationAuthorizationFlowReceipts)
        .where(eq(integrationAuthorizationFlowReceipts.localFlowId, installed.localFlowId))
    ).toEqual([{ localFlowId: installed.localFlowId }])
    expect(await repository.deleteWithRevocation(installed.connectionId)).toMatchObject({ status: 'updated' })
    expect(
      await db
        .select({ authorizationFlowId: integrationRevocationJobs.authorizationFlowId })
        .from(integrationRevocationJobs)
        .where(eq(integrationRevocationJobs.credentialRef, installed.credentialRef))
    ).toEqual([{ authorizationFlowId: installed.localFlowId }])
    expect(
      await db
        .select({ revocationRequiredAt: integrationAuthorizationFlowReceipts.revocationRequiredAt })
        .from(integrationAuthorizationFlowReceipts)
        .where(eq(integrationAuthorizationFlowReceipts.localFlowId, installed.localFlowId))
    ).toEqual([{ revocationRequiredAt: expect.any(Date) }])

    const revocation = new IntegrationRevocationWorker({
      repository: new DbIntegrationRevocationRepository(),
      credentials: {
        refreshKey: async () => {},
        get: () =>
          serializeOAuthCredential({
            version: 1,
            accessToken: 'access-token',
            refreshToken: null,
            expiresAt: null,
            tokenRevision: 1,
          }),
      },
      resolvePlugin: () => ({
        authorization: { kind: 'oauth2', adapter: 'notion' },
        classifyError: () => ({ code: 'provider_unavailable', retryable: true }),
      }),
      revocationTransports: {
        resolve: (authority) => ({ authority, revoke: async () => {} }),
      },
    })
    expect(await revocation.runOnce()).toBe(true)
    const cleanup = new IntegrationCredentialCleanupWorker(new DbIntegrationCredentialCleanupRepository(), {
      deleteWithDurableMutation: async (key: string, mutation: (tx: SecretStoreTransaction) => Promise<void>) =>
        db.transaction(async (tx) => {
          await mutation(tx)
          await tx.delete(secrets).where(eq(secrets.key, key))
        }),
    })
    expect(await cleanup.runOnce()).toBe(true)
    expect(
      await db
        .select({
          revocationSettledAt: integrationAuthorizationFlowReceipts.revocationSettledAt,
          cleanupSettledAt: integrationAuthorizationFlowReceipts.cleanupSettledAt,
        })
        .from(integrationAuthorizationFlowReceipts)
        .where(eq(integrationAuthorizationFlowReceipts.localFlowId, installed.localFlowId))
    ).toEqual([{ revocationSettledAt: expect.any(Date), cleanupSettledAt: expect.any(Date) }])
    await db
      .update(integrationAuthorizationFlowReceipts)
      .set({ retainUntil: new Date('2000-01-01T00:00:00.000Z') })
      .where(eq(integrationAuthorizationFlowReceipts.localFlowId, installed.localFlowId))
    await deleteSettledAuthorizationReceipts()
    expect(
      await db
        .select()
        .from(integrationAuthorizationFlowReceipts)
        .where(eq(integrationAuthorizationFlowReceipts.localFlowId, installed.localFlowId))
    ).toHaveLength(0)
  } finally {
    await db
      .delete(integrationRevocationJobs)
      .where(eq(integrationRevocationJobs.credentialRef, installed.credentialRef))
    await db
      .delete(integrationCredentialCleanupJobs)
      .where(eq(integrationCredentialCleanupJobs.credentialRef, installed.credentialRef))
    await db.delete(integrationConnections).where(eq(integrationConnections.id, installed.connectionId))
    await db.delete(secrets).where(eq(secrets.key, installed.credentialRef))
    await db
      .delete(integrationAuthorizationFlowReceipts)
      .where(eq(integrationAuthorizationFlowReceipts.localFlowId, installed.localFlowId))
  }
})

test('local reconnect clears retired broker ownership and both artifacts drain', async () => {
  const repository = new DbIntegrationConnectionRepository()
  const installed = await installedFlowConnection(repository)
  const localCredentialRef = `test:${crypto.randomUUID()}`
  const localRevision = crypto.randomUUID()
  await db.insert(secrets).values({ key: localCredentialRef, encryptedValue: 'ciphertext', iv: 'iv' })
  const worker = (authority: 'local' | 'platform_broker') =>
    new IntegrationRevocationWorker({
      repository: new DbIntegrationRevocationRepository(),
      credentials: {
        refreshKey: async () => {},
        get: () =>
          serializeOAuthCredential({
            version: 1,
            accessToken: `${authority}-access`,
            refreshToken: null,
            expiresAt: null,
            tokenRevision: 1,
          }),
      },
      resolvePlugin: () => ({
        authorization: { kind: 'oauth2', adapter: 'notion' },
        classifyError: () => ({ code: 'provider_unavailable', retryable: true }),
      }),
      revocationTransports: {
        resolve: (jobAuthority) => ({ authority: jobAuthority, revoke: async () => {} }),
      },
    })
  const cleanup = new IntegrationCredentialCleanupWorker(new DbIntegrationCredentialCleanupRepository(), {
    deleteWithDurableMutation: async (key: string, mutation: (tx: SecretStoreTransaction) => Promise<void>) =>
      db.transaction(async (tx) => {
        await mutation(tx)
        await tx.delete(secrets).where(eq(secrets.key, key))
      }),
  })
  try {
    await db
      .update(integrationConnections)
      .set({ authState: 'invalid', lastErrorCode: 'client_authority_mismatch' })
      .where(eq(integrationConnections.id, installed.connectionId))
    expect(
      await repository.installAuthorizedMaterial({
        id: installed.connectionId,
        expectedMaterialRevision: installed.materialRevision,
        expectedProviderKey: 'notion',
        expectedAdapterVersion: 1,
        expectedIdentity: { workspaceId: 'workspace-1' },
        configuration: { version: 1, workspaceId: 'workspace-1' },
        credentialRef: localCredentialRef,
        materialRevision: localRevision,
        displayName: 'Local Workspace',
        updatedByUserId: await createActor(),
        clientAuthority: 'local',
      })
    ).toEqual({ status: 'updated' })
    expect(await repository.get(installed.connectionId)).toMatchObject({
      authorizationFlowId: null,
      clientAuthority: 'local',
      credentialRef: localCredentialRef,
      materialRevision: localRevision,
    })
    const [schedule] = await db
      .select({
        next: integrationConnections.nextValidationAt,
        expires: integrationConnections.validationExpiresAt,
      })
      .from(integrationConnections)
      .where(eq(integrationConnections.id, installed.connectionId))
    expect(schedule.expires!.getTime() - schedule.next!.getTime()).toBe(120_000)
    expect(
      await db
        .select({
          authorizationFlowId: integrationRevocationJobs.authorizationFlowId,
          clientAuthority: integrationRevocationJobs.clientAuthority,
        })
        .from(integrationRevocationJobs)
        .where(eq(integrationRevocationJobs.credentialRef, installed.credentialRef))
    ).toEqual([{ authorizationFlowId: installed.localFlowId, clientAuthority: 'platform_broker' }])
    expect(await worker('platform_broker').runOnce()).toBe(true)
    expect(await cleanup.runOnce()).toBe(true)

    expect(await repository.deleteWithRevocation(installed.connectionId)).toMatchObject({ status: 'updated' })
    expect(
      await db
        .select({
          authorizationFlowId: integrationRevocationJobs.authorizationFlowId,
          clientAuthority: integrationRevocationJobs.clientAuthority,
        })
        .from(integrationRevocationJobs)
        .where(eq(integrationRevocationJobs.credentialRef, localCredentialRef))
    ).toEqual([{ authorizationFlowId: null, clientAuthority: 'local' }])
    expect(await worker('local').runOnce()).toBe(true)
    expect(await cleanup.runOnce()).toBe(true)
    expect(
      await db
        .select()
        .from(secrets)
        .where(inArray(secrets.key, [installed.credentialRef, localCredentialRef]))
    ).toHaveLength(0)
  } finally {
    await db.delete(integrationConnections).where(eq(integrationConnections.id, installed.connectionId))
    await db
      .delete(integrationRevocationJobs)
      .where(inArray(integrationRevocationJobs.credentialRef, [installed.credentialRef, localCredentialRef]))
    await db
      .delete(integrationCredentialCleanupJobs)
      .where(inArray(integrationCredentialCleanupJobs.credentialRef, [installed.credentialRef, localCredentialRef]))
    await db
      .delete(integrationAuthorizationFlowReceipts)
      .where(eq(integrationAuthorizationFlowReceipts.localFlowId, installed.localFlowId))
    await db.delete(secrets).where(inArray(secrets.key, [installed.credentialRef, localCredentialRef]))
  }
})

test('authorization flow marker uniquely resolves one durable connection', async () => {
  const repository = new DbIntegrationConnectionRepository()
  const authorizationFlowId = crypto.randomUUID()
  const first = await repository.createPending({
    ...pending(),
    clientAuthority: 'platform_broker',
    authorizationFlowId,
  })
  try {
    expect(await repository.getByAuthorizationFlow(authorizationFlowId)).toMatchObject({
      id: first.id,
      authorizationFlowId,
      clientAuthority: 'platform_broker',
    })
    await expect(
      repository.createPending({
        ...pending(),
        clientAuthority: 'platform_broker',
        authorizationFlowId,
      })
    ).rejects.toBeDefined()
  } finally {
    await db.delete(integrationConnections).where(eq(integrationConnections.id, first.id))
  }
})

test('distinct reconnect finalization rejects a deleted source at the commit boundary', async () => {
  const repository = new DbIntegrationConnectionRepository()
  const sourceId = crypto.randomUUID()
  const sourceRevision = crypto.randomUUID()
  const sourceRef = `test:${crypto.randomUUID()}`
  const localFlowId = crypto.randomUUID()
  const newId = crypto.randomUUID()
  const newRevision = crypto.randomUUID()
  const artifactRef = `__integration-credential:authorization-flow:${localFlowId}:bearer`
  await db.insert(secrets).values([
    { key: sourceRef, encryptedValue: 'ciphertext', iv: 'iv' },
    { key: artifactRef, encryptedValue: 'ciphertext', iv: 'iv' },
  ])
  await repository.createPending({
    ...pending(sourceId),
    credentialRef: sourceRef,
    materialRevision: sourceRevision,
  })
  await db.insert(integrationAuthorizationFlowReceipts).values({
    localFlowId,
    providerKey: 'bigbrain',
    authority: 'platform_broker',
    intent: 'reconnect',
    initiatingUserId: crypto.randomUUID(),
    returnTo: '/settings',
    completionHandleHash: 'd'.repeat(64),
    adapterVersion: 1,
    sourceConnectionId: sourceId,
    sourceMaterialRevision: sourceRevision,
    artifactCredentialRef: artifactRef,
    stagingStartedAt: new Date(),
    recoveryExpiresAt: new Date(Date.now() + 60_000),
    retainUntil: new Date(Date.now() + 60_000),
  })
  await repository.createPending({
    ...pending(newId),
    clientAuthority: 'platform_broker',
    authorizationFlowId: localFlowId,
    credentialRef: artifactRef,
    materialRevision: newRevision,
  })
  try {
    await db.delete(integrationConnections).where(eq(integrationConnections.id, sourceId))
    const now = new Date()
    expect(
      await repository.enableValidated({
        id: newId,
        materialRevision: newRevision,
        validation: { ok: true, grantedScopes: [] },
        now,
        expiresAt: new Date(now.getTime() + 60_000),
        authorizationFlowId: localFlowId,
      })
    ).toBe(false)
    expect(
      await db
        .select({ installKind: integrationAuthorizationFlowReceipts.installKind })
        .from(integrationAuthorizationFlowReceipts)
        .where(eq(integrationAuthorizationFlowReceipts.localFlowId, localFlowId))
    ).toEqual([{ installKind: null }])
  } finally {
    await db.delete(integrationConnections).where(inArray(integrationConnections.id, [sourceId, newId]))
    await db
      .delete(integrationAuthorizationFlowReceipts)
      .where(eq(integrationAuthorizationFlowReceipts.localFlowId, localFlowId))
    await db.delete(secrets).where(inArray(secrets.key, [sourceRef, artifactRef]))
  }
})

test('local staged revocation ownership transfers atomically on create and reconnect', async () => {
  const repository = new DbIntegrationConnectionRepository()
  const connectionId = crypto.randomUUID()
  const oldRef = `test:${crypto.randomUUID()}`
  const stagedRef = `test:${crypto.randomUUID()}`
  const nextRef = `test:${crypto.randomUUID()}`
  const oldRevision = crypto.randomUUID()
  const nextRevision = crypto.randomUUID()
  await db.insert(secrets).values([
    { key: oldRef, encryptedValue: 'encrypted', iv: 'iv' },
    { key: stagedRef, encryptedValue: 'encrypted', iv: 'iv' },
    { key: nextRef, encryptedValue: 'encrypted', iv: 'iv' },
  ])
  await db.insert(integrationRevocationJobs).values([
    { providerKey: 'notion', adapterVersion: 1, clientAuthority: 'local', credentialRef: stagedRef },
    { providerKey: 'notion', adapterVersion: 1, clientAuthority: 'local', credentialRef: nextRef },
  ])
  try {
    await db
      .update(integrationRevocationJobs)
      .set({ leaseToken: crypto.randomUUID(), leaseExpiresAt: new Date(Date.now() + 60_000) })
      .where(eq(integrationRevocationJobs.credentialRef, stagedRef))
    await expect(
      repository.createPending({
        id: connectionId,
        providerKey: 'notion',
        adapterVersion: 1,
        clientAuthority: 'local',
        displayName: 'Workspace',
        configuration: {
          version: 1,
          workspaceId: 'workspace-1',
          workspaceName: 'Workspace',
          workspaceIcon: null,
          botId: 'bot-1',
        },
        credentialRef: stagedRef,
        materialRevision: oldRevision,
        adoptStagedRevocationRef: stagedRef,
      })
    ).rejects.toThrow('not adoptable')
    expect(await repository.get(connectionId)).toBeNull()
    expect(await repository.hasRevocation(stagedRef)).toBe(true)
    await db
      .update(integrationRevocationJobs)
      .set({ leaseToken: null, leaseExpiresAt: null })
      .where(eq(integrationRevocationJobs.credentialRef, stagedRef))

    await expect(
      repository.createPending({
        id: connectionId,
        providerKey: 'notion',
        adapterVersion: 1,
        clientAuthority: 'local',
        displayName: 'Workspace',
        configuration: {
          version: 1,
          workspaceId: 'workspace-1',
          workspaceName: 'Workspace',
          workspaceIcon: null,
          botId: 'bot-1',
        },
        credentialRef: oldRef,
        materialRevision: oldRevision,
        adoptStagedRevocationRef: stagedRef,
      })
    ).rejects.toThrow('reference mismatch')
    expect(await repository.get(connectionId)).toBeNull()

    const created = await repository.createPending({
      id: connectionId,
      providerKey: 'notion',
      adapterVersion: 1,
      clientAuthority: 'local',
      displayName: 'Workspace',
      configuration: {
        version: 1,
        workspaceId: 'workspace-1',
        workspaceName: 'Workspace',
        workspaceIcon: null,
        botId: 'bot-1',
      },
      credentialRef: stagedRef,
      materialRevision: oldRevision,
      adoptStagedRevocationRef: stagedRef,
    })
    expect(await repository.hasRevocation(stagedRef)).toBe(true)

    await db
      .update(integrationRevocationJobs)
      .set({ leaseToken: crypto.randomUUID(), leaseExpiresAt: new Date(Date.now() + 60_000) })
      .where(eq(integrationRevocationJobs.credentialRef, nextRef))
    await expect(
      repository.installAuthorizedMaterial({
        id: created.id,
        expectedMaterialRevision: oldRevision,
        expectedProviderKey: 'notion',
        expectedAdapterVersion: 1,
        expectedIdentity: { workspaceId: 'workspace-1' },
        configuration: {
          version: 1,
          workspaceId: 'workspace-1',
          workspaceName: 'Renamed',
          workspaceIcon: null,
          botId: 'bot-1',
        },
        credentialRef: nextRef,
        materialRevision: nextRevision,
        displayName: 'Renamed',
        updatedByUserId: await createActor(),
        clientAuthority: 'local',
        adoptStagedRevocationRef: nextRef,
      })
    ).rejects.toThrow('not adoptable')
    expect(await repository.get(created.id)).toMatchObject({ credentialRef: stagedRef, materialRevision: oldRevision })
    await db
      .update(integrationRevocationJobs)
      .set({ leaseToken: null, leaseExpiresAt: null })
      .where(eq(integrationRevocationJobs.credentialRef, nextRef))

    expect(
      await repository.installAuthorizedMaterial({
        id: created.id,
        expectedMaterialRevision: oldRevision,
        expectedProviderKey: 'notion',
        expectedAdapterVersion: 1,
        expectedIdentity: { workspaceId: 'workspace-1' },
        configuration: {
          version: 1,
          workspaceId: 'workspace-1',
          workspaceName: 'Renamed',
          workspaceIcon: null,
          botId: 'bot-1',
        },
        credentialRef: nextRef,
        materialRevision: nextRevision,
        displayName: 'Renamed',
        updatedByUserId: await createActor(),
        clientAuthority: 'local',
        adoptStagedRevocationRef: nextRef,
      })
    ).toEqual({ status: 'updated' })
    expect(await repository.hasRevocation(nextRef)).toBe(false)
    expect(await repository.hasRevocation(stagedRef)).toBe(true)
    expect(await repository.get(created.id)).toMatchObject({ credentialRef: nextRef, materialRevision: nextRevision })
  } finally {
    await db.delete(integrationConnections).where(eq(integrationConnections.id, connectionId))
    await db
      .delete(integrationRevocationJobs)
      .where(inArray(integrationRevocationJobs.credentialRef, [oldRef, stagedRef, nextRef]))
    await db.delete(secrets).where(inArray(secrets.key, [oldRef, stagedRef, nextRef]))
  }
})

test('pending local rollback preserves its exact pristine revocation owner without another lease', async () => {
  const repository = new DbIntegrationConnectionRepository()
  const input = { ...pending(), providerKey: 'notion', clientAuthority: 'local' as const }
  await db.insert(secrets).values({ key: input.credentialRef, encryptedValue: 'ciphertext', iv: 'iv' })
  try {
    await db.insert(integrationRevocationJobs).values({
      providerKey: input.providerKey,
      adapterVersion: input.adapterVersion,
      clientAuthority: 'local',
      credentialRef: input.credentialRef,
    })
    const connection = await repository.createPending({ ...input, adoptStagedRevocationRef: input.credentialRef })
    expect(
      await repository.recordValidation({
        id: connection.id,
        materialRevision: connection.materialRevision,
        validation: { ok: true, grantedScopes: ['content:read'] },
        now: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      })
    ).toBe(true)
    expect(await repository.get(connection.id)).toMatchObject({ enabled: false, authState: 'authenticated' })
    expect(await repository.rollbackPendingLocal({ id: connection.id, credentialRef: connection.credentialRef })).toBe(
      true
    )
    expect(await repository.get(connection.id)).toBeNull()
    expect(await repository.hasRevocation(connection.credentialRef)).toBe(true)
  } finally {
    await db.delete(integrationConnections).where(eq(integrationConnections.id, input.id))
    await db.delete(integrationRevocationJobs).where(eq(integrationRevocationJobs.credentialRef, input.credentialRef))
    await db.delete(secrets).where(eq(secrets.key, input.credentialRef))
  }
})

test('a released revocation retry can never become connection-authoritative', async () => {
  const repository = new DbIntegrationConnectionRepository()
  const input = { ...pending(), adoptStagedRevocationRef: '' }
  input.adoptStagedRevocationRef = input.credentialRef
  await db.insert(secrets).values({ key: input.credentialRef, encryptedValue: 'encrypted', iv: 'iv' })
  await db.insert(integrationRevocationJobs).values({
    providerKey: input.providerKey,
    adapterVersion: input.adapterVersion,
    clientAuthority: input.clientAuthority,
    credentialRef: input.credentialRef,
    attempts: 1,
  })
  try {
    await expect(repository.createPending(input)).rejects.toThrow('not adoptable')
    expect(await repository.get(input.id)).toBeNull()
    expect(await repository.hasRevocation(input.credentialRef)).toBe(true)
  } finally {
    await db.delete(integrationConnections).where(eq(integrationConnections.id, input.id))
    await db.delete(integrationRevocationJobs).where(eq(integrationRevocationJobs.credentialRef, input.credentialRef))
    await db.delete(secrets).where(eq(secrets.key, input.credentialRef))
  }
})

test('durable deletion carries broker authority after removing the connection row', async () => {
  const repository = new DbIntegrationConnectionRepository()
  const input = { ...pending(), providerKey: 'notion', clientAuthority: 'platform_broker' as const }
  await db.insert(secrets).values({ key: input.credentialRef, encryptedValue: 'encrypted', iv: 'iv' })
  const connection = await repository.createPending(input)
  try {
    expect(await repository.deleteWithRevocation(connection.id, true)).toMatchObject({ status: 'updated' })
    const [job] = await db
      .select({ clientAuthority: integrationRevocationJobs.clientAuthority })
      .from(integrationRevocationJobs)
      .where(eq(integrationRevocationJobs.credentialRef, input.credentialRef))
    expect(job).toEqual({ clientAuthority: 'platform_broker' })
    expect(await repository.hasRevocation(input.credentialRef)).toBe(true)
    expect(await repository.get(connection.id)).toBeNull()

    await db
      .update(integrationRevocationJobs)
      .set({ nextAttemptAt: new Date('2000-01-01T00:00:00.000Z') })
      .where(eq(integrationRevocationJobs.credentialRef, input.credentialRef))
    const revocations = new DbIntegrationRevocationRepository()
    const now = new Date()
    const claimed = await revocations.claim(now, new Date(now.getTime() + 60_000), crypto.randomUUID())
    expect(claimed).toMatchObject({ credentialRef: input.credentialRef })
    await revocations.failTerminal({
      id: claimed!.id,
      leaseToken: claimed!.leaseToken,
      attempts: 1,
      code: 'client_authority_mismatch',
      at: now,
    })
    expect(await revocations.claim(now, new Date(now.getTime() + 60_000), crypto.randomUUID())).toBeNull()
    const [terminal] = await db
      .select({ terminalAt: integrationRevocationJobs.terminalAt, code: integrationRevocationJobs.lastErrorCode })
      .from(integrationRevocationJobs)
      .where(eq(integrationRevocationJobs.credentialRef, input.credentialRef))
    expect(terminal).toEqual({ terminalAt: expect.any(Date), code: 'client_authority_mismatch' })
    expect(await db.select().from(secrets).where(eq(secrets.key, input.credentialRef))).toHaveLength(1)
  } finally {
    await db.delete(integrationRevocationJobs).where(eq(integrationRevocationJobs.credentialRef, input.credentialRef))
    await db.delete(integrationConnections).where(eq(integrationConnections.id, connection.id))
    await db.delete(secrets).where(eq(secrets.key, input.credentialRef))
  }
})

test('revocation uses the database clock and an expired owner cannot settle cleanup', async () => {
  const credentialRef = `test:${crypto.randomUUID()}`
  await db.insert(secrets).values({ key: credentialRef, encryptedValue: 'encrypted', iv: 'iv' })
  try {
    const [row] = await db
      .insert(integrationRevocationJobs)
      .values({
        providerKey: 'notion',
        adapterVersion: 1,
        clientAuthority: 'local',
        credentialRef,
        nextAttemptAt: sql`clock_timestamp()`,
      })
      .returning()
    const repository = new DbIntegrationRevocationRepository()
    expect(
      await new DbIntegrationRevocationRepository([]).claim(
        new Date('1900-01-01T00:00:00.000Z'),
        new Date('1900-01-01T00:01:00.000Z'),
        crypto.randomUUID()
      )
    ).toBeNull()
    const claimed = await repository.claim(
      new Date('1900-01-01T00:00:00.000Z'),
      new Date('1900-01-01T00:01:00.000Z'),
      crypto.randomUUID()
    )
    expect(claimed?.id).toBe(row!.id)
    await db
      .update(integrationRevocationJobs)
      .set({ leaseExpiresAt: new Date('2000-01-01T00:00:00.000Z') })
      .where(eq(integrationRevocationJobs.id, row!.id))

    await expect(repository.complete(claimed!)).rejects.toThrow('Revocation lease lost')
    expect(
      await db
        .select()
        .from(integrationCredentialCleanupJobs)
        .where(eq(integrationCredentialCleanupJobs.credentialRef, credentialRef))
    ).toHaveLength(0)
    expect(
      await db.select().from(integrationRevocationJobs).where(eq(integrationRevocationJobs.id, row!.id))
    ).toHaveLength(1)
  } finally {
    await db
      .delete(integrationCredentialCleanupJobs)
      .where(eq(integrationCredentialCleanupJobs.credentialRef, credentialRef))
    await db.delete(integrationRevocationJobs).where(eq(integrationRevocationJobs.credentialRef, credentialRef))
    await db.delete(secrets).where(eq(secrets.key, credentialRef))
  }
})

test('runtime authentication disable uses global material revision CAS', async () => {
  const repository = new DbIntegrationConnectionRepository()
  const oldRevision = crypto.randomUUID()
  const newRevision = crypto.randomUUID()
  const connection = await repository.createPending({ ...pending(), materialRevision: oldRevision })
  try {
    await repository.rotateMaterial({ id: connection.id, materialRevision: newRevision })
    await repository.enableValidated({
      id: connection.id,
      materialRevision: newRevision,
      validation: { ok: true, grantedScopes: ['vault:read'] },
      now: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    })

    expect(await repository.disableRuntimeAuthFailure({ id: connection.id, materialRevision: oldRevision })).toBe(false)
    expect(await repository.get(connection.id)).toMatchObject({
      enabled: true,
      authState: 'authenticated',
      materialRevision: newRevision,
    })
    expect(await repository.disableRuntimeAuthFailure({ id: connection.id, materialRevision: newRevision })).toBe(true)
    expect(await repository.get(connection.id)).toMatchObject({
      enabled: false,
      authState: 'invalid',
      lastErrorCode: 'invalid_auth',
    })
  } finally {
    await db.delete(integrationConnections).where(eq(integrationConnections.id, connection.id))
  }
})

test('validation classification preserves authentication for transient failures only', async () => {
  const repository = new DbIntegrationConnectionRepository()
  const connection = await repository.createPending(pending())
  const now = new Date()
  try {
    await repository.recordValidation({
      id: connection.id,
      materialRevision: connection.materialRevision,
      validation: { ok: true, grantedScopes: ['vault:read'] },
      now,
      expiresAt: new Date(now.getTime() + 60_000),
    })
    await repository.recordValidation({
      id: connection.id,
      materialRevision: connection.materialRevision,
      validation: { ok: false, code: 'provider_unavailable' },
      now: new Date(now.getTime() + 1),
      expiresAt: new Date(now.getTime() + 30_000),
    })
    expect(await repository.get(connection.id)).toMatchObject({
      authState: 'authenticated',
      healthState: 'degraded',
      lastErrorCode: 'provider_unavailable',
    })
    await repository.recordValidation({
      id: connection.id,
      materialRevision: connection.materialRevision,
      validation: { ok: false, code: 'invalid_auth' },
      now: new Date(now.getTime() + 2),
      expiresAt: new Date(now.getTime() + 30_000),
    })
    expect(await repository.get(connection.id)).toMatchObject({ authState: 'invalid', healthState: 'unreachable' })
  } finally {
    await db.delete(integrationConnections).where(eq(integrationConnections.id, connection.id))
  }
})

test('successful validation persists a refreshed configuration and leaves it alone otherwise', async () => {
  const repository = new DbIntegrationConnectionRepository()
  const connection = await repository.createPending(pending())
  const now = new Date()
  const refreshed = { version: 1, apiBase: 'https://renamed.example' }
  try {
    await repository.recordValidation({
      id: connection.id,
      materialRevision: connection.materialRevision,
      validation: { ok: true, grantedScopes: [], configuration: refreshed },
      now,
      expiresAt: new Date(now.getTime() + 60_000),
    })
    expect(await repository.get(connection.id)).toMatchObject({
      configuration: refreshed,
      validatedRevision: connection.materialRevision,
    })
    await repository.recordValidation({
      id: connection.id,
      materialRevision: connection.materialRevision,
      validation: { ok: true, grantedScopes: [] },
      now: new Date(now.getTime() + 1),
      expiresAt: new Date(now.getTime() + 60_000),
    })
    expect((await repository.get(connection.id))?.configuration).toEqual(refreshed)
  } finally {
    await db.delete(integrationConnections).where(eq(integrationConnections.id, connection.id))
  }
})

test('an expired or provider-rejected refresh failure deprojects but remains retryable and recoverable', async () => {
  const repository = new DbIntegrationConnectionRepository()
  const connection = await repository.createPending(pending())
  let recoverySquadId: string | null = null
  try {
    const [recoverySquad] = await db.insert(squads).values({ name: 'Recovery', purpose: 'test' }).returning()
    recoverySquadId = recoverySquad.id
    await db.insert(integrationConnectionAssignments).values({
      squadId: recoverySquad.id,
      providerKey: connection.providerKey,
      connectionId: connection.id,
    })
    const now = new Date()
    await repository.enableValidated({
      id: connection.id,
      materialRevision: connection.materialRevision,
      validation: { ok: true, grantedScopes: ['content:read'] },
      now,
      expiresAt: new Date(now.getTime() + 15 * 60_000),
    })
    await repository.recordRefreshFailure({
      id: connection.id,
      materialRevision: connection.materialRevision,
      code: 'provider_unavailable',
      invalidateAuthentication: true,
    })
    expect(await repository.get(connection.id)).toMatchObject({
      enabled: true,
      authState: 'invalid',
      healthState: 'degraded',
      lastErrorCode: 'provider_unavailable',
    })
    expect(await repository.due(new Date(now.getTime() + 61_000), 10)).toContainEqual({ id: connection.id })
    await db
      .update(integrationProjectionStates)
      .set({ status: 'ready', leaseToken: null, leaseExpiresAt: null })
      .where(eq(integrationProjectionStates.squadId, recoverySquad.id))
    await repository.recordValidation({
      id: connection.id,
      materialRevision: connection.materialRevision,
      validation: { ok: true, grantedScopes: ['content:read'] },
      now: new Date(now.getTime() + 62_000),
      expiresAt: new Date(now.getTime() + 20 * 60_000),
    })
    expect(await repository.get(connection.id)).toMatchObject({
      enabled: true,
      authState: 'authenticated',
      healthState: 'healthy',
      lastErrorCode: null,
    })
    const [projection] = await db
      .select()
      .from(integrationProjectionStates)
      .where(eq(integrationProjectionStates.squadId, recoverySquad.id))
    expect(projection).toMatchObject({ generation: 3n, status: 'pending' })
  } finally {
    if (recoverySquadId) await db.delete(squads).where(eq(squads.id, recoverySquadId))
    await db.delete(integrationConnections).where(eq(integrationConnections.id, connection.id))
  }
})

test('successful validation schedules recovery from degraded and expired authenticated eligibility', async () => {
  const repository = new DbIntegrationConnectionRepository()
  const connection = await repository.createPending(pending())
  let squadId: string | null = null
  try {
    const [squad] = await db.insert(squads).values({ name: 'Validation recovery', purpose: 'test' }).returning()
    squadId = squad.id
    await db.insert(integrationConnectionAssignments).values({
      squadId: squad.id,
      providerKey: connection.providerKey,
      connectionId: connection.id,
    })
    const initial = new Date()
    await repository.enableValidated({
      id: connection.id,
      materialRevision: connection.materialRevision,
      validation: { ok: true, grantedScopes: [] },
      now: initial,
      expiresAt: new Date(initial.getTime() + 60_000),
    })
    await repository.recordValidation({
      id: connection.id,
      materialRevision: connection.materialRevision,
      validation: { ok: false, code: 'provider_unavailable' },
      now: new Date(initial.getTime() + 1_000),
      expiresAt: new Date(initial.getTime() + 2_000),
    })
    await db
      .update(integrationProjectionStates)
      .set({ status: 'ready' })
      .where(eq(integrationProjectionStates.squadId, squad.id))
    await repository.recordValidation({
      id: connection.id,
      materialRevision: connection.materialRevision,
      validation: { ok: true, grantedScopes: [] },
      now: new Date(initial.getTime() + 3_000),
      expiresAt: new Date(initial.getTime() + 60_000),
    })
    expect(
      (await db.select().from(integrationProjectionStates).where(eq(integrationProjectionStates.squadId, squad.id)))[0]
    ).toMatchObject({ generation: 2n, status: 'pending' })
    await db
      .update(integrationConnections)
      .set({ validationExpiresAt: new Date(initial.getTime() - 1), validatedRevision: connection.materialRevision })
      .where(eq(integrationConnections.id, connection.id))
    await db
      .update(integrationProjectionStates)
      .set({ status: 'ready' })
      .where(eq(integrationProjectionStates.squadId, squad.id))
    await repository.recordValidation({
      id: connection.id,
      materialRevision: connection.materialRevision,
      validation: { ok: true, grantedScopes: [] },
      now: new Date(initial.getTime() + 4_000),
      expiresAt: new Date(initial.getTime() + 60_000),
    })
    expect(
      (await db.select().from(integrationProjectionStates).where(eq(integrationProjectionStates.squadId, squad.id)))[0]
    ).toMatchObject({ generation: 3n, status: 'pending' })
  } finally {
    if (squadId) await db.delete(squads).where(eq(squads.id, squadId))
    await db.delete(integrationConnections).where(eq(integrationConnections.id, connection.id))
  }
})

test('enabling a disabled assigned connection schedules projection recovery', async () => {
  const repository = new DbIntegrationConnectionRepository()
  const connection = await repository.createPending(pending())
  let squadId: string | null = null
  try {
    const [squad] = await db.insert(squads).values({ name: 'Enable recovery', purpose: 'test' }).returning()
    squadId = squad.id
    await db.insert(integrationConnectionAssignments).values({
      squadId: squad.id,
      providerKey: connection.providerKey,
      connectionId: connection.id,
    })
    const validation = { ok: true as const, grantedScopes: ['content:read'] }
    expect(
      await repository.enableValidated({
        id: connection.id,
        materialRevision: connection.materialRevision,
        validation,
        now: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      })
    ).toBe(true)
    expect((await repository.disable(connection.id, true)).status).toBe('updated')
    await db
      .update(integrationProjectionStates)
      .set({ status: 'ready' })
      .where(eq(integrationProjectionStates.squadId, squad.id))
    expect(
      await repository.enableValidated({
        id: connection.id,
        materialRevision: connection.materialRevision,
        validation,
        now: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      })
    ).toBe(true)
    const [projection] = await db
      .select()
      .from(integrationProjectionStates)
      .where(eq(integrationProjectionStates.squadId, squad.id))
    expect(projection).toMatchObject({ generation: 3n, status: 'pending' })
  } finally {
    if (squadId) await db.delete(squads).where(eq(squads.id, squadId))
    await db.delete(integrationConnections).where(eq(integrationConnections.id, connection.id))
  }
})

test('concurrent rotations durably queue every superseded credential reference', async () => {
  const repository = new DbIntegrationConnectionRepository()
  const input = pending()
  const firstRef = `test:${crypto.randomUUID()}`
  const secondRef = `test:${crypto.randomUUID()}`
  await db
    .insert(secrets)
    .values([input.credentialRef, firstRef, secondRef].map((key) => ({ key, encryptedValue: 'ciphertext', iv: 'iv' })))
  const connection = await repository.createPending(input)
  try {
    await Promise.all([
      repository.rotateMaterial({ id: connection.id, materialRevision: crypto.randomUUID(), credentialRef: firstRef }),
      repository.rotateMaterial({ id: connection.id, materialRevision: crypto.randomUUID(), credentialRef: secondRef }),
    ])
    const active = (await repository.get(connection.id))!.credentialRef
    const queued = await db
      .select()
      .from(integrationCredentialCleanupJobs)
      .where(inArray(integrationCredentialCleanupJobs.credentialRef, [input.credentialRef, firstRef, secondRef]))
    expect(new Set(queued.map((job) => job.credentialRef))).toEqual(
      new Set([input.credentialRef, firstRef, secondRef].filter((reference) => reference !== active))
    )
  } finally {
    await db
      .delete(integrationCredentialCleanupJobs)
      .where(inArray(integrationCredentialCleanupJobs.credentialRef, [input.credentialRef, firstRef, secondRef]))
    await db.delete(integrationConnections).where(eq(integrationConnections.id, connection.id))
    await db.delete(secrets).where(inArray(secrets.key, [input.credentialRef, firstRef, secondRef]))
  }
})

test('authorized Notion reconnect atomically compares workspace and revision before queuing old material', async () => {
  const repository = new DbIntegrationConnectionRepository()
  const id = crypto.randomUUID()
  const expectedRevision = crypto.randomUUID()
  const nextRevision = crypto.randomUUID()
  const localFlowId = crypto.randomUUID()
  const priorFlowId = crypto.randomUUID()
  const oldRef = `__integration-credential:authorization-flow:${priorFlowId}:bearer`
  const newRef = `__integration-credential:authorization-flow:${localFlowId}:bearer`
  await db.insert(secrets).values([oldRef, newRef].map((key) => ({ key, encryptedValue: 'ciphertext', iv: 'iv' })))
  await db.insert(integrationAuthorizationFlowReceipts).values({
    localFlowId: priorFlowId,
    providerKey: 'notion',
    authority: 'platform_broker',
    intent: 'connect',
    initiatingUserId: crypto.randomUUID(),
    returnTo: '/settings',
    completionHandleHash: 'a'.repeat(64),
    adapterVersion: 1,
    artifactCredentialRef: oldRef,
    stagingStartedAt: new Date(),
    installKind: 'connect',
    installedConnectionId: id,
    installedMaterialRevision: expectedRevision,
    installedAt: new Date(),
    recoveryExpiresAt: new Date(Date.now() + 60_000),
    retainUntil: new Date(Date.now() + 60_000),
  })
  await db.insert(integrationAuthorizationFlowReceipts).values({
    localFlowId,
    providerKey: 'notion',
    authority: 'platform_broker',
    intent: 'reconnect',
    initiatingUserId: crypto.randomUUID(),
    returnTo: '/settings',
    sourceConnectionId: id,
    sourceMaterialRevision: expectedRevision,
    completionHandleHash: 'b'.repeat(64),
    adapterVersion: 1,
    artifactCredentialRef: newRef,
    stagingStartedAt: new Date(),
    recoveryExpiresAt: new Date(Date.now() + 60_000),
    retainUntil: new Date(Date.now() + 60_000),
  })
  await repository.createPending({
    id,
    providerKey: 'notion',
    adapterVersion: 1,
    clientAuthority: 'platform_broker',
    authorizationFlowId: priorFlowId,
    displayName: 'Workspace',
    configuration: {
      version: 1,
      workspaceId: 'workspace-1',
      workspaceName: 'Old',
      workspaceIcon: null,
      botId: 'bot-old',
    },
    credentialRef: oldRef,
    materialRevision: expectedRevision,
  })
  try {
    await db
      .update(integrationAuthorizationFlowReceipts)
      .set({ sourceMaterialRevision: crypto.randomUUID() })
      .where(eq(integrationAuthorizationFlowReceipts.localFlowId, localFlowId))
    await expect(
      repository.installAuthorizedMaterial({
        id,
        expectedMaterialRevision: expectedRevision,
        expectedProviderKey: 'notion',
        expectedAdapterVersion: 1,
        expectedIdentity: { workspaceId: 'workspace-1' },
        configuration: {},
        credentialRef: newRef,
        materialRevision: nextRevision,
        displayName: 'Mismatch',
        updatedByUserId: await createActor(),
        clientAuthority: 'platform_broker',
        authorizationFlowId: localFlowId,
      })
    ).rejects.toThrow('Authorization flow receipt cannot install reconnect')
    expect(
      await db.select().from(integrationRevocationJobs).where(eq(integrationRevocationJobs.credentialRef, oldRef))
    ).toHaveLength(0)
    await db
      .update(integrationAuthorizationFlowReceipts)
      .set({ sourceMaterialRevision: expectedRevision })
      .where(eq(integrationAuthorizationFlowReceipts.localFlowId, localFlowId))
    expect(
      await repository.installAuthorizedMaterial({
        id,
        expectedMaterialRevision: expectedRevision,
        expectedProviderKey: 'notion',
        expectedAdapterVersion: 1,
        expectedIdentity: { workspaceId: 'workspace-1' },
        configuration: {
          version: 1,
          workspaceId: 'workspace-1',
          workspaceName: 'New',
          workspaceIcon: null,
          botId: 'bot-new',
        },
        credentialRef: newRef,
        materialRevision: nextRevision,
        displayName: 'New',
        updatedByUserId: await createActor(),
        clientAuthority: 'platform_broker',
        authorizationFlowId: localFlowId,
      })
    ).toEqual({ status: 'updated' })
    expect(await repository.get(id)).toMatchObject({
      credentialRef: newRef,
      materialRevision: nextRevision,
      authState: 'authenticated',
      clientAuthority: 'platform_broker',
      configuration: { workspaceId: 'workspace-1', botId: 'bot-new' },
    })
    expect(
      await db
        .select({
          installKind: integrationAuthorizationFlowReceipts.installKind,
          installedConnectionId: integrationAuthorizationFlowReceipts.installedConnectionId,
          installedMaterialRevision: integrationAuthorizationFlowReceipts.installedMaterialRevision,
        })
        .from(integrationAuthorizationFlowReceipts)
        .where(eq(integrationAuthorizationFlowReceipts.localFlowId, localFlowId))
    ).toEqual([{ installKind: 'reconnect_same', installedConnectionId: id, installedMaterialRevision: nextRevision }])
    expect(
      await db
        .select({
          clientAuthority: integrationRevocationJobs.clientAuthority,
          authorizationFlowId: integrationRevocationJobs.authorizationFlowId,
        })
        .from(integrationRevocationJobs)
        .where(eq(integrationRevocationJobs.credentialRef, oldRef))
    ).toEqual([{ clientAuthority: 'platform_broker', authorizationFlowId: priorFlowId }])
    expect(
      await db
        .select({
          installKind: integrationAuthorizationFlowReceipts.installKind,
          installedMaterialRevision: integrationAuthorizationFlowReceipts.installedMaterialRevision,
          revocationRequiredAt: integrationAuthorizationFlowReceipts.revocationRequiredAt,
        })
        .from(integrationAuthorizationFlowReceipts)
        .where(eq(integrationAuthorizationFlowReceipts.localFlowId, priorFlowId))
    ).toEqual([
      {
        installKind: 'connect',
        installedMaterialRevision: expectedRevision,
        revocationRequiredAt: expect.any(Date),
      },
    ])
    expect(
      await repository.installAuthorizedMaterial({
        id,
        expectedMaterialRevision: expectedRevision,
        expectedProviderKey: 'notion',
        expectedAdapterVersion: 1,
        expectedIdentity: { workspaceId: 'workspace-1' },
        configuration: {},
        credentialRef: oldRef,
        materialRevision: crypto.randomUUID(),
        displayName: 'Stale',
        updatedByUserId: await createActor(),
        clientAuthority: 'platform_broker',
      })
    ).toEqual({ status: 'changed' })
  } finally {
    await db.delete(integrationConnections).where(eq(integrationConnections.id, id))
    await db.delete(integrationRevocationJobs).where(eq(integrationRevocationJobs.credentialRef, oldRef))
    await db
      .delete(integrationAuthorizationFlowReceipts)
      .where(inArray(integrationAuthorizationFlowReceipts.localFlowId, [localFlowId, priorFlowId]))
    await db.delete(secrets).where(inArray(secrets.key, [oldRef, newRef]))
  }
})

test('deletion durably queues the locked credential reference before removing the connection', async () => {
  const repository = new DbIntegrationConnectionRepository()
  const input = pending()
  await db.insert(secrets).values({ key: input.credentialRef, encryptedValue: 'ciphertext', iv: 'iv' })
  const connection = await repository.createPending(input)
  try {
    expect(await repository.delete(connection.id)).toEqual({
      status: 'updated',
      value: { retiredCredentialRef: input.credentialRef },
    })
    expect(await repository.get(connection.id)).toBeNull()
    expect(
      await db
        .select({ credentialRef: integrationCredentialCleanupJobs.credentialRef })
        .from(integrationCredentialCleanupJobs)
        .where(eq(integrationCredentialCleanupJobs.credentialRef, input.credentialRef))
    ).toEqual([{ credentialRef: input.credentialRef }])
  } finally {
    await db
      .delete(integrationCredentialCleanupJobs)
      .where(eq(integrationCredentialCleanupJobs.credentialRef, input.credentialRef))
    await db.delete(integrationConnections).where(eq(integrationConnections.id, connection.id))
    await db.delete(secrets).where(eq(secrets.key, input.credentialRef))
  }
})

test('reauthorization CAS atomically supersedes an already-claimed projection generation', async () => {
  const repository = new DbIntegrationConnectionRepository()
  const connection = await repository.createPending(pending())
  const [squad] = await db.insert(squads).values({ name: 'Authority invalidation', purpose: 'test' }).returning()
  await repository.enableValidated({
    id: connection.id,
    materialRevision: connection.materialRevision,
    validation: { ok: true, grantedScopes: ['vault:read'] },
    now: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
  })
  await db.insert(integrationConnectionAssignments).values({
    squadId: squad.id,
    providerKey: connection.providerKey,
    connectionId: connection.id,
  })
  const originalLeaseToken = crypto.randomUUID()
  await db.insert(integrationProjectionStates).values({
    squadId: squad.id,
    providerKey: connection.providerKey,
    generation: 1n,
    status: 'installing',
    leaseToken: originalLeaseToken,
    leaseExpiresAt: new Date(Date.now() + 60_000),
    nextAttemptAt: new Date(),
  })
  try {
    const failingRepository = new DbIntegrationConnectionRepository({
      afterTerminalAuthConnectionUpdate: async () => {
        throw new Error('simulated crash before projection invalidation')
      },
    })
    await expect(
      failingRepository.markReauthorizationRequired({
        id: connection.id,
        materialRevision: connection.materialRevision,
        code: 'client_authority_mismatch',
      })
    ).rejects.toThrow('simulated crash')
    expect(await repository.get(connection.id)).toMatchObject({ authState: 'authenticated' })
    expect(
      await db.select().from(integrationProjectionStates).where(eq(integrationProjectionStates.squadId, squad.id))
    ).toEqual([expect.objectContaining({ generation: 1n, status: 'installing', leaseToken: originalLeaseToken })])
    expect(
      await repository.markReauthorizationRequired({
        id: connection.id,
        materialRevision: connection.materialRevision,
        code: 'client_authority_mismatch',
      })
    ).toBe(true)
    expect(await repository.get(connection.id)).toMatchObject({ authState: 'reauthorization_required' })
    expect(
      await repository.markReauthorizationRequired({
        id: connection.id,
        materialRevision: connection.materialRevision,
        code: 'client_authority_mismatch',
      })
    ).toBe(false)
    expect(
      await repository.disableRuntimeAuthFailure({
        id: connection.id,
        materialRevision: connection.materialRevision,
      })
    ).toBe(false)
    expect(
      await repository.recordRefreshFailure({
        id: connection.id,
        materialRevision: connection.materialRevision,
        code: 'invalid_grant',
        invalidateAuthentication: true,
      })
    ).toBe(false)
    expect(
      await repository.recordRefreshFailure({
        id: connection.id,
        materialRevision: connection.materialRevision,
        code: 'provider_unavailable',
        invalidateAuthentication: false,
      })
    ).toBe(false)
    expect(
      await repository.recordValidation({
        id: connection.id,
        materialRevision: connection.materialRevision,
        validation: { ok: true, grantedScopes: ['vault:read'] },
        now: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      })
    ).toBe(false)
    expect(await repository.get(connection.id)).toMatchObject({ authState: 'reauthorization_required' })
    expect(
      await repository.enableValidated({
        id: connection.id,
        materialRevision: connection.materialRevision,
        validation: { ok: true, grantedScopes: ['vault:read'] },
        now: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      })
    ).toBe(false)
    const [projection] = await db
      .select()
      .from(integrationProjectionStates)
      .where(eq(integrationProjectionStates.squadId, squad.id))
    expect(projection).toMatchObject({ generation: 2n, status: 'pending', leaseToken: null, leaseExpiresAt: null })
  } finally {
    await db.delete(squads).where(eq(squads.id, squad.id))
    await db.delete(integrationConnections).where(eq(integrationConnections.id, connection.id))
  }
})

test('refresh candidate keyset admits the initial current-authority page, advances, and wraps', async () => {
  const repository = new DbIntegrationConnectionRepository()
  const rows = Array.from({ length: 51 }, (_, index) => {
    const materialRevision = crypto.randomUUID()
    return {
      providerKey: 'notion',
      adapterVersion: 1,
      clientAuthority: 'platform_broker' as const,
      displayName: `Current authority ${index} ${crypto.randomUUID()}`,
      configuration: { version: 1, workspaceId: `current-workspace-${index}` },
      credentialRef: `test:current:${crypto.randomUUID()}`,
      materialRevision,
      validatedRevision: materialRevision,
      enabled: true,
      authState: 'authenticated' as const,
      healthState: 'healthy' as const,
      validationExpiresAt: new Date(Date.now() + 60_000),
    }
  })
  const inserted = await db.insert(integrationConnections).values(rows).returning({ id: integrationConnections.id })
  try {
    const first = await repository.listRefreshCandidates('notion', 'platform_broker', null, 50)
    expect(first).toHaveLength(50)
    const next = await repository.listRefreshCandidates('notion', 'platform_broker', first.at(-1)!.id, 50)
    expect(next).toHaveLength(1)
    expect(await repository.listRefreshCandidates('notion', 'platform_broker', next[0]!.id, 50)).toEqual([])
    expect(await repository.listRefreshCandidates('notion', 'platform_broker', null, 50)).toHaveLength(50)
  } finally {
    await db.delete(integrationConnections).where(
      inArray(
        integrationConnections.id,
        inserted.map((row) => row.id)
      )
    )
  }
})

test('refresh candidate pagination exhausts more than fifty historical authority rows across restarts', async () => {
  const repository = new DbIntegrationConnectionRepository()
  const rows = Array.from({ length: 51 }, (_, index) => {
    const materialRevision = crypto.randomUUID()
    return {
      providerKey: 'notion',
      adapterVersion: 1,
      clientAuthority: 'local' as const,
      displayName: `Historical authority ${index} ${crypto.randomUUID()}`,
      configuration: { version: 1, workspaceId: `workspace-${index}` },
      credentialRef: `test:historical:${crypto.randomUUID()}`,
      materialRevision,
      validatedRevision: materialRevision,
      enabled: true,
      authState: 'authenticated' as const,
      healthState: 'healthy' as const,
      validationExpiresAt: new Date(Date.now() + 60_000),
    }
  })
  const inserted = await db.insert(integrationConnections).values(rows).returning({ id: integrationConnections.id })
  try {
    const first = await repository.listRefreshCandidates('notion', 'platform_broker', null, 50, 'mismatched')
    expect(first).toHaveLength(50)
    await db
      .update(integrationConnections)
      .set({ authState: 'reauthorization_required' })
      .where(
        inArray(
          integrationConnections.id,
          first.map((row) => row.id)
        )
      )
    const afterRestart = await repository.listRefreshCandidates('notion', 'platform_broker', null, 50, 'mismatched')
    expect(afterRestart).toHaveLength(1)
    expect(first.map((row) => row.id)).not.toContain(afterRestart[0]!.id)
  } finally {
    await db.delete(integrationConnections).where(
      inArray(
        integrationConnections.id,
        inserted.map((row) => row.id)
      )
    )
  }
})

test('revocation claim skips a busy oldest artifact and drains unrelated work', async () => {
  const oldestRef = `test:busy-revocation:${crypto.randomUUID()}`
  const nextRef = `test:ready-revocation:${crypto.randomUUID()}`
  await db.insert(secrets).values([
    { key: oldestRef, encryptedValue: 'ciphertext', iv: 'iv' },
    { key: nextRef, encryptedValue: 'ciphertext', iv: 'iv' },
  ])
  await db.insert(integrationRevocationJobs).values([
    {
      providerKey: 'notion',
      adapterVersion: 1,
      clientAuthority: 'local',
      credentialRef: oldestRef,
      nextAttemptAt: new Date(0),
    },
    {
      providerKey: 'notion',
      adapterVersion: 1,
      clientAuthority: 'local',
      credentialRef: nextRef,
      nextAttemptAt: new Date(1),
    },
  ])
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let signalEntered!: () => void
  const entered = new Promise<void>((resolve) => {
    signalEntered = resolve
  })
  const holder = new ConnectionAuthorizationLease().runExclusive(
    revocationArtifactLeaseResource(oldestRef),
    async () => {
      signalEntered()
      await gate
    }
  )
  try {
    await entered
    const claimed = await new DbIntegrationRevocationRepository().claim(
      new Date(),
      new Date(Date.now() + 60_000),
      crypto.randomUUID()
    )
    expect(claimed?.credentialRef).toBe(nextRef)
  } finally {
    release()
    await holder
    await db
      .delete(integrationRevocationJobs)
      .where(inArray(integrationRevocationJobs.credentialRef, [oldestRef, nextRef]))
    await db.delete(secrets).where(inArray(secrets.key, [oldestRef, nextRef]))
  }
})

test('hosted projection emits zero material for a historical local Notion connection', async () => {
  const previousManaged = process.env.FICUS_MANAGED
  process.env.FICUS_MANAGED = '1'
  const [squad] = await db.insert(squads).values({ name: 'Authority projection', purpose: 'test' }).returning()
  const materialRevision = crypto.randomUUID()
  const [connection] = await db
    .insert(integrationConnections)
    .values({
      providerKey: 'notion',
      adapterVersion: 1,
      clientAuthority: 'local',
      displayName: 'Historical Notion',
      configuration: { version: 1, workspaceId: 'workspace', workspaceName: 'Workspace' },
      credentialRef: `test:notion:${crypto.randomUUID()}`,
      materialRevision,
      validatedRevision: materialRevision,
      enabled: true,
      authState: 'authenticated',
      healthState: 'healthy',
      validationExpiresAt: new Date(Date.now() + 60_000),
    })
    .returning()
  await db.insert(integrationConnectionAssignments).values({
    squadId: squad.id,
    providerKey: 'notion',
    connectionId: connection.id,
  })
  try {
    expect(await loadProtectedIntegrationBindings(squad.id)).toEqual([])
    expect(await resolveAssignedIntegrationRefs(squad.id)).toEqual({ skills: [], extensions: [] })
    expect(await loadEffectiveToolchain(squad.id, undefined)).toMatchObject({
      config: { packages: [] },
      initHooks: [],
      readiness: [],
    })
  } finally {
    if (previousManaged === undefined) delete process.env.FICUS_MANAGED
    else process.env.FICUS_MANAGED = previousManaged
    await db.delete(squads).where(eq(squads.id, squad.id))
    await db.delete(integrationConnections).where(eq(integrationConnections.id, connection.id))
  }
})

test('permits multiple enabled pool connections for one provider', async () => {
  const repository = new DbIntegrationConnectionRepository()
  const [first, second] = await Promise.all([repository.createPending(pending()), repository.createPending(pending())])
  try {
    const enable = (connection: typeof first) =>
      repository.enableValidated({
        id: connection.id,
        materialRevision: connection.materialRevision,
        validation: { ok: true, grantedScopes: ['vault:read'] },
        now: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      })
    expect(await Promise.all([enable(first), enable(second)])).toEqual([true, true])
    expect(await repository.list('bigbrain')).toHaveLength(2)
  } finally {
    await db.delete(integrationConnections).where(inArray(integrationConnections.id, [first.id, second.id]))
  }
})

for (const method of ['enableValidated', 'recordValidation'] as const) {
  test(`${method} schedules healthy revalidation before authorization expires`, async () => {
    const repository = new DbIntegrationConnectionRepository()
    const connection = await repository.createPending(pending())
    try {
      const now = new Date()
      const expiresAt = new Date(now.getTime() + 15 * 60_000)
      await repository.enableValidated({
        id: connection.id,
        materialRevision: connection.materialRevision,
        validation: { ok: true, grantedScopes: [] },
        now,
        expiresAt,
      })
      await repository[method]({
        id: connection.id,
        materialRevision: connection.materialRevision,
        validation: { ok: true, grantedScopes: [] },
        now,
        expiresAt,
      })
      expect(await repository.due(new Date(now.getTime() + 13 * 60_000 - 1), 1000)).not.toContainEqual({
        id: connection.id,
      })
      expect(await repository.due(new Date(now.getTime() + 13 * 60_000), 1000)).toContainEqual({ id: connection.id })
      expect((await repository.get(connection.id))?.validationExpiresAt).toEqual(expiresAt)
      await repository.recordValidation({
        id: connection.id,
        materialRevision: connection.materialRevision,
        validation: { ok: false, code: 'invalid_auth' },
        now,
        expiresAt,
      })
      expect(await repository.due(new Date(now.getTime() + 13 * 60_000), 1000)).not.toContainEqual({
        id: connection.id,
      })
      expect(await repository.due(expiresAt, 1000)).toContainEqual({ id: connection.id })
    } finally {
      await db.delete(integrationConnections).where(eq(integrationConnections.id, connection.id))
    }
  })
}
