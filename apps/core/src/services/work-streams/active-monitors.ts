import { and, eq, inArray, or } from 'drizzle-orm'
import { db } from '../../db'
import { agents, monitors } from '../../db/schema'
import { Monitor } from '../../entities/Monitor'

/**
 * Read-only presentation context: which of the given agents are waiting on a
 * live background monitor, either their own or one owned by a direct subagent.
 * One query for the whole batch. It never wakes, suspends or schedules work and
 * exposes no monitor details (labels, commands, counts) beyond the agent id.
 */
export async function loadAgentsWithActiveMonitors(agentIds: string[]): Promise<Set<string>> {
  const monitoring = new Set<string>()
  if (agentIds.length === 0) return monitoring
  const rows = await db
    .selectDistinct({ agentId: monitors.agentId, parentAgentId: agents.parentAgentId })
    .from(monitors)
    .innerJoin(agents, eq(agents.id, monitors.agentId))
    .where(
      and(
        inArray(monitors.status, Monitor.activeStatuses()),
        or(inArray(monitors.agentId, agentIds), inArray(agents.parentAgentId, agentIds))
      )
    )
  const requested = new Set(agentIds)
  for (const { agentId, parentAgentId } of rows) {
    if (requested.has(agentId)) monitoring.add(agentId)
    if (parentAgentId && requested.has(parentAgentId)) monitoring.add(parentAgentId)
  }
  return monitoring
}
