import { and, eq, isNull, inArray, sql } from 'drizzle-orm'
import { db, type DbTx } from '../../../db'
import {
  githubPersonalIdentities,
  integrationAuditEvents,
  roleAssignments,
  roles,
  squads,
  users,
} from '../../../db/schema'
import { eventEmitter } from '../../../lib/infra/event-emitter'
import {
  permissionMatches,
  permissionsFromAssignments,
  type Identity,
  type PermissionAssignment,
} from '../../rbac/permissions'
import { GitHubFeedbackError, requireGitHubHuman, githubAuthorityActor } from './feedback-trust'
import { lockGitHubTrustAuthority } from './trust-authority-lock'

const DEFAULT_SQUAD = 'github:future-squad'

async function snapshot(tx: DbTx, actorId?: string) {
  const linked = await tx
    .select({ userId: githubPersonalIdentities.userId, disabledAt: users.disabledAt })
    .from(githubPersonalIdentities)
    .innerJoin(users, eq(users.id, githubPersonalIdentities.userId))
    .where(and(isNull(githubPersonalIdentities.unlinkedAt), sql`${githubPersonalIdentities.accountId} IS NOT NULL`))
  const assignments = await tx
    .select({
      userId: roleAssignments.subjectId,
      scope: roleAssignments.scope,
      squadId: roleAssignments.squadId,
      permissions: roles.permissions,
    })
    .from(roleAssignments)
    .innerJoin(roles, eq(roles.id, roleAssignments.roleId))
    .where(
      and(
        eq(roleAssignments.subjectType, 'user'),
        inArray(roleAssignments.subjectId, [...linked.map((row) => row.userId), ...(actorId ? [actorId] : [])])
      )
    )
  const byUser = new Map<string, PermissionAssignment[]>()
  for (const row of assignments) {
    const rows = byUser.get(row.userId) ?? []
    rows.push({
      scope: row.scope as PermissionAssignment['scope'],
      squadId: row.squadId,
      permissions: row.permissions as string[],
    })
    byUser.set(row.userId, rows)
  }
  const squadRows = await tx.select({ id: squads.id }).from(squads)
  // Defaults/system wildcards affect future squads too. A currently masked
  // default must not become an automated grant when a new squad is created.
  squadRows.push({ id: DEFAULT_SQUAD })
  const canUpdate = (userId: string, squadId: string) =>
    permissionsFromAssignments(byUser.get(userId) ?? [], squadId).some((p) => permissionMatches(p, 'squads:update'))
  const trusted = new Map<string, { userId: string; squadId: string }>()
  for (const user of linked)
    if (!user.disabledAt)
      for (const squad of squadRows)
        if (canUpdate(user.userId, squad.id))
          trusted.set(`${user.userId}:${squad.id}`, { userId: user.userId, squadId: squad.id })
  return { trusted, canUpdate }
}

/**
 * Trust-affecting API RBAC/account mutations use this transaction. Compare the actual effective
 * dynamic grant, not permission spellings: overrides, defaults, wildcards, redundant
 * assignments and disabled users follow the existing resolver exactly. No network I/O.
 * Link confirmation takes the same lock BEFORE its user/proof locks, so an unlinked
 * target cannot become linked between the snapshot and an automated write.
 */
export async function withGitHubTrustMutation<T>(
  identity: Identity | undefined,
  targetId: string,
  mutate: (tx: DbTx) => Promise<T>,
  options: { credentials?: boolean } = {}
): Promise<T> {
  try {
    const { result, affected } = await db.transaction(async (tx) => {
      await lockGitHubTrustAuthority(tx)
      const before = await snapshot(tx, identity?.type === 'user' ? identity.userId : undefined)
      // Capture authority before the write: self-demotion must not invent new authority.
      const actor = identity?.type === 'user' ? await requireGitHubHuman(tx, identity) : null
      if (options.credentials) {
        if (!actor) throw new GitHubFeedbackError('human_required', 403)
        for (const grant of before.trusted.values())
          if (grant.userId === targetId && !before.canUpdate(actor, grant.squadId))
            throw new GitHubFeedbackError('squad_update_required', 403)
      }
      const result = await mutate(tx)
      const after = await snapshot(tx, identity?.type === 'user' ? identity.userId : undefined)
      const changed = new Map(
        [...before.trusted, ...after.trusted].filter(([key]) => before.trusted.has(key) !== after.trusted.has(key))
      )
      const [remainingActor] = actor ? await tx.select({ id: users.id }).from(users).where(eq(users.id, actor)) : []
      if (options.credentials)
        await tx.insert(integrationAuditEvents).values({
          actorKey: githubAuthorityActor(identity),
          userId: remainingActor?.id ?? null,
          action: 'github.authority.credentials',
          outcome: 'allowed',
          targetKind: 'user',
          targetId,
        })
      for (const { userId, squadId } of changed.values()) {
        if (!actor) throw new GitHubFeedbackError('human_required', 403)
        if (!before.canUpdate(actor, squadId)) throw new GitHubFeedbackError('squad_update_required', 403)
        await tx.insert(integrationAuditEvents).values({
          actorKey: githubAuthorityActor(identity),
          userId: remainingActor?.id ?? null,
          squadId: squadId === DEFAULT_SQUAD ? null : squadId,
          action: 'github.trust.authority',
          outcome: 'allowed',
          targetKind: 'user',
          targetId: userId,
          code: after.trusted.has(`${userId}:${squadId}`) ? 'dynamic_grant' : 'dynamic_revoke',
        })
      }
      return { result, affected: [...new Set([...changed.values()].map((row) => row.squadId))] }
    })
    // Existing squad invalidation is content/count-free, emitted only after commit.
    for (const squadId of affected) if (squadId !== DEFAULT_SQUAD) eventEmitter.emit('squad.updated', { squadId })
    return result
  } catch (error) {
    if (error instanceof GitHubFeedbackError)
      await db.insert(integrationAuditEvents).values({
        actorKey: githubAuthorityActor(identity),
        action: options.credentials ? 'github.authority.credentials' : 'github.trust.authority',
        outcome: 'denied',
        targetKind: 'authority_mutation',
        targetId,
        code: error.code,
      })
    throw error
  }
}
