import { db } from '../db'
import { users, roles, roleAssignments, sessions, agentTokens, userCredentials } from '../db/schema'
import { eq, like, inArray, and, notInArray } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { createHash } from 'crypto'
import { invalidatePermissionCache } from '../services/rbac/permissions'
import { AGENT_TOKEN_PREFIX, SESSION_TOKEN_PREFIX } from '../services/auth/token-prefixes'

// ── Types ────────────────────────────────────────────────────────────────────

export interface TestUser {
  id: string
  email: string
  displayName: string
  /** Raw session token (unhashed) — use in Authorization header */
  token: string
  sessionId: string
}

export interface TestRole {
  id: string
  name: string
  slug: string
  permissions: string[]
}

export interface TestAgentToken {
  id: string
  agentId: string
  squadId: string | null
  /** Raw token (unhashed) — use in Authorization header */
  token: string
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

// ── Factory Functions ────────────────────────────────────────────────────────

export async function createTestUser(opts?: {
  email?: string
  displayName?: string
  prefix?: string
}): Promise<TestUser> {
  const prefix = opts?.prefix ?? 'test'
  const email = opts?.email ?? `${prefix}-${randomUUID().slice(0, 8)}@test.local`
  const displayName = opts?.displayName ?? `Test User ${prefix}`

  const [user] = await db
    .insert(users)
    .values({
      email,
      displayName,
    })
    .returning()

  const token = `${SESSION_TOKEN_PREFIX}${randomUUID()}`
  const [session] = await db
    .insert(sessions)
    .values({
      userId: user.id,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    })
    .returning()

  return {
    id: user.id,
    email,
    displayName,
    token,
    sessionId: session.id,
  }
}

/** A signed-in session for an existing user (one made some other way than createTestUser). */
export async function createTestSession(userId: string): Promise<string> {
  const token = `${SESSION_TOKEN_PREFIX}${randomUUID()}`
  await db.insert(sessions).values({
    userId,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  })
  return token
}

export async function createTestRole(opts: {
  name?: string
  slug?: string
  permissions: string[]
  prefix?: string
  isSystem?: boolean
}): Promise<TestRole> {
  const prefix = opts.prefix ?? 'test'
  const slug = opts.slug ?? `${prefix}-role-${randomUUID().slice(0, 8)}`
  const name = opts.name ?? `Test Role ${slug}`

  const [role] = await db
    .insert(roles)
    .values({
      name,
      slug,
      permissions: opts.permissions,
      isSystem: opts.isSystem ?? false,
    })
    .onConflictDoUpdate({
      target: roles.slug,
      set: {
        name,
        permissions: opts.permissions,
        isSystem: opts.isSystem ?? false,
        updatedAt: new Date(),
      },
    })
    .returning()

  return {
    id: role.id,
    name: role.name,
    slug: role.slug,
    permissions: role.permissions as string[],
  }
}

export async function assignRole(opts: {
  subjectType?: 'user' | 'channel'
  userId?: string
  subjectId?: string
  roleId: string
  scope: 'system' | 'squad_default' | 'squad'
  squadId?: string
}): Promise<string> {
  const subjectType = opts.subjectType ?? 'user'
  const subjectId = opts.subjectId ?? opts.userId
  if (!subjectId) throw new Error('assignRole: userId or subjectId required')

  const [assignment] = await db
    .insert(roleAssignments)
    .values({
      subjectType,
      subjectId,
      roleId: opts.roleId,
      scope: opts.scope,
      squadId: opts.squadId ?? null,
    })
    .returning()
  // Mirror the route-side role writes: the user-permission cache must not
  // serve a pre-assignment result to the test that just granted the role.
  invalidatePermissionCache()
  return assignment.id
}

/**
 * Create a test user with admin permissions.
 *
 * By default, creates a role with a random slug and `["*"]` permissions.
 * This is intentional: random slugs don't match the canonical `admin` slug,
 * so `hasAdminUsers()` checks (which use `roles.slug = 'admin'`) won't see
 * these test admins. This prevents cross-test pollution in concurrent runs.
 *
 * Pass `canonicalAdmin: true` when testing code that specifically checks for
 * the `admin` slug (e.g. `hasAdminUsers`, legacy password rejection).
 */
export async function createTestAdmin(opts?: {
  email?: string
  prefix?: string
  canonicalAdmin?: boolean
}): Promise<TestUser> {
  const prefix = opts?.prefix ?? 'admin'
  const user = await createTestUser({ ...opts, prefix })

  let role: TestRole
  if (opts?.canonicalAdmin) {
    role = await findOrCreateCanonicalAdminRole()
  } else {
    role = await createTestRole({
      permissions: ['*'],
      prefix,
      slug: `${prefix}-admin-${randomUUID().slice(0, 8)}`,
    })
  }

  await assignRole({
    userId: user.id,
    roleId: role.id,
    scope: 'system',
  })
  invalidatePermissionCache()
  return user
}

/**
 * Find or create the canonical admin role (slug: 'admin').
 * Safe for concurrent use via INSERT ... ON CONFLICT DO NOTHING.
 */
async function findOrCreateCanonicalAdminRole(): Promise<TestRole> {
  await db
    .insert(roles)
    .values({
      name: 'Admin',
      slug: 'admin',
      permissions: ['*'],
      isSystem: true,
    })
    .onConflictDoNothing()

  const [row] = await db.select().from(roles).where(eq(roles.slug, 'admin')).limit(1)
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    permissions: row.permissions as string[],
  }
}

/**
 * Register a passkey credential row for a user. Used by auth tests that need an
 * admin to hold a *usable* credential (the passkey-vs-password gate), not just
 * an admin role assignment.
 */
export async function createTestCredential(opts: { userId: string; displayName?: string }): Promise<string> {
  const [cred] = await db
    .insert(userCredentials)
    .values({
      userId: opts.userId,
      credentialId: `test-cred-${randomUUID()}`,
      publicKey: Buffer.from(randomUUID()).toString('base64url'),
      counter: 0,
      displayName: opts.displayName ?? 'Test passkey',
    })
    .returning()
  return cred.id
}

export async function createTestAgentToken(opts: {
  agentId: string
  // null = squad-less token (system-managers): must match a squad-less agent
  // row, or resolveAgentAuthority fails closed on the mismatch.
  squadId: string | null
  userId?: string
}): Promise<TestAgentToken> {
  const token = `${AGENT_TOKEN_PREFIX}${randomUUID()}`
  const [row] = await db
    .insert(agentTokens)
    .values({
      agentId: opts.agentId,
      squadId: opts.squadId,
      tokenHash: hashToken(token),
      userId: opts.userId ?? null,
    })
    .returning()

  return {
    id: row.id,
    agentId: opts.agentId,
    squadId: opts.squadId,
    token,
  }
}

export function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` }
}

export async function cleanupTestRbac(prefix: string): Promise<void> {
  invalidatePermissionCache()
  // Find user IDs matching the prefix email pattern, then clean their role assignments
  const matchingUsers = await db
    .select({ id: users.id })
    .from(users)
    .where(like(users.email, `${prefix}%`))
  const userIds = matchingUsers.map((u) => u.id)
  if (userIds.length > 0) {
    await db.delete(userCredentials).where(inArray(userCredentials.userId, userIds))
    await db.delete(sessions).where(inArray(sessions.userId, userIds))
    await db.delete(roleAssignments).where(inArray(roleAssignments.subjectId, userIds))
    await db
      .update(agentTokens)
      .set({ userId: null, revokedAt: new Date() })
      .where(inArray(agentTokens.userId, userIds))
  }
  await db.delete(users).where(like(users.email, `${prefix}%`))
  await db.delete(roles).where(like(roles.slug, `${prefix}%`))

  // Remove orphaned user role assignments. `role_assignments.subject_id` is a
  // plain text column (no FK cascade to `users.id`), so deleting a user — whether
  // via this helper, the factory above, or the production DELETE /api/users route
  // (User.delete only removes the users row) — leaves the assignment behind.
  // A leftover `scope='system'` assignment to the canonical `admin` role makes the
  // global `hasAdminUsers()` query return true, which silently flips legacy-auth
  // and auth-status tests in the shared test DB. Sweep any user assignment whose
  // subject no longer exists so each cleanup restores the global admin baseline.
  await purgeOrphanedRbac()
}

/**
 * Delete role assignments whose subject user no longer exists, then drop the
 * canonical `admin` role if nothing references it anymore. Keeps the shared test
 * DB's global "does any admin exist" state at baseline regardless of how/when a
 * test user was removed (factory cleanup vs. API delete).
 */
async function purgeOrphanedRbac(): Promise<void> {
  const existing = await db.select({ id: users.id }).from(users)
  const existingIds = existing.map((u) => u.id)

  // Delete user-scoped assignments pointing at a non-existent subject.
  if (existingIds.length > 0) {
    await db
      .delete(roleAssignments)
      .where(and(eq(roleAssignments.subjectType, 'user'), notInArray(roleAssignments.subjectId, existingIds)))
  } else {
    await db.delete(roleAssignments).where(eq(roleAssignments.subjectType, 'user'))
  }

  // Drop the canonical admin role if no assignment references it. Leaving a bare
  // role row is harmless (hasAdminUsers requires an assignment) but removing it
  // keeps the test DB pristine.
  const adminRefs = await db
    .select({ id: roleAssignments.id })
    .from(roleAssignments)
    .innerJoin(roles, eq(roles.id, roleAssignments.roleId))
    .where(eq(roles.slug, 'admin'))
    .limit(1)
  if (adminRefs.length === 0) {
    await db.delete(roles).where(eq(roles.slug, 'admin'))
  }
}
