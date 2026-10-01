import { describe, it, expect, beforeAll, afterAll, spyOn } from 'bun:test'
import { Hono } from 'hono'
import { usersRouter } from './users'
import { identityMiddleware } from '../middleware/identity'
import {
  createTestAdmin,
  createTestUser,
  createTestRole,
  createTestCredential,
  assignRole,
  authHeaders,
  cleanupTestRbac,
} from '../test-utils'
import { db } from '../db'
import { emailVerifications, roleAssignments, squads, users } from '../db/schema'
import { eq, inArray, like } from 'drizzle-orm'
import type { TestUser } from '../test-utils/rbac'
import * as onboardingEvents from '../services/onboarding/events'
import { eventEmitter } from '../lib/infra/event-emitter'

const app = new Hono()
app.use('*', identityMiddleware)
app.route('/api/users', usersRouter)

const prefix = `users-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

let admin: TestUser

beforeAll(async () => {
  // canonicalAdmin: true so last-admin checks (slug='admin') detect this user
  admin = await createTestAdmin({ prefix, canonicalAdmin: true })
})

afterAll(async () => {
  await cleanupTestRbac(prefix)
})

describe('Security: POST /api/users/:id/roles privilege-escalation guard', () => {
  it('a user-manager without "*" cannot self-assign an admin (*) role', async () => {
    const pfx = `${prefix}-escal`
    const manager = await createTestUser({ prefix: pfx })
    const mgrRole = await createTestRole({ permissions: ['users:read', 'users:update'], prefix: pfx })
    await assignRole({ userId: manager.id, roleId: mgrRole.id, scope: 'system' })
    const adminRole = await createTestRole({ permissions: ['*'], prefix: `${pfx}-adminrole` })
    try {
      const res = await app.request(`/api/users/${manager.id}/roles`, {
        method: 'POST',
        headers: { ...authHeaders(manager.token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ roleId: adminRole.id, scope: 'system' }),
      })
      expect(res.status).toBe(403)
      const body = await res.json()
      expect(body.error).toContain('Cannot grant permissions you do not hold')
    } finally {
      await cleanupTestRbac(`${pfx}-adminrole`)
      await cleanupTestRbac(pfx)
    }
  })

  it('admin can still grant any role', async () => {
    const pfx = `${prefix}-escal-ok`
    const target = await createTestUser({ prefix: pfx })
    const role = await createTestRole({ permissions: ['users:read'], prefix: pfx })
    try {
      const res = await app.request(`/api/users/${target.id}/roles`, {
        method: 'POST',
        headers: { ...authHeaders(admin.token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ roleId: role.id, scope: 'system' }),
      })
      expect(res.status).toBe(201)
    } finally {
      await cleanupTestRbac(pfx)
    }
  })

  it('returns 404 when the target user does not exist', async () => {
    const pfx = `${prefix}-orphan`
    const role = await createTestRole({ permissions: ['users:read'], prefix: pfx })
    try {
      const res = await app.request(`/api/users/00000000-0000-0000-0000-000000000000/roles`, {
        method: 'POST',
        headers: { ...authHeaders(admin.token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ roleId: role.id, scope: 'system' }),
      })
      expect(res.status).toBe(404)
    } finally {
      await cleanupTestRbac(pfx)
    }
  })
})

describe('POST /api/users guard uses users:create', () => {
  it('allows a non-admin holding users:create to invite', async () => {
    const pfx = `${prefix}-invite`
    const inviter = await createTestUser({ prefix: pfx })
    const role = await createTestRole({ permissions: ['users:create'], prefix: pfx })
    await assignRole({ userId: inviter.id, roleId: role.id, scope: 'system' })
    try {
      const res = await app.request('/api/users', {
        method: 'POST',
        headers: { ...authHeaders(inviter.token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: `${pfx}-new@test.local`, displayName: 'Invited' }),
      })
      expect(res.status).toBe(201)
    } finally {
      await cleanupTestRbac(pfx)
    }
  })

  it('returns a one-time invite code when email is not configured', async () => {
    const pfx = `${prefix}-invitecode`
    const priorFrom = process.env.SES_FROM_ADDRESS
    delete process.env.SES_FROM_ADDRESS
    try {
      const res = await app.request('/api/users', {
        method: 'POST',
        headers: { ...authHeaders(admin.token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: `${pfx}-new@test.local`, displayName: 'Invited' }),
      })
      expect(res.status).toBe(201)
      const body = await res.json()
      expect(body.inviteCode).toMatch(/^\d{6}$/)
    } finally {
      if (priorFrom === undefined) delete process.env.SES_FROM_ADDRESS
      else process.env.SES_FROM_ADDRESS = priorFrom
      await cleanupTestRbac(pfx)
    }
  })

  it('notifies onboarding (invite_users signal) when a new user is created', async () => {
    const pfx = `${prefix}-notify`
    const spy = spyOn(onboardingEvents, 'notifyOnboardingChanged')
    try {
      const res = await app.request('/api/users', {
        method: 'POST',
        headers: { ...authHeaders(admin.token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: `${pfx}-new@test.local`, displayName: 'Invited' }),
      })
      expect(res.status).toBe(201)
      expect(spy).toHaveBeenCalledTimes(1)
    } finally {
      spy.mockRestore()
      await cleanupTestRbac(pfx)
    }
  })
})

describe('GET /api/users', () => {
  it('lists users for admin', async () => {
    const res = await app.request('/api/users', {
      headers: authHeaders(admin.token),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body)).toBe(true)
    expect(body.some((u: any) => u.id === admin.id)).toBe(true)
  })

  it('denies access without users:read', async () => {
    const user = await createTestUser({ prefix })
    const res = await app.request('/api/users', {
      headers: authHeaders(user.token),
    })
    expect(res.status).toBe(403)
  })
})

describe('GET /api/users onboarding state', () => {
  /**
   * The list is the only place an admin can see WHO actually arrived, so these
   * cover both sides of the invited-vs-joined split plus the join fan-out that
   * would otherwise inflate the count.
   *
   * Not asserted here: that it stays ONE query. postgres-js only exposes its
   * `debug` hook at connection-construction time and the suite shares a single
   * pooled handle, so query count isn't observable from a route test — the
   * single-statement shape is enforced by User.findAllWithOnboarding itself.
   */
  const listEntry = async (userId: string) => {
    const res = await app.request('/api/users', { headers: authHeaders(admin.token) })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any[]
    return body.find((u) => u.id === userId)
  }

  it('reports a user with no passkey as not set up', async () => {
    const pfx = `${prefix}-invited`
    const invitee = await createTestUser({ prefix: pfx })
    try {
      const entry = await listEntry(invitee.id)
      expect(entry).toBeDefined()
      expect(entry.hasPasskey).toBe(false)
      expect(entry.passkeyCount).toBe(0)
    } finally {
      await cleanupTestRbac(pfx)
    }
  })

  it('marks system admins so a pending admin invite can be handled differently', async () => {
    const pfx = `${prefix}-pending-admin`
    const pendingAdmin = await createTestAdmin({ prefix: pfx, canonicalAdmin: true })
    const invitee = await createTestUser({ prefix: pfx })
    try {
      expect((await listEntry(pendingAdmin.id)).isAdmin).toBe(true)
      expect((await listEntry(invitee.id)).isAdmin).toBe(false)
    } finally {
      await cleanupTestRbac(pfx)
    }
  })

  it('reports a user with a passkey as set up', async () => {
    const pfx = `${prefix}-joined`
    const joined = await createTestUser({ prefix: pfx })
    await createTestCredential({ userId: joined.id })
    try {
      const entry = await listEntry(joined.id)
      expect(entry.hasPasskey).toBe(true)
      expect(entry.passkeyCount).toBe(1)
    } finally {
      await cleanupTestRbac(pfx)
    }
  })

  it('counts each passkey once even when the user also has outstanding challenges', async () => {
    const pfx = `${prefix}-fanout`
    const user = await createTestUser({ prefix: pfx })
    await createTestCredential({ userId: user.id })
    await createTestCredential({ userId: user.id })
    await db.insert(emailVerifications).values([
      { email: user.email.toLowerCase(), code: 'hash-a', expiresAt: new Date(Date.now() + 60_000) },
      { email: user.email.toLowerCase(), code: 'hash-b', expiresAt: new Date(Date.now() + 120_000) },
    ])
    try {
      const entry = await listEntry(user.id)
      // Two credentials × two challenges would be 4 with a naive count.
      expect(entry.passkeyCount).toBe(2)
    } finally {
      await db.delete(emailVerifications).where(like(emailVerifications.email, `${pfx}%`))
      await cleanupTestRbac(pfx)
    }
  })

  it('surfaces an outstanding invite expiry without leaking the challenge', async () => {
    const pfx = `${prefix}-pending`
    const invitee = await createTestUser({ prefix: pfx })
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    await db.insert(emailVerifications).values({
      // Invites store the address lowercased; the user row keeps its own case.
      email: invitee.email.toLowerCase(),
      code: 'super-secret-code-hash',
      tokenHash: `token-hash-${pfx}`,
      expiresAt,
    })
    try {
      const entry = await listEntry(invitee.id)
      expect(entry.hasPasskey).toBe(false)
      expect(new Date(entry.inviteExpiresAt).getTime()).toBe(expiresAt.getTime())
      // Booleans, counts and timestamps only — no code, hash or token ever.
      expect(Object.keys(entry).sort()).toEqual(
        [
          'createdAt',
          'disabledAt',
          'displayName',
          'email',
          'hasPasskey',
          'id',
          'inviteExpiresAt',
          'isAdmin',
          'passkeyCount',
          'updatedAt',
        ].sort()
      )
      expect(JSON.stringify(entry)).not.toContain('super-secret-code-hash')
      expect(JSON.stringify(entry)).not.toContain(`token-hash-${pfx}`)
    } finally {
      await db.delete(emailVerifications).where(like(emailVerifications.email, `${pfx}%`))
      await cleanupTestRbac(pfx)
    }
  })

  it('reports no outstanding invite once the challenge is consumed', async () => {
    const pfx = `${prefix}-consumed`
    const invitee = await createTestUser({ prefix: pfx })
    await db.insert(emailVerifications).values({
      email: invitee.email.toLowerCase(),
      code: 'used-code-hash',
      expiresAt: new Date(Date.now() + 60_000),
      usedAt: new Date(),
    })
    try {
      const entry = await listEntry(invitee.id)
      expect(entry.inviteExpiresAt).toBeNull()
    } finally {
      await db.delete(emailVerifications).where(like(emailVerifications.email, `${pfx}%`))
      await cleanupTestRbac(pfx)
    }
  })

  it('reports a lapsed invite as an expiry in the past', async () => {
    const pfx = `${prefix}-lapsed`
    const invitee = await createTestUser({ prefix: pfx })
    const expiresAt = new Date(Date.now() - 60_000)
    await db.insert(emailVerifications).values({
      email: invitee.email.toLowerCase(),
      code: 'lapsed-code-hash',
      expiresAt,
    })
    try {
      const entry = await listEntry(invitee.id)
      expect(new Date(entry.inviteExpiresAt).getTime()).toBe(expiresAt.getTime())
      expect(new Date(entry.inviteExpiresAt).getTime()).toBeLessThan(Date.now())
    } finally {
      await db.delete(emailVerifications).where(like(emailVerifications.email, `${pfx}%`))
      await cleanupTestRbac(pfx)
    }
  })
})

describe('GET /api/users/:id/roles', () => {
  it('lists role assignments', async () => {
    const res = await app.request(`/api/users/${admin.id}/roles`, {
      headers: authHeaders(admin.token),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body)).toBe(true)
    expect(body.length).toBeGreaterThanOrEqual(1)
    expect(body[0]).toHaveProperty('roleName')
    expect(body[0]).toHaveProperty('roleSlug')
  })
})

describe('GET /api/users/:id/permissions', () => {
  it("resolves another user's effective permissions with the same squad precedence route guards use", async () => {
    const pfx = `${prefix}-effective`
    const target = await createTestUser({ prefix: pfx })
    const baseline = await createTestRole({ permissions: ['chat:read'], prefix: `${pfx}-sys` })
    const squadDefault = await createTestRole({ permissions: ['deployments:read'], prefix: `${pfx}-default` })
    const override = await createTestRole({ permissions: ['workstreams:read'], prefix: `${pfx}-override` })
    const [overridden, defaulted] = await db
      .insert(squads)
      .values([
        { name: `${pfx}-overridden`, purpose: 'Test' },
        { name: `${pfx}-defaulted`, purpose: 'Test' },
      ])
      .returning()
    await assignRole({ userId: target.id, roleId: baseline.id, scope: 'system' })
    await assignRole({ userId: target.id, roleId: squadDefault.id, scope: 'squad_default' })
    await assignRole({ userId: target.id, roleId: override.id, scope: 'squad', squadId: overridden.id })
    const read = async (squadId?: string) => {
      const query = squadId ? `?squadId=${squadId}` : ''
      const res = await app.request(`/api/users/${target.id}/permissions${query}`, {
        headers: authHeaders(admin.token),
      })
      expect(res.status).toBe(200)
      return res.json()
    }
    try {
      const system = await read()
      expect(system).toMatchObject({ userId: target.id, email: target.email, disabled: false, squad: null })
      expect(system.permissions).toEqual(['chat:read'])

      // No roles on this squad: the squad_default tier applies.
      const byDefault = await read(defaulted.id)
      expect(byDefault.squad).toEqual({ id: defaulted.id, name: defaulted.name })
      expect(byDefault.permissions.sort()).toEqual(['chat:read', 'deployments:read'])

      // A role on the squad REPLACES the default tier, and a short id names the same squad.
      const byOverride = await read(overridden.id.slice(0, 8))
      expect(byOverride.squad.id).toBe(overridden.id)
      expect(byOverride.permissions.sort()).toEqual(['chat:read', 'workstreams:read'])
      expect(byOverride.roles.map((role: { scope: string }) => role.scope).sort()).toEqual(['squad', 'system'])
    } finally {
      await db.delete(roleAssignments).where(eq(roleAssignments.subjectId, target.id))
      await db.delete(squads).where(inArray(squads.id, [overridden.id, defaulted.id]))
      for (const suffix of ['sys', 'default', 'override']) await cleanupTestRbac(`${pfx}-${suffix}`)
      await cleanupTestRbac(pfx)
    }
  })

  it('reports a disabled user as disabled', async () => {
    const pfx = `${prefix}-effective-disabled`
    const target = await createTestUser({ prefix: pfx })
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, target.id))
    try {
      const res = await app.request(`/api/users/${target.id}/permissions`, { headers: authHeaders(admin.token) })
      expect((await res.json()).disabled).toBe(true)
    } finally {
      await cleanupTestRbac(pfx)
    }
  })

  it('returns 404 for an unknown user or squad', async () => {
    const missingUser = await app.request('/api/users/00000000-0000-0000-0000-000000000000/permissions', {
      headers: authHeaders(admin.token),
    })
    expect(missingUser.status).toBe(404)
    const missingSquad = await app.request(
      `/api/users/${admin.id}/permissions?squadId=00000000-0000-0000-0000-000000000000`,
      { headers: authHeaders(admin.token) }
    )
    expect(missingSquad.status).toBe(404)
    expect((await missingSquad.json()).error).toBe('Squad not found')
  })

  it('requires users:read', async () => {
    const pfx = `${prefix}-effective-denied`
    const caller = await createTestUser({ prefix: pfx })
    try {
      const res = await app.request(`/api/users/${admin.id}/permissions`, { headers: authHeaders(caller.token) })
      expect(res.status).toBe(403)
    } finally {
      await cleanupTestRbac(pfx)
    }
  })
})

describe('POST /api/users/:id/roles', () => {
  it('assigns a role', async () => {
    const user = await createTestUser({ prefix })
    const role = await createTestRole({ permissions: ['read'], prefix })

    const res = await app.request(`/api/users/${user.id}/roles`, {
      method: 'POST',
      headers: { ...authHeaders(admin.token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ roleId: role.id, scope: 'system' }),
    })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.roleId).toBe(role.id)
    expect(body.subjectId).toBe(user.id)
  })
})

describe('DELETE /api/users/:id', () => {
  it('prevents deleting last admin', async () => {
    const res = await app.request(`/api/users/${admin.id}`, {
      method: 'DELETE',
      headers: authHeaders(admin.token),
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('last admin')
  })

  it('allows deleting admin when another exists', async () => {
    // Create a second admin (canonical so invariant can detect both)
    const _admin2 = await createTestAdmin({ prefix: `${prefix}-del`, canonicalAdmin: true })
    // Create a third admin so admin2 can be safely deleted while admin remains
    const deletable = await createTestAdmin({ prefix: `${prefix}-del2`, canonicalAdmin: true })

    const res = await app.request(`/api/users/${deletable.id}`, {
      method: 'DELETE',
      headers: authHeaders(admin.token),
    })
    expect(res.status).toBe(204)

    // Clean up admin2
    await cleanupTestRbac(`${prefix}-del`)
  })

  it('notifies onboarding (invite_users signal can flip back to todo) when a user is deleted', async () => {
    const pfx = `${prefix}-delnotify`
    // A second admin so `deletable` can be removed without tripping the
    // last-active-admin guard.
    await createTestAdmin({ prefix: pfx, canonicalAdmin: true })
    const deletable = await createTestAdmin({ prefix: `${pfx}-2`, canonicalAdmin: true })

    const spy = spyOn(onboardingEvents, 'notifyOnboardingChanged')
    try {
      const res = await app.request(`/api/users/${deletable.id}`, {
        method: 'DELETE',
        headers: authHeaders(admin.token),
      })
      expect(res.status).toBe(204)
      expect(spy).toHaveBeenCalledTimes(1)
    } finally {
      spy.mockRestore()
      await cleanupTestRbac(pfx)
    }
  })
})

describe('DELETE /api/users/:id/roles/:assignmentId', () => {
  it('removes assignment', async () => {
    const user = await createTestUser({ prefix })
    const role = await createTestRole({ permissions: ['read'], prefix })
    const assignmentId = await assignRole({ userId: user.id, roleId: role.id, scope: 'system' })

    const emit = spyOn(eventEmitter, 'emit')
    try {
      const res = await app.request(`/api/users/${user.id}/roles/${assignmentId}`, {
        method: 'DELETE',
        headers: authHeaders(admin.token),
      })
      expect(res.status).toBe(204)
      expect(emit).toHaveBeenCalledWith('liveActivity.interestChanged', { userId: user.id })
    } finally {
      emit.mockRestore()
    }
  })

  it('prevents removing last admin role', async () => {
    // admin has exactly one admin role assignment — try to find it
    const rolesRes = await app.request(`/api/users/${admin.id}/roles`, {
      headers: authHeaders(admin.token),
    })
    const adminRoles = (await rolesRes.json()) as any[]
    // The admin role assignment is the one created by createTestAdmin
    const adminAssignment = adminRoles[0]

    const res = await app.request(`/api/users/${admin.id}/roles/${adminAssignment.id}`, {
      method: 'DELETE',
      headers: authHeaders(admin.token),
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('last admin')
  })
})

describe('Live Activity user lifecycle refresh', () => {
  it('refreshes authoritative interest immediately after disable and enable', async () => {
    const target = await createTestUser({ prefix: `${prefix}-activity-lifecycle` })
    const emit = spyOn(eventEmitter, 'emit')
    try {
      const disabled = await app.request(`/api/users/${target.id}/disable`, {
        method: 'PATCH',
        headers: authHeaders(admin.token),
      })
      expect(disabled.status).toBe(200)
      expect(emit).toHaveBeenCalledWith('liveActivity.interestChanged', { userId: target.id })

      emit.mockClear()
      const enabled = await app.request(`/api/users/${target.id}/enable`, {
        method: 'PATCH',
        headers: authHeaders(admin.token),
      })
      expect(enabled.status).toBe(200)
      expect(emit).toHaveBeenCalledWith('liveActivity.interestChanged', { userId: target.id })
    } finally {
      emit.mockRestore()
      await cleanupTestRbac(`${prefix}-activity-lifecycle`)
    }
  })
})

// ── Security Regression Tests ────────────────────────────────────────────────

describe('Security: lockout guards', () => {
  it('PATCH /:id/disable on the last active admin returns 400', async () => {
    // admin is the only canonical admin — disabling should be blocked
    const res = await app.request(`/api/users/${admin.id}/disable`, {
      method: 'PATCH',
      headers: authHeaders(admin.token),
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('last')
  })

  it('DELETE /:id of the only active admin while a second admin exists but is disabled returns 400', async () => {
    const pfx = `${prefix}-lockout`
    // Create a second canonical admin, then disable them
    const disabledAdmin = await createTestAdmin({ prefix: pfx, canonicalAdmin: true })
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, disabledAdmin.id))

    try {
      // Now admin is the only ACTIVE admin (disabledAdmin is disabled)
      const res = await app.request(`/api/users/${admin.id}`, {
        method: 'DELETE',
        headers: authHeaders(admin.token),
      })
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toContain('last admin')
    } finally {
      await cleanupTestRbac(pfx)
    }
  })

  it('PATCH /:id with disabledAt in body does NOT disable the user (Fix 1 regression)', async () => {
    const user = await createTestUser({ prefix: `${prefix}-patchfix` })
    try {
      const res = await app.request(`/api/users/${user.id}`, {
        method: 'PATCH',
        headers: { ...authHeaders(admin.token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ disabledAt: '2030-01-01T00:00:00Z' }),
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      // disabledAt must remain null — body field must have been stripped
      expect(body.disabledAt).toBeNull()
    } finally {
      await cleanupTestRbac(`${prefix}-patchfix`)
    }
  })
})

describe('Security: permission enforcement on POST /:id/roles', () => {
  it('POST /:id/roles by a user without users:update returns 403', async () => {
    // Create a plain user (no users:update permission)
    const nonAdmin = await createTestUser({ prefix: `${prefix}-nowrite` })
    const role = await createTestRole({ permissions: ['users:read'], prefix: `${prefix}-nowrite` })
    await assignRole({ userId: nonAdmin.id, roleId: role.id, scope: 'system' })

    const targetUser = await createTestUser({ prefix: `${prefix}-target` })
    const assignableRole = await createTestRole({ permissions: ['read'], prefix: `${prefix}-assignable` })

    try {
      const res = await app.request(`/api/users/${targetUser.id}/roles`, {
        method: 'POST',
        headers: { ...authHeaders(nonAdmin.token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ roleId: assignableRole.id, scope: 'system' }),
      })
      expect(res.status).toBe(403)
    } finally {
      await cleanupTestRbac(`${prefix}-nowrite`)
      await cleanupTestRbac(`${prefix}-target`)
      await cleanupTestRbac(`${prefix}-assignable`)
    }
  })
})

it('duplicate role assignments remain a safe 409 through wrapped driver failures', async () => {
  const pfx = `${prefix}-duplicate-role`
  const user = await createTestUser({ prefix: pfx })
  const role = await createTestRole({ prefix: pfx, permissions: ['users:read'] })
  try {
    const request = () =>
      app.request(`/api/users/${user.id}/roles`, {
        method: 'POST',
        headers: { ...authHeaders(admin.token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ roleId: role.id, scope: 'system' }),
      })
    expect((await request()).status).toBe(201)
    const duplicate = await request()
    expect(duplicate.status).toBe(409)
    expect(await duplicate.json()).toEqual({ error: 'Role assignment already exists for this user, role, and scope' })
  } finally {
    await cleanupTestRbac(pfx)
  }
})
