import { sql } from 'drizzle-orm'
import { LIVE_AGENT_STATUSES } from '@ficus/shared'
import { agents } from '../../db/schema'
import type { DbHandle } from '../work-streams/waits'

/**
 * Agent types the AUTOMATIC work-stream teardown never puts to sleep.
 *
 * Managers own their squad and outlive every stream in it. Consultants are
 * ephemeral managers — spawned ad hoc, usually bound to no stream at all — so
 * a stream going terminal says nothing about whether they are still needed.
 *
 * This is deliberately NOT enforced in `canTerminate`: an operator unspawning
 * a consultant by hand is a legitimate act. Only the automatic path abstains.
 */
const AUTO_DORMANCY_EXEMPT_TYPES = ['manager', 'system-manager', 'assistant', 'assistant-worker', 'consultant'] as const

/** Whether automatic work-stream teardown must leave this agent type alone. */
export function isAutoDormancyExempt(agentTypeId: string | null | undefined): boolean {
  return AUTO_DORMANCY_EXEMPT_TYPES.includes(agentTypeId as (typeof AUTO_DORMANCY_EXEMPT_TYPES)[number])
}

/**
 * Stamp the durable "this agent should go dormant" request on a terminal work
 * stream's crew, inside the transaction that made the stream terminal.
 *
 * WHY THIS EXISTS. Crew teardown used to be a post-commit side effect:
 * `update()` committed `status='done'`, then called
 * `cleanupAgentsForTerminalWorkStream` on the next line. That call is the ONLY
 * trigger, so anything that kills the process in between — a deploy, a
 * restart, a crash — leaves the stream durably done and its crew permanently
 * idle, because nothing ever retries. Errors were swallowed too, so a miss
 * left no trace. On the noah tenant this stranded 24 agents in one window,
 * 37% of the streams that completed while #1312 was rolling out.
 *
 * Writing the request in the SAME transaction as the status change makes the
 * intent commit atomically with the fact that produced it. If the process dies
 * one instruction later the request is already durable, and the existing
 * `runPendingAgentLifecycleSweep` finishes the job — it claims exactly on
 * `metadata->>'pendingLifecycleTarget'`. The post-commit fast path stays as an
 * optimisation for the common case; it is no longer the only chance.
 *
 * `pendingLifecycleRequestId` is NOT optional. `reconcileAgentLifecycleRequest`
 * bails out early unless BOTH the target and a string request id are present,
 * and the sweep claims on the target alone — so a target without an id would
 * be claimed forever, settle nothing, and never clear. Each row gets its own
 * uuid because reconcile CAS-matches on it when clearing.
 *
 * @returns ids of the agents that took the request.
 */
export async function markCrewForDormancy(tx: DbHandle, crewAgentIds: readonly string[]): Promise<string[]> {
  if (crewAgentIds.length === 0) return []

  const marked = await tx
    .update(agents)
    .set({
      metadata: sql`COALESCE(${agents.metadata}, '{}'::jsonb) || jsonb_build_object(
        'pendingLifecycleTarget', 'dormant',
        'pendingLifecycleRequestId', gen_random_uuid()::text,
        'pendingLifecycleReason', 'work-stream-terminal'
      )`,
      updatedAt: new Date(),
    })
    .where(
      sql`
      ${agents.id} = ANY(${sql.param(crewAgentIds as string[])}::uuid[])
      AND ${agents.status} = ANY(${sql.param([...LIVE_AGENT_STATUSES])}::agent_status[])
      AND ${agents.persist} = false
      AND ${agents.parentAgentId} IS NULL
      AND ${agents.agentTypeId} <> ALL(${sql.param([...AUTO_DORMANCY_EXEMPT_TYPES])}::text[])
      -- Never downgrade a request that is already in flight. A pending
      -- 'terminated' target outranks this 'dormant' one, and re-stamping a
      -- fresh request id would orphan the in-flight one's CAS clear.
      AND ${agents.metadata}->>'pendingLifecycleTarget' IS NULL
      -- Evaluated inside the transaction, so the stream that triggered this is
      -- already terminal here and correctly excludes itself. An agent still
      -- crewed on another open stream keeps working.
      AND NOT EXISTS (
        SELECT 1 FROM work_streams w
        WHERE ${agents.id} = ANY(w.agent_ids)
          AND w.status NOT IN ('done', 'canceled')
      )
    `
    )
    .returning({ id: agents.id })

  return marked.map((row) => row.id)
}
