/**
 * Human-only authority for managed shared BigBrain vaults.
 *
 * Management requires a LITERAL enabled human session (`identity.type === 'user'`) holding the
 * instance `integrations:write:bigbrain` permission. Agents, delegated user-assistant agents,
 * system tokens and legacy/bootstrap identities are refused even with identical or wildcard
 * scopes — this deliberately does not resolve an acting user. Owner links additionally require
 * the vault's stored owner; squad attach/detach additionally requires that squad's
 * `integrations:write`.
 */
import { eq } from 'drizzle-orm'
import { db, users } from '../../../../db'
import { hasUserPermissionWithExecutor, type Identity } from '../../../rbac/permissions'

export type ManagedVaultAuthorizationCode =
  | 'human_required'
  | 'enabled_human_required'
  | 'permission_required'
  | 'owner_required'
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

/** Create, rename, retry, revoke/reconnect read access, delete. Returns the acting user ID. */
export async function requireManagedVaultManager(
  identity: Identity | undefined,
  executor: Executor = db
): Promise<string> {
  const userId = await requireEnabledHuman(identity, executor)
  if (!(await hasUserPermissionWithExecutor(executor, userId, MANAGED_VAULT_MANAGE_PERMISSION)))
    throw new ManagedVaultAuthorizationError('permission_required')
  return userId
}

/** Owner device links: only the vault's recorded owner, who must still be a live manager. No
 * other administrator can mint an impersonating owner link. */
export async function requireManagedVaultOwner(
  identity: Identity | undefined,
  vault: { ownerUserId: string | null },
  executor: Executor = db
): Promise<string> {
  const userId = await requireManagedVaultManager(identity, executor)
  // A vault whose owner was deleted has no owner in Ficus: nobody may mint its owner links.
  if (vault.ownerUserId === null || userId !== vault.ownerUserId)
    throw new ManagedVaultAuthorizationError('owner_required')
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

/** Whether this identity may enumerate the whole managed pool (names, owners, state). Ordinary
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
