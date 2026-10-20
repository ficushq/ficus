import { afterAll, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { db, squads, users } from '../../../../db'
import { assignRole, cleanupTestRbac, createTestRole, createTestUser } from '../../../../test-utils/rbac'
import type { Identity } from '../../../rbac/permissions'
import {
  ManagedVaultAuthorizationError,
  canEnumerateManagedVaults,
  requireManagedVaultManager,
  requireManagedVaultSquadManager,
} from './authorization'

const PREFIX = `mbb-auth-${crypto.randomUUID().slice(0, 8)}`
const createdSquads: string[] = []
afterAll(async () => {
  for (const id of createdSquads) await db.delete(squads).where(eq(squads.id, id))
  await cleanupTestRbac(PREFIX)
})

async function userWith(permissions: string[], scope: 'system' | 'squad' = 'system', squadId?: string) {
  const user = await createTestUser({ prefix: PREFIX })
  if (permissions.length) {
    const role = await createTestRole({ prefix: PREFIX, permissions })
    await assignRole({ userId: user.id, roleId: role.id, scope, squadId })
  }
  return user.id
}
async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(ManagedVaultAuthorizationError)
    expect((error as ManagedVaultAuthorizationError).status).toBe(403)
    return (error as ManagedVaultAuthorizationError).code
  }
  throw new Error('expected a refusal')
}
const human = (userId: string): Identity => ({ type: 'user', userId })

test('only a literal enabled human with the instance permission may manage vaults', async () => {
  const admin = await userWith(['*'])
  expect(await requireManagedVaultManager(human(admin))).toBe(admin)
  const nonHuman: Identity[] = [
    { type: 'agent', agentId: crypto.randomUUID(), squadId: crypto.randomUUID() },
    // A delegated user-assistant agent keeps its non-human identity, even for an admin owner.
    { type: 'agent', agentId: crypto.randomUUID(), squadId: null, userId: admin },
    { type: 'system', systemTokenId: crypto.randomUUID(), name: 'automation', scopes: ['*'] },
    { type: 'legacy' },
  ]
  for (const identity of [...nonHuman, undefined])
    expect(await refusal(requireManagedVaultManager(identity))).toBe('human_required')
})

test('a disabled human or one without the BigBrain write permission is refused', async () => {
  const disabled = await userWith(['*'])
  await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, disabled))
  expect(await refusal(requireManagedVaultManager(human(disabled)))).toBe('enabled_human_required')
  const reader = await userWith(['integrations:read:bigbrain'])
  expect(await refusal(requireManagedVaultManager(human(reader)))).toBe('permission_required')
  const otherProvider = await userWith(['integrations:write:notion'])
  expect(await refusal(requireManagedVaultManager(human(otherProvider)))).toBe('permission_required')
  expect(await refusal(requireManagedVaultManager(human(crypto.randomUUID())))).toBe('enabled_human_required')
})

test('attaching to a squad additionally requires that squad’s integrations:write', async () => {
  const [squad] = await db
    .insert(squads)
    .values({ name: `${PREFIX} squad`, purpose: 'test' })
    .returning()
  createdSquads.push(squad!.id)
  const manager = await userWith(['integrations:write:bigbrain'])
  expect(await refusal(requireManagedVaultSquadManager(human(manager), squad!.id))).toBe('squad_permission_required')
  const role = await createTestRole({ prefix: PREFIX, permissions: ['integrations:write'] })
  await assignRole({ userId: manager, roleId: role.id, scope: 'squad', squadId: squad!.id })
  expect(await requireManagedVaultSquadManager(human(manager), squad!.id)).toBe(manager)
})

test('only enabled humans with BigBrain read authority enumerate the managed pool', async () => {
  const reader = await userWith(['integrations:read:bigbrain'])
  expect(await canEnumerateManagedVaults(human(reader))).toBe(true)
  // A squad-scoped reader is not an instance reader of the managed pool.
  const [squad] = await db
    .insert(squads)
    .values({ name: `${PREFIX} readers`, purpose: 'test' })
    .returning()
  createdSquads.push(squad!.id)
  const squadReader = await userWith(['integrations:read'], 'squad', squad!.id)
  expect(await canEnumerateManagedVaults(human(squadReader))).toBe(false)
  expect(await canEnumerateManagedVaults(human(await userWith([])))).toBe(false)
  expect(
    await canEnumerateManagedVaults({ type: 'system', systemTokenId: crypto.randomUUID(), name: 'x', scopes: ['*'] })
  ).toBe(false)
  expect(await canEnumerateManagedVaults({ type: 'agent', agentId: crypto.randomUUID(), squadId: null })).toBe(false)
})
