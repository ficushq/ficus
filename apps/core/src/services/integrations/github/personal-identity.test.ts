import { expect, test } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import { db } from '../../../db'
import { githubIdentityProofs, githubPersonalIdentities, integrationAuditEvents, users } from '../../../db/schema'
import type { OAuthStateRecord } from '../authorization/state-repository'

import * as service from './personal-identity'

async function fixture() {
  const userIds = [crypto.randomUUID(), crypto.randomUUID()]
  await db.insert(users).values(userIds.map((id) => ({ id, email: `${id}@personal-github.test` })))
  const humans = userIds.map((userId) => ({ type: 'user' as const, userId }))
  return {
    userIds,
    humans,
    state(index: number, generation: number): OAuthStateRecord {
      return {
        stateHash: new Bun.CryptoHasher('sha256').update(crypto.randomUUID()).digest('hex'),
        localFlowId: null,
        authority: 'local',
        completionHandleHash: null,
        recoveryExpiresAt: null,
        providerKey: 'github',
        userId: userIds[index],
        purpose: 'github_identity',
        linkGeneration: generation,
        intent: 'connect',
        connectionId: null,
        expectedMaterialRevision: null,
        redirectUri: 'https://ficus.test/callback',
        returnTo: '/settings',
        expiresAt: new Date(Date.now() + 60_000),
        createdAt: new Date(),
      }
    },
    async close() {
      await db.delete(integrationAuditEvents).where(inArray(integrationAuditEvents.userId, userIds))
      await db.delete(users).where(inArray(users.id, userIds))
    },
  }
}
const profile = { id: 101, login: 'alice', type: 'User' }

test('ordinary humans can confirm fresh personal proof without integration or squad administration', async () => {
  expect(service.beginGitHubIdentityLink).toBeDefined()
  const h = await fixture()
  try {
    const generation = await service.beginGitHubIdentityLink(h.humans[0])
    expect(generation).toBe(0)
    expect(await service.getGitHubPersonalIdentity(h.humans[0])).toBeNull()
    const proof = await service.saveGitHubIdentityProof({
      identity: h.humans[0],
      state: h.state(0, generation),
      profile,
    })
    expect(proof).toMatchObject({ accountId: '101', login: 'alice' })
    expect(await service.confirmGitHubIdentityProof(h.humans[0], proof.id)).toMatchObject({
      accountId: '101',
      login: 'alice',
    })
    await expect(service.confirmGitHubIdentityProof(h.humans[0], proof.id)).rejects.toMatchObject({ status: 409 })
    const [row] = await db.select().from(githubIdentityProofs).where(eq(githubIdentityProofs.id, proof.id))
    expect(row?.consumedAt).not.toBeNull()
  } finally {
    await h.close()
  }
})

test('unlink fences pending proof confirmation and late callback before any first link', async () => {
  expect(service.beginGitHubIdentityLink).toBeDefined()
  const h = await fixture()
  try {
    const generation = await service.beginGitHubIdentityLink(h.humans[0])
    const state = h.state(0, generation)
    const proof = await service.saveGitHubIdentityProof({ identity: h.humans[0], state, profile })
    await service.unlinkGitHubIdentity(h.humans[0])
    await expect(service.confirmGitHubIdentityProof(h.humans[0], proof.id)).rejects.toMatchObject({ status: 409 })
    await expect(
      service.saveGitHubIdentityProof({ identity: h.humans[0], state: h.state(0, generation), profile })
    ).rejects.toMatchObject({ status: 409 })
    expect(await service.getGitHubPersonalIdentity(h.humans[0])).toBeNull()
    expect(await service.beginGitHubIdentityLink(h.humans[0])).toBe(1)
  } finally {
    await h.close()
  }
})

test('personal proof is self-only, expires by database time, and never accepts integration-purpose state', async () => {
  expect(service.beginGitHubIdentityLink).toBeDefined()
  const h = await fixture()
  try {
    const generation = await service.beginGitHubIdentityLink(h.humans[0])
    const proof = await service.saveGitHubIdentityProof({
      identity: h.humans[0],
      state: h.state(0, generation),
      profile,
    })
    await expect(service.confirmGitHubIdentityProof(h.humans[1], proof.id)).rejects.toMatchObject({ status: 409 })
    await db
      .update(githubIdentityProofs)
      .set({ verifiedAt: new Date(Date.now() - 120_000), expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(githubIdentityProofs.id, proof.id))
    await expect(service.confirmGitHubIdentityProof(h.humans[0], proof.id)).rejects.toMatchObject({ status: 409 })
    await expect(
      service.saveGitHubIdentityProof({
        identity: h.humans[0],
        state: { ...h.state(0, generation), purpose: 'integration', linkGeneration: null },
        profile,
      })
    ).rejects.toMatchObject({ status: 409 })
  } finally {
    await h.close()
  }
})

test('two concurrent human confirmations cannot transfer one stable GitHub account', async () => {
  expect(service.beginGitHubIdentityLink).toBeDefined()
  const h = await fixture()
  try {
    const generations = await Promise.all(h.humans.map((human) => service.beginGitHubIdentityLink(human)))
    const proofs = await Promise.all(
      h.humans.map((identity, index) =>
        service.saveGitHubIdentityProof({ identity, state: h.state(index, generations[index]!), profile })
      )
    )
    const results = await Promise.allSettled(
      h.humans.map((identity, index) => service.confirmGitHubIdentityProof(identity, proofs[index]!.id))
    )
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    const links = await db.select().from(githubPersonalIdentities).where(eq(githubPersonalIdentities.accountId, '101'))
    expect(links).toHaveLength(1)
  } finally {
    await h.close()
  }
})

test('delegated agents cannot begin, confirm, unlink, or inspect personal proofs', async () => {
  expect(service.beginGitHubIdentityLink).toBeDefined()
  const h = await fixture()
  try {
    const identity = { type: 'agent' as const, agentId: crypto.randomUUID(), squadId: null, userId: h.userIds[0] }
    await expect(service.beginGitHubIdentityLink(identity)).rejects.toMatchObject({ status: 403 })
    await expect(service.confirmGitHubIdentityProof(identity, crypto.randomUUID())).rejects.toMatchObject({
      status: 403,
    })
    await expect(service.unlinkGitHubIdentity(identity)).rejects.toMatchObject({ status: 403 })
    await expect(service.getGitHubPersonalIdentity(identity)).rejects.toMatchObject({ status: 403 })
  } finally {
    await h.close()
  }
})
