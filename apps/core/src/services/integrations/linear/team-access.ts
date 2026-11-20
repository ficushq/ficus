import { and, eq, inArray, ne, sql } from 'drizzle-orm'
import {
  db,
  integrationConnectionAssignments,
  linearAgentSessions,
  linearTeamAccess,
  squads,
  workStreams,
} from '../../../db'
import { InboxMessage } from '../../../entities/InboxMessage'
import { linearQuery } from './plugin'

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.length > 0 && item.length <= 200)
    : []
}

/**
 * `PermissionChange` `teamAccessChanged` (5.8): record which teams the app can access, mark sessions
 * on removed teams `inaccessible`, and tell each bound stream's owner once.
 */
export async function applyLinearPermissionChange(connectionId: string, payload: Record<string, unknown>) {
  const added = strings(payload.addedTeamIds)
  const removed = strings(payload.removedTeamIds)
  const canAccessAllPublicTeams = payload.canAccessAllPublicTeams === true
  await db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(linearTeamAccess)
      .where(eq(linearTeamAccess.connectionId, connectionId))
      .for('update')
    const teamIds = [...new Set([...(current?.teamIds ?? []), ...added])].filter((id) => !removed.includes(id))
    const values = { canAccessAllPublicTeams, teamIds, observedAt: new Date(), source: 'webhook' as const }
    await tx
      .insert(linearTeamAccess)
      .values({ connectionId, ...values })
      .onConflictDoUpdate({ target: linearTeamAccess.connectionId, set: values })
  })
  if (!removed.length) return
  const sessions = await db
    .update(linearAgentSessions)
    .set({ disposition: 'inaccessible', updatedAt: new Date() })
    .where(
      and(
        eq(linearAgentSessions.connectionId, connectionId),
        inArray(linearAgentSessions.teamId, removed),
        ne(linearAgentSessions.disposition, 'inaccessible')
      )
    )
    .returning()
  for (const session of sessions) {
    if (!session.workStreamId) continue
    const [stream] = await db
      .select({ ownerAgentId: workStreams.ownerAgentId, title: workStreams.title })
      .from(workStreams)
      .where(eq(workStreams.id, session.workStreamId))
    if (!stream?.ownerAgentId) continue
    await InboxMessage.sendOnce(
      {
        recipientId: stream.ownerAgentId,
        senderType: 'system',
        subject: 'Linear session no longer accessible',
        content: `The Ficus app lost access to the Linear team of ${session.issueIdentifier ?? 'the issue'} that this work stream is linked to, so Ficus stops posting progress to its Linear agent session. A Linear admin can grant the team access again in the Ficus app settings.`,
        metadata: { source: 'linear-session', workStreamId: session.workStreamId },
        wakeEligible: true,
      },
      `linear-session-inaccessible:${session.id}`
    )
  }
}

/**
 * Fast pre-filter only: true when a `PermissionChange` from Linear says the app has no access to the
 * team. A record seeded by Ficus's own team listing never rejects on its own; the live probe decides.
 */
export async function isTeamKnownInaccessible(connectionId: string, teamId: string): Promise<boolean> {
  const [access] = await db.select().from(linearTeamAccess).where(eq(linearTeamAccess.connectionId, connectionId))
  return !!access && access.source === 'webhook' && !access.canAccessAllPublicTeams && !access.teamIds.includes(teamId)
}

/** The live probe read an issue on this team, so the app can access it: keep the record in step. */
export async function recordLinearTeamReadable(connectionId: string, teamId: string) {
  await db
    .update(linearTeamAccess)
    .set({ teamIds: sql`array_append(${linearTeamAccess.teamIds}, ${teamId}::text)`, observedAt: new Date() })
    .where(
      and(
        eq(linearTeamAccess.connectionId, connectionId),
        sql`NOT (${teamId}::text = ANY(${linearTeamAccess.teamIds}))`
      )
    )
}

/**
 * Records the teams the app can read when nothing is recorded yet, from one `teams` query.
 * `PermissionChange` webhooks keep it current afterwards.
 */
export async function recordLinearTeamAccessProbe(connectionId: string, authorization: string) {
  const [existing] = await db
    .select({ connectionId: linearTeamAccess.connectionId })
    .from(linearTeamAccess)
    .where(eq(linearTeamAccess.connectionId, connectionId))
  if (existing) return
  const teamIds: string[] = []
  let after: string | null = null
  // Every page, bounded: a workspace with more teams than one page must not look partly inaccessible.
  for (let page = 0; page < 20; page++) {
    const data: {
      teams?: { nodes?: Array<{ id?: string }>; pageInfo?: { hasNextPage?: boolean; endCursor?: string } }
    } = await linearQuery(
      authorization,
      'query FicusLinearTeams($after: String) { teams(first: 250, after: $after) { nodes { id } pageInfo { hasNextPage endCursor } } }',
      { after }
    )
    teamIds.push(...strings((data.teams?.nodes ?? []).map((team) => team.id)))
    if (!data.teams?.pageInfo?.hasNextPage || !data.teams.pageInfo.endCursor) break
    after = data.teams.pageInfo.endCursor
  }
  await db
    .insert(linearTeamAccess)
    .values({ connectionId, canAccessAllPublicTeams: false, teamIds, source: 'probe' })
    .onConflictDoNothing({ target: linearTeamAccess.connectionId })
}

/**
 * Routed Linear teams the squad's app connection is known not to reach, for the squad Integrations
 * tab. Empty for API-key connections and when access has not been recorded.
 */
export async function inaccessibleLinearTeams(squadId: string, connectionId: string): Promise<string[]> {
  const [access] = await db.select().from(linearTeamAccess).where(eq(linearTeamAccess.connectionId, connectionId))
  if (!access || access.canAccessAllPublicTeams) return []
  const [squad] = await db.select({ metadata: squads.metadata }).from(squads).where(eq(squads.id, squadId))
  const routes = (squad?.metadata as Record<string, unknown> | null)?.linear
  const teamIds = (Array.isArray(routes) ? routes : [routes])
    .map((route) => (route && typeof route === 'object' ? (route as Record<string, unknown>).teamId : undefined))
    .filter((teamId): teamId is string => typeof teamId === 'string' && teamId.length > 0)
  return [...new Set(teamIds)].filter((teamId) => !access.teamIds.includes(teamId))
}

/**
 * One setup issue per squad that routes Linear teams its assigned agent app cannot access (5.8),
 * naming the squad and the team IDs. API-key connections and unrecorded access report nothing.
 */
export async function linearTeamAccessSetupIssues(): Promise<string[]> {
  const rows = await db
    .select({ squadId: squads.id, squadName: squads.name, connectionId: linearTeamAccess.connectionId })
    .from(linearTeamAccess)
    .innerJoin(
      integrationConnectionAssignments,
      and(
        eq(integrationConnectionAssignments.connectionId, linearTeamAccess.connectionId),
        eq(integrationConnectionAssignments.providerKey, 'linear')
      )
    )
    .innerJoin(squads, eq(squads.id, integrationConnectionAssignments.squadId))
    .where(eq(squads.status, 'active'))
  const issues: string[] = []
  for (const row of rows) {
    const teams = await inaccessibleLinearTeams(row.squadId, row.connectionId)
    if (teams.length)
      issues.push(
        `Squad ${row.squadName} routes Linear ${teams.length === 1 ? 'team' : 'teams'} ${teams.join(', ')}, which the Ficus app cannot access. A Linear admin can grant access in the Ficus app settings in Linear.`
      )
  }
  return issues
}
