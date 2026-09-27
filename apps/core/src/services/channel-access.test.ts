import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import {
  db,
  channelIdentityLinks,
  channelLinkChallenges,
  channelInstances,
  squads,
  users,
  roleAssignments,
} from '../db'
import { ChannelInstance } from '../entities/ChannelInstance'
import {
  startChannelLink,
  claimChannelLink,
  confirmChannelLink,
  canUseChannel,
  channelLinkReply,
  parseTrustedChannelIds,
} from './channel-access'
import { createTestUser, createTestRole, assignRole, cleanupTestRbac, type TestUser } from '../test-utils'

const prefix = `channel-access-${crypto.randomUUID()}`
let user: TestUser
let other: TestUser
let instance: ChannelInstance
let squadId: string
let secondSquad: string
let assignmentId: string
beforeAll(async () => {
  user = await createTestUser({ prefix })
  other = await createTestUser({ prefix })
  const [squad, another] = await db
    .insert(squads)
    .values([
      { name: prefix, purpose: 'test' },
      { name: prefix + '-other', purpose: 'test' },
    ])
    .returning()
  squadId = squad.id
  secondSquad = another.id
  instance = await ChannelInstance.create({
    id: prefix,
    provider: 'slack',
    name: prefix,
    providerConfig: { teamId: prefix },
    defaultSquadId: squadId,
  })
  const role = await createTestRole({ prefix, permissions: ['chat:send'] })
  const assignment = await assignRole({ userId: user.id, roleId: role.id, scope: 'squad', squadId })
  assignmentId = assignment
})
afterAll(async () => {
  await db.delete(channelInstances).where(eq(channelInstances.id, prefix))
  if (squadId) await db.delete(squads).where(eq(squads.id, squadId))
  if (secondSquad) await db.delete(squads).where(eq(squads.id, secondSquad))
  await cleanupTestRbac(prefix)
})

describe('channel identity proof and authorization', () => {
  test('requires both external proof and Ficus confirmation; enforces squad scope', async () => {
    expect(await canUseChannel(instance, 'C1', 'U1', squadId)).toBe(false)
    const challenge = await startChannelLink(user.id)
    await expect(confirmChannelLink(user.id, challenge.id)).rejects.toThrow()
    expect(await claimChannelLink(instance.id, 'U1', 'Alice', challenge.code)).toBe(true)
    expect(await canUseChannel(instance, 'C1', 'U1', squadId)).toBe(false)
    await expect(confirmChannelLink(other.id, challenge.id)).rejects.toThrow()
    await confirmChannelLink(user.id, challenge.id)
    expect(await canUseChannel(instance, 'C1', 'U1', squadId)).toBe(true)
    expect(await canUseChannel(instance, 'C1', 'U1', secondSquad)).toBe(false)
    await expect(confirmChannelLink(user.id, challenge.id)).rejects.toThrow()
    expect(await claimChannelLink(instance.id, 'attacker', 'Alice', challenge.code)).toBe(false)
  })
  test('cannot steal an already-linked external account', async () => {
    const challenge = await startChannelLink(other.id)
    await claimChannelLink(instance.id, 'U1', 'Alice', challenge.code)
    await expect(confirmChannelLink(other.id, challenge.id)).rejects.toThrow('already linked')
    const [link] = await db.select().from(channelIdentityLinks).where(eq(channelIdentityLinks.externalUserId, 'U1'))
    expect(link.userId).toBe(user.id)
  })
  test('expiry prevents claiming and confirmation', async () => {
    const challenge = await startChannelLink(user.id)
    await db
      .update(channelLinkChallenges)
      .set({ expiresAt: new Date(0) })
      .where(eq(channelLinkChallenges.id, challenge.id))
    expect(await claimChannelLink(instance.id, 'expired', 'Alice', challenge.code)).toBe(false)
    await expect(confirmChannelLink(user.id, challenge.id)).rejects.toThrow()
  })
  test('a code can be claimed by only one external sender, including concurrent claims', async () => {
    const challenge = await startChannelLink(user.id)
    const results = await Promise.all(
      ['U2', 'U3'].map((sender) => claimChannelLink(instance.id, sender, sender, challenge.code))
    )
    expect(results.filter(Boolean)).toHaveLength(1)
    const [row] = await db.select().from(channelLinkChallenges).where(eq(channelLinkChallenges.id, challenge.id))
    expect(row.tokenHash).not.toBe(challenge.code)
    await confirmChannelLink(user.id, challenge.id)
  })
  test('links are bound to the provider instance, not just display name or external ID', async () => {
    const otherInstance = new ChannelInstance({ ...instance, id: 'different-instance' })
    expect(await canUseChannel(otherInstance, 'C1', 'U1', squadId)).toBe(false)
    expect(await canUseChannel(instance, 'C1', 'Alice', squadId)).toBe(false)
  })
  test('changing the workspace invalidates links and pending proofs even if the connection ID is reused', async () => {
    const challenge = await startChannelLink(user.id)
    await claimChannelLink(instance.id, 'pending', 'Alice', challenge.code)
    const original = instance.providerConfig
    try {
      await instance.update({ providerConfig: { teamId: 'replacement-workspace' } })
      expect(await canUseChannel(instance, 'C1', 'U1', squadId)).toBe(false)
      await expect(confirmChannelLink(user.id, challenge.id)).rejects.toThrow('connection changed')
    } finally {
      await instance.update({ providerConfig: original })
    }
  })
  test('disabling the user takes effect without a permission-cache refresh', async () => {
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, user.id))
    try {
      expect(await canUseChannel(instance, 'C1', 'U1', squadId)).toBe(false)
    } finally {
      await db.update(users).set({ disabledAt: null }).where(eq(users.id, user.id))
    }
  })
  test('unlinked users may act only in explicitly trusted channels; disabled connections deny everyone', async () => {
    const trusted = new ChannelInstance({ ...instance, trustedChannelIds: ['C-trusted'] })
    expect(await canUseChannel(trusted, 'C-trusted', 'unknown', squadId)).toBe(true)
    expect(await canUseChannel(trusted, 'C-other', 'unknown', squadId)).toBe(false)
    trusted.deniedChannelIds = ['C-trusted']
    expect(await canUseChannel(trusted, 'C-trusted', 'unknown', squadId)).toBe(false)
    trusted.deniedChannelIds = []
    trusted.allowedChannelIds = ['C-other']
    expect(await canUseChannel(trusted, 'C-trusted', 'unknown', squadId)).toBe(false)
    trusted.disabled = true
    expect(await canUseChannel(trusted, 'C-trusted', 'unknown', squadId)).toBe(false)
    expect(await canUseChannel(trusted, 'C-other', 'U1', squadId)).toBe(false)
  })
  test('permission revocation takes effect on the next message', async () => {
    await db.delete(roleAssignments).where(eq(roleAssignments.id, assignmentId))
    expect(await canUseChannel(instance, 'C1', 'U1', squadId)).toBe(false)
  })
  test('unlink removes external access', async () => {
    await db
      .delete(channelIdentityLinks)
      .where(and(eq(channelIdentityLinks.userId, user.id), eq(channelIdentityLinks.externalUserId, 'U1')))
    expect(await canUseChannel(instance, 'C1', 'U1', squadId)).toBe(false)
  })
  test('rejects blanket trust and malformed lists', () => {
    for (const value of ['C1', ['*'], [' * '], [''], [null], {}]) expect(() => parseTrustedChannelIds(value)).toThrow()
    expect(parseTrustedChannelIds([' C1 ', 'C1'])).toEqual(['C1'])
  })
})

describe('link command text', () => {
  test('a bot-mention link command (@Ficus link <code>) claims the proof', async () => {
    const linker = await createTestUser({ prefix })
    const challenge = await startChannelLink(linker.id)
    expect(
      await channelLinkReply(instance, { id: 'U-mention', name: 'Mention' }, `@Ficus link ${challenge.code}`)
    ).toStartWith('Account verified.')
  })
})
