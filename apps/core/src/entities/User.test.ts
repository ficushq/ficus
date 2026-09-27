import { describe, it, expect, afterEach } from 'bun:test'
import { eq, like, and, sql } from 'drizzle-orm'
import { User } from './User'
import { db } from '../db'
import { users, sessions, userCredentials, roleAssignments, roles } from '../db/schema'
import { createHash } from 'crypto'

const PREFIX = 'user-test'

function testEmail(suffix?: string) {
  return `${PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}${suffix ?? ''}@test.local`
}

describe('User entity', () => {
  afterEach(async () => {
    // Clean up test users by email prefix
    const testUsers = await db
      .select({ id: users.id })
      .from(users)
      .where(like(users.email, `${PREFIX}%`))
    for (const u of testUsers) {
      await db.delete(sessions).where(eq(sessions.userId, u.id))
      await db.delete(userCredentials).where(eq(userCredentials.userId, u.id))
      await db
        .delete(roleAssignments)
        .where(and(eq(roleAssignments.subjectType, 'user'), eq(roleAssignments.subjectId, u.id)))
    }
    await db.delete(users).where(like(users.email, `${PREFIX}%`))
  })

  // ---------------------------------------------------------------------------
  // User.create
  // ---------------------------------------------------------------------------

  describe('User.create', () => {
    it('creates a user with email', async () => {
      const email = testEmail()
      const user = await User.create({ email })

      expect(user.id).toBeDefined()
      expect(user.email).toBe(email)
      expect(user.displayName).toBeNull()
      expect(user.disabledAt).toBeNull()
      expect(user.isDisabled).toBe(false)
      expect(user.createdAt).toBeInstanceOf(Date)
      expect(user.updatedAt).toBeInstanceOf(Date)
    })

    it('creates a user with displayName', async () => {
      const email = testEmail()
      const user = await User.create({ email, displayName: 'Alice' })

      expect(user.displayName).toBe('Alice')
    })
  })

  // ---------------------------------------------------------------------------
  // User.findById
  // ---------------------------------------------------------------------------

  describe('User.findById', () => {
    it('returns user by id', async () => {
      const created = await User.create({ email: testEmail() })
      const found = await User.findById(created.id)

      expect(found).not.toBeNull()
      expect(found!.id).toBe(created.id)
      expect(found!.email).toBe(created.email)
    })

    it('returns null for non-existent id', async () => {
      const found = await User.findById('00000000-0000-0000-0000-000000000000')
      expect(found).toBeNull()
    })
  })

  // ---------------------------------------------------------------------------
  // User.findByEmail
  // ---------------------------------------------------------------------------

  describe('User.findByEmail', () => {
    it('returns user by email', async () => {
      const email = testEmail()
      const created = await User.create({ email })
      const found = await User.findByEmail(email)

      expect(found).not.toBeNull()
      expect(found!.id).toBe(created.id)
    })

    it('returns null for unknown email', async () => {
      const found = await User.findByEmail('nonexistent@test.local')
      expect(found).toBeNull()
    })
  })

  // ---------------------------------------------------------------------------
  // User.count
  // ---------------------------------------------------------------------------

  describe('User.count', () => {
    it('returns a number', async () => {
      const before = await User.count()
      await User.create({ email: testEmail() })
      const after = await User.count()
      expect(after).toBe(before + 1)
    })
  })

  // ---------------------------------------------------------------------------
  // User.update
  // ---------------------------------------------------------------------------

  describe('user.update', () => {
    it('updates email', async () => {
      const user = await User.create({ email: testEmail() })
      const newEmail = testEmail('-new')
      const updated = await user.update({ email: newEmail })

      expect(updated.email).toBe(newEmail)
      expect(updated).toBe(user) // same instance
    })

    it('updates displayName', async () => {
      const user = await User.create({ email: testEmail() })
      await user.update({ displayName: 'Bob' })
      expect(user.displayName).toBe('Bob')
    })
  })

  // ---------------------------------------------------------------------------
  // User.disable / User.enable
  // ---------------------------------------------------------------------------

  describe('user.disable / user.enable', () => {
    it('disables a user', async () => {
      const user = await User.create({ email: testEmail() })
      expect(user.isDisabled).toBe(false)

      await user.disable()
      expect(user.isDisabled).toBe(true)
      expect(user.disabledAt).toBeInstanceOf(Date)
    })

    it('enables a disabled user', async () => {
      const user = await User.create({ email: testEmail() })
      await user.disable()
      expect(user.isDisabled).toBe(true)

      await user.enable()
      expect(user.isDisabled).toBe(false)
      expect(user.disabledAt).toBeNull()
    })
  })

  // ---------------------------------------------------------------------------
  // User.delete
  // ---------------------------------------------------------------------------

  describe('user.delete', () => {
    it('deletes the user', async () => {
      const user = await User.create({ email: testEmail() })
      await user.delete()

      const found = await User.findById(user.id)
      expect(found).toBeNull()
    })

    it('revokes agent tokens owned by the deleted user', async () => {
      const { createTestAgentToken } = await import('../test-utils/rbac')
      const { resolveToken } = await import('../services/auth/resolve-token')
      const { agents, agentTokens, agentTypes, squads } = await import('../db/schema')
      const { AgentType } = await import('./AgentType')
      const { Agent } = await import('./Agent')

      const user = await User.create({ email: testEmail() })
      const [squad] = await db
        .insert(squads)
        .values({ name: `${PREFIX}-squad-${Date.now()}`, purpose: 'delete-revoke test' })
        .returning()
      const agentTypeId = `${PREFIX}-at-${Date.now()}`
      await AgentType.create({ id: agentTypeId, model: 'anthropic:claude-sonnet-4-5', name: 'T', systemPrompt: 'T' })
      const agent = await Agent.create({ agentTypeId, squadId: squad.id })
      const { token } = await createTestAgentToken({ agentId: agent.id, squadId: squad.id, userId: user.id })

      // Resolves as a user-scoped (system-manager) agent identity first.
      expect(await resolveToken(token)).toMatchObject({ type: 'agent', userId: user.id })

      await user.delete()

      // Owner gone -> token revoked -> resolveToken fails closed (not downgraded
      // to a plain agent identity via the FK's ON DELETE SET NULL).
      expect(await resolveToken(token)).toBeNull()

      await db.delete(agentTokens).where(eq(agentTokens.agentId, agent.id))
      await db.delete(agents).where(eq(agents.id, agent.id))
      await db.delete(agentTypes).where(eq(agentTypes.id, agentTypeId))
      await db.delete(squads).where(eq(squads.id, squad.id))
    })

    it('cascade-deletes role_assignments for the deleted user (no orphan)', async () => {
      // Ensure the canonical admin role exists
      await db
        .insert(roles)
        .values({ name: 'Admin', slug: 'admin', permissions: ['*'], isSystem: true })
        .onConflictDoNothing()
      const [adminRole] = await db.select().from(roles).where(eq(roles.slug, 'admin')).limit(1)

      const user = await User.create({ email: testEmail() })
      // Assign the canonical admin role (system scope) to this user
      await db.insert(roleAssignments).values({
        subjectType: 'user',
        subjectId: user.id,
        roleId: adminRole.id,
        scope: 'system',
      })

      // Verify assignment exists before delete
      const before = await db
        .select()
        .from(roleAssignments)
        .where(and(eq(roleAssignments.subjectType, 'user'), eq(roleAssignments.subjectId, user.id)))
      expect(before.length).toBe(1)

      await user.delete()

      // After delete, NO role_assignments should remain for this subject_id
      const after = await db
        .select()
        .from(roleAssignments)
        .where(and(eq(roleAssignments.subjectType, 'user'), eq(roleAssignments.subjectId, user.id)))
      expect(after.length).toBe(0)
    })

    it('hasAdminUsers reports false (not a ghost) after the only admin user is deleted', async () => {
      // Ensure the canonical admin role exists
      await db
        .insert(roles)
        .values({ name: 'Admin', slug: 'admin', permissions: ['*'], isSystem: true })
        .onConflictDoNothing()
      const [adminRole] = await db.select().from(roles).where(eq(roles.slug, 'admin')).limit(1)

      const user = await User.create({ email: testEmail() })
      await db.insert(roleAssignments).values({
        subjectType: 'user',
        subjectId: user.id,
        roleId: adminRole.id,
        scope: 'system',
      })

      // Confirm admin assignment exists with a live user (defense-in-depth query)
      const withJoin = await db
        .select({ id: roleAssignments.id })
        .from(roleAssignments)
        .innerJoin(roles, eq(roles.id, roleAssignments.roleId))
        .innerJoin(users, sql`${users.id}::text = ${roleAssignments.subjectId}`)
        .where(
          and(eq(roleAssignments.subjectType, 'user'), eq(roleAssignments.scope, 'system'), eq(roles.slug, 'admin'))
        )
        .limit(1)
      expect(withJoin.length).toBe(1)

      await user.delete()

      // After delete, the joined query (which requires the user to exist) must return 0
      const afterJoin = await db
        .select({ id: roleAssignments.id })
        .from(roleAssignments)
        .innerJoin(roles, eq(roles.id, roleAssignments.roleId))
        .innerJoin(users, sql`${users.id}::text = ${roleAssignments.subjectId}`)
        .where(
          and(eq(roleAssignments.subjectType, 'user'), eq(roleAssignments.scope, 'system'), eq(roles.slug, 'admin'))
        )
        .limit(1)
      expect(afterJoin.length).toBe(0)
    })
  })

  // ---------------------------------------------------------------------------
  // User.createSession
  // ---------------------------------------------------------------------------

  describe('user.createSession', () => {
    it('returns a token with ficus_sess_ prefix', async () => {
      const user = await User.create({ email: testEmail() })
      const token = await user.createSession()

      expect(token).toMatch(/^ficus_sess_[0-9a-f-]+$/)
    })

    it('stores SHA-256 hash of the token in sessions table', async () => {
      const user = await User.create({ email: testEmail() })
      const token = await user.createSession()

      const expectedHash = createHash('sha256').update(token).digest('hex')
      const rows = await db.select().from(sessions).where(eq(sessions.userId, user.id))

      expect(rows.length).toBe(1)
      expect(rows[0].tokenHash).toBe(expectedHash)
    })

    it('sets expiresAt 30 days in the future by default', async () => {
      const user = await User.create({ email: testEmail() })
      const before = Date.now()
      await user.createSession()
      const after = Date.now()

      const rows = await db.select().from(sessions).where(eq(sessions.userId, user.id))
      const expiresAt = rows[0].expiresAt.getTime()
      const thirtyDays = 30 * 24 * 60 * 60 * 1000

      expect(expiresAt).toBeGreaterThanOrEqual(before + thirtyDays - 1000)
      expect(expiresAt).toBeLessThanOrEqual(after + thirtyDays + 1000)
    })

    it('accepts custom expiresInMs', async () => {
      const user = await User.create({ email: testEmail() })
      const before = Date.now()
      await user.createSession({ expiresInMs: 60_000 })
      const after = Date.now()

      const rows = await db.select().from(sessions).where(eq(sessions.userId, user.id))
      const expiresAt = rows[0].expiresAt.getTime()

      expect(expiresAt).toBeGreaterThanOrEqual(before + 60_000 - 1000)
      expect(expiresAt).toBeLessThanOrEqual(after + 60_000 + 1000)
    })

    it('stores userAgent and ipAddress', async () => {
      const user = await User.create({ email: testEmail() })
      await user.createSession({ userAgent: 'Mozilla/5.0', ipAddress: '127.0.0.1' })

      const rows = await db.select().from(sessions).where(eq(sessions.userId, user.id))
      expect(rows[0].userAgent).toBe('Mozilla/5.0')
      expect(rows[0].ipAddress).toBe('127.0.0.1')
    })
  })

  // ---------------------------------------------------------------------------
  // User.getCredentials / User.addCredential
  // ---------------------------------------------------------------------------

  describe('user.getCredentials / user.addCredential', () => {
    it('returns empty array when no credentials', async () => {
      const user = await User.create({ email: testEmail() })
      const creds = await user.getCredentials()
      expect(creds).toEqual([])
    })

    it('adds and retrieves a credential', async () => {
      const user = await User.create({ email: testEmail() })
      await user.addCredential({
        credentialId: `cred-${Date.now()}`,
        publicKey: 'pk-abc',
        counter: 0,
        transports: ['usb'],
        displayName: 'My Key',
      })

      const creds = await user.getCredentials()
      expect(creds.length).toBe(1)
      expect(creds[0].publicKey).toBe('pk-abc')
      expect(creds[0].displayName).toBe('My Key')
    })
  })

  // ---------------------------------------------------------------------------
  // User.toJSON
  // ---------------------------------------------------------------------------

  describe('user.toJSON', () => {
    it('serializes to JSON', async () => {
      const user = await User.create({ email: testEmail(), displayName: 'Alice' })
      const json = user.toJSON()

      expect(json.id).toBe(user.id)
      expect(json.email).toBe(user.email)
      expect(json.displayName).toBe('Alice')
      expect(json.disabledAt).toBeNull()
      expect(typeof json.createdAt).toBe('string')
      expect(typeof json.updatedAt).toBe('string')
    })

    it('serializes disabledAt as ISO string when set', async () => {
      const user = await User.create({ email: testEmail() })
      await user.disable()
      const json = user.toJSON()

      expect(typeof json.disabledAt).toBe('string')
    })
  })
})
