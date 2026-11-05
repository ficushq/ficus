import { consultantSandboxSquadId } from '../sandbox/consultant-sandbox'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { agents, db, executions, monitors } from '../../db'
import { ARTIFACT_BUILDER_AGENT_TYPE_ID } from '../../entities/agent-runners/constants'
import type { DbExecutor } from './force-migration-audit'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface SandboxActivity {
  active: boolean
  /** Count is absent when the sandbox owner cannot be derived safely. */
  activeExecutionCount?: number
  /** Live monitors on the sandbox; present only when there is one and no execution is active. */
  liveMonitorCount?: number
}

/**
 * Monitor statuses whose process is still on the box: a monitor outlives the
 * agent turn that started it (the agent ends its turn and waits on it), so an
 * agent with no execution can still have work running there. `canceling` is
 * included because its process has not exited yet.
 */
export const LIVE_MONITOR_STATUSES = ['starting', 'running', 'canceling'] as const

async function liveMonitorCount(sandboxId: string, executor: DbExecutor = db): Promise<number> {
  const [row] = await executor
    .select({ count: sql<number>`count(*)::int` })
    .from(monitors)
    .where(and(eq(monitors.sandboxId, sandboxId), inArray(monitors.status, [...LIVE_MONITOR_STATUSES])))
  return row?.count ?? 0
}

async function ownerActivity(seedWhere: ReturnType<typeof sql>, executor: DbExecutor = db): Promise<SandboxActivity> {
  const rows = (await executor.execute(sql`
    WITH RECURSIVE owners AS (
      SELECT ${agents.id} AS id FROM ${agents} WHERE ${seedWhere}
      UNION
      SELECT a.id FROM ${agents} a JOIN owners o ON a.parent_agent_id = o.id
    )
    SELECT count(*)::int AS count FROM ${executions} e
    JOIN owners o ON e.agent_id = o.id
    WHERE e.status IN ('queued', 'waiting-sandbox', 'running', 'stopping')
  `)) as unknown as Array<{ count: number }>
  const activeExecutionCount = rows[0]?.count ?? 0
  return { active: activeExecutionCount > 0, activeExecutionCount }
}

/**
 * Whether work is running in a sandbox: an active execution of an agent that
 * can use it, or a live monitor on it. Callers use this to avoid restarting,
 * migrating or recreating a box under running work, and a monitor's process
 * dies with the box unit just like an execution's commands. Unknown sandbox
 * IDs fail safe as active so destructive callers choose the longer grace tier.
 */
export async function sandboxActivity(sandboxId: string, executor: DbExecutor = db): Promise<SandboxActivity> {
  const execution = await executionActivity(sandboxId, executor)
  if (execution.active) return execution
  const monitorsLive = await liveMonitorCount(sandboxId, executor)
  return monitorsLive > 0 ? { ...execution, active: true, liveMonitorCount: monitorsLive } : execution
}

async function executionActivity(sandboxId: string, executor: DbExecutor = db): Promise<SandboxActivity> {
  const consultantSquad = consultantSandboxSquadId(sandboxId)
  if (consultantSquad) {
    if (!UUID_RE.test(consultantSquad)) return { active: true }
    return ownerActivity(sql`${agents.squadId} = ${consultantSquad} AND ${agents.agentTypeId} = 'consultant'`, executor)
  }
  if (sandboxId.startsWith('system_manager_')) {
    const userId = sandboxId.slice('system_manager_'.length)
    if (!UUID_RE.test(userId)) return { active: true }
    return ownerActivity(
      sql`${agents.ownerUserId} = ${userId} AND ${agents.agentTypeId} IN ('system-manager', 'assistant', 'assistant-worker')`,
      executor
    )
  }

  if (sandboxId.startsWith('agent_')) {
    const agentId = sandboxId.slice('agent_'.length)
    if (!UUID_RE.test(agentId)) return { active: true }
    return ownerActivity(sql`${agents.id} = ${agentId}`, executor)
  }

  if (sandboxId.startsWith('squad_')) {
    const squadId = sandboxId.slice('squad_'.length)
    if (!UUID_RE.test(squadId)) return { active: true }
    const rows = (await executor.execute(sql`
      SELECT count(*)::int AS count FROM ${executions} e
      JOIN ${agents} a ON e.agent_id = a.id
      WHERE a.squad_id = ${squadId}
        AND (a.parent_agent_id IS NOT NULL OR a.agent_type_id NOT IN ('system-manager', 'assistant', 'assistant-worker', ${ARTIFACT_BUILDER_AGENT_TYPE_ID}))
        AND e.status IN ('running', 'stopping')
    `)) as unknown as Array<{ count: number }>
    const activeExecutionCount = rows[0]?.count ?? 0
    return { active: activeExecutionCount > 0, activeExecutionCount }
  }

  return { active: true }
}

export async function sandboxHasActiveExecution(sandboxId: string, executor: DbExecutor = db): Promise<boolean> {
  return (await sandboxActivity(sandboxId, executor)).active
}
