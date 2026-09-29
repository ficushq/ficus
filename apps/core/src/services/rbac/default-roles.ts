import { and, eq, exists, inArray, isNull, ne, sql } from 'drizzle-orm'
import { db } from '../../db'
import { roleAssignments, roles, users } from '../../db/schema'
import { DEMO_REVIEWER_EMAIL } from '../demo/reviewer'

type Executor = Pick<typeof db, 'select' | 'insert'>

/**
 * Roles every new person gets when their account is created, as ordinary
 * assignments an admin can later remove (config/roles/defaults.yaml): the
 * Farmer role, the farm's multiplayer (farm:read, farm:chat), instance-wide,
 * so someone whose other roles are all scoped to squads can still use it.
 * When one of these roles is first created on an instance, the people already
 * there with access get it too (see role-sync.ts and backfillUserIds).
 *
 * Not everyone gets them: a self-registration under the "No role" policy
 * waits for an administrator (signup.ts), and the shared demo reviewer
 * account only ever holds its own role (demo/seed.ts).
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

/**
 * Who gets a default role that was just created: every active person who
 * already holds a role (someone with none is waiting for an administrator),
 * except the shared demo reviewer.
 */
export async function backfillUserIds(executor: Pick<typeof db, 'select'> = db): Promise<string[]> {
  const rows = await executor
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        isNull(users.disabledAt),
        ne(users.email, DEMO_REVIEWER_EMAIL),
        exists(
          executor
            .select({ id: roleAssignments.id })
            .from(roleAssignments)
            .where(and(eq(roleAssignments.subjectType, 'user'), sql`${roleAssignments.subjectId} = ${users.id}::text`))
        )
      )
    )
  return rows.map((row) => row.id)
}
