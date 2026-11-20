import type { LinearTeamDirectory } from '@ficus/shared'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { db, squads } from '../../../db'
import { eventEmitter } from '../../../lib/infra/event-emitter'
import {
  isLinearTeamId,
  linearEventRuleTeamValues,
  linearRouteTeamValues,
  resolveLinearEventRuleTeams,
  resolveLinearTeamRoutes,
} from './team-routes'

type ListTeams = (squadId: string) => Promise<LinearTeamDirectory>

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

/** The squad's Linear team routes and Linear event rules, as stored. */
function linearTeamSettings(metadata: unknown): { routes: unknown; rules: unknown } {
  const stored = record(metadata)
  return { routes: stored?.linear, rules: record(stored?.integrationRules)?.linear }
}

async function storedMetadata(squadId: string): Promise<unknown> {
  const [squad] = await db.select({ metadata: squads.metadata }).from(squads).where(eq(squads.id, squadId))
  return squad?.metadata
}

/** Resolves a squad metadata write's `linear` routes to team IDs before it is stored. */
export async function resolveSquadLinearTeamRoutes(squadId: string, routes: unknown, listTeams: ListTeams) {
  return resolveLinearTeamRoutes({
    routes,
    stored: linearRouteTeamValues(linearTeamSettings(await storedMetadata(squadId)).routes),
    listTeams: () => listTeams(squadId),
  })
}

/** Resolves the team filters of a squad metadata write's Linear event rules to team IDs before they are stored. */
export async function resolveSquadLinearEventRuleTeams(squadId: string, rules: unknown, listTeams: ListTeams) {
  return resolveLinearEventRuleTeams({
    rules,
    stored: linearEventRuleTeamValues(linearTeamSettings(await storedMetadata(squadId)).rules),
    listTeams: () => listTeams(squadId),
  })
}

/** True when a stored route or event-rule team filter is not a team ID, so it matches no Linear event. */
function hasStoredTeamKeys(metadata: unknown): boolean {
  const { routes, rules } = linearTeamSettings(metadata)
  return [...linearRouteTeamValues(routes), ...linearEventRuleTeamValues(rules)].some((value) => !isLinearTeamId(value))
}

/**
 * Rewrites stored routes and event-rule team filters saved by team key to team IDs, through the squad's
 * Linear connections. A value no listed team matches stays as it is (setup status names it). The write
 * applies only when both are unchanged since they were read, so it never overwrites a concurrent save.
 * Returns true when the stored values changed.
 *
 * This writes squad metadata, so it runs only from write paths and the startup backfill, never from a
 * read: attaching a Linear connection to the squad, and {@link reconcileStoredLinearTeamKeys}.
 */
export async function reconcileSquadLinearTeamRoutes(squadId: string, listTeams: ListTeams): Promise<boolean> {
  const metadata = await storedMetadata(squadId)
  if (!hasStoredTeamKeys(metadata)) return false
  const { routes, rules } = linearTeamSettings(metadata)
  // One listing serves both; the directory caches it anyway, but a reconcile should ask Linear once.
  let listing: Promise<LinearTeamDirectory> | undefined
  const listOnce = () => (listing ??= listTeams(squadId))
  const resolvedRoutes = await resolveLinearTeamRoutes({
    routes,
    stored: linearRouteTeamValues(routes),
    listTeams: listOnce,
  })
  const resolvedRules = await resolveLinearEventRuleTeams({
    rules,
    stored: linearEventRuleTeamValues(rules),
    listTeams: listOnce,
  })
  const before = JSON.stringify({ routes, rules })
  if (JSON.stringify({ routes: resolvedRoutes, rules: resolvedRules }) === before) return false
  const changed = await db.transaction(async (tx) => {
    const [current] = await tx
      .select({ metadata: squads.metadata })
      .from(squads)
      .where(eq(squads.id, squadId))
      .for('update')
    const latest = record(current?.metadata)
    if (!latest || JSON.stringify(linearTeamSettings(latest)) !== before) return false
    const next: Record<string, unknown> = { ...latest }
    if (routes !== undefined) next.linear = resolvedRoutes
    if (rules !== undefined) next.integrationRules = { ...record(latest.integrationRules), linear: resolvedRules }
    await tx.update(squads).set({ metadata: next, updatedAt: new Date() }).where(eq(squads.id, squadId))
    return true
  })
  if (changed) eventEmitter.emit('squad.updated', { squadId })
  return changed
}

/**
 * Startup backfill: rewrites team keys still stored in any live squad's Linear routes or event-rule
 * team filters (saved before keys were resolved on write) to team IDs. Squads with nothing to resolve
 * cost no Linear call, so it is cheap to run on every start; a squad Linear cannot answer for is
 * skipped and retried on the next start. Returns the number of squads it changed.
 */
export async function reconcileStoredLinearTeamKeys(
  listTeams: ListTeams,
  onError: (squadId: string, error: unknown) => void = () => {}
): Promise<number> {
  const candidates = await db
    .select({ id: squads.id, metadata: squads.metadata })
    .from(squads)
    .where(
      and(
        isNull(squads.archivedAt),
        sql`(${squads.metadata}->'linear' IS NOT NULL OR jsonb_typeof(${squads.metadata}->'integrationRules'->'linear') = 'array')`
      )
    )
  let changed = 0
  for (const candidate of candidates) {
    if (!hasStoredTeamKeys(candidate.metadata)) continue
    try {
      if (await reconcileSquadLinearTeamRoutes(candidate.id, listTeams)) changed++
    } catch (error) {
      onError(candidate.id, error)
    }
  }
  return changed
}
