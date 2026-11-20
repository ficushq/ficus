import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db, integrationAuthorizationFlowReceipts, integrationOauthStates, users } from '../../../db'
import { DbOAuthStateRepository } from './db-state-repository'
import { resolveAuthorizationFlowProvider } from './flow-provider'

const repository = new DbOAuthStateRepository()
const prefix = crypto.randomUUID().slice(0, 8)
const userId = crypto.randomUUID()
const otherUserId = crypto.randomUUID()

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function opaque(character: string): string {
  return character.repeat(43)
}

async function createBrokerFlow(input: {
  providerKey: string
  purpose?: 'integration' | 'linear_identity'
  stateCharacter: string
}): Promise<string> {
  const localFlowId = crypto.randomUUID()
  await repository.create({
    stateHash: sha256(opaque(input.stateCharacter)),
    localFlowId,
    authority: 'platform_broker',
    providerKey: input.providerKey,
    userId,
    intent: 'connect',
    ...(input.purpose ? { purpose: input.purpose } : {}),
    connectionId: null,
    expectedMaterialRevision: null,
    redirectUri: 'https://platform.example/api/oauth-broker/callback',
    returnTo: '/settings',
    expiresAt: new Date(Date.now() + 60_000),
  })
  return localFlowId
}

beforeAll(async () => {
  await db.insert(users).values([
    { id: userId, email: `${prefix}-flow-provider@example.com` },
    { id: otherUserId, email: `${prefix}-flow-provider-other@example.com` },
  ])
})

afterAll(async () => {
  await db
    .delete(integrationAuthorizationFlowReceipts)
    .where(eq(integrationAuthorizationFlowReceipts.initiatingUserId, userId))
  await db.delete(integrationOauthStates).where(eq(integrationOauthStates.userId, userId))
  await db.delete(users).where(eq(users.id, userId))
  await db.delete(users).where(eq(users.id, otherUserId))
})

describe('resolveAuthorizationFlowProvider', () => {
  test('a hosted Linear app install started elsewhere resolves to linear, which the notion completion cannot claim', async () => {
    const localFlowId = await createBrokerFlow({ providerKey: 'linear', stateCharacter: 'a' })

    expect(await resolveAuthorizationFlowProvider({ userId, source: { kind: 'complete', localFlowId } })).toBe('linear')
    // The failure Noah saw: with no hint the page posted this flow to the notion completion, whose
    // provider-bound claim finds nothing, so Core answered with the terminal invalid_or_expired_state.
    const claim = (providerKey: string) =>
      repository.claimByFlow({
        localFlowId,
        providerKey,
        userId,
        authority: 'platform_broker',
        handleHash: sha256(opaque('h')),
      })
    expect(await claim('notion')).toBeNull()
    expect(await claim('linear')).toMatchObject({ providerKey: 'linear', localFlowId })
  })

  test('Linear account linking and other shared-callback providers resolve from their own flows', async () => {
    const identity = await createBrokerFlow({ providerKey: 'linear', purpose: 'linear_identity', stateCharacter: 'b' })
    const notion = await createBrokerFlow({ providerKey: 'notion', stateCharacter: 'c' })
    const slack = await createBrokerFlow({ providerKey: 'slack', stateCharacter: 'd' })

    for (const [localFlowId, provider] of [
      [identity, 'linear'],
      [notion, 'notion'],
      [slack, 'slack'],
    ] as const) {
      expect(await resolveAuthorizationFlowProvider({ userId, source: { kind: 'complete', localFlowId } })).toBe(
        provider
      )
    }
  })

  test("another person's flow, an unknown flow and a malformed flow ID resolve to nothing", async () => {
    const localFlowId = await createBrokerFlow({ providerKey: 'linear', stateCharacter: 'e' })

    expect(
      await resolveAuthorizationFlowProvider({ userId: otherUserId, source: { kind: 'complete', localFlowId } })
    ).toBeNull()
    expect(
      await resolveAuthorizationFlowProvider({
        userId,
        source: { kind: 'complete', localFlowId: crypto.randomUUID() },
      })
    ).toBeNull()
    expect(
      await resolveAuthorizationFlowProvider({ userId, source: { kind: 'complete', localFlowId: 'not-a-uuid' } })
    ).toBeNull()
  })

  test('a self-hosted callback resolves from its state, and a broker flow state is not a local callback', async () => {
    const state = opaque('f')
    await repository.create({
      stateHash: sha256(state),
      providerKey: 'slack',
      userId,
      intent: 'connect',
      connectionId: null,
      expectedMaterialRevision: null,
      redirectUri: 'https://ficus.example/settings/integrations/oauth/callback',
      returnTo: '/settings',
      expiresAt: new Date(Date.now() + 60_000),
    })

    expect(await resolveAuthorizationFlowProvider({ userId, source: { kind: 'callback', state } })).toBe('slack')
    expect(
      await resolveAuthorizationFlowProvider({ userId: otherUserId, source: { kind: 'callback', state } })
    ).toBeNull()
    expect(await resolveAuthorizationFlowProvider({ userId, source: { kind: 'callback', state: 'short' } })).toBeNull()
    // Broker flows are only ever completed by flow ID.
    expect(
      await resolveAuthorizationFlowProvider({ userId, source: { kind: 'callback', state: opaque('a') } })
    ).toBeNull()
  })

  test('a hosted flow whose state is gone still resolves from its receipt, so a reload after completion works', async () => {
    const localFlowId = crypto.randomUUID()
    await db.insert(integrationAuthorizationFlowReceipts).values({
      localFlowId,
      providerKey: 'linear',
      authority: 'platform_broker',
      intent: 'connect',
      initiatingUserId: userId,
      returnTo: '/settings',
      completionHandleHash: sha256(opaque('g')),
      artifactCredentialRef: `__integration-credential:authorization-flow:${localFlowId}:bearer`,
      recoveryExpiresAt: new Date(Date.now() + 60_000),
      retainUntil: new Date(Date.now() + 60_000),
    })

    expect(await resolveAuthorizationFlowProvider({ userId, source: { kind: 'complete', localFlowId } })).toBe('linear')
    expect(
      await resolveAuthorizationFlowProvider({ userId: otherUserId, source: { kind: 'complete', localFlowId } })
    ).toBeNull()
  })
})
