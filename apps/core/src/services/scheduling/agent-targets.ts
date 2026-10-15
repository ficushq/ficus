import { sql, type SQL } from 'drizzle-orm'
import { schedules } from '../../db/schema'

/**
 * Schedules that name an agent directly: agent-scoped, or an action whose
 * target, assignee or agent list holds it. `agentId` is a text-valued SQL
 * expression — a bound id (sql`${id}`) or a correlated column (sql`${agents.id}::text`).
 *
 * Shared by target discovery (Schedule.listTargetingAgent), dormancy
 * reconciliation and the idle-worker sweep, so they agree on what "targets
 * this agent" means. A squad-manager target is resolved separately by callers
 * that need it, since it names the squad rather than the agent.
 */
export function scheduleNamesAgent(agentId: SQL): SQL {
  return sql`(
    (${schedules.scopeType} = 'agent' AND ${schedules.scopeId} = (${agentId})::uuid)
    OR ${schedules.action}->'target'->>'agentId' = (${agentId})::text
    OR ${schedules.action}->>'assigneeAgentId' = (${agentId})::text
    OR ${schedules.action}->'agentIds' @> jsonb_build_array((${agentId})::text)
  )`
}
