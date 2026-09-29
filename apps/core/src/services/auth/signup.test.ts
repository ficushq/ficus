import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { db } from '../../db'
import { roleAssignments, roles } from '../../db/schema'
import { Role } from '../../entities/Role'
import { User } from '../../entities/User'
import { getAuthSettings, updateAuthSettings } from './email'
import { createSelfRegisteredUser } from './signup'

const ownedUsers: User[] = []
const ownedRoles: Role[] = []
async function role(appliesTo: 'user' | 'agent' = 'user') {
  const created = await Role.create({
    name: 'Sign-up test',
    slug: `signup-${crypto.randomUUID()}`,
    permissions: ['squads:read'],
    appliesTo,
  })
  ownedRoles.push(created)
  return created
}
async function register(domain = 'example.com') {
  const user = await createSelfRegisteredUser({ email: `signup-${crypto.randomUUID()}@${domain}` })
  if (user) ownedUsers.push(user)
  return user
}
// The default roles every member gets (the farm) exist here whatever ran earlier in the process,
// so each case pins whether a sign-up gets them.
let farmerId: string
let ownFarmer = false
beforeEach(async () => {
  const [existing] = await db.select({ id: roles.id }).from(roles).where(eq(roles.slug, 'farmer'))
  if (existing) {
    farmerId = existing.id
    return
  }
  const [created] = await db
    .insert(roles)
    .values({ name: 'Farmer', slug: 'farmer', permissions: ['farm:read', 'farm:chat'], isSystem: true })
    .returning({ id: roles.id })
  farmerId = created!.id
  ownFarmer = true
})
afterAll(async () => {
  if (ownFarmer) await db.delete(roles).where(eq(roles.id, farmerId))
})
const heldRoleIds = async (user: User) =>
  (await db.select().from(roleAssignments).where(eq(roleAssignments.subjectId, user.id))).map((a) => a.roleId).sort()

afterEach(async () => {
  await updateAuthSettings({ requireInvite: true, allowedDomains: [], defaultSignupRoleId: null })
  for (const user of ownedUsers.splice(0)) await user.delete()
  for (const role of ownedRoles.splice(0)) if (await Role.findById(role.id)) await role.delete()
})

describe('self-registration default role', () => {
  test.each([false, true])(
    'assigns the role, and the default roles, for requireInvite=%s when the domain is allowed',
    async (requireInvite) => {
      const selected = await role()
      await updateAuthSettings({ requireInvite, allowedDomains: ['Example.com'], defaultSignupRoleId: selected.id })
      const user = await register()
      expect(user).not.toBeNull()
      const assignments = await db.select().from(roleAssignments).where(eq(roleAssignments.subjectId, user!.id))
      expect(assignments.map((a) => a.roleId).sort()).toEqual([selected.id, farmerId].sort())
      for (const assignment of assignments) {
        expect(assignment).toMatchObject({ subjectType: 'user', scope: 'system', squadId: null })
      }
    }
  )
  test('No role creates an account without any grants, not even the default roles', async () => {
    await updateAuthSettings({ requireInvite: false, defaultSignupRoleId: null })
    const user = await register()
    expect(user).not.toBeNull()
    expect(await db.select().from(roleAssignments).where(eq(roleAssignments.subjectId, user!.id))).toEqual([])
  })
  test('does not admit an unlisted domain, even with a default role', async () => {
    const selected = await role()
    await updateAuthSettings({ requireInvite: true, allowedDomains: ['example.com'], defaultSignupRoleId: selected.id })
    expect(await register('other.example')).toBeNull()
  })
  test('does not use a configured role to bypass invite-only admission', async () => {
    const selected = await role()
    await updateAuthSettings({ requireInvite: true, allowedDomains: [], defaultSignupRoleId: selected.id })
    expect(await register()).toBeNull()
  })
  test('changing the default does not change existing accounts', async () => {
    const selected = await role()
    await updateAuthSettings({ requireInvite: false, defaultSignupRoleId: selected.id })
    const user = await register()
    await updateAuthSettings({ defaultSignupRoleId: null })
    expect(await heldRoleIds(user!)).toEqual([selected.id, farmerId].sort())
  })
  test('deleting the selected role resets the policy to No role', async () => {
    const selected = await role()
    await updateAuthSettings({ requireInvite: false, defaultSignupRoleId: selected.id })
    await selected.delete()
    expect((await getAuthSettings()).defaultSignupRoleId).toBeNull()
    const user = await register()
    expect(user).not.toBeNull()
    expect(await db.select().from(roleAssignments).where(eq(roleAssignments.subjectId, user!.id))).toEqual([])
  })
  test('rejects an agent-only role even if an invalid policy was stored outside the API', async () => {
    const selected = await role('agent')
    await updateAuthSettings({ requireInvite: false, defaultSignupRoleId: selected.id })
    expect(await register()).toBeNull()
  })
})
