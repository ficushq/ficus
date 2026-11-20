import type { LinearTeamDirectory } from '@ficus/shared'
import { eq } from 'drizzle-orm'
import { db, squads } from '../../../db'
import { eventEmitter } from '../../../lib/infra/event-emitter'
import { isLinearTeamId, linearRouteTeamValues, resolveLinearTeamRoutes } from './team-routes'

type ListTeams = (squadId: string) => Promise<LinearTeamDirectory>

async function storedRoutes(squadId: string): Promise<unknown> {
  const [squad] = await db.select({ metadata: squads.metadata }).from(squads).where(eq(squads.id, squadId))
  return (squad?.metadata as Record<string, unknown> | null)?.linear
}

/** Resolves a squad metadata write's `linear` routes to team IDs before it is stored. */
export async function resolveSquadLinearTeamRoutes(squadId: string, routes: unknown, listTeams: ListTeams) {
  return resolveLinearTeamRoutes({
    routes,
    stored: linearRouteTeamValues(await storedRoutes(squadId)),
    listTeams: () => listTeams(squadId),
  })
}

/**
 * Rewrites stored routes saved by team key (from before the team picker) to team IDs, through the
 * squad's Linear connections. A value no listed team matches stays as it is. The write applies only when
 * the routes are unchanged since they were read, so it never overwrites a concurrent save.
 * Returns true when the stored routes changed.
 */
export async function reconcileSquadLinearTeamRoutes(squadId: string, listTeams: ListTeams): Promise<boolean> {
  const routes = await storedRoutes(squadId)
  const values = linearRouteTeamValues(routes)
  if (values.every(isLinearTeamId)) return false
  const resolved = await resolveLinearTeamRoutes({ routes, stored: values, listTeams: () => listTeams(squadId) })
  const before = JSON.stringify(routes)
  if (JSON.stringify(resolved) === before) return false
  const changed = await db.transaction(async (tx) => {
    const [current] = await tx
      .select({ metadata: squads.metadata })
      .from(squads)
      .where(eq(squads.id, squadId))
      .for('update')
    const metadata = (current?.metadata as Record<string, unknown> | null) ?? null
    if (!metadata || JSON.stringify(metadata.linear) !== before) return false
    await tx
      .update(squads)
      .set({ metadata: { ...metadata, linear: resolved }, updatedAt: new Date() })
      .where(eq(squads.id, squadId))
    return true
  })
  if (changed) eventEmitter.emit('squad.updated', { squadId })
  return changed
}
