import { and, eq, inArray } from 'drizzle-orm'
import { db } from '../../db'
import { authSettings, roleAssignments, roles } from '../../db/schema'
import { User, type CreateUserInput } from '../../entities/User'

/** Called only for a new, email-verified self-registration, never an invite or bootstrap. */
export async function createSelfRegisteredUser(input: CreateUserInput): Promise<User | null> {
  return db.transaction(async (tx) => {
    // Keep admission and the selected grant together if the operator edits the policy.
    const [policy] = await tx.select().from(authSettings).where(eq(authSettings.id, 'default')).for('share')
    const domain = input.email.split('@')[1]?.toLowerCase()
    if (!policy || (policy.requireInvite && !policy.allowedDomains.some((d) => d.toLowerCase() === domain))) return null

    const roleId = policy.defaultSignupRoleId
    if (roleId) {
      const [role] = await tx
        .select({ id: roles.id })
        .from(roles)
        .where(and(eq(roles.id, roleId), inArray(roles.appliesTo, ['user', 'both'])))
        .for('share')
      if (!role) return null
    }
    // "No role" means an administrator grants access later, so that includes the default roles
    // (the farm). With a sign-up role, they're a member like any other and get the defaults too.
    const user = await User.create({ ...input, withoutDefaultRoles: !roleId }, tx)
    if (roleId) {
      await tx.insert(roleAssignments).values({ subjectType: 'user', subjectId: user.id, roleId, scope: 'system' })
    }
    return user
  })
}
