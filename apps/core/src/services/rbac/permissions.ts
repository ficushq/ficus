import { isUserAssistantAgentType } from '@ficus/shared'
import { db } from '../../db'
import { agentExtraScopes, agents, agentTypes, roleAssignments, roles, users } from '../../db/schema'
import { eq, and, inArray, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm'
import { isLiveAgentStatus, permissionMatches } from '@ficus/shared'

export { permissionMatches }

// ── Identity Types ───────────────────────────────────────────────────────────

export interface UserIdentity {
  type: 'user'
  userId: string
}

export interface AgentIdentity {
  type: 'agent'
  agentId: string
  squadId: string | null // null for squad-less agents (system-managers)
  userId?: string // system-manager — resolve via the owning user
}

export interface LegacyIdentity {
  type: 'legacy'
}

// A user-less automation identity backed by a system API token. Its permissions are exactly the
// token's assigned scopes (least-privilege), applied globally (not squad-scoped).
export interface SystemIdentity {
  type: 'system'
  systemTokenId: string
  name: string
  scopes: string[]
}

export type Identity = UserIdentity | AgentIdentity | LegacyIdentity | SystemIdentity

export interface ResolvedRoleSummary {
  slug: string
  name: string
  scope: 'system' | 'squad_default' | 'squad'
  squadId: string | null
  source: 'assignment' | 'agentType' | 'agentOverride'
  permissions: string[]
}

function roleSlugForAgentType(agentTypeId: string | null | undefined): string {
  const ROLE_BY_AGENT_TYPE: Record<string, string> = {
    manager: 'default-manager',
    consultant: 'default-manager', // full manager-equivalent permissions
  }
  return ROLE_BY_AGENT_TYPE[agentTypeId ?? ''] ?? 'default-worker'
}

// ── Permission Resolution ────────────────────────────────────────────────────

type AgentAuthority = {
  agentId: string
  agentTypeId: string
  squadId: string | null
  ownerUserId: string | null
}

/** Resolves an agent to its live root authority, failing closed on corrupt chains. */
async function resolveAgentAuthority(agentId: string, allowInactive = false): Promise<AgentAuthority | null> {
  const seen = new Set<string>()
  let currentId: string | null = agentId
  let descendantSquadId: string | null | undefined

  while (currentId) {
    if (seen.has(currentId)) return null
    seen.add(currentId)
    const [row] = await db
      .select({
        id: agents.id,
        agentTypeId: agents.agentTypeId,
        squadId: agents.squadId,
        ownerUserId: agents.ownerUserId,
        parentAgentId: agents.parentAgentId,
        status: agents.status,
      })
      .from(agents)
      .where(eq(agents.id, currentId))
      .limit(1)
    if (!row || (!allowInactive && !isLiveAgentStatus(row.status))) return null
    if (descendantSquadId !== undefined && row.squadId !== descendantSquadId) return null
    descendantSquadId = row.squadId
    if (!row.parentAgentId) {
      return {
        agentId: row.id,
        agentTypeId: row.agentTypeId,
        squadId: row.squadId,
        ownerUserId: row.ownerUserId,
      }
    }
    currentId = row.parentAgentId
  }
  return null
}

/** User-facing ownership without discarding the authenticated agent's execution identity. */
export async function resolveActingUser(identity: Identity | undefined): Promise<UserIdentity | null> {
  if (identity?.type === 'user') return identity
  if (identity?.type !== 'agent') return null
  const authority = await resolveAgentAuthority(identity.agentId)
  if (
    !authority ||
    !isUserAssistantAgentType(authority.agentTypeId) ||
    authority.squadId !== null ||
    identity.squadId !== null ||
    !authority.ownerUserId ||
    (identity.userId && identity.userId !== authority.ownerUserId)
  )
    return null
  const [owner] = await db
    .select({ disabledAt: users.disabledAt })
    .from(users)
    .where(eq(users.id, authority.ownerUserId))
    .limit(1)
  if (!owner || owner.disabledAt) return null
  return { type: 'user', userId: authority.ownerUserId }
}

/** One `role_assignments` × `roles` row as permission resolution sees it. */
export interface PermissionAssignment {
  scope: 'system' | 'squad_default' | 'squad'
  squadId: string | null
  permissions: string[]
}

/**
 * The whole of the user permission rule, as a pure function of a subject's assignment rows.
 *
 * System-scoped roles always apply. A squad-scoped check adds exactly ONE squad tier on top:
 * the rows assigned directly on that squad if the subject has any, otherwise the
 * `squad_default` rows — an override REPLACES the default rather than supplementing it, so a
 * role that deliberately withholds a permission on one squad is not undone by the default.
 * A system `*` short-circuits the squad tier entirely: nothing it could add is not already held.
 *
 * Both the per-user path ({@link resolveUserPermissions}) and the all-users scan
 * ({@link getUserIdsWithPermission}) evaluate through here, so the one-query audience and the
 * single-subject check cannot drift apart.
 */
export function permissionsFromAssignments(assignments: PermissionAssignment[], squadId?: string): string[] {
  const permissions: string[] = []
  for (const row of assignments) {
    if (row.scope === 'system') permissions.push(...row.permissions)
  }

  if (squadId && !permissions.includes('*')) {
    const overrides = assignments.filter((row) => row.scope === 'squad' && row.squadId === squadId)
    const tier = overrides.length > 0 ? overrides : assignments.filter((row) => row.scope === 'squad_default')
    for (const row of tier) permissions.push(...row.permissions)
  }

  return [...new Set(permissions)]
}

/**
 * `squad_id` is a uuid column, but a `squadId` ARGUMENT is not guaranteed to be one: it arrives
 * from callers, and a value of the wrong shape handed to a uuid comparison fails the whole
 * statement with `invalid input syntax for type uuid`.
 */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The scopes {@link permissionsFromAssignments} can consume for this check. An unscoped check
 * reads nothing but system rows, so the squad tiers stay out of the query entirely.
 *
 * A squad id that is not a uuid identifies NO squad, so it gets the unscoped treatment: system
 * rows only. It deliberately does NOT fall back to `squad_default` — a squad-scoped role that
 * withholds a permission on one squad replaces the default tier, and honouring the default for an
 * unidentifiable squad would hand back exactly the permission that override exists to remove.
 * Route guards must resolve a short id to its full squad id BEFORE asking (see
 * `middleware/require-permission.ts`); this is the fail-closed floor under that, not a substitute
 * for it. `uuidPrefixCondition` would be wrong here: an ambiguous prefix would union the overrides
 * of every squad it matches.
 */
function assignmentScopeFilter(squadId?: string): SQL {
  if (!squadId || !UUID_SHAPE.test(squadId)) return eq(roleAssignments.scope, 'system')
  return or(
    inArray(roleAssignments.scope, ['system', 'squad_default']),
    and(eq(roleAssignments.scope, 'squad'), eq(roleAssignments.squadId, squadId))
  )!
}

async function resolveUserPermissions(
  userId: string,
  squadId?: string,
  executor: Pick<typeof db, 'select'> = db
): Promise<string[]> {
  // One round trip for every scope this check can consume; the precedence between them is
  // resolved in `permissionsFromAssignments`, not by issuing a second query.
  const assignments = await executor
    .select({
      scope: roleAssignments.scope,
      squadId: roleAssignments.squadId,
      permissions: roles.permissions,
    })
    .from(roleAssignments)
    .innerJoin(roles, eq(roles.id, roleAssignments.roleId))
    .where(
      and(
        eq(roleAssignments.subjectType, 'user'),
        eq(roleAssignments.subjectId, userId),
        assignmentScopeFilter(squadId)
      )
    )

  return permissionsFromAssignments(
    assignments.map((row) => ({
      scope: row.scope as PermissionAssignment['scope'],
      squadId: row.squadId,
      permissions: row.permissions as string[],
    })),
    squadId
  )
}

async function resolveAgentPermissions(identity: AgentIdentity, squadId?: string): Promise<string[]> {
  const authority = await resolveAgentAuthority(identity.agentId)
  if (!authority || authority.squadId !== identity.squadId) return []

  // A user-owned root resolves via the owning user's live roles. Child tokens
  // retain child authorship but cannot change this authority.
  if (authority.ownerUserId) return resolveUserPermissions(authority.ownerUserId, squadId)

  const roleSlug = roleSlugForAgentType(authority.agentTypeId)
  const agentRole = await db.select().from(roles).where(eq(roles.slug, roleSlug)).limit(1)
  const rolePermissions = agentRole.length > 0 ? (agentRole[0].permissions as string[]) : []

  // Opt-in extra scopes declared on the agent type (e.g. amtp:send). Looked
  // up here, but unioned only AFTER the squad-accessibility gate below.
  let extraScopes: string[] = []
  if (authority.agentTypeId) {
    const [typeRow] = await db
      .select({ extraScopes: agentTypes.extraScopes })
      .from(agentTypes)
      .where(eq(agentTypes.id, authority.agentTypeId))
      .limit(1)
    extraScopes = (typeRow?.extraScopes as string[] | null) ?? []
  }

  // Per-agent granted extra scopes (agent_extra_scopes rows), unioned alongside
  // the agent-type extra scopes below.
  const grantedRows = await db
    .select({ permission: agentExtraScopes.permission })
    .from(agentExtraScopes)
    .where(eq(agentExtraScopes.agentId, authority.agentId))
  const grantedScopes = grantedRows.map((row) => row.permission)

  // Nothing to grant: no default role AND no extra scopes. (This subsumes the old
  // early `agentRole.length === 0` return, but must NOT fire when a roleless agent
  // type still has extra scopes.)
  if (rolePermissions.length === 0 && extraScopes.length === 0 && grantedScopes.length === 0) return []

  // Gate ALL agent-derived permissions (role permissions AND extra scopes) by the
  // agent's accessible squads. A userless squad agent may exercise these only against
  // its own squad. Without this, squad-scoped guards would accept these permissions
  // for ANY squad (cross-tenant IDOR). An unscoped check defaults to the agent's own
  // squad.
  const effectiveSquadId = squadId ?? authority.squadId
  if (!effectiveSquadId) return [] // squad-less non-system-manager agent: fail closed
  const accessible = await getAccessibleSquadIds({
    type: 'agent',
    agentId: authority.agentId,
    squadId: authority.squadId,
  })
  if (accessible !== 'all' && !accessible.includes(effectiveSquadId)) {
    return []
  }

  // Union extra scopes AFTER the squad gate (cross-tenant IDOR otherwise).
  return [...new Set([...rolePermissions, ...extraScopes, ...grantedScopes])]
}

async function resolveUserRoleSummaries(userId: string, squadId?: string): Promise<ResolvedRoleSummary[]> {
  const summaries: ResolvedRoleSummary[] = []

  const systemAssignments = await db
    .select({ slug: roles.slug, name: roles.name, permissions: roles.permissions })
    .from(roleAssignments)
    .innerJoin(roles, eq(roles.id, roleAssignments.roleId))
    .where(
      and(
        eq(roleAssignments.subjectType, 'user'),
        eq(roleAssignments.subjectId, userId),
        eq(roleAssignments.scope, 'system')
      )
    )

  for (const row of systemAssignments) {
    summaries.push({
      slug: row.slug,
      name: row.name,
      scope: 'system',
      squadId: null,
      source: 'assignment',
      permissions: row.permissions as string[],
    })
  }

  if (!squadId || summaries.some((role) => role.permissions.includes('*'))) return summaries

  const squadOverride = await db
    .select({ slug: roles.slug, name: roles.name, permissions: roles.permissions, squadId: roleAssignments.squadId })
    .from(roleAssignments)
    .innerJoin(roles, eq(roles.id, roleAssignments.roleId))
    .where(
      and(
        eq(roleAssignments.subjectType, 'user'),
        eq(roleAssignments.subjectId, userId),
        eq(roleAssignments.scope, 'squad'),
        eq(roleAssignments.squadId, squadId)
      )
    )

  if (squadOverride.length > 0) {
    return [
      ...summaries,
      ...squadOverride.map((row) => ({
        slug: row.slug,
        name: row.name,
        scope: 'squad' as const,
        squadId: row.squadId,
        source: 'assignment' as const,
        permissions: row.permissions as string[],
      })),
    ]
  }

  const squadDefault = await db
    .select({ slug: roles.slug, name: roles.name, permissions: roles.permissions })
    .from(roleAssignments)
    .innerJoin(roles, eq(roles.id, roleAssignments.roleId))
    .where(
      and(
        eq(roleAssignments.subjectType, 'user'),
        eq(roleAssignments.subjectId, userId),
        eq(roleAssignments.scope, 'squad_default')
      )
    )

  return [
    ...summaries,
    ...squadDefault.map((row) => ({
      slug: row.slug,
      name: row.name,
      scope: 'squad_default' as const,
      squadId: null,
      source: 'assignment' as const,
      permissions: row.permissions as string[],
    })),
  ]
}

async function resolveAgentRoleSummaries(identity: AgentIdentity, squadId?: string): Promise<ResolvedRoleSummary[]> {
  const authority = await resolveAgentAuthority(identity.agentId)
  if (!authority || authority.squadId !== identity.squadId) return []
  if (authority.ownerUserId) return resolveUserRoleSummaries(authority.ownerUserId, squadId)

  const roleSlug = roleSlugForAgentType(authority.agentTypeId)
  const [role] = await db.select().from(roles).where(eq(roles.slug, roleSlug)).limit(1)
  if (!role) return []

  const effectiveSquadId = squadId ?? authority.squadId
  if (!effectiveSquadId) return []
  const accessible = await getAccessibleSquadIds({
    type: 'agent',
    agentId: authority.agentId,
    squadId: authority.squadId,
  })
  if (accessible !== 'all' && !accessible.includes(effectiveSquadId)) return []

  const summaries: ResolvedRoleSummary[] = [
    {
      slug: role.slug,
      name: role.name,
      scope: 'squad',
      squadId: effectiveSquadId,
      source: 'agentType',
      permissions: role.permissions as string[],
    },
  ]

  const extra = await db
    .select({ permission: agentExtraScopes.permission })
    .from(agentExtraScopes)
    .where(eq(agentExtraScopes.agentId, authority.agentId))

  if (extra.length > 0) {
    summaries.push({
      slug: 'agent-override',
      name: 'Agent extra scopes',
      scope: 'squad',
      squadId: effectiveSquadId,
      source: 'agentOverride',
      permissions: extra.map((row) => row.permission),
    })
  }

  return summaries
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Short-TTL permission cache. Permissions are resolved on virtually every API
 * request and WS action (role_assignments joins measured at ~20/s on a live
 * tenant under agent load, 2026-09-01), while role edits are rare
 * admin operations. USER identities only; entries are keyed per user + squad scope; role writes
 * call {@link invalidatePermissionCache}, and the TTL bounds staleness for
 * any write path that misses it (including cross-process edits — a few
 * seconds of lag on a role change is acceptable; revocation-critical paths
 * use device/session revocation, not role edits).
 */
const permissionCache = new Map<string, { permissions: string[]; at: number }>()
const PERMISSION_CACHE_TTL_MS = 5_000

export function invalidatePermissionCache(): void {
  permissionCache.clear()
}

function cachedPermissions(key: string): string[] | null {
  const entry = permissionCache.get(key)
  if (!entry) return null
  if (Date.now() - entry.at > PERMISSION_CACHE_TTL_MS) {
    permissionCache.delete(key)
    return null
  }
  return entry.permissions
}

export async function resolvePermissions(identity: Identity, squadId?: string): Promise<string[]> {
  switch (identity.type) {
    case 'legacy':
      return ['*']

    case 'system':
      // A system token's permissions are its assigned scopes, applied globally.
      return identity.scopes

    case 'user': {
      const key = `user:${identity.userId}:${squadId ?? ''}`
      const cached = cachedPermissions(key)
      if (cached) return cached
      const permissions = await resolveUserPermissions(identity.userId, squadId)
      permissionCache.set(key, { permissions, at: Date.now() })
      return permissions
    }

    case 'agent':
      // Deliberately uncached: an agent's permissions derive from its parent
      // chain, owner, and extra scopes, which change on spawn/reparent without
      // any role-write hook. Agent traffic is also a fraction of user traffic.
      return resolveAgentPermissions(identity, squadId)
  }
}

export async function resolveRoleSummaries(identity: Identity, squadId?: string): Promise<ResolvedRoleSummary[]> {
  switch (identity.type) {
    case 'legacy':
    case 'system':
      return []

    case 'user':
      return resolveUserRoleSummaries(identity.userId, squadId)

    case 'agent':
      return resolveAgentRoleSummaries(identity, squadId)
  }
}

export async function hasUserPermissionWithExecutor(
  executor: Pick<typeof db, 'select'>,
  userId: string,
  permission: string,
  squadId?: string
): Promise<boolean> {
  const permissions = await resolveUserPermissions(userId, squadId, executor)
  return permissions.some((held) => permissionMatches(held, permission))
}

export async function hasPermission(identity: Identity, permission: string, squadId?: string): Promise<boolean> {
  const permissions = await resolvePermissions(identity, squadId)
  return permissions.some((held) => permissionMatches(held, permission))
}

export async function hasAnyPermission(identity: Identity, permissions: string[], squadId?: string): Promise<boolean> {
  const heldPermissions = await resolvePermissions(identity, squadId)
  return permissions.some((permission) => heldPermissions.some((held) => permissionMatches(held, permission)))
}

/**
 * Authorizes only idempotent slot cleanup for an authenticated agent after it
 * becomes dormant/terminated. The caller remains bound to its immutable agent
 * and squad identity; role resolution alone relaxes the ordinary liveness gate.
 */
export async function hasAnySlotCleanupPermission(
  identity: Identity,
  permissions: string[],
  squadId: string
): Promise<boolean> {
  if (identity.type !== 'agent') return hasAnyPermission(identity, permissions, squadId)
  const authority = await resolveAgentAuthority(identity.agentId, true)
  if (!authority || authority.squadId !== identity.squadId || authority.squadId !== squadId) return false

  let heldPermissions: string[]
  if (authority.ownerUserId) {
    heldPermissions = await resolveUserPermissions(authority.ownerUserId, squadId)
  } else {
    const roleSlug = roleSlugForAgentType(authority.agentTypeId)
    const [role] = await db
      .select({ permissions: roles.permissions })
      .from(roles)
      .where(eq(roles.slug, roleSlug))
      .limit(1)
    const [typeRow, grantedRows] = await Promise.all([
      db
        .select({ extraScopes: agentTypes.extraScopes })
        .from(agentTypes)
        .where(eq(agentTypes.id, authority.agentTypeId))
        .limit(1),
      db
        .select({ permission: agentExtraScopes.permission })
        .from(agentExtraScopes)
        .where(eq(agentExtraScopes.agentId, authority.agentId)),
    ])
    heldPermissions = [
      ...((role?.permissions as string[] | undefined) ?? []),
      ...((typeRow[0]?.extraScopes as string[] | null) ?? []),
      ...grantedRows.map((row) => row.permission),
    ]
  }
  return permissions.some((permission) => heldPermissions.some((held) => permissionMatches(held, permission)))
}

/**
 * Every enabled user holding `permission`, optionally within one squad's scope. This is the only
 * place that scans all users; use it for content-free fan-out (realtime invalidation) and
 * routability checks, never for push recipients — those resolve from bounded subscription rows.
 *
 * A constant number of queries (one), not one per user: this runs on every agent-question
 * lifecycle event, and the per-user form turned an audience resolution into a full-table scan
 * multiplied by the user count. The rows are grouped per user and evaluated through
 * {@link permissionsFromAssignments} — the same function {@link hasPermission} resolves through
 * for a single user — so the audience and the individual check agree by construction.
 *
 * A user with no assignment row in scope holds nothing and is simply absent; disabled accounts
 * are excluded by the join, exactly as before (`hasPermission` itself does NOT check
 * `disabledAt`, so this is the gate that keeps a disabled holder out of an audience).
 */
export async function getUserIdsWithPermission(permission: string, squadId?: string): Promise<string[]> {
  const rows = await db
    .select({
      userId: roleAssignments.subjectId,
      scope: roleAssignments.scope,
      squadId: roleAssignments.squadId,
      permissions: roles.permissions,
    })
    .from(roleAssignments)
    .innerJoin(roles, eq(roles.id, roleAssignments.roleId))
    // `subject_id` is text (it also holds channel ids), so the join casts the uuid side rather
    // than the other way round: casting a channel's non-uuid subject id to uuid errors out before
    // the subjectType filter can discard the row.
    .innerJoin(users, sql`${users.id}::text = ${roleAssignments.subjectId}`)
    .where(and(eq(roleAssignments.subjectType, 'user'), isNull(users.disabledAt), assignmentScopeFilter(squadId)))

  const byUser = new Map<string, PermissionAssignment[]>()
  for (const row of rows) {
    const assignments = byUser.get(row.userId) ?? []
    assignments.push({
      scope: row.scope as PermissionAssignment['scope'],
      squadId: row.squadId,
      permissions: row.permissions as string[],
    })
    byUser.set(row.userId, assignments)
  }

  const holders: string[] = []
  for (const [userId, assignments] of byUser) {
    const held = permissionsFromAssignments(assignments, squadId)
    if (held.some((granted) => permissionMatches(granted, permission))) holders.push(userId)
  }
  // Sorted, not in row order: the SELECT is unordered, and callers diff these audiences.
  return holders.sort()
}

export async function getAccessibleSquadIds(identity: Identity): Promise<string[] | 'all'> {
  // Legacy + system tokens are global automation identities; per-action scopes still gate via hasPermission.
  if (identity.type === 'legacy' || identity.type === 'system') return 'all'

  if (identity.type === 'agent') {
    const authority = await resolveAgentAuthority(identity.agentId)
    if (!authority || authority.squadId !== identity.squadId) return []
    // User-backed roots preserve the owning user's RBAC scope.
    if (authority.ownerUserId) {
      return getAccessibleSquadIds({ type: 'user', userId: authority.ownerUserId })
    }

    // Relationships authorize manager messaging, not resource visibility.
    return authority.squadId ? [authority.squadId] : []
  }

  // User identity
  const userId = identity.userId

  // Check system-scoped roles — if any has '*', return 'all'
  const systemAssignments = await db
    .select({ permissions: roles.permissions })
    .from(roleAssignments)
    .innerJoin(roles, eq(roles.id, roleAssignments.roleId))
    .where(
      and(
        eq(roleAssignments.subjectType, 'user'),
        eq(roleAssignments.subjectId, userId),
        eq(roleAssignments.scope, 'system')
      )
    )

  for (const row of systemAssignments) {
    if ((row.permissions as string[]).includes('*')) return 'all'
  }

  // Check for squad_default assignments — if any exist, return 'all'
  const squadDefaultAssignments = await db
    .select({ id: roleAssignments.id })
    .from(roleAssignments)
    .where(
      and(
        eq(roleAssignments.subjectType, 'user'),
        eq(roleAssignments.subjectId, userId),
        eq(roleAssignments.scope, 'squad_default')
      )
    )
    .limit(1)

  if (squadDefaultAssignments.length > 0) return 'all'

  // Collect specific squad IDs from squad-scoped assignments
  const squadAssignments = await db
    .select({ squadId: roleAssignments.squadId })
    .from(roleAssignments)
    .where(
      and(
        eq(roleAssignments.subjectType, 'user'),
        eq(roleAssignments.subjectId, userId),
        eq(roleAssignments.scope, 'squad'),
        isNotNull(roleAssignments.squadId)
      )
    )

  const squadIds = [...new Set(squadAssignments.map((a) => a.squadId!).filter(Boolean))]
  return squadIds
}
