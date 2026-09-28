import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import type { ExecutionStatus, SessionUsage } from '@ficus/shared'
import { db } from '../../db'
import { agents, executions } from '../../db/schema'
import { createLogger } from '../../lib/infra/logger'
import { subtractTokens } from './usage-delta'
import { isActiveExecutionStatus } from './status'

const log = createLogger('usage-backfill')

/**
 * Reconstruct per-execution usage for rows written before deltas existed.
 *
 * Nothing has to be cleared or guessed. `usage.stats` is the session's running
 * total at the end of each execution, so an agent's rows in time order are a
 * cumulative series and each execution's own consumption is the step between
 * consecutive snapshots. The final snapshot equals the sum of the steps, which
 * is why a backfilled agent reports exactly what the un-backfilled aggregation
 * already reported for it.
 *
 * A session that was reset or rotated shows up as a snapshot LOWER than its
 * predecessor. That row starts a new series, so its own snapshot is its delta
 * rather than a negative step. (None were observed on the noah tenant: 2157
 * consecutive pairs across 142 agents were all monotonic.)
 */
export interface UsageBackfillRow {
  id: string
  usage: SessionUsage | null
  /** Execution-start timestamp; the ordering key validated by planAgentUsageBackfill. */
  startedAt: Date
}

export interface UsageBackfillUpdate {
  id: string
  usage: SessionUsage
}

/** Rows were not in execution order (oldest first) for one agent. */
export class UsageBackfillOrderError extends Error {
  constructor(previous: UsageBackfillRow, offending: UsageBackfillRow, reason: 'order' | 'duplicate' = 'order') {
    super(
      reason === 'duplicate'
        ? `planAgentUsageBackfill: duplicate execution id ${offending.id} (${offending.startedAt.toISOString()}) — the same row appears twice (first seen at ${previous.startedAt.toISOString()}); expected ORDER BY startedAt ASC, id ASC`
        : `planAgentUsageBackfill: rows out of execution order — ${offending.id} (${offending.startedAt.toISOString()}) ` +
            `does not follow ${previous.id} (${previous.startedAt.toISOString()}); expected ORDER BY startedAt ASC, id ASC`
    )
    this.name = 'UsageBackfillOrderError'
  }
}

/**
 * Throws `UsageBackfillOrderError` if the rows are not in execution order
 * (oldest first: strictly increasing `(startedAt, id)` with distinct ids,
 * matching the caller's `ORDER BY startedAt ASC, id ASC`). Out-of-order or
 * duplicated input would otherwise silently compute plausible wrong deltas.
 */
export function planAgentUsageBackfill(rows: readonly UsageBackfillRow[]): UsageBackfillUpdate[] {
  const firstIndexById = new Map<string, number>()
  for (let i = 0; i < rows.length; i++) {
    const curr = rows[i]!
    const firstSeen = firstIndexById.get(curr.id)
    if (firstSeen !== undefined) throw new UsageBackfillOrderError(rows[firstSeen]!, curr, 'duplicate')
    firstIndexById.set(curr.id, i)

    if (i === 0) continue
    const prev = rows[i - 1]!
    const ordered =
      prev.startedAt < curr.startedAt || (prev.startedAt.getTime() === curr.startedAt.getTime() && prev.id < curr.id)
    if (!ordered) throw new UsageBackfillOrderError(prev, curr)
  }

  const updates: UsageBackfillUpdate[] = []
  let baseline: SessionUsage['stats'] | null = null

  for (const row of rows) {
    const usage = row.usage
    // No usage recorded (a failed or aborted execution): it consumed nothing we
    // can attribute, and it must not disturb the series for later rows.
    if (!usage?.stats?.tokens) continue

    const restarted = baseline !== null && usage.stats.tokens.total < baseline.tokens.total
    const effectiveBaseline = restarted ? null : baseline

    // Already backfilled or written by a runner that emits deltas: leave it
    // alone, but let it carry the series forward so neighbours stay correct.
    if (!usage.delta) {
      updates.push({
        id: row.id,
        usage: {
          ...usage,
          delta: {
            tokens: subtractTokens(usage.stats.tokens, effectiveBaseline?.tokens),
            cost: Math.max(0, (usage.stats.cost ?? 0) - (effectiveBaseline?.cost ?? 0)),
          },
        },
      })
    }
    baseline = usage.stats
  }

  return updates
}

export interface UsageBackfillSummary {
  agentsScanned: number
  executionsScanned: number
  executionsUpdated: number
}

/**
 * Backfill deltas for every ended execution of the given agents (or of a whole
 * squad). Live executions are skipped: their row is still owned by a running
 * runner, which writes the authoritative usage when it settles.
 */
export async function backfillExecutionUsage(options: {
  squadId?: string
  agentIds?: string[]
  apply: boolean
}): Promise<UsageBackfillSummary> {
  const targets = options.agentIds?.length
    ? options.agentIds
    : (
        await db
          .select({ id: agents.id })
          .from(agents)
          .where(options.squadId ? eq(agents.squadId, options.squadId) : sql`true`)
      ).map((row) => row.id)

  const summary: UsageBackfillSummary = { agentsScanned: 0, executionsScanned: 0, executionsUpdated: 0 }

  for (const agentId of targets) {
    const rows = await db
      .select({
        id: executions.id,
        usage: executions.usage,
        status: executions.status,
        startedAt: executions.startedAt,
      })
      .from(executions)
      .where(and(eq(executions.agentId, agentId), isNotNull(executions.usage)))
      .orderBy(asc(executions.startedAt), asc(executions.id))

    summary.agentsScanned += 1
    summary.executionsScanned += rows.length
    if (rows.length === 0) continue

    // A running execution's final usage is not written yet, so it cannot anchor
    // the series; stop before it and let the next pass pick it up.
    const settled: UsageBackfillRow[] = []
    for (const row of rows) {
      if (isActiveExecutionStatus(row.status as ExecutionStatus)) break
      settled.push({ id: row.id, usage: row.usage as SessionUsage | null, startedAt: row.startedAt })
    }

    const updates = planAgentUsageBackfill(settled)
    summary.executionsUpdated += updates.length
    if (!options.apply || updates.length === 0) continue

    await db.transaction(async (tx) => {
      for (const update of updates) {
        await tx.update(executions).set({ usage: update.usage }).where(eq(executions.id, update.id))
      }
    })
    log.info(`Backfilled ${updates.length} execution(s) for agent ${agentId}`)
  }

  return summary
}

/** Convenience for callers that already hold a set of agent ids. */
export async function backfillExecutionUsageForAgents(agentIds: string[], apply: boolean) {
  if (agentIds.length === 0) return { agentsScanned: 0, executionsScanned: 0, executionsUpdated: 0 }
  await db.select({ id: agents.id }).from(agents).where(inArray(agents.id, agentIds)).limit(1)
  return backfillExecutionUsage({ agentIds, apply })
}
