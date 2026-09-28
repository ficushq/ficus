import { permissionMatches } from '@ficus/shared'
import { and, eq } from 'drizzle-orm'
import { db } from '../../db'
import { roleAssignments, roles } from '../../db/schema'
import { getAccessibleSquadIds, resolvePermissions, type Identity } from './permissions'

export type PermissionSquadScope = { kind: 'all'; excludedSquadIds: string[] } | { kind: 'some'; squadIds: string[] }

export interface UserRoleScopeRow {
  scope: 'system' | 'squad_default' | 'squad'
  squadId: string | null
  permissions: string[]
}

const canonicalIds = (ids: Iterable<string>): string[] => [...new Set(ids)].sort()
const grants = (permissions: string[], requested: string): boolean =>
  permissions.some((held) => permissionMatches(held, requested))

export function scopeFromUserRoleRows(rows: UserRoleScopeRow[], permission: string): PermissionSquadScope {
  if (rows.some((row) => row.scope === 'system' && grants(row.permissions, permission))) {
    return { kind: 'all', excludedSquadIds: [] }
  }

  const defaultGrants = rows.some((row) => row.scope === 'squad_default' && grants(row.permissions, permission))
  const overrides = new Map<string, UserRoleScopeRow[]>()
  for (const row of rows) {
    if (row.scope !== 'squad' || !row.squadId) continue
    const existing = overrides.get(row.squadId) ?? []
    existing.push(row)
    overrides.set(row.squadId, existing)
  }

  if (defaultGrants) {
    const excluded = [...overrides.entries()]
      .filter(([, assigned]) => !assigned.some((row) => grants(row.permissions, permission)))
      .map(([squadId]) => squadId)
    return { kind: 'all', excludedSquadIds: canonicalIds(excluded) }
  }

  const allowed = [...overrides.entries()]
    .filter(([, assigned]) => assigned.some((row) => grants(row.permissions, permission)))
    .map(([squadId]) => squadId)
  return { kind: 'some', squadIds: canonicalIds(allowed) }
}

export function scopeAllows(scope: PermissionSquadScope, squadId: string): boolean {
  return scope.kind === 'all' ? !scope.excludedSquadIds.includes(squadId) : scope.squadIds.includes(squadId)
}

export function narrowScope(scope: PermissionSquadScope, squadId: string): PermissionSquadScope {
  return scopeAllows(scope, squadId) ? { kind: 'some', squadIds: [squadId] } : { kind: 'some', squadIds: [] }
}

export function isEmptyScope(scope: PermissionSquadScope): boolean {
  return scope.kind === 'some' && scope.squadIds.length === 0
}

export async function loadUserRoleRows(userId: string): Promise<UserRoleScopeRow[]> {
  const rows = await db
    .select({ scope: roleAssignments.scope, squadId: roleAssignments.squadId, permissions: roles.permissions })
    .from(roleAssignments)
    .innerJoin(roles, eq(roles.id, roleAssignments.roleId))
    .where(and(eq(roleAssignments.subjectType, 'user'), eq(roleAssignments.subjectId, userId)))

  return rows.map((row) => ({
    scope: row.scope as UserRoleScopeRow['scope'],
    squadId: row.squadId,
    permissions: row.permissions as string[],
  }))
}

export interface PermissionScopeDependencies {
  loadUserRoleRows: (userId: string) => Promise<UserRoleScopeRow[]>
}

export async function resolvePermissionSquadScope(
  identity: Identity,
  permission: string,
  dependencies: PermissionScopeDependencies = { loadUserRoleRows }
): Promise<PermissionSquadScope> {
  if (identity.type === 'legacy') return { kind: 'all', excludedSquadIds: [] }
  if (identity.type === 'system') {
    return identity.scopes.some((held) => permissionMatches(held, permission))
      ? { kind: 'all', excludedSquadIds: [] }
      : { kind: 'some', squadIds: [] }
  }
  if (identity.type === 'user') {
    return scopeFromUserRoleRows(await dependencies.loadUserRoleRows(identity.userId), permission)
  }
  if (identity.userId) {
    return scopeFromUserRoleRows(await dependencies.loadUserRoleRows(identity.userId), permission)
  }

  const accessible = await getAccessibleSquadIds(identity)
  const held = await resolvePermissions(identity, identity.squadId ?? undefined)
  if (!held.some((value) => permissionMatches(value, permission))) return { kind: 'some', squadIds: [] }
  return accessible === 'all'
    ? { kind: 'all', excludedSquadIds: [] }
    : { kind: 'some', squadIds: canonicalIds(accessible) }
}
