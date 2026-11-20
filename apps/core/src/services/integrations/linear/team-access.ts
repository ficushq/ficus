import { and, eq, inArray, ne } from 'drizzle-orm'
import { db, linearAgentSessions, linearTeamAccess, squads, workStreams } from '../../../db'
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

/** Fast pre-filter only: true when recorded access excludes the team. The live probe stays authoritative. */
export async function isTeamKnownInaccessible(connectionId: string, teamId: string): Promise<boolean> {
  const [access] = await db.select().from(linearTeamAccess).where(eq(linearTeamAccess.connectionId, connectionId))
  return !!access && !access.canAccessAllPublicTeams && !access.teamIds.includes(teamId)
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
  const data = await linearQuery<{ teams?: { nodes?: Array<{ id?: string }> } }>(
    authorization,
    'query FicusLinearTeams { teams(first: 250) { nodes { id } } }'
  )
  const teamIds = strings((data.teams?.nodes ?? []).map((team) => team.id))
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
