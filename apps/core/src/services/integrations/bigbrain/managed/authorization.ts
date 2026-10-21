/**
 * Human-only authority for managed shared BigBrain vaults.
 *
 * Management requires a LITERAL enabled human session (`identity.type === 'user'`) holding the
 * instance `integrations:write:bigbrain` permission. Agents, delegated user-assistant agents,
 * system tokens and legacy/bootstrap identities are refused even with identical or wildcard
 * scopes — this deliberately does not resolve an acting user. Vaults belong to the instance, so
 * the same permission also covers owner device links (which connect a BigBrain app as the
 * vault's upstream `ficus` owner); squad attach/detach additionally requires that squad's
 * `integrations:write`.
 */
import { and, asc, eq, inArray, isNull } from 'drizzle-orm'
import { db, squads, users } from '../../../../db'
import { getAccessibleSquadIds, hasUserPermissionWithExecutor, type Identity } from '../../../rbac/permissions'

export type ManagedVaultAuthorizationCode =
  | 'human_required'
  | 'enabled_human_required'
  | 'permission_required'
  | 'squad_permission_required'

export class ManagedVaultAuthorizationError extends Error {
  readonly status = 403
  constructor(readonly code: ManagedVaultAuthorizationCode) {
    super(code)
    this.name = 'ManagedVaultAuthorizationError'
  }
}

type Executor = Pick<typeof db, 'select'>
export const MANAGED_VAULT_MANAGE_PERMISSION = 'integrations:write:bigbrain'
export const MANAGED_VAULT_READ_PERMISSION = 'integrations:read:bigbrain'

async function requireEnabledHuman(identity: Identity | undefined, executor: Executor): Promise<string> {
  if (identity?.type !== 'user') throw new ManagedVaultAuthorizationError('human_required')
  const [user] = await executor
    .select({ disabledAt: users.disabledAt })
    .from(users)
    .where(eq(users.id, identity.userId))
    .limit(1)
  if (!user || user.disabledAt) throw new ManagedVaultAuthorizationError('enabled_human_required')
  return identity.userId
}

/** Create, rename, retry, owner device links, revoke/reconnect read access, delete. Returns the
 * acting user ID. */
export async function requireManagedVaultManager(
  identity: Identity | undefined,
  executor: Executor = db
): Promise<string> {
  const userId = await requireEnabledHuman(identity, executor)
  if (!(await hasUserPermissionWithExecutor(executor, userId, MANAGED_VAULT_MANAGE_PERMISSION)))
    throw new ManagedVaultAuthorizationError('permission_required')
  return userId
}

/** Attach/detach a vault for one squad. */
export async function requireManagedVaultSquadManager(
  identity: Identity | undefined,
  squadId: string,
  executor: Executor = db
): Promise<string> {
  const userId = await requireManagedVaultManager(identity, executor)
  if (!(await hasUserPermissionWithExecutor(executor, userId, 'integrations:write', squadId)))
    throw new ManagedVaultAuthorizationError('squad_permission_required')
  return userId
}

/** Squads (not archived) where this BigBrain manager also holds `integrations:write`: exactly the
 * squads `requireManagedVaultSquadManager` would allow an attach or detach for. Offering is not
 * authorizing: every attach/detach still goes through the squad assignment route and its checks. */
export async function managedVaultAttachableSquads(
  identity: Identity,
  userId: string,
  executor: Executor = db
): Promise<{ id: string; name: string }[]> {
  const accessible = await getAccessibleSquadIds(identity, executor)
  if (accessible !== 'all' && accessible.length === 0) return []
  const candidates = await executor
    .select({ id: squads.id, name: squads.name })
    .from(squads)
    .where(and(isNull(squads.archivedAt), accessible === 'all' ? undefined : inArray(squads.id, accessible)))
    .orderBy(asc(squads.name))
  const writable: { id: string; name: string }[] = []
  for (const squad of candidates)
    if (await hasUserPermissionWithExecutor(executor, userId, 'integrations:write', squad.id)) writable.push(squad)
  return writable
}

/** Whether this identity may enumerate the whole managed pool (names, owner handles, state). Ordinary
 * agents and squad readers see only their assigned vaults, through the assignment. */
export async function canEnumerateManagedVaults(
  identity: Identity | undefined,
  executor: Executor = db
): Promise<boolean> {
  try {
    const userId = await requireEnabledHuman(identity, executor)
    return await hasUserPermissionWithExecutor(executor, userId, MANAGED_VAULT_READ_PERMISSION)
  } catch {
    return false
  }
}
