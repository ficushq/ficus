import { LIVE_AGENT_STATUSES, type SquadActivityProjectionEventData } from '@ficus/shared'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { db } from '../../db'
import { agents, squads, systemTokens, users } from '../../db/schema'
import { permissionMatches, resolvePermissions, type Identity } from '../rbac'
import type { SquadActivityAccess } from '../squad/activity'

const holds = (permissions: readonly string[], permission: string) =>
  permissions.some((held) => permissionMatches(held, permission))

export async function resolveSquadActivityAccess(
  identity: Identity,
  squadId: string
): Promise<SquadActivityAccess | null> {
  const [activeSquad] = await db
    .select({ id: squads.id })
    .from(squads)
    .where(and(eq(squads.id, squadId), isNull(squads.archivedAt)))
    .limit(1)
  if (!activeSquad) return null

  if (identity.type === 'system') {
    const [activeToken] = await db
      .select({ id: systemTokens.id })
      .from(systemTokens)
      .where(and(eq(systemTokens.id, identity.systemTokenId), isNull(systemTokens.revokedAt)))
      .limit(1)
    if (!activeToken) return null
  }

  if (identity.type === 'user') {
    const [activeUser] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, identity.userId), isNull(users.disabledAt)))
      .limit(1)
    if (!activeUser) return null
  }

  let currentAgent: { squadId: string | null; ownerUserId: string | null } | null = null
  if (identity.type === 'agent') {
    const [agent] = await db
      .select({ squadId: agents.squadId, ownerUserId: agents.ownerUserId })
      .from(agents)
      .where(and(eq(agents.id, identity.agentId), inArray(agents.status, [...LIVE_AGENT_STATUSES])))
      .limit(1)
    currentAgent = agent ?? null
    if (!currentAgent) return null
    if (identity.userId) {
      if (currentAgent.ownerUserId !== identity.userId) return null
      const [activeOwner] = await db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.id, identity.userId), isNull(users.disabledAt)))
        .limit(1)
      if (!activeOwner) return null
    } else if (currentAgent.squadId !== identity.squadId || identity.squadId !== squadId) return null
  }

  const permissions = await resolvePermissions(identity, squadId)
  if (!holds(permissions, 'squads:read')) return null

  let inbox: SquadActivityAccess['inbox'] = { mode: 'none' }
  if (identity.type === 'agent' && !identity.userId && identity.squadId === squadId) {
    if (currentAgent?.squadId === squadId)
      inbox = holds(permissions, 'inbox:read-squad') ? { mode: 'all' } : { mode: 'own', recipientId: identity.agentId }
  } else if (identity.type !== 'agent' && holds(permissions, 'inbox:read')) inbox = { mode: 'all' }

  return {
    agentsRead: holds(permissions, 'agents:read'),
    workstreamsRead: holds(permissions, 'workstreams:read'),
    inbox,
  }
}

export interface GlobalActivityAccessEntry {
  squadId: string
  squadName: string
  access: SquadActivityAccess
}

/**
 * Cross-squad access enumeration for the global activity feed: every
 * non-archived squad, each resolved through the SAME per-squad
 * `resolveSquadActivityAccess` check the per-squad route uses — no separate
 * "global" permission model — filtered down to the squads that resolved
 * non-null access. A squad the caller cannot read contributes nothing here,
 * so it never reaches the projection query at all.
 */
export async function resolveGlobalActivityAccess(identity: Identity): Promise<GlobalActivityAccessEntry[]> {
  const activeSquads = await db
    .select({ id: squads.id, name: squads.name })
    .from(squads)
    .where(isNull(squads.archivedAt))
  const resolved = await Promise.all(
    activeSquads.map(async (squad) => ({ squad, access: await resolveSquadActivityAccess(identity, squad.id) }))
  )
  const entries: GlobalActivityAccessEntry[] = []
  for (const { squad, access } of resolved) {
    if (access) entries.push({ squadId: squad.id, squadName: squad.name, access })
  }
  return entries
}

export function activityAccessSignature(identity: Identity, squadId: string, access: SquadActivityAccess): string {
  const identityKey =
    identity.type === 'agent'
      ? `agent:${identity.agentId}:${identity.squadId ?? ''}:${identity.userId ?? ''}`
      : identity.type === 'user'
        ? `user:${identity.userId}`
        : identity.type === 'system'
          ? `system:${identity.systemTokenId}`
          : 'legacy'
  const inbox = access.inbox.mode === 'own' ? `own:${access.inbox.recipientId}` : access.inbox.mode
  return `${identityKey}:${squadId}:${access.agentsRead}:${access.workstreamsRead}:${inbox}`
}

export function activityEventVisible(
  access: SquadActivityAccess,
  data: Pick<SquadActivityProjectionEventData, 'accessScope' | 'inboxRecipientId'>
): boolean {
  const inboxVisible =
    access.inbox.mode === 'all' || (access.inbox.mode === 'own' && data.inboxRecipientId === access.inbox.recipientId)
  if (data.accessScope === 'agents') return access.agentsRead
  if (data.accessScope === 'workstreams') return access.workstreamsRead
  if (data.accessScope === 'inbox') return inboxVisible
  return access.workstreamsRead && inboxVisible
}

export function redactActivityEvent(
  access: SquadActivityAccess,
  data: SquadActivityProjectionEventData
): SquadActivityProjectionEventData {
  if (!data.agentTypeRequiresAgentsRead || access.agentsRead) return data
  return { ...data, item: { ...data.item, agentTypeId: null } }
}
