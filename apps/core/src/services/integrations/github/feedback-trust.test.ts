import { expect, test } from 'bun:test'
import { and, eq, inArray, or } from 'drizzle-orm'
import { db } from '../../../db'
import {
  githubPersonalIdentities,
  githubTrustedAuthors,
  integrationAuditEvents,
  roleAssignments,
  roles,
  squads,
  users,
} from '../../../db/schema'
import { hasPermission } from '../../rbac/permissions'
import type { Identity } from '../../rbac/permissions'

import * as service from './feedback-trust'

async function fixture() {
  const userId = crypto.randomUUID()
  const readerId = crypto.randomUUID()
  const squadIds = [crypto.randomUUID(), crypto.randomUUID()]
  const roleId = crypto.randomUUID()
  await db.transaction(async (tx) => {
    await tx.insert(users).values([userId, readerId].map((id) => ({ id, email: `${id}@feedback.test` })))
    await tx.insert(squads).values(squadIds.map((id) => ({ id, name: 'Trust test', purpose: 'Test' })))
    await tx.insert(roles).values({ id: roleId, slug: roleId, name: 'Scoped human', permissions: ['squads:update'] })
    await tx
      .insert(roleAssignments)
      .values({ subjectType: 'user', subjectId: userId, roleId, scope: 'squad', squadId: squadIds[0] })
  })
  return {
    userId,
    readerId,
    squadIds,
    roleId,
    human: { type: 'user', userId } as const,
    async close() {
      await db
        .delete(integrationAuditEvents)
        .where(
          or(
            inArray(integrationAuditEvents.userId, [userId, readerId]),
            and(eq(integrationAuditEvents.targetKind, 'squad'), inArray(integrationAuditEvents.targetId, squadIds))
          )
        )
      await db.delete(roleAssignments).where(inArray(roleAssignments.subjectId, [userId, readerId]))
      await db.delete(roles).where(eq(roles.id, roleId))
      await db.delete(squads).where(inArray(squads.id, squadIds))
      await db.delete(users).where(inArray(users.id, [userId, readerId]))
    },
  }
}

const resolver = async () => ({ id: 303, login: 'approved[bot]', type: 'Bot' })

test('delegated agents, system tokens, legacy and missing identities cannot mutate trust', async () => {
  expect(service?.addManualGitHubTrust).toBeDefined()
  const h = await fixture()
  try {
    const nonHumans: Array<Identity | undefined> = [
      { type: 'agent', agentId: crypto.randomUUID(), squadId: h.squadIds[0], userId: h.userId },
      { type: 'system', systemTokenId: crypto.randomUUID(), name: 'admin', scopes: ['*'] },
      { type: 'legacy' },
      undefined,
    ]
    for (const identity of nonHumans) {
      await expect(
        service!.addManualGitHubTrust(identity, h.squadIds[0], 'approved[bot]', resolver)
      ).rejects.toMatchObject({ status: 403 })
    }
    expect(
      await db.select().from(githubTrustedAuthors).where(eq(githubTrustedAuthors.squadId, h.squadIds[0]))
    ).toHaveLength(0)
    const denied = await db
      .select()
      .from(integrationAuditEvents)
      .where(eq(integrationAuditEvents.targetId, h.squadIds[0]))
    expect(denied).toHaveLength(nonHumans.length)
    expect(denied.every((row) => row.outcome === 'denied' && row.actorKey !== `user:${h.userId}`)).toBe(true)
  } finally {
    await h.close()
  }
})

test('manual bot trust is squad-local, provider-resolved, audited and human-only to remove', async () => {
  expect(service?.addManualGitHubTrust).toBeDefined()
  const h = await fixture()
  try {
    const result = await service!.addManualGitHubTrust(h.human, h.squadIds[0], 'approved[bot]', resolver)
    expect(result).toMatchObject({ accountId: '303', accountType: 'Bot' })
    expect(await service!.resolveGitHubAuthorTrust(db, h.squadIds[0], '303')).toEqual([
      { kind: 'manual', addedByUserId: h.userId },
    ])
    expect(await service!.resolveGitHubAuthorTrust(db, h.squadIds[1], '303')).toEqual([])
    const audit = await db.select().from(integrationAuditEvents).where(eq(integrationAuditEvents.userId, h.userId))
    expect(audit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'github.trust.add',
          targetKind: 'github_account',
          targetId: '303',
          outcome: 'allowed',
        }),
      ])
    )
    await expect(
      service!.removeManualGitHubTrust(
        { type: 'agent', agentId: crypto.randomUUID(), squadId: h.squadIds[0], userId: h.userId },
        h.squadIds[0],
        '303'
      )
    ).rejects.toMatchObject({ status: 403 })
    await service!.removeManualGitHubTrust(h.human, h.squadIds[0], '303')
    expect(await service!.resolveGitHubAuthorTrust(db, h.squadIds[0], '303')).toEqual([])
  } finally {
    await h.close()
  }
})

test('linked humans require fresh effective squad update; unlink, disable and revocation take effect immediately', async () => {
  expect(service?.resolveGitHubAuthorTrust).toBeDefined()
  const h = await fixture()
  try {
    await db.insert(githubPersonalIdentities).values([
      { userId: h.userId, accountId: '101', login: 'alice' },
      { userId: h.readerId, accountId: '202', login: 'reader' },
    ])
    expect(await service!.resolveGitHubAuthorTrust(db, h.squadIds[0], '202')).toEqual([])
    expect(await service!.resolveGitHubAuthorTrust(db, h.squadIds[1], '101')).toEqual([])
    expect(await service!.resolveGitHubAuthorTrust(db, h.squadIds[0], '101')).toEqual([
      { kind: 'linked_user', userId: h.userId },
    ])
    await db
      .update(githubPersonalIdentities)
      .set({ login: 'renamed' })
      .where(eq(githubPersonalIdentities.userId, h.userId))
    expect(await service!.resolveGitHubAuthorTrust(db, h.squadIds[0], '101')).toHaveLength(1)
    expect(await service!.resolveGitHubAuthorTrust(db, h.squadIds[0], '999')).toEqual([])
    // Prime the ordinary permission cache; trust must not consult it.
    expect(await hasPermission(h.human, 'squads:update', h.squadIds[0])).toBe(true)
    await db.update(roles).set({ permissions: [] }).where(eq(roles.id, h.roleId))
    expect(await service!.resolveGitHubAuthorTrust(db, h.squadIds[0], '101')).toEqual([])
    await db
      .update(roles)
      .set({ permissions: ['squads:update'] })
      .where(eq(roles.id, h.roleId))
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, h.userId))
    expect(await service!.resolveGitHubAuthorTrust(db, h.squadIds[0], '101')).toEqual([])
    await expect(
      service!.addManualGitHubTrust(h.human, h.squadIds[0], 'approved[bot]', resolver)
    ).rejects.toMatchObject({ status: 403 })
    await db.update(users).set({ disabledAt: null }).where(eq(users.id, h.userId))
    await db
      .update(githubPersonalIdentities)
      .set({ unlinkedAt: new Date() })
      .where(eq(githubPersonalIdentities.userId, h.userId))
    expect(await service!.resolveGitHubAuthorTrust(db, h.squadIds[0], '101')).toEqual([])
  } finally {
    await h.close()
  }
})

test('removing manual trust preserves independent linked-user trust origins', async () => {
  expect(service?.removeManualGitHubTrust).toBeDefined()
  const h = await fixture()
  try {
    await db.insert(githubPersonalIdentities).values({ userId: h.userId, accountId: '101', login: 'alice' })
    await service!.addManualGitHubTrust(h.human, h.squadIds[0], 'alice', async () => ({
      id: 101,
      login: 'alice',
      type: 'User',
    }))
    expect(await service!.resolveGitHubAuthorTrust(db, h.squadIds[0], '101')).toHaveLength(2)
    expect(await service!.removeManualGitHubTrust(h.human, h.squadIds[0], '101')).toEqual([
      { kind: 'linked_user', userId: h.userId },
    ])
  } finally {
    await h.close()
  }
})

test('permissionless and wrong-squad humans cannot mutate trust, even for linked accounts', async () => {
  expect(service?.addManualGitHubTrust).toBeDefined()
  const h = await fixture()
  try {
    await expect(
      service!.addManualGitHubTrust({ type: 'user', userId: h.readerId }, h.squadIds[0], 'approved[bot]', resolver)
    ).rejects.toMatchObject({ status: 403 })
    await expect(
      service!.addManualGitHubTrust(h.human, h.squadIds[1], 'approved[bot]', resolver)
    ).rejects.toMatchObject({ status: 403 })
    expect(
      await db
        .select()
        .from(githubTrustedAuthors)
        .where(and(eq(githubTrustedAuthors.squadId, h.squadIds[0]), eq(githubTrustedAuthors.accountId, '303')))
    ).toHaveLength(0)
  } finally {
    await h.close()
  }
})

test('provider lookup rejects organizations, ghost, spoofed and imprecise numeric identities', async () => {
  expect(service?.parseGitHubAccount).toBeDefined()
  for (const profile of [
    { id: 1, login: 'org', type: 'Organization' },
    { id: -1, login: 'ghost', type: 'User' },
    { id: '123', login: 'alice', type: 'User' },
    { id: 9007199254740992, login: 'alice', type: 'User' },
    { id: 123, login: '../evil', type: 'User' },
    { login: 'alice', type: 'User' },
  ])
    expect(service!.parseGitHubAccount(profile)).toBeNull()
  expect(service!.parseGitHubAccount({ id: 123, login: 'renamed', type: 'User' })).toEqual({
    accountId: '123',
    login: 'renamed',
    accountType: 'User',
  })
})

test('a permission revoked during provider resolution cannot become a stale manual grant', async () => {
  const h = await fixture()
  try {
    await expect(
      service.addManualGitHubTrust(h.human, h.squadIds[0], 'approved[bot]', async () => {
        await db.update(roles).set({ permissions: [] }).where(eq(roles.id, h.roleId))
        return resolver()
      })
    ).rejects.toMatchObject({ status: 403, code: 'squad_update_required' })
    expect(await service.resolveGitHubAuthorTrust(db, h.squadIds[0], '303')).toEqual([])
  } finally {
    await h.close()
  }
})
