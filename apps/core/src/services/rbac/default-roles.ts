import { inArray, isNull } from 'drizzle-orm'
import { db } from '../../db'
import { roleAssignments, roles, users } from '../../db/schema'

type Executor = Pick<typeof db, 'select' | 'insert'>

/**
 * Roles every new person gets when their account is created, as ordinary
 * assignments an admin can later remove (config/roles/defaults.yaml): the
 * Farmer role, the farm's multiplayer (farm:read, farm:chat), instance-wide,
 * so someone whose other roles are all scoped to squads can still use it.
 * When one of these roles is first created on an instance, everyone already
 * there gets it too (see role-sync.ts).
 */
export const DEFAULT_USER_ROLE_SLUGS = ['farmer'] as const

/** Gives these people the default roles (instance-wide), skipping any they already hold. */
export async function grantDefaultRoles(
  userIds: readonly string[],
  slugs: readonly string[] = DEFAULT_USER_ROLE_SLUGS,
  executor: Executor = db
): Promise<void> {
  if (!userIds.length || !slugs.length) return
  const found = await executor
    .select({ id: roles.id })
    .from(roles)
    .where(inArray(roles.slug, [...slugs]))
  const values = userIds.flatMap((subjectId) =>
    found.map((role) => ({ subjectType: 'user' as const, subjectId, roleId: role.id, scope: 'system' as const }))
  )
  if (values.length) await executor.insert(roleAssignments).values(values).onConflictDoNothing()
}

/** Every active person, for granting a default role that was just created. */
export async function activeUserIds(executor: Pick<typeof db, 'select'> = db): Promise<string[]> {
  const rows = await executor.select({ id: users.id }).from(users).where(isNull(users.disabledAt))
  return rows.map((row) => row.id)
}
