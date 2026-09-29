import { createHash } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { eq, inArray, sql } from 'drizzle-orm'
import {
  db,
  integrationAuthorizationFlowReceipts,
  integrationConnections,
  integrationCredentialCleanupJobs,
  integrationOauthStates,
  integrationRevocationJobs,
  secrets,
  users,
} from '../../../db'
import { DbOAuthStateRepository } from './db-state-repository'
import { ConnectionAuthorizationLease } from './connection-lease'
import {
  authorizationCredentialReference,
  DbAuthorizationFlowReceiptRepository,
  deleteSettledAuthorizationReceipts,
  sweepExpiredAuthorizationFlows,
} from './flow-repository'

const userId = crypto.randomUUID()
const createdFlowIds = new Set<string>()
const states = new DbOAuthStateRepository()
const receipts = new DbAuthorizationFlowReceiptRepository()

function hash(character: string): string {
  return character.repeat(64)
}

async function createClaimedFlow(localFlowId: string = crypto.randomUUID()): Promise<string> {
  createdFlowIds.add(localFlowId)
  await states.create({
    stateHash: createHash('sha256').update(localFlowId).digest('hex'),
    localFlowId,
    authority: 'platform_broker',
    providerKey: 'notion',
    userId,
    intent: 'connect',
    connectionId: null,
    expectedMaterialRevision: null,
    redirectUri: 'https://ficus.example/settings/integrations/oauth/callback',
    returnTo: '/settings',
    expiresAt: new Date(Date.now() + 60_000),
  })
  const claimed = await states.claimByFlow({
    localFlowId,
    providerKey: 'notion',
    userId,
    authority: 'platform_broker',
    handleHash: hash('a'),
  })
  expect(claimed).not.toBeNull()
  return localFlowId
}

beforeAll(async () => {
  await db.insert(users).values({ id: userId, email: `flow-${userId}@example.com` })
})

afterEach(async () => {
  const flowIds = [...createdFlowIds]
  for (const localFlowId of flowIds) {
    await db.delete(integrationRevocationJobs).where(eq(integrationRevocationJobs.authorizationFlowId, localFlowId))
    await db
      .delete(integrationCredentialCleanupJobs)
      .where(eq(integrationCredentialCleanupJobs.authorizationFlowId, localFlowId))
    await db.delete(secrets).where(eq(secrets.key, authorizationCredentialReference(localFlowId)))
    await db.delete(integrationOauthStates).where(eq(integrationOauthStates.localFlowId, localFlowId))
    await db
      .delete(integrationAuthorizationFlowReceipts)
      .where(eq(integrationAuthorizationFlowReceipts.localFlowId, localFlowId))
  }
  createdFlowIds.clear()
})
afterAll(async () => {
  await db.delete(users).where(eq(users.id, userId))
})

describe('authorization flow receipts', () => {
  test('flow fixtures with a shared UUID prefix have distinct state hashes', async () => {
    const first = crypto.randomUUID()
    const second = first[0] + crypto.randomUUID().slice(1)
    expect(second).not.toBe(first)
    await createClaimedFlow(first)
    await createClaimedFlow(second)
    const rows = await db
      .select()
      .from(integrationOauthStates)
      .where(inArray(integrationOauthStates.localFlowId, [first, second]))
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map((row) => row.stateHash)).size).toBe(2)
  })

  test('recovery eligibility is decided by the database clock', async () => {
    const localFlowId = await createClaimedFlow()
    expect(await receipts.getRecoverable(localFlowId)).not.toBeNull()
    await db
      .update(integrationAuthorizationFlowReceipts)
      .set({ recoveryExpiresAt: new Date(Date.now() - 1_000), retainUntil: new Date(Date.now() - 1_000) })
      .where(eq(integrationAuthorizationFlowReceipts.localFlowId, localFlowId))
    expect(await receipts.getRecoverable(localFlowId)).toBeNull()
  })

  test('an admitted staging act continues after expiry while the sweeper respects its flow lease', async () => {
    const localFlowId = await createClaimedFlow()
    expect(await receipts.beginStaging(localFlowId, 1)).not.toBeNull()
    await db
      .update(integrationAuthorizationFlowReceipts)
      .set({ recoveryExpiresAt: new Date('2000-01-01T00:00:00.000Z') })
      .where(eq(integrationAuthorizationFlowReceipts.localFlowId, localFlowId))
    const lease = new ConnectionAuthorizationLease()
    await lease.runExclusive(`flow:${localFlowId}`, async () => {
      expect(await receipts.beginStaging(localFlowId, 1)).not.toBeNull()
      await sweepExpiredAuthorizationFlows()
      expect(await receipts.get(localFlowId)).toMatchObject({ terminalAt: null, revocationRequiredAt: null })
    })
    await sweepExpiredAuthorizationFlows()
    expect(await receipts.get(localFlowId)).toMatchObject({
      terminalCode: 'flow_expired',
      terminalAt: expect.any(Date),
    })
  })

  test('staging and terminal dispositions are monotonic', async () => {
    const localFlowId = await createClaimedFlow()
    const staged = await receipts.beginStaging(localFlowId, 1)
    expect(staged).toMatchObject({
      localFlowId,
      adapterVersion: 1,
      stagingStartedAt: expect.any(Date),
      terminalAt: null,
    })
    expect(await receipts.beginStaging(localFlowId, 2)).toBeNull()
    expect(await receipts.markTerminal(localFlowId, 'grant_abandoned')).toBeNull()

    const abandoned = await receipts.requireRevocation({ localFlowId, adapterVersion: 1, code: 'grant_abandoned' })
    expect(abandoned).toMatchObject({
      terminalCode: 'grant_abandoned',
      revocationRequiredAt: expect.any(Date),
      revocationSettledAt: expect.any(Date),
      cleanupSettledAt: expect.any(Date),
    })
    expect(await receipts.beginStaging(localFlowId, 1)).toBeNull()
    expect((await receipts.requireRevocation({ localFlowId, adapterVersion: 1, code: 'other' }))?.terminalCode).toBe(
      'grant_abandoned'
    )
  })

  test('cleanup ownership facts are write-once across retries', async () => {
    const localFlowId = await createClaimedFlow()
    const staged = await receipts.beginStaging(localFlowId, 1)
    await db.insert(secrets).values({ key: staged!.artifactCredentialRef, encryptedValue: 'ciphertext', iv: 'iv' })
    const first = await receipts.requireCleanup(localFlowId, 'grant_abandoned')
    await Bun.sleep(5)
    const replay = await receipts.requireCleanup(localFlowId, 'ignored')
    expect(replay?.terminalCode).toBe('grant_abandoned')
    expect(replay?.terminalAt).toEqual(first?.terminalAt)
    expect(replay?.cleanupRequiredAt).toEqual(first?.cleanupRequiredAt)
  })

  test('revocation obligation queries the authoritative secret row and enqueues once', async () => {
    const localFlowId = await createClaimedFlow()
    const staged = await receipts.beginStaging(localFlowId, 1)
    await db.insert(secrets).values({ key: staged!.artifactCredentialRef, encryptedValue: 'ciphertext', iv: 'iv' })

    await receipts.requireRevocation({ localFlowId, adapterVersion: 1, code: 'grant_abandoned' })
    await receipts.requireRevocation({ localFlowId, adapterVersion: 1, code: 'ignored' })

    const jobs = await db
      .select()
      .from(integrationRevocationJobs)
      .where(eq(integrationRevocationJobs.authorizationFlowId, localFlowId))
    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({ clientAuthority: 'platform_broker', credentialRef: staged!.artifactCredentialRef })
    expect((await receipts.get(localFlowId))?.revocationSettledAt).toBeNull()
  })

  test('expired staged flow becomes terminal and preserves its cleanup obligation', async () => {
    const localFlowId = await createClaimedFlow()
    const staged = await receipts.beginStaging(localFlowId, 1)
    await db.insert(secrets).values({ key: staged!.artifactCredentialRef, encryptedValue: 'ciphertext', iv: 'iv' })
    await db
      .update(integrationAuthorizationFlowReceipts)
      .set({ recoveryExpiresAt: new Date(Date.now() - 1_000), retainUntil: new Date(Date.now() + 60_000) })
      .where(eq(integrationAuthorizationFlowReceipts.localFlowId, localFlowId))

    await sweepExpiredAuthorizationFlows()

    expect(await receipts.get(localFlowId)).toMatchObject({
      terminalCode: 'flow_expired',
      revocationRequiredAt: expect.any(Date),
    })
    expect(
      await db
        .select()
        .from(integrationRevocationJobs)
        .where(eq(integrationRevocationJobs.authorizationFlowId, localFlowId))
    ).toHaveLength(1)
  })

  test('more than 100 referenced receipts cannot starve a deletable receipt', async () => {
    const blockerIds = Array.from({ length: 101 }, () => crypto.randomUUID())
    const blockerRefs = blockerIds.map((id) => `__integration-credential:authorization-flow:${id}:bearer`)
    const connectionIds = blockerIds.map(() => crypto.randomUUID())
    const eligibleId = await createClaimedFlow()
    await db
      .update(integrationAuthorizationFlowReceipts)
      .set({
        terminalCode: 'flow_expired',
        terminalAt: sql`now()`,
        recoveryExpiresAt: sql`now() - interval '2 days'`,
        retainUntil: sql`now() - interval '1 day'`,
      })
      .where(eq(integrationAuthorizationFlowReceipts.localFlowId, eligibleId))
    await db.insert(secrets).values(blockerRefs.map((key) => ({ key, encryptedValue: 'ciphertext', iv: 'iv' })))
    await db.insert(integrationAuthorizationFlowReceipts).values(
      blockerIds.map((localFlowId, index) => ({
        localFlowId,
        providerKey: 'notion',
        authority: 'platform_broker' as const,
        intent: 'connect' as const,
        initiatingUserId: crypto.randomUUID(),
        returnTo: '/settings',
        completionHandleHash: 'd'.repeat(64),
        artifactCredentialRef: blockerRefs[index]!,
        adapterVersion: 1,
        stagingStartedAt: new Date(),
        installKind: 'connect' as const,
        installedConnectionId: connectionIds[index]!,
        installedMaterialRevision: crypto.randomUUID(),
        installedAt: new Date(),
        recoveryExpiresAt: new Date('2000-01-01T00:00:00.000Z'),
        retainUntil: new Date('2000-01-01T00:00:00.000Z'),
      }))
    )
    await db.insert(integrationConnections).values(
      blockerIds.map((authorizationFlowId, index) => ({
        id: connectionIds[index]!,
        providerKey: 'notion',
        adapterVersion: 1,
        clientAuthority: 'platform_broker',
        authorizationFlowId,
        displayName: `Referenced receipt ${crypto.randomUUID()}`,
        configuration: { version: 1 },
        credentialRef: blockerRefs[index]!,
        materialRevision: crypto.randomUUID(),
      }))
    )
    try {
      expect(await deleteSettledAuthorizationReceipts()).toBe(1)
      expect(await receipts.get(eligibleId)).toBeNull()
      expect(await receipts.get(blockerIds[0]!)).not.toBeNull()
    } finally {
      await db.delete(integrationConnections).where(inArray(integrationConnections.id, connectionIds))
      await db
        .delete(integrationAuthorizationFlowReceipts)
        .where(inArray(integrationAuthorizationFlowReceipts.localFlowId, blockerIds))
      await db.delete(secrets).where(inArray(secrets.key, blockerRefs))
    }
  })

  test('settled receipts are deleted only after their retention window', async () => {
    const localFlowId = await createClaimedFlow()
    const expired = new Date(Date.now() - 1_000)
    await db
      .update(integrationAuthorizationFlowReceipts)
      .set({
        terminalCode: 'completion_not_found',
        terminalAt: new Date(),
        recoveryExpiresAt: expired,
        retainUntil: expired,
      })
      .where(eq(integrationAuthorizationFlowReceipts.localFlowId, localFlowId))
    expect(await deleteSettledAuthorizationReceipts()).toBe(1)
    expect(await receipts.get(localFlowId)).toBeNull()
  })
})
