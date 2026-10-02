import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import {
  db,
  integrationAuthorizationFlowReceipts,
  integrationConnections,
  integrationOauthStates,
  users,
} from '../../../db'
import { DbOAuthStateRepository } from './db-state-repository'

const repository = new DbOAuthStateRepository()
const prefix = crypto.randomUUID().slice(0, 8)
const initiatingUserId = crypto.randomUUID()
const otherUserId = crypto.randomUUID()
const connectionId = crypto.randomUUID()
const materialRevision = crypto.randomUUID()

function hash(character: string): string {
  return character.repeat(64)
}

beforeAll(async () => {
  await db.insert(users).values([
    { id: initiatingUserId, email: `${prefix}-initiator@example.com` },
    { id: otherUserId, email: `${prefix}-other@example.com` },
  ])
  await db.insert(integrationConnections).values({
    id: connectionId,
    providerKey: 'notion',
    adapterVersion: 1,
    displayName: `${prefix} Notion`,
    configuration: { version: 1, workspaceId: 'workspace' },
    credentialRef: `__integration-credential:${prefix}`,
    materialRevision,
  })
})

afterAll(async () => {
  await db
    .delete(integrationAuthorizationFlowReceipts)
    .where(eq(integrationAuthorizationFlowReceipts.initiatingUserId, initiatingUserId))
  await db.delete(integrationOauthStates).where(eq(integrationOauthStates.userId, initiatingUserId))
  await db.delete(integrationConnections).where(eq(integrationConnections.id, connectionId))
  await db.delete(users).where(eq(users.id, initiatingUserId))
  await db.delete(users).where(eq(users.id, otherUserId))
})

describe('DbOAuthStateRepository', () => {
  test('atomically consumes a state exactly once', async () => {
    await repository.create({
      stateHash: hash('a'),
      providerKey: 'notion',
      userId: initiatingUserId,
      intent: 'connect',
      connectionId: null,
      expectedMaterialRevision: null,
      redirectUri: 'https://ficus.example/settings/integrations/oauth/callback',
      returnTo: '/settings/integrations',
      expiresAt: new Date(Date.now() + 60_000),
    })

    const first = await repository.consume({
      stateHash: hash('a'),
      providerKey: 'notion',
      userId: initiatingUserId,
    })
    const replay = await repository.consume({
      stateHash: hash('a'),
      providerKey: 'notion',
      userId: initiatingUserId,
    })

    expect(first).toMatchObject({ intent: 'connect', returnTo: '/settings/integrations' })
    expect(replay).toBeNull()
  })

  test('wrong user and provider cannot consume or mutate server-owned reconnect intent', async () => {
    await repository.create({
      stateHash: hash('b'),
      providerKey: 'notion',
      userId: initiatingUserId,
      intent: 'reconnect',
      connectionId,
      expectedMaterialRevision: materialRevision,
      redirectUri: 'https://ficus.example/settings/integrations/oauth/callback',
      returnTo: '/settings/integrations',
      expiresAt: new Date(Date.now() + 60_000),
    })

    expect(await repository.consume({ stateHash: hash('b'), providerKey: 'notion', userId: otherUserId })).toBeNull()
    expect(
      await repository.consume({ stateHash: hash('b'), providerKey: 'bigbrain', userId: initiatingUserId })
    ).toBeNull()
    expect(
      await repository.consume({ stateHash: hash('b'), providerKey: 'notion', userId: initiatingUserId })
    ).toMatchObject({
      intent: 'reconnect',
      connectionId,
      expectedMaterialRevision: materialRevision,
    })
  })

  test('expired states fail closed without depending on cleanup', async () => {
    await repository.create({
      stateHash: hash('c'),
      providerKey: 'notion',
      userId: initiatingUserId,
      intent: 'connect',
      connectionId: null,
      expectedMaterialRevision: null,
      redirectUri: 'https://ficus.example/settings/integrations/oauth/callback',
      returnTo: '/settings/integrations',
      expiresAt: new Date(Date.now() - 1_000),
    })

    expect(
      await repository.consume({ stateHash: hash('c'), providerKey: 'notion', userId: initiatingUserId })
    ).toBeNull()
  })

  test('hosted flow claim binds the caller and creates one durable receipt', async () => {
    const localFlowId = crypto.randomUUID()
    const handleHash = hash('e')
    await repository.create({
      stateHash: hash('e'),
      localFlowId,
      authority: 'platform_broker',
      providerKey: 'notion',
      userId: initiatingUserId,
      intent: 'connect',
      connectionId: null,
      expectedMaterialRevision: null,
      redirectUri: 'https://ficus.example/settings/integrations/oauth/callback',
      returnTo: '/settings/integrations',
      expiresAt: new Date(Date.now() + 60_000),
    })
    const claim = (overrides: Partial<Parameters<typeof repository.claimByFlow>[0]> = {}) =>
      repository.claimByFlow({
        localFlowId,
        providerKey: 'notion',
        userId: initiatingUserId,
        authority: 'platform_broker',
        handleHash,
        ...overrides,
      })

    expect(await claim({ userId: otherUserId })).toBeNull()
    expect(await claim({ providerKey: 'bigbrain' })).toBeNull()
    expect(await claim({ authority: 'local' as never })).toBeNull()
    const claimed = await claim()
    expect(claimed).toMatchObject({ localFlowId, completionHandleHash: handleHash })
    expect(await claim({ handleHash: hash('f') })).toBeNull()

    const retries = await Promise.all(Array.from({ length: 8 }, () => claim()))
    expect(retries.filter(Boolean)).toHaveLength(8)
    expect(new Set(retries.map((row) => row?.recoveryExpiresAt?.getTime())).size).toBe(1)

    const receipts = await db
      .select()
      .from(integrationAuthorizationFlowReceipts)
      .where(eq(integrationAuthorizationFlowReceipts.localFlowId, localFlowId))
    expect(receipts).toHaveLength(1)
    expect(receipts[0]).toMatchObject({
      localFlowId,
      providerKey: 'notion',
      authority: 'platform_broker',
      initiatingUserId,
      completionHandleHash: handleHash,
      artifactCredentialRef: `__integration-credential:authorization-flow:${localFlowId}:bearer`,
    })
    expect(receipts[0]!.recoveryExpiresAt.getTime()).toBe(claimed!.recoveryExpiresAt!.getTime())
  })

  test('initially expired hosted flow fails closed using the database clock', async () => {
    const localFlowId = crypto.randomUUID()
    await repository.create({
      stateHash: hash('f'),
      localFlowId,
      authority: 'platform_broker',
      providerKey: 'notion',
      userId: initiatingUserId,
      intent: 'connect',
      connectionId: null,
      expectedMaterialRevision: null,
      redirectUri: 'https://ficus.example/settings/integrations/oauth/callback',
      returnTo: '/settings/integrations',
      expiresAt: new Date(Date.now() - 1_000),
    })

    expect(
      await repository.claimByFlow({
        localFlowId,
        providerKey: 'notion',
        userId: initiatingUserId,
        authority: 'platform_broker',
        handleHash: hash('f'),
      })
    ).toBeNull()
    expect(
      await db
        .select()
        .from(integrationAuthorizationFlowReceipts)
        .where(eq(integrationAuthorizationFlowReceipts.localFlowId, localFlowId))
    ).toHaveLength(0)
  })

  test('hosted coordinator finalization requires a compatible receipt disposition', async () => {
    const localFlowId = crypto.randomUUID()
    const handleHash = hash('9')
    await repository.create({
      stateHash: hash('9'),
      localFlowId,
      authority: 'platform_broker',
      providerKey: 'notion',
      userId: initiatingUserId,
      intent: 'connect',
      connectionId: null,
      expectedMaterialRevision: null,
      redirectUri: 'https://ficus.example/settings/integrations/oauth/callback',
      returnTo: '/settings',
      expiresAt: new Date(Date.now() + 60_000),
    })
    expect(
      await repository.claimByFlow({
        localFlowId,
        providerKey: 'notion',
        userId: initiatingUserId,
        authority: 'platform_broker',
        handleHash,
      })
    ).not.toBeNull()

    expect(await repository.finishByFlow({ localFlowId, handleHash })).toBe(false)
    await db
      .update(integrationAuthorizationFlowReceipts)
      .set({
        adapterVersion: 1,
        stagingStartedAt: new Date(),
        installKind: 'connect',
        installedConnectionId: crypto.randomUUID(),
        installedMaterialRevision: crypto.randomUUID(),
        installedAt: new Date(),
      })
      .where(eq(integrationAuthorizationFlowReceipts.localFlowId, localFlowId))
    expect(await repository.finishByFlow({ localFlowId, handleHash })).toBe(true)
    expect(await repository.flowExists(localFlowId)).toBe(false)
  })

  test('concurrent callbacks have exactly one winner', async () => {
    await repository.create({
      stateHash: hash('d'),
      providerKey: 'notion',
      userId: initiatingUserId,
      intent: 'connect',
      connectionId: null,
      expectedMaterialRevision: null,
      redirectUri: 'https://ficus.example/settings/integrations/oauth/callback',
      returnTo: '/settings/integrations',
      expiresAt: new Date(Date.now() + 60_000),
    })

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        repository.consume({ stateHash: hash('d'), providerKey: 'notion', userId: initiatingUserId })
      )
    )
    expect(results.filter(Boolean)).toHaveLength(1)
  })
})

test('personal purpose and unlink generation survive hosted claim and immutable recovery binding', async () => {
  const localFlowId = crypto.randomUUID()
  const stateHash = new Bun.CryptoHasher('sha256').update(localFlowId).digest('hex')
  await repository.create({
    stateHash,
    localFlowId,
    authority: 'platform_broker',
    providerKey: 'github',
    userId: initiatingUserId,
    purpose: 'github_identity',
    linkGeneration: 4,
    intent: 'connect',
    connectionId: null,
    expectedMaterialRevision: null,
    redirectUri: 'https://ficus.example/settings/integrations/oauth/callback',
    returnTo: '/settings',
    expiresAt: new Date(Date.now() + 60_000),
  })
  expect(
    await repository.claimByFlow({
      localFlowId,
      providerKey: 'github',
      userId: otherUserId,
      authority: 'platform_broker',
      handleHash: hash('f'),
    })
  ).toBeNull()
  const claimed = await repository.claimByFlow({
    localFlowId,
    providerKey: 'github',
    userId: initiatingUserId,
    authority: 'platform_broker',
    handleHash: hash('f'),
  })
  expect(claimed).toMatchObject({ purpose: 'github_identity', linkGeneration: 4, connectionId: null })
  const [receipt] = await db
    .select()
    .from(integrationAuthorizationFlowReceipts)
    .where(eq(integrationAuthorizationFlowReceipts.localFlowId, localFlowId))
  expect(receipt).toMatchObject({
    purpose: 'github_identity',
    linkGeneration: 4,
    installedConnectionId: null,
    initiatingUserId,
  })
  // Even an accidental integration installer cannot commit a connection result for personal purpose.
  await expect(
    db
      .update(integrationAuthorizationFlowReceipts)
      .set({
        installKind: 'connect',
        installedConnectionId: crypto.randomUUID(),
        installedMaterialRevision: crypto.randomUUID(),
        installedAt: new Date(),
        stagingStartedAt: new Date(),
        adapterVersion: 1,
      })
      .where(eq(integrationAuthorizationFlowReceipts.localFlowId, localFlowId))
      .execute()
  ).rejects.toMatchObject({ cause: expect.objectContaining({ code: '23514' }) })
  await expect(
    repository.create({
      stateHash: new Bun.CryptoHasher('sha256').update(crypto.randomUUID()).digest('hex'),
      providerKey: 'github',
      userId: initiatingUserId,
      purpose: 'github_identity',
      intent: 'connect',
      connectionId: null,
      expectedMaterialRevision: null,
      redirectUri: 'https://ficus.example/settings/integrations/oauth/callback',
      returnTo: '/settings',
      expiresAt: new Date(Date.now() + 60_000),
    })
  ).rejects.toMatchObject({ cause: expect.objectContaining({ code: '23514' }) })
})
