import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test'
import { Hono } from 'hono'
import { randomUUID } from 'crypto'
import { eq, and, like } from 'drizzle-orm'
import { usersRouter } from './users'
import { identityMiddleware } from '../middleware/identity'
import {
  createTestAdmin,
  createTestUser,
  createTestRole,
  assignRole,
  authHeaders,
  cleanupTestRbac,
} from '../test-utils'
import type { TestUser } from '../test-utils/rbac'
import { db } from '../db'
import { emailVerifications, roleAssignments, roles, squads, users } from '../db/schema'
import { sesSendMock } from '../test-utils/ses-mock'

// Invites are the one flow that MUST send mail. The bug this suite pins down:
// POST /users used to compute the invite code as
//   isEmailConfigured() ? undefined : await sendVerificationEmail(...)
// so the branch where mail could actually be delivered never called the mailer
// at all, and the invitee heard nothing.

const app = new Hono()
app.use('*', identityMiddleware)
app.route('/api/users', usersRouter)

const prefix = `invite-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

let admin: TestUser
let operatorRoleId: string
let viewerRoleId: string
let agentRoleId: string

/** Seed the canonical human + agent roles this suite asserts against. */
async function seedRole(slug: string, name: string, appliesTo: 'user' | 'agent'): Promise<string> {
  const [row] = await db
    .insert(roles)
    .values({ name, slug, permissions: ['squads:read'], appliesTo, isSystem: true })
    .onConflictDoUpdate({ target: roles.slug, set: { appliesTo, permissions: ['squads:read'] } })
    .returning()
  return row.id
}

beforeAll(async () => {
  admin = await createTestAdmin({ prefix })
  operatorRoleId = await seedRole('operator', 'Operator', 'user')
  viewerRoleId = await seedRole('viewer', 'Viewer', 'user')
  agentRoleId = await seedRole('default-worker', 'Squad Worker', 'agent')
})

afterAll(async () => {
  await cleanupTestRbac(prefix)
  await db.delete(roles).where(eq(roles.slug, 'operator'))
  await db.delete(roles).where(eq(roles.slug, 'viewer'))
  await db.delete(roles).where(eq(roles.slug, 'default-worker'))
})

const priorFrom = process.env.SES_FROM_ADDRESS

beforeEach(() => {
  sesSendMock.mockClear()
})

afterEach(async () => {
  if (priorFrom === undefined) delete process.env.SES_FROM_ADDRESS
  else process.env.SES_FROM_ADDRESS = priorFrom
  await db.delete(emailVerifications).where(like(emailVerifications.email, `${prefix}%`))
  const invited = await db
    .select({ id: users.id })
    .from(users)
    .where(like(users.email, `${prefix}-invitee%`))
  for (const u of invited) {
    await db.delete(roleAssignments).where(eq(roleAssignments.subjectId, u.id))
    await db.delete(users).where(eq(users.id, u.id))
  }
})

async function invite(body: Record<string, unknown>) {
  const res = await app.request('/api/users', {
    method: 'POST',
    headers: { ...authHeaders(admin.token), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { res, body: (await res.json()) as any }
}

function newEmail() {
  return `${prefix}-invitee-${randomUUID().slice(0, 8)}@test.local`
}

// ── A. The invite actually sends ─────────────────────────────────────────────

describe('POST /api/users sends the invite', () => {
  it('MAILS the invite when email is configured (the regression this fixes)', async () => {
    process.env.SES_FROM_ADDRESS = 'noreply@test.local'
    const email = newEmail()
    const { res } = await invite({ email })
    expect(res.status).toBe(201)
    expect(sesSendMock).toHaveBeenCalledTimes(1)
  })

  // The mail used to carry the 6-digit code as a "finish on another device"
  // fallback, but typing it needs the login page's "Create account" form — which
  // an invite-only instance with no allowed domains hides (canSelfRegister:false).
  // The code had nowhere to go, so the mail is now link-only. The challenge row
  // still holds both presentations (see the token/code test below); only the
  // advertising changed.
  it('the mailed invite carries the deep link and no typeable code', async () => {
    process.env.SES_FROM_ADDRESS = 'noreply@test.local'
    await invite({ email: newEmail() })
    const command = sesSendMock.mock.calls[0]?.[0] as {
      input: { Message: { Subject: { Data: string }; Body: { Text: { Data: string }; Html: { Data: string } } } }
    }
    const text = command.input.Message.Body.Text.Data
    const html = command.input.Message.Body.Html.Data
    expect(text).toMatch(/\/register\?token=[\w-]{20,}/)
    expect(html).toContain('/register?token=')
    // No bare 6-digit run in the text body, and no instruction to type one.
    expect(text).not.toMatch(/\b\d{6}\b/)
    for (const body of [text, html]) {
      expect(body).not.toMatch(/enter this code/i)
      expect(body).not.toContain('Create account')
    }
  })

  it('names the instance in the subject, like the verification email does', async () => {
    process.env.SES_FROM_ADDRESS = 'noreply@test.local'
    const priorAppUrl = process.env.APP_URL
    process.env.APP_URL = 'https://demo.ficus.sh'
    try {
      await invite({ email: newEmail() })
      const command = sesSendMock.mock.calls[0]?.[0] as { input: { Message: { Subject: { Data: string } } } }
      expect(command.input.Message.Subject.Data).toContain('demo.ficus.sh')
    } finally {
      if (priorAppUrl === undefined) delete process.env.APP_URL
      else process.env.APP_URL = priorAppUrl
    }
  })

  it('does NOT echo the code or link back to the admin when email is configured', async () => {
    process.env.SES_FROM_ADDRESS = 'noreply@test.local'
    const { body } = await invite({ email: newEmail() })
    expect(body.inviteCode).toBeUndefined()
    expect(body.inviteUrl).toBeUndefined()
  })

  it('still returns a one-time code + link (and sends nothing) with no email provider', async () => {
    delete process.env.SES_FROM_ADDRESS
    const { res, body } = await invite({ email: newEmail() })
    expect(res.status).toBe(201)
    expect(sesSendMock).not.toHaveBeenCalled()
    expect(body.inviteCode).toMatch(/^\d{6}$/)
    expect(body.inviteUrl).toContain('/register?token=')
  })

  it('persists a token alongside the code so the link and the code share one challenge', async () => {
    delete process.env.SES_FROM_ADDRESS
    const email = newEmail()
    await invite({ email })
    const [row] = await db.select().from(emailVerifications).where(eq(emailVerifications.email, email.toLowerCase()))
    expect(row.tokenHash).toBeTruthy()
    expect(row.purpose).toBe('register')
  })
})

// ── B. Roles at invite time ──────────────────────────────────────────────────

describe('POST /api/users assigns roles', () => {
  /** The roles the invite gave, besides the ones every new person gets (the Farmer role, when synced). */
  async function assignmentsFor(userId: string) {
    const [farmer] = await db.select({ id: roles.id }).from(roles).where(eq(roles.slug, 'farmer'))
    const rows = await db
      .select({ roleId: roleAssignments.roleId, scope: roleAssignments.scope, squadId: roleAssignments.squadId })
      .from(roleAssignments)
      .where(and(eq(roleAssignments.subjectType, 'user'), eq(roleAssignments.subjectId, userId)))
    return rows.filter((row) => row.roleId !== farmer?.id)
  }

  it('defaults to operator when the caller names no role', async () => {
    delete process.env.SES_FROM_ADDRESS
    const { body } = await invite({ email: newEmail() })
    expect(body.roles).toEqual(['operator'])
    const assignments = await assignmentsFor(body.id)
    expect(assignments).toHaveLength(1)
    expect(assignments[0].roleId).toBe(operatorRoleId)
  })

  it('assigns at system scope with no squad', async () => {
    delete process.env.SES_FROM_ADDRESS
    const { body } = await invite({ email: newEmail() })
    const assignments = await assignmentsFor(body.id)
    expect(assignments[0].scope).toBe('system')
    expect(assignments[0].squadId).toBeNull()
  })

  it('honours an explicit role slug', async () => {
    delete process.env.SES_FROM_ADDRESS
    const { body } = await invite({ email: newEmail(), roleIds: ['viewer'] })
    expect(body.roles).toEqual(['viewer'])
    const assignments = await assignmentsFor(body.id)
    expect(assignments.map((a) => a.roleId)).toEqual([viewerRoleId])
  })

  it('honours explicit role ids, including several at once', async () => {
    delete process.env.SES_FROM_ADDRESS
    const { body } = await invite({ email: newEmail(), roleIds: [operatorRoleId, viewerRoleId] })
    const assignments = await assignmentsFor(body.id)
    expect(assignments.map((a) => a.roleId).sort()).toEqual([operatorRoleId, viewerRoleId].sort())
  })

  it('gives several roles in their own scopes: system-wide, every squad, and one squad', async () => {
    delete process.env.SES_FROM_ADDRESS
    const [squad] = await db
      .insert(squads)
      .values({ name: `${prefix} squad`, purpose: 'test' })
      .returning()
    try {
      const { res, body } = await invite({
        email: newEmail(),
        assignments: [
          { roleId: 'viewer', scope: 'system' },
          { roleId: operatorRoleId, scope: 'squad', squadId: squad!.id },
          { roleId: 'viewer', scope: 'squad_default' },
          { roleId: 'viewer', scope: 'system' },
        ],
      })
      expect(res.status).toBe(201)
      expect(body.roles).toEqual(['viewer'])
      const given = (await assignmentsFor(body.id)).map((a) => [a.roleId, a.scope, a.squadId])
      expect(given.sort()).toEqual(
        [
          [viewerRoleId, 'system', null],
          [operatorRoleId, 'squad', squad!.id],
          [viewerRoleId, 'squad_default', null],
        ].sort()
      )
    } finally {
      await db.delete(squads).where(eq(squads.id, squad!.id))
    }
  })

  it('choosing Farmer, which every new person already gets, gives it once', async () => {
    delete process.env.SES_FROM_ADDRESS
    let [farmer] = await db.select({ id: roles.id }).from(roles).where(eq(roles.slug, 'farmer'))
    const ownFarmer = !farmer
    if (!farmer)
      [farmer] = await db
        .insert(roles)
        .values({ name: 'Farmer', slug: 'farmer', permissions: ['farm:read', 'farm:chat'], isSystem: true })
        .returning({ id: roles.id })
    try {
      const { res, body } = await invite({
        email: newEmail(),
        assignments: [
          { roleId: 'viewer', scope: 'system' },
          { roleId: 'farmer', scope: 'system' },
        ],
      })
      expect(res.status).toBe(201)
      const held = await db
        .select({ roleId: roleAssignments.roleId })
        .from(roleAssignments)
        .where(eq(roleAssignments.subjectId, body.id))
      expect(held.map((a) => a.roleId).sort()).toEqual([viewerRoleId, farmer!.id].sort())
    } finally {
      if (ownFarmer) await db.delete(roles).where(eq(roles.id, farmer!.id))
    }
  })

  it('rejects a squad assignment without a real squad, and a bad scope, creating nobody', async () => {
    delete process.env.SES_FROM_ADDRESS
    for (const assignments of [
      [{ roleId: 'viewer', scope: 'squad' }],
      [{ roleId: 'viewer', scope: 'squad', squadId: randomUUID() }],
      [{ roleId: 'viewer', scope: 'everywhere' }],
      [{ roleId: 'viewer', scope: 'system', squadId: randomUUID() }],
    ]) {
      const email = newEmail()
      const { res } = await invite({ email, assignments })
      expect(res.status).toBe(400)
      expect(await db.select().from(users).where(eq(users.email, email))).toEqual([])
    }
  })

  it('rejects an unknown role without creating the user', async () => {
    delete process.env.SES_FROM_ADDRESS
    const email = newEmail()
    const { res, body } = await invite({ email, roleIds: ['does-not-exist'] })
    expect(res.status).toBe(400)
    expect(body.error).toContain('Unknown role')
    const [row] = await db.select().from(users).where(eq(users.email, email))
    expect(row).toBeUndefined()
  })

  it('refuses to put an agent-only role on a person', async () => {
    delete process.env.SES_FROM_ADDRESS
    const { res, body } = await invite({ email: newEmail(), roleIds: ['default-worker'] })
    expect(res.status).toBe(400)
    expect(body.error).toContain('cannot be assigned to a user')
    expect(agentRoleId).toBeTruthy()
  })

  it('will not let a caller grant permissions they do not hold', async () => {
    delete process.env.SES_FROM_ADDRESS
    const pfx = `${prefix}-escal`
    const inviter = await createTestUser({ prefix: pfx })
    const weak = await createTestRole({ permissions: ['users:create'], prefix: pfx })
    await assignRole({ userId: inviter.id, roleId: weak.id, scope: 'system' })
    const strong = await createTestRole({ permissions: ['*'], prefix: `${pfx}-strong` })
    try {
      const res = await app.request('/api/users', {
        method: 'POST',
        headers: { ...authHeaders(inviter.token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: newEmail(), roleIds: [strong.id] }),
      })
      expect(res.status).toBe(403)
      expect((await res.json()).error).toContain('Cannot grant permissions you do not hold')
    } finally {
      await cleanupTestRbac(`${pfx}-strong`)
      await cleanupTestRbac(pfx)
    }
  })

  it('rejects a malformed roleIds payload', async () => {
    delete process.env.SES_FROM_ADDRESS
    const { res } = await invite({ email: newEmail(), roleIds: 'operator' })
    expect(res.status).toBe(400)
  })
})

describe('POST /api/users/:id/roles rejects agent roles too', () => {
  it('a person cannot be given an agent-derived role after the fact either', async () => {
    delete process.env.SES_FROM_ADDRESS
    const target = await createTestUser({ prefix: `${prefix}-later` })
    try {
      const res = await app.request(`/api/users/${target.id}/roles`, {
        method: 'POST',
        headers: { ...authHeaders(admin.token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ roleId: agentRoleId, scope: 'system' }),
      })
      expect(res.status).toBe(400)
      expect((await res.json()).error).toContain('cannot be assigned to a user')
    } finally {
      await cleanupTestRbac(`${prefix}-later`)
    }
  })
})
