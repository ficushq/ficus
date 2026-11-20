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
import { isLinearTeamId, linearEventRuleTeamKeys, linearRouteTeamValues } from './team-routes'

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.length > 0 && item.length <= 200)
    : []
}

/**
 * `PermissionChange` `teamAccessChanged` (5.8): record which teams the app can access, mark sessions
 * on removed teams `inaccessible`, and tell each bound stream's owner once.
 */
export async function applyLinearPermissionChange(
  connectionId: string,
  payload: Record<string, unknown>,
  authorization: string
) {
  const added = strings(payload.addedTeamIds)
  const removed = strings(payload.removedTeamIds)
  const canAccessAllPublicTeams = payload.canAccessAllPublicTeams === true
  // A change is a delta: with nothing recorded yet, start from the full listing (taken after the
  // change), or the record would hold only the delta and rule out every other readable team.
  const [existing] = await db
    .select({ connectionId: linearTeamAccess.connectionId })
    .from(linearTeamAccess)
    .where(eq(linearTeamAccess.connectionId, connectionId))
  const listed = existing ? [] : await listLinearTeamIds(authorization)
  await db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(linearTeamAccess)
      .where(eq(linearTeamAccess.connectionId, connectionId))
      .for('update')
    const teamIds = [...new Set([...(current?.teamIds ?? listed), ...added])].filter((id) => !removed.includes(id))
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
  const teamIds = await listLinearTeamIds(authorization)
  await db
    .insert(linearTeamAccess)
    .values({ connectionId, canAccessAllPublicTeams: false, teamIds, source: 'probe' })
    .onConflictDoNothing({ target: linearTeamAccess.connectionId })
}

async function squadLinearRoutes(squadId: string): Promise<unknown> {
  const [squad] = await db.select({ metadata: squads.metadata }).from(squads).where(eq(squads.id, squadId))
  return (squad?.metadata as Record<string, unknown> | null)?.linear
}

/**
 * Routed Linear team IDs the squad's app connection is known not to reach, for the squad Integrations
 * tab. Only real team IDs are judged: a value saved by team key never matches any team, so it is
 * reported as a key instead of as a team the app cannot access. Empty for API-key connections and when
 * access has not been recorded.
 */
export async function inaccessibleLinearTeams(squadId: string, connectionId: string): Promise<string[]> {
  const [access] = await db.select().from(linearTeamAccess).where(eq(linearTeamAccess.connectionId, connectionId))
  if (!access || access.canAccessAllPublicTeams) return []
  return linearRouteTeamValues(await squadLinearRoutes(squadId))
    .filter(isLinearTeamId)
    .filter((teamId) => !access.teamIds.includes(teamId))
}

/**
 * Squad setup issues for Linear routing, naming the squad: routes and event-rule team filters saved by
 * team key rather than team ID (they match nothing), and routed team IDs the assigned agent app cannot
 * access (5.8). API-key connections and unrecorded access report no access issue.
 */
export async function linearTeamAccessSetupIssues(): Promise<string[]> {
  const assigned = await db
    .select({
      squadId: squads.id,
      squadName: squads.name,
      metadata: squads.metadata,
      connectionId: integrationConnectionAssignments.connectionId,
    })
    .from(integrationConnectionAssignments)
    .innerJoin(squads, eq(squads.id, integrationConnectionAssignments.squadId))
    .where(and(eq(integrationConnectionAssignments.providerKey, 'linear'), eq(squads.status, 'active')))
  const recorded = new Set(
    assigned.length
      ? (
          await db
            .select({ connectionId: linearTeamAccess.connectionId })
            .from(linearTeamAccess)
            .where(
              inArray(
                linearTeamAccess.connectionId,
                assigned.map((row) => row.connectionId)
              )
            )
        ).map((row) => row.connectionId)
      : []
  )
  const issues: string[] = []
  // A squad with several attached Linear connections names its key routes and rule filters once.
  const keyChecked = new Set<string>()
  for (const row of assigned) {
    const keys = keyChecked.has(row.squadId)
      ? []
      : linearRouteTeamValues((row.metadata as Record<string, unknown> | null)?.linear).filter(
          (value) => !isLinearTeamId(value)
        )
    const ruleKeys = keyChecked.has(row.squadId)
      ? []
      : linearEventRuleTeamKeys(
          (row.metadata as { integrationRules?: { linear?: unknown } } | null)?.integrationRules?.linear
        )
    keyChecked.add(row.squadId)
    if (keys.length)
      issues.push(
        `Squad ${row.squadName} routes Linear ${keys.length === 1 ? 'team key' : 'team keys'} ${keys.join(', ')}, which ${keys.length === 1 ? 'is not a team ID' : 'are not team IDs'}, so ${keys.length === 1 ? 'it routes' : 'they route'} no Linear events. Open the squad's Linear settings and choose the ${keys.length === 1 ? 'team' : 'teams'} so Ficus stores the team ID.`
      )
    if (ruleKeys.length)
      issues.push(
        `Squad ${row.squadName} has ${ruleKeys.length === 1 ? 'a Linear event rule' : 'Linear event rules'} whose team filter is not a team ID, so ${ruleKeys.length === 1 ? 'it matches' : 'they match'} no Linear events: ${ruleKeys.map((key) => `rule ${key.ruleId} (team key ${key.value} is not a team ID)`).join(', ')}. Open the squad's Linear event rules and choose the team in each Team filter so Ficus stores the team ID.`
      )
    if (!recorded.has(row.connectionId)) continue
    const teams = await inaccessibleLinearTeams(row.squadId, row.connectionId)
    if (teams.length)
      issues.push(
        `Squad ${row.squadName} routes Linear ${teams.length === 1 ? 'team' : 'teams'} ${teams.join(', ')}, which the Ficus app cannot access. A Linear admin can grant access in the Ficus app settings in Linear.`
      )
  }
  return issues
}

/** Every team the app can list, page by page (bounded), so a large workspace never looks partly inaccessible. */
async function listLinearTeamIds(authorization: string): Promise<string[]> {
  const teamIds: string[] = []
  let after: string | null = null
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
  return teamIds
}
