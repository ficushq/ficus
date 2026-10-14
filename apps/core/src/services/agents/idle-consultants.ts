import { and, asc, eq, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm'
import type { IdleConsultantsDormancyResult } from '@ficus/shared'
import { agents, db, squads } from '../../db'
import { Agent } from '../../entities/Agent'
import { createLogger } from '../../lib/infra/logger'
import { publicErrorMessage } from '../../db/errors'
import { storageAgentColumns, type StorageAgentRow } from '../storage/agents'

const log = createLogger('idle-consultants')
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Consultants in a squad idle for at least `days`: last message older than the
 * cutoff, or never messaged and created before it. Only plain idle top-level
 * consultants qualify — executing (active, waiting-input, compacting, resetting),
 * dormant, persistent, or already-requested agents are never selected.
 */
export async function findIdleConsultants(squadId: string, days: number, now = new Date()): Promise<StorageAgentRow[]> {
  const cutoff = new Date(now.getTime() - days * DAY_MS)
  return db
    .select(storageAgentColumns)
    .from(agents)
    .where(
      and(
        eq(agents.squadId, squadId),
        eq(agents.agentTypeId, 'consultant'),
        eq(agents.status, 'idle'),
        eq(agents.persist, false),
        isNull(agents.parentAgentId),
        sql`${agents.metadata}->>'pendingLifecycleTarget' IS NULL`,
        // canTerminate refuses agents on open work streams; never select one, or
        // a stuck candidate would be retried (and spend the sweep budget) forever.
        sql`NOT EXISTS (SELECT 1 FROM work_streams w WHERE ${agents.id} = ANY(w.agent_ids) AND w.status NOT IN ('done', 'canceled'))`,
        or(
          and(isNotNull(agents.lastMessageAt), lt(agents.lastMessageAt, cutoff)),
          and(isNull(agents.lastMessageAt), lt(agents.createdAt, cutoff))
        )
      )
    )
    .orderBy(asc(sql`coalesce(${agents.lastMessageAt}, ${agents.createdAt})`), asc(agents.id))
}

/**
 * Make a squad's idle consultants dormant through the ordinary terminate path.
 * The set is always recomputed here; `agentIds` (what a client previewed) can
 * only narrow it, never add to it.
 */
export async function makeIdleConsultantsDormant(
  squadId: string,
  days: number,
  options: { agentIds?: string[]; now?: Date; limit?: number; reason?: string } = {}
): Promise<IdleConsultantsDormancyResult> {
  const idle = await findIdleConsultants(squadId, days, options.now)
  const idleIds = new Set(idle.map((row) => row.id))
  const result: IdleConsultantsDormancyResult = { dormant: [], deferred: [], skipped: [] }
  let targets = idle.map((row) => row.id)
  if (options.agentIds) {
    const requested = new Set(options.agentIds)
    targets = targets.filter((id) => requested.has(id))
    for (const id of requested)
      if (!idleIds.has(id)) result.skipped.push({ id, reason: `Not a consultant idle for ${days} days in this squad` })
  }
  if (options.limit !== undefined) targets = targets.slice(0, options.limit)
  for (const id of targets) {
    try {
      const agent = await Agent.find(id, { eager: false })
      if (!agent) {
        result.skipped.push({ id, reason: 'Agent not found' })
        continue
      }
      await agent.tryTerminate()
      if (agent.pendingDormancyAt) result.deferred.push(id)
      else result.dormant.push(id)
      log.info(
        `Made idle consultant ${id} in squad ${squadId} dormant (idle at least ${days} days${options.reason ? `; ${options.reason}` : ''})`
      )
    } catch (error) {
      result.skipped.push({ id, reason: publicErrorMessage(error) })
    }
  }
  return result
}

/**
 * Lifecycle-sweep step: for each squad with `consultant_idle_dormancy_days`
 * set, make its idle consultants dormant. Bounded per tick so enabling the
 * setting on a squad with a large backlog drains gradually.
 * @returns the number of agents made (or requested to become) dormant.
 */
export async function runIdleConsultantDormancySweep(
  options: { now?: Date; maxAgents?: number; squadIds?: string[] } = {}
): Promise<number> {
  let remaining = Math.max(1, options.maxAgents ?? 10)
  const configured = await db
    .select({ id: squads.id, days: squads.consultantIdleDormancyDays })
    .from(squads)
    .where(
      and(
        isNotNull(squads.consultantIdleDormancyDays),
        isNull(squads.archivedAt),
        options.squadIds ? inArray(squads.id, options.squadIds) : undefined
      )
    )
  let count = 0
  for (const squad of configured) {
    if (remaining <= 0) break
    const result = await makeIdleConsultantsDormant(squad.id, squad.days!, {
      now: options.now,
      limit: remaining,
      reason: 'squad idle-consultant setting',
    })
    const made = result.dormant.length + result.deferred.length
    for (const skipped of result.skipped)
      log.warn(`Idle consultant ${skipped.id} in squad ${squad.id} stays live: ${skipped.reason}`)
    count += made
    remaining -= made + result.skipped.length
  }
  return count
}
