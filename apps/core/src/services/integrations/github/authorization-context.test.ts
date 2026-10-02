import { createHash } from 'node:crypto'
import { expect, test } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import { db } from '../../../db'
import {
  users,
  integrationOauthStates,
  integrationAuthorizationFlowReceipts,
  integrationDeviceAuthorizations,
} from '../../../db/schema'
import { DbOAuthStateRepository } from '../authorization/db-state-repository'

const context = await import('./authorization-context')

async function fixture(authority: 'local' | 'platform_broker' = 'local', personal = true) {
  const userId = crypto.randomUUID(),
    otherUserId = crypto.randomUUID(),
    id = crypto.randomUUID()
  const nonce = new Bun.CryptoHasher('sha256').update(id).digest('base64url')
  const stateHash = createHash('sha256')
    .update(authority === 'local' ? nonce : id)
    .digest('hex')
  const states = new DbOAuthStateRepository()
  await db.insert(users).values([userId, otherUserId].map((id) => ({ id, email: `${id}@purpose-context.test` })))
  await states.create({
    stateHash,
    localFlowId: authority === 'local' && !personal ? null : id,
    authority,
    providerKey: 'github',
    userId,
    purpose: personal ? 'github_identity' : 'integration',
    linkGeneration: personal ? 0 : null,
    intent: 'connect',
    connectionId: null,
    expectedMaterialRevision: null,
    redirectUri: 'https://ficus.test/callback',
    returnTo: '/settings',
    expiresAt: new Date(Date.now() + 60_000),
  })
  return {
    userId,
    otherUserId,
    id,
    nonce,
    stateHash,
    states,
    async close() {
      await db.delete(integrationOauthStates).where(eq(integrationOauthStates.stateHash, stateHash))
      await db
        .delete(integrationAuthorizationFlowReceipts)
        .where(eq(integrationAuthorizationFlowReceipts.localFlowId, id))
      await db.delete(users).where(inArray(users.id, [userId, otherUserId]))
    },
  }
}

test.each([true, false])('callback purpose resolves only owned local state/receipt, personal=%s', async (personal) => {
  expect(context.resolveStoredGitHubPurpose).toBeDefined()
  const h = await fixture('local', personal)
  try {
    const input = { providerKey: 'github', userId: h.userId, source: { kind: 'callback' as const, state: h.nonce } }
    expect(await context.resolveStoredGitHubPurpose(input)).toBe(personal ? 'github_identity' : 'integration')
    expect(await context.resolveStoredGitHubPurpose({ ...input, userId: h.otherUserId })).toBeNull()
    expect(await context.resolveStoredGitHubPurpose({ ...input, providerKey: 'notion' })).toBeNull()
    await h.states.consume({ stateHash: h.stateHash, providerKey: 'github', userId: h.userId })
    expect(await context.resolveStoredGitHubPurpose(input)).toBe(personal ? 'github_identity' : null)
    expect(
      await context.resolveStoredGitHubPurpose({ ...input, source: { kind: 'complete', localFlowId: h.id } })
    ).toBeNull()
  } finally {
    await h.close()
  }
})

test('hosted purpose resolves only self-owned hosted flow, including receipt replay after coordinator cleanup', async () => {
  expect(context.resolveStoredGitHubPurpose).toBeDefined()
  const h = await fixture('platform_broker')
  try {
    const input = { providerKey: 'github', userId: h.userId, source: { kind: 'complete' as const, localFlowId: h.id } }
    expect(await context.resolveStoredGitHubPurpose(input)).toBe('github_identity')
    expect(await context.resolveStoredGitHubPurpose({ ...input, userId: h.otherUserId })).toBeNull()
    await h.states.claimByFlow({
      localFlowId: h.id,
      providerKey: 'github',
      userId: h.userId,
      authority: 'platform_broker',
      handleHash: 'a'.repeat(64),
    })
    await db.delete(integrationOauthStates).where(eq(integrationOauthStates.stateHash, h.stateHash))
    expect(await context.resolveStoredGitHubPurpose(input)).toBe('github_identity')
  } finally {
    await h.close()
  }
})

test.each([true, false])(
  'device purpose is bound to both device and receipt owners before any secret read, personal=%s',
  async (personal) => {
    const h = await fixture('platform_broker', personal)
    try {
      await h.states.claimByFlow({
        localFlowId: h.id,
        providerKey: 'github',
        userId: h.userId,
        authority: 'platform_broker',
        handleHash: 'a'.repeat(64),
      })
      await db
        .update(integrationAuthorizationFlowReceipts)
        .set({ authority: 'local' })
        .where(eq(integrationAuthorizationFlowReceipts.localFlowId, h.id))
      const input = { providerKey: 'github', userId: h.userId, source: { kind: 'device' as const, id: h.id } }
      // A browser receipt must not be selectable as a device receipt.
      expect(await context.resolveStoredGitHubPurpose(input).catch(() => 'unsupported_source')).toBeNull()
      await db.insert(integrationDeviceAuthorizations).values({
        id: h.id,
        userId: h.userId,
        clientBinding: {},
        userCode: 'CODE',
        verificationUri: 'https://github.com/login/device',
        encryptedDeviceCode: 'INVALID_CIPHERTEXT_MUST_NOT_BE_READ',
        deviceCodeIv: 'INVALID_IV',
        intervalSeconds: 5,
        nextPollAt: new Date(),
        expiresAt: new Date(Date.now() + 60000),
      })
      expect(await context.resolveStoredGitHubPurpose(input)).toBe(personal ? 'github_identity' : 'integration')
      expect(await context.resolveStoredGitHubPurpose({ ...input, userId: h.otherUserId })).toBeNull()
      expect(await context.resolveStoredGitHubPurpose({ ...input, providerKey: 'notion' })).toBeNull()
      await db
        .update(integrationDeviceAuthorizations)
        .set({ userId: h.otherUserId })
        .where(eq(integrationDeviceAuthorizations.id, h.id))
      expect(await context.resolveStoredGitHubPurpose(input)).toBeNull()
      expect(await context.resolveStoredGitHubPurpose({ ...input, userId: h.otherUserId })).toBeNull()
    } finally {
      await h.close()
    }
  }
)
