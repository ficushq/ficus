import { expect, test } from 'bun:test'
import { Hono } from 'hono'
import { and, eq, inArray, or } from 'drizzle-orm'
import { createSquadSchema, updateSquadSchema } from '@ficus/shared'
import { db } from '../db'
import {
  agents,
  githubPersonalIdentities,
  integrationAuditEvents,
  roleAssignments,
  roles,
  squads,
  users,
} from '../db/schema'
import { Squad } from '../entities/Squad'
import { usersRouter } from './users'
import { rolesRouter } from './roles'
import { resolveGitHubAuthorTrust } from '../services/integrations/github/feedback-trust'
import type { Identity } from '../services/rbac/permissions'

async function fixture() {
  const adminId = crypto.randomUUID()
  const targetId = crypto.randomUUID()
  const agentId = crypto.randomUUID()
  const squadIds = [crypto.randomUUID(), crypto.randomUUID()]
  const adminRoleId = crypto.randomUUID()
  const roleId = crypto.randomUUID()
  const defaultRoleId = crypto.randomUUID()
  await db.insert(users).values([adminId, targetId].map((id) => ({ id, email: `${id}@trust-bypass.test` })))
  await db.insert(squads).values(squadIds.map((id) => ({ id, name: 'Bypass test', purpose: 'Test' })))
  await db.insert(roles).values([
    { id: adminRoleId, slug: adminRoleId, name: 'Admin test', permissions: ['*'] },
    { id: roleId, slug: roleId, name: 'Editable', permissions: ['squads:read'] },
    { id: defaultRoleId, slug: defaultRoleId, name: 'Default', permissions: ['squads:*'] },
  ])
  await db
    .insert(roleAssignments)
    .values({ subjectType: 'user', subjectId: adminId, roleId: adminRoleId, scope: 'system' })
  await db.insert(agents).values({
    id: agentId,
    agentTypeId: 'system-manager',
    ownerUserId: adminId,
    squadId: null,
    status: 'idle',
  })
  await db
    .insert(githubPersonalIdentities)
    .values({ userId: targetId, accountId: '8137', login: 'linked', linkedAt: new Date(), unlinkedAt: null })
  const appFor = (identity: Identity) => {
    const app = new Hono()
    app.use('*', async (c, next) => {
      c.set('identity', identity)
      await next()
    })
    app.route('/users', usersRouter)
    app.route('/roles', rolesRouter)
    return app
  }
  const agent = appFor({ type: 'agent', agentId, squadId: null, userId: adminId })
  const human = appFor({ type: 'user', userId: adminId })
  const request = (app: Hono, path: string, method: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  const assign = async (
    role = roleId,
    scope: 'system' | 'squad_default' | 'squad' = 'squad',
    squadId = squadIds[0]
  ) => {
    const [row] = await db
      .insert(roleAssignments)
      .values({
        subjectType: 'user',
        subjectId: targetId,
        roleId: role,
        scope,
        squadId: scope === 'squad' ? squadId : null,
      })
      .returning()
    return row!.id
  }
  return {
    adminId,
    targetId,
    agentId,
    squadIds,
    adminRoleId,
    roleId,
    defaultRoleId,
    agent,
    human,
    appFor,
    request,
    assign,
    async close() {
      await db
        .delete(integrationAuditEvents)
        .where(
          or(
            inArray(integrationAuditEvents.userId, [adminId, targetId]),
            inArray(integrationAuditEvents.targetId, [targetId, roleId, defaultRoleId, ...squadIds]),
            eq(integrationAuditEvents.actorKey, `agent:${agentId}`)
          )
        )
      await db.delete(agents).where(eq(agents.id, agentId))
      await db.delete(roleAssignments).where(inArray(roleAssignments.subjectId, [adminId, targetId]))
      await db.delete(users).where(inArray(users.id, [adminId, targetId]))
      await db.delete(roles).where(inArray(roles.id, [adminRoleId, roleId, defaultRoleId]))
      await db.delete(squads).where(inArray(squads.id, squadIds))
    },
  }
}

for (const metadata of [
  { githubAuthorTrust: null },
  { 'githubFeedbackModeration.allowAll': true },
  { nested: { githubPersonalIdentity: { accountId: '8137' } } },
])
  test(`reserved authority metadata is rejected: ${JSON.stringify(metadata)}`, async () => {
    expect(createSquadSchema.safeParse({ name: 'Test', metadata }).success).toBe(false)
    expect(updateSquadSchema.safeParse({ metadata }).success).toBe(false)
    await expect(Squad.update(crypto.randomUUID(), { metadata })).rejects.toThrow('Reserved GitHub authority metadata')
    await expect(Squad.create({ name: 'Test', purpose: 'Test', metadata })).rejects.toThrow(
      'Reserved GitHub authority metadata'
    )
  })

test('legitimate git-author metadata remains valid; rule approval hints are not authority', () => {
  expect(
    updateSquadSchema.safeParse({
      metadata: {
        githubIdentity: { gitUserName: 'Ficus', gitUserEmail: 'ficus@example.test' },
        ordinary: { note: 'ok' },
      },
    }).success
  ).toBe(true)
  expect(
    updateSquadSchema.safeParse({ metadata: { integrationRules: { github: [{ approved: true }] } } }).success
  ).toBe(false)
})

for (const scope of ['system', 'squad_default', 'squad'] as const)
  test(`agent cannot grant dynamic trust through ${scope} assignment`, async () => {
    const h = await fixture()
    try {
      const body = { roleId: h.defaultRoleId, scope, ...(scope === 'squad' ? { squadId: h.squadIds[0] } : {}) }
      expect((await h.request(h.agent, `/users/${h.targetId}/roles`, 'POST', body)).status).toBe(403)
      expect(await resolveGitHubAuthorTrust(db, h.squadIds[0], '8137')).toEqual([])
      expect((await h.request(h.human, `/users/${h.targetId}/roles`, 'POST', body)).status).toBe(201)
      expect(await resolveGitHubAuthorTrust(db, h.squadIds[0], '8137')).toHaveLength(1)
    } finally {
      await h.close()
    }
  })

test('role edits are effective-diff guarded, not a blanket ban on agent role tools', async () => {
  const h = await fixture()
  try {
    await h.assign()
    expect(
      (
        await h.request(h.agent, `/roles/${h.roleId}`, 'PUT', {
          name: 'Renamed',
          permissions: ['squads:read', 'agents:read'],
        })
      ).status
    ).toBe(200)
    expect((await h.request(h.agent, `/roles/${h.roleId}`, 'PUT', { permissions: ['squads:*'] })).status).toBe(403)
    expect((await db.select().from(roles).where(eq(roles.id, h.roleId)))[0]!.permissions).toEqual([
      'squads:read',
      'agents:read',
    ])
    expect((await h.request(h.human, `/roles/${h.roleId}`, 'PUT', { permissions: ['squads:*'] })).status).toBe(200)
    expect(
      (await h.request(h.agent, `/roles/${h.roleId}`, 'PUT', { permissions: ['squads:update', 'agents:read'] })).status
    ).toBe(200)
    expect((await h.request(h.agent, `/roles/${h.roleId}`, 'DELETE')).status).toBe(403)
    const audit = await db
      .select()
      .from(integrationAuditEvents)
      .where(
        and(eq(integrationAuditEvents.action, 'github.trust.authority'), eq(integrationAuditEvents.userId, h.adminId))
      )
    expect(audit.some((row) => row.outcome === 'allowed' && row.actorKey === `user:${h.adminId}`)).toBe(true)
  } finally {
    await h.close()
  }
})

for (const remove of ['assignment', 'role'] as const)
  test(`deleting ${remove} cannot reveal a trusted default`, async () => {
    const h = await fixture()
    try {
      await h.assign(h.defaultRoleId, 'squad_default')
      const id = await h.assign()
      const path = remove === 'assignment' ? `/users/${h.targetId}/roles/${id}` : `/roles/${h.roleId}`
      expect(await resolveGitHubAuthorTrust(db, h.squadIds[0], '8137')).toEqual([])
      expect((await h.request(h.agent, path, 'DELETE')).status).toBe(403)
      expect(await resolveGitHubAuthorTrust(db, h.squadIds[0], '8137')).toEqual([])
      expect((await h.request(h.human, path, 'DELETE')).status).toBe(204)
      expect(await resolveGitHubAuthorTrust(db, h.squadIds[0], '8137')).toHaveLength(1)
    } finally {
      await h.close()
    }
  })

for (const action of ['disable', 'enable', 'delete'] as const)
  test(`linked user ${action} cannot change trust as an agent`, async () => {
    const h = await fixture()
    try {
      await h.assign(h.defaultRoleId)
      if (action === 'enable') await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, h.targetId))
      expect(
        (
          await h.request(
            h.agent,
            `/users/${h.targetId}${action === 'delete' ? '' : `/${action}`}`,
            action === 'delete' ? 'DELETE' : 'PATCH'
          )
        ).status
      ).toBe(403)
    } finally {
      await h.close()
    }
  })

test('generic profile cannot install identity fields or agent-controlled recovery email', async () => {
  const h = await fixture()
  try {
    expect(
      (await h.request(h.agent, `/users/${h.targetId}`, 'PATCH', { email: 'attacker@trust-bypass.test' })).status
    ).toBe(403)
    expect(
      (await h.request(h.human, `/users/${h.targetId}`, 'PATCH', { githubPersonalIdentity: { accountId: '1' } })).status
    ).toBe(400)
    expect((await h.request(h.agent, `/users/${h.targetId}`, 'PATCH', { displayName: 'Ordinary' })).status).toBe(200)
  } finally {
    await h.close()
  }
})

test('agent invitation routes cannot return human registration credentials', async () => {
  const h = await fixture()
  try {
    expect((await h.request(h.agent, `/users/${h.targetId}/invite?delivery=link`, 'POST')).status).toBe(403)
    expect((await h.request(h.agent, `/users/${h.targetId}/invite`, 'POST')).status).toBe(403)
  } finally {
    await h.close()
  }
})

test('assignment deletion checks the URL subject instead of another user assignment', async () => {
  const h = await fixture()
  try {
    const id = await h.assign()
    expect((await h.request(h.human, `/users/${h.adminId}/roles/${id}`, 'DELETE')).status).toBe(404)
  } finally {
    await h.close()
  }
})

for (const kind of ['system', 'legacy'] as const)
  test(`${kind} cannot manufacture linked authority but retains unrelated RBAC tools`, async () => {
    const h = await fixture()
    try {
      await h.assign()
      const app = h.appFor(
        kind === 'system'
          ? { type: 'system', systemTokenId: crypto.randomUUID(), name: 'Test', scopes: ['*'] }
          : { type: 'legacy' }
      )
      expect((await h.request(app, `/roles/${h.roleId}`, 'PUT', { permissions: ['squads:update'] })).status).toBe(403)
      expect((await h.request(app, `/roles/${h.roleId}`, 'PUT', { name: 'Unrelated' })).status).toBe(200)
    } finally {
      await h.close()
    }
  })

test('human role editor without affected squad authority cannot alter dynamic trust', async () => {
  const h = await fixture()
  try {
    await h.assign()
    await db
      .update(roles)
      .set({ permissions: ['roles:update'] })
      .where(eq(roles.id, h.adminRoleId))
    expect((await h.request(h.human, `/roles/${h.roleId}`, 'PUT', { permissions: ['squads:update'] })).status).toBe(403)
    expect(await resolveGitHubAuthorTrust(db, h.squadIds[0], '8137')).toEqual([])
  } finally {
    await h.close()
  }
})

test('redundant grants, unrelated subjects and masked defaults retain automated admin capabilities', async () => {
  const h = await fixture()
  try {
    await h.assign(h.defaultRoleId)
    const redundant = await h.assign(h.adminRoleId)
    expect((await h.request(h.agent, `/users/${h.targetId}/roles/${redundant}`, 'DELETE')).status).toBe(204)
    // An override shields squad 0; the default write would alter squad 1, so it must fail.
    expect(
      (
        await h.request(h.agent, `/users/${h.targetId}/roles`, 'POST', {
          roleId: h.defaultRoleId,
          scope: 'squad_default',
        })
      ).status
    ).toBe(403)
    await h.assign(h.defaultRoleId, 'squad', h.squadIds[1])
    expect(
      (
        await h.request(h.agent, `/users/${h.targetId}/roles`, 'POST', {
          roleId: h.defaultRoleId,
          scope: 'squad_default',
        })
      ).status
    ).toBe(403)
    expect(
      (await h.request(h.agent, `/users/${h.targetId}/roles`, 'POST', { roleId: h.roleId, scope: 'squad_default' }))
        .status
    ).toBe(201)
    await db
      .update(githubPersonalIdentities)
      .set({ unlinkedAt: new Date() })
      .where(eq(githubPersonalIdentities.userId, h.targetId))
    expect((await h.request(h.agent, `/users/${h.targetId}/disable`, 'PATCH')).status).toBe(200)
  } finally {
    await h.close()
  }
})

test('automated user creation never returns registration credentials in no-email mode', async () => {
  const h = await fixture()
  const email = `${crypto.randomUUID()}@trust-invite.test`
  const oldSender = process.env.SES_FROM_ADDRESS
  delete process.env.SES_FROM_ADDRESS
  try {
    const response = await h.request(h.agent, '/users', 'POST', {
      email,
      assignments: [{ roleId: h.roleId, scope: 'system' }],
    })
    expect(response.status).toBe(201)
    const body = await response.json()
    expect(body.inviteUrl).toBeUndefined()
    expect(body.inviteCode).toBeUndefined()
    expect(body.inviteEmailFailed).toBe(true)
  } finally {
    if (oldSender === undefined) delete process.env.SES_FROM_ADDRESS
    else process.env.SES_FROM_ADDRESS = oldSender
    const found = await db.select().from(users).where(eq(users.email, email))
    for (const user of found) {
      await db.delete(roleAssignments).where(eq(roleAssignments.subjectId, user.id))
      await db.delete(users).where(eq(users.id, user.id))
    }
    await h.close()
  }
})

test('credential ownership changes on dynamically trusted users need human squad authority and literal audit', async () => {
  const h = await fixture()
  try {
    await h.assign(h.defaultRoleId)
    await db
      .update(roles)
      .set({ permissions: ['users:update', 'users:create'] })
      .where(eq(roles.id, h.adminRoleId))
    expect(
      (await h.request(h.human, `/users/${h.targetId}`, 'PATCH', { email: 'new-owner@trust-bypass.test' })).status
    ).toBe(403)
    expect((await h.request(h.human, `/users/${h.targetId}/invite?delivery=link`, 'POST')).status).toBe(403)
    expect(
      (await h.request(h.agent, `/users/${h.targetId}`, 'PATCH', { email: 'agent-owner@trust-bypass.test' })).status
    ).toBe(403)
    const denied = await db
      .select()
      .from(integrationAuditEvents)
      .where(eq(integrationAuditEvents.actorKey, `agent:${h.agentId}`))
    expect(denied.some((row) => row.outcome === 'denied' && row.userId === null)).toBe(true)
  } finally {
    await h.close()
  }
})

test('real delegated bearer authentication cannot reach metadata, RBAC or human credential authority', async () => {
  const h = await fixture()
  const { identityMiddleware } = await import('../middleware/identity')
  const { squadsRouter } = await import('./squads')
  const { authRouter } = await import('./auth')
  const { createTestAgentToken } = await import('../test-utils/rbac')
  const token = await createTestAgentToken({ agentId: h.agentId, squadId: null, userId: h.adminId })
  const app = new Hono()
  app.use('*', identityMiddleware)
  app.route('/users', usersRouter)
  app.route('/roles', rolesRouter)
  app.route('/squads', squadsRouter)
  app.route('/auth', authRouter)
  const request = (path: string, method: string, body: unknown = {}) =>
    app.request(path, {
      method,
      headers: { Authorization: `Bearer ${token.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  try {
    expect(
      (await request(`/squads/${h.squadIds[0]}`, 'PATCH', { metadata: { 'githubAuthorTrust.allowAll': true } })).status
    ).toBe(400)
    expect((await request('/squads', 'POST', { name: 'Bypass', metadata: { githubAuthorTrust: null } })).status).toBe(
      400
    )
    expect(
      (await request(`/users/${h.targetId}/roles`, 'POST', { roleId: h.defaultRoleId, scope: 'system' })).status
    ).toBe(403)
    expect((await request('/auth/me/credentials/options', 'POST', { userId: h.adminId })).status).toBe(400)
    expect((await request('/auth/ws-ticket', 'POST', { userId: h.adminId })).status).toBe(400)
    expect(await resolveGitHubAuthorTrust(db, h.squadIds[0], '8137')).toEqual([])
  } finally {
    await h.close()
  }
})

test('a scoped human retains exact-squad authority without gaining other squads or future defaults', async () => {
  const h = await fixture()
  try {
    await db
      .update(roles)
      .set({ permissions: ['users:update'] })
      .where(eq(roles.id, h.adminRoleId))
    await db
      .update(roles)
      .set({ permissions: ['squads:update'] })
      .where(eq(roles.id, h.defaultRoleId))
    await db.insert(roleAssignments).values({
      subjectType: 'user',
      subjectId: h.adminId,
      roleId: h.defaultRoleId,
      scope: 'squad',
      squadId: h.squadIds[0],
    })
    expect(
      (
        await h.request(h.human, `/users/${h.targetId}/roles`, 'POST', {
          roleId: h.defaultRoleId,
          scope: 'squad',
          squadId: h.squadIds[0],
        })
      ).status
    ).toBe(201)
    expect(
      (
        await h.request(h.human, `/users/${h.targetId}/roles`, 'POST', {
          roleId: h.defaultRoleId,
          scope: 'squad',
          squadId: h.squadIds[1],
        })
      ).status
    ).toBe(403)
    expect(
      (
        await h.request(h.human, `/users/${h.targetId}/roles`, 'POST', {
          roleId: h.defaultRoleId,
          scope: 'squad_default',
        })
      ).status
    ).toBe(403)
    expect(await resolveGitHubAuthorTrust(db, h.squadIds[0], '8137')).toHaveLength(1)
    expect(await resolveGitHubAuthorTrust(db, h.squadIds[1], '8137')).toEqual([])
  } finally {
    await h.close()
  }
})

test('a human self-deletion retains scalar trust audit after actor FK removal', async () => {
  const h = await fixture()
  try {
    await h.assign(h.adminRoleId, 'system')
    const self = h.appFor({ type: 'user', userId: h.targetId })
    expect((await h.request(self, `/users/${h.targetId}`, 'DELETE')).status).toBe(204)
    const audit = await db
      .select()
      .from(integrationAuditEvents)
      .where(eq(integrationAuditEvents.actorKey, `user:${h.targetId}`))
    expect(audit.some((row) => row.outcome === 'allowed' && row.userId === null && row.targetId === h.targetId)).toBe(
      true
    )
  } finally {
    await h.close()
  }
})

test('automation cannot mint a person who arrives able to update squads, nor grant that role to one who lacks it', async () => {
  const h = await fixture()
  const email = `${crypto.randomUUID()}@trust-mint.test`
  const freshId = crypto.randomUUID()
  await db.insert(users).values({ id: freshId, email: `${freshId}@trust-mint.test` })
  try {
    // Creating a person with a squads:* role is a trust grant: human only.
    const minted = await h.request(h.agent, '/users', 'POST', {
      email,
      assignments: [{ roleId: h.defaultRoleId, scope: 'system' }],
    })
    expect(minted.status).toBe(403)
    expect(await db.select().from(users).where(eq(users.email, email))).toEqual([])
    // Granting squads:update to an unlinked person who does not hold it yet: human only.
    expect(
      (await h.request(h.agent, `/users/${freshId}/roles`, 'POST', { roleId: h.defaultRoleId, scope: 'system' })).status
    ).toBe(403)
    // A redundant grant (already effectively held) stays available to automation.
    await db
      .insert(roleAssignments)
      .values({ subjectType: 'user', subjectId: freshId, roleId: h.adminRoleId, scope: 'system' })
    expect(
      (await h.request(h.agent, `/users/${freshId}/roles`, 'POST', { roleId: h.defaultRoleId, scope: 'system' })).status
    ).toBe(201)
    // Roles without squads:update are unaffected, and a human can do all of it.
    expect(
      (await h.request(h.agent, `/users/${freshId}/roles`, 'POST', { roleId: h.roleId, scope: 'system' })).status
    ).toBe(201)
    const human = await h.request(h.human, '/users', 'POST', {
      email,
      assignments: [{ roleId: h.defaultRoleId, scope: 'system' }],
    })
    expect(human.status).toBe(201)
    const denied = await db
      .select()
      .from(integrationAuditEvents)
      .where(and(eq(integrationAuditEvents.outcome, 'denied'), eq(integrationAuditEvents.code, 'human_required')))
    expect(denied.some((row) => row.targetId === email)).toBe(true)
    expect(denied.some((row) => row.targetId === freshId)).toBe(true)
  } finally {
    const created = await db.select().from(users).where(eq(users.email, email))
    for (const user of created) {
      await db.delete(roleAssignments).where(eq(roleAssignments.subjectId, user.id))
      await db.delete(users).where(eq(users.id, user.id))
    }
    await db.delete(integrationAuditEvents).where(inArray(integrationAuditEvents.targetId, [email, freshId]))
    await db.delete(roleAssignments).where(eq(roleAssignments.subjectId, freshId))
    await db.delete(users).where(eq(users.id, freshId))
    await h.close()
  }
})
