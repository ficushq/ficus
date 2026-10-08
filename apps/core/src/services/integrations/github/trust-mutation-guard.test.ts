import { expect, test } from 'bun:test'
import { eq, inArray, or } from 'drizzle-orm'
import { db, setDatabaseQueryObserverForTest } from '../../../db'
import { integrationAuditEvents, roleAssignments, roles, squads, users } from '../../../db/schema'
import { beginGitHubIdentityLink, confirmGitHubIdentityProof, saveGitHubIdentityProof } from './personal-identity'
import { withGitHubTrustMutation } from './trust-mutation-guard'
import { resolveGitHubAuthorTrust } from './feedback-trust'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

test('link confirmation serializes before API RBAC effective snapshots even for unlinked subjects', async () => {
  const userId = crypto.randomUUID()
  const squadId = crypto.randomUUID()
  const roleId = crypto.randomUUID()
  const actor = { type: 'user', userId } as const
  await db.insert(users).values({ id: userId, email: `${userId}@authority-race.test` })
  await db.insert(squads).values({ id: squadId, name: 'Authority race', purpose: 'Test' })
  await db.insert(roles).values({ id: roleId, name: 'Authority race', slug: roleId, permissions: ['squads:update'] })
  const generation = await beginGitHubIdentityLink(actor)
  const proof = await saveGitHubIdentityProof({
    identity: actor,
    profile: { id: 12377, login: 'owner', type: 'User' },
    state: {
      purpose: 'github_identity',
      providerKey: 'github',
      intent: 'connect',
      userId,
      connectionId: null,
      expectedMaterialRevision: null,
      linkGeneration: generation,
      stateHash: '7'.repeat(64),
      expiresAt: new Date(Date.now() + 60000),
    } as Parameters<typeof saveGitHubIdentityProof>[0]['state'],
  })
  const entered = deferred<void>()
  const release = deferred<void>()
  const observedLock = deferred<'lock'>()
  let mutation: Promise<unknown> | undefined
  let confirmation: Promise<unknown> | undefined
  try {
    mutation = withGitHubTrustMutation(
      { type: 'agent', agentId: crypto.randomUUID(), squadId, userId },
      userId,
      async (tx) => {
        entered.resolve()
        await release.promise
        await tx
          .insert(roleAssignments)
          .values({ subjectType: 'user', subjectId: userId, scope: 'squad', squadId, roleId })
      }
    )
    await entered.promise
    setDatabaseQueryObserverForTest((query) => {
      if (query.includes('pg_advisory_xact_lock')) observedLock.resolve('lock')
    })
    confirmation = confirmGitHubIdentityProof(actor, proof.id)
    // Observes the actual DB query before lock acquisition, not a timing-based sleep.
    const first = await Promise.race([observedLock.promise, confirmation.then(() => 'confirmation' as const)])
    expect(first).toBe('lock')
    release.resolve()
    await mutation
    await confirmation
    expect(await resolveGitHubAuthorTrust(db, squadId, '12377')).toEqual([{ kind: 'linked_user', userId }])
  } finally {
    release.resolve()
    await Promise.allSettled([mutation, confirmation].filter(Boolean))
    setDatabaseQueryObserverForTest(undefined)
    await db
      .delete(integrationAuditEvents)
      .where(or(eq(integrationAuditEvents.userId, userId), eq(integrationAuditEvents.targetId, userId)))
    await db.delete(roleAssignments).where(eq(roleAssignments.subjectId, userId))
    await db.delete(users).where(eq(users.id, userId))
    await db.delete(roles).where(inArray(roles.id, [roleId]))
    await db.delete(squads).where(eq(squads.id, squadId))
  }
})
