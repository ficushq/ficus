import { and, eq, inArray, or, sql, type SQL } from 'drizzle-orm'
import { agents, db, monitors, type DbTx } from '../../db'
import { MONITOR_LIVENESS_WINDOW_MS } from './liveness'

/**
 * The one definition of a "live" monitor, shared by the squad stall alert
 * (fleet demand) and the work-stream idle nudge (continuation) so the two can
 * never disagree about whether an idle agent is waiting on supervised work.
 *
 * Live means: `running`, no pending relaunch, a process confirmation within
 * `MONITOR_LIVENESS_WINDOW_MS` of `now` (event-only monitors can be silent for
 * hours, so stdout is not the signal), and its absolute deadline not yet
 * passed. `markRunning` stamps the confirmation before the monitor tool
 * returns, so a monitor created just before the agent ended its turn is
 * already live; `starting` only exists while that tool call (and therefore the
 * agent's execution) is still in flight.
 *
 * Renders against the unaliased `monitors` table; callers must not alias it.
 */
export function liveMonitorCondition(now: Date): SQL {
  const cutoff = new Date(now.getTime() - MONITOR_LIVENESS_WINDOW_MS).toISOString()
  return sql`(${monitors.status} = 'running'
    AND ${monitors.nextRestartAt} IS NULL
    AND ${monitors.lastConfirmedAliveAt} >= ${cutoff}::timestamptz
    AND COALESCE(${monitors.deadlineAt},
      COALESCE(${monitors.startedAt}, ${monitors.createdAt}) + ${monitors.timeoutMs} * interval '1 millisecond')
      > ${now.toISOString()}::timestamptz)`
}

/**
 * Which of `agentIds` are waiting on a live monitor: their own, or one owned
 * by a direct subagent (matching the Monitoring presentation in
 * `work-streams/active-monitors.ts`). One set-based query for the whole batch.
 * Read-only; callers holding a transaction pass it so the check sees the same
 * snapshot as their other in-transaction facts.
 */
export async function listAgentsWithLiveMonitors(
  store: typeof db | DbTx,
  agentIds: string[],
  now: Date
): Promise<Set<string>> {
  const monitoring = new Set<string>()
  if (agentIds.length === 0) return monitoring
  const rows = await store
    .selectDistinct({ agentId: monitors.agentId, parentAgentId: agents.parentAgentId })
    .from(monitors)
    .innerJoin(agents, eq(agents.id, monitors.agentId))
    .where(
      and(or(inArray(monitors.agentId, agentIds), inArray(agents.parentAgentId, agentIds)), liveMonitorCondition(now))
    )
  const requested = new Set(agentIds)
  for (const { agentId, parentAgentId } of rows) {
    if (requested.has(agentId)) monitoring.add(agentId)
    if (parentAgentId && requested.has(parentAgentId)) monitoring.add(parentAgentId)
  }
  return monitoring
}
