import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import { db } from '../../db'
import { roles, roleAssignments, userCredentials, users } from '../../db/schema'

/** True if at least one enabled user holds the system-scoped `admin` role. */
export async function hasAdminUsers(): Promise<boolean> {
  const result = await db
    .select({ id: roleAssignments.id })
    .from(roleAssignments)
    .innerJoin(roles, eq(roles.id, roleAssignments.roleId))
    .innerJoin(users, sql`${users.id}::text = ${roleAssignments.subjectId}`)
    .where(
      and(
        eq(roleAssignments.subjectType, 'user'),
        eq(roleAssignments.scope, 'system'),
        eq(roles.slug, 'admin'),
        isNull(users.disabledAt)
      )
    )
    .limit(1)

  return result.length > 0
}

/**
 * True if at least one enabled admin user has a registered passkey credential.
 *
 * This is the source of truth for the password-vs-passkey decision: the
 * bootstrap `FICUS_PASSWORD` may authenticate, and the UI should offer password
 * login, precisely while this returns `false`.
 *
 * It is strictly wider than `hasAdminUsers()` only in the "admin users exist
 * but none holds a passkey" state. That state is the deliberate
 * cross-subdomain restore case: a backup restored onto a NEW origin keeps the
 * user/role rows but every WebAuthn credential is dead (origin-bound), so the
 * platform strips the credential rows. Without this predicate such an instance
 * would be a total lockout (no working passkey, and the password rejected the
 * moment any admin row exists). Re-enabling the env-held password there is a
 * recovery improvement — the state is otherwise reachable only if every admin
 * deletes every passkey, in which case the instance is already unrecoverable
 * today. The moment an admin registers a passkey this flips to `true` and
 * password auth turns off again.
 */
export async function adminHasPasskey(): Promise<boolean> {
  const result = await db
    .select({ id: userCredentials.id })
    .from(roleAssignments)
    .innerJoin(roles, eq(roles.id, roleAssignments.roleId))
    .innerJoin(users, sql`${users.id}::text = ${roleAssignments.subjectId}`)
    .innerJoin(userCredentials, eq(userCredentials.userId, users.id))
    .where(
      and(
        eq(roleAssignments.subjectType, 'user'),
        eq(roleAssignments.scope, 'system'),
        eq(roles.slug, 'admin'),
        isNull(users.disabledAt)
      )
    )
    .limit(1)

  return result.length > 0
}

/** An account the bootstrap session may finish setting up as the first passkey-holding admin. */
export interface PendingAdminAccount {
  id: string
  email: string
  displayName: string | null
}

export interface PendingAdminSetup {
  /** An enabled admin row exists (none holds a passkey, or password auth would be off). */
  adminExists: boolean
  /** Oldest first. Empty when nobody is waiting, e.g. before the first account exists. */
  accounts: PendingAdminAccount[]
}

/**
 * Who is waiting to become the instance's first passkey-holding admin, for the
 * bootstrap `FICUS_PASSWORD` session to finish setting up. Only meaningful while
 * `adminHasPasskey()` is false.
 *
 * - An admin row exists (a restore stripped its credentials, or its passkey
 *   ceremony never finished): those admins. None holds a passkey, by definition.
 * - No admin yet: first-admin registration creates the account row before the
 *   passkey ceremony and grants the admin role only once a passkey verifies, so a
 *   failed ceremony leaves an enabled account with no passkey and no role. Every
 *   such account is a candidate.
 */
export async function pendingAdminSetup(): Promise<PendingAdminSetup> {
  const adminExists = await hasAdminUsers()
  const withoutPasskey = await db
    .select({ id: users.id, email: users.email, displayName: users.displayName })
    .from(users)
    .leftJoin(userCredentials, eq(userCredentials.userId, users.id))
    .where(and(isNull(users.disabledAt), isNull(userCredentials.id)))
    .orderBy(asc(users.createdAt), asc(users.id))
  if (!adminExists) return { adminExists, accounts: withoutPasskey }

  const adminIds = await systemAdminUserIds()
  return { adminExists, accounts: withoutPasskey.filter((account) => adminIds.has(account.id)) }
}

/** Ids of every user holding the system-scoped `admin` role, enabled or not. */
export async function systemAdminUserIds(): Promise<Set<string>> {
  const rows = await db
    .select({ userId: roleAssignments.subjectId })
    .from(roleAssignments)
    .innerJoin(roles, eq(roles.id, roleAssignments.roleId))
    .where(and(eq(roleAssignments.subjectType, 'user'), eq(roleAssignments.scope, 'system'), eq(roles.slug, 'admin')))
  return new Set(rows.map((row) => row.userId))
}
