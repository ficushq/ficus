import { and, asc, eq, inArray, isNotNull, isNull, lt, notExists, or, sql, type SQL } from 'drizzle-orm'
import type { IdleConsultantsDormancyResult } from '@ficus/shared'
import { agents, db, executions, inbox, messages, squads } from '../../db'
import { ACTIVE_EXECUTION_STATUSES } from '../execution/status'
import type { DbTransaction } from '../machines/queries'
import { Agent } from '../../entities/Agent'
import { createLogger } from '../../lib/infra/logger'
import { publicErrorMessage } from '../../db/errors'
import { storageAgentColumns, type StorageAgentRow } from '../storage/agents'

const log = createLogger('idle-consultants')
const DAY_MS = 24 * 60 * 60 * 1000
const FAILURE_BACKOFF_MS = 60 * 60 * 1000
/** Refusal reasons from the idle-only re-check: the consultant is in use, nothing is wrong. */
const EXPECTED_REFUSALS = new Set(['became active', 'has a message waiting', 'was active recently'])

export type Executor = Pick<DbTransaction, 'select'>
export const activeExecutionOf = (agentId: SQL | typeof agents.id, executor: Executor = db) =>
  executor
    .select({ one: sql`1` })
    .from(executions)
    .where(and(eq(executions.agentId, agentId), inArray(executions.status, [...ACTIVE_EXECUTION_STATUSES])))
export const waitingMessageOf = (agentId: SQL | typeof agents.id, executor: Executor = db) =>
  executor
    .select({ one: sql`1` })
    .from(messages)
    .where(and(eq(messages.agentId, agentId), eq(messages.role, 'human'), eq(messages.pending, true)))
export const undeliveredInboxOf = (agentId: SQL | typeof agents.id, executor: Executor = db) =>
  executor
    .select({ one: sql`1` })
    .from(inbox)
    .where(
      and(
        eq(inbox.recipientType, 'agent'),
        sql`${inbox.recipientId} = ${agentId}::text`,
        isNull(inbox.readAt),
        isNull(inbox.deliveredAt)
      )
    )

/**
 * Consultants in a squad idle for at least `days`: last message older than the
 * cutoff, or never messaged and created before it. Only plain idle top-level
 * consultants qualify. Never selected: executing (active, waiting-input,
 * compacting, resetting) or dormant agents; agents with any active execution
 * (including queued or waiting for a sandbox — the agent stays `idle` then), a
 * pending human message or an undelivered inbox item; a wake in progress;
 * persistent or already-requested agents; agents on an open work stream.
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
        sql`NOT EXISTS (SELECT 1 FROM work_streams w WHERE w.squad_id = ${squadId} AND ${agents.id} = ANY(w.agent_ids) AND w.status NOT IN ('done', 'canceled'))`,
        sql`coalesce(${agents.metadata}->>'wakeCompletionPending', 'false') <> 'true'`,
        notExists(activeExecutionOf(agents.id)),
        notExists(waitingMessageOf(agents.id)),
        notExists(undeliveredInboxOf(agents.id)),
        or(
          and(isNotNull(agents.lastMessageAt), lt(agents.lastMessageAt, cutoff)),
          and(isNull(agents.lastMessageAt), lt(agents.createdAt, cutoff))
        )
      )
    )
    .orderBy(asc(sql`coalesce(${agents.lastMessageAt}, ${agents.createdAt})`), asc(agents.id))
}

/** Re-checked under the agent queue lock, after the plain-idle and no-active-execution checks. */
function stillIdleGuard(cutoff: Date) {
  return async (tx: DbTransaction, agentId: string): Promise<string | null> => {
    const id = sql`${agentId}::uuid`
    if ((await waitingMessageOf(id, tx).limit(1)).length || (await undeliveredInboxOf(id, tx).limit(1)).length)
      return 'has a message waiting'
    const [row] = await tx
      .select({ lastMessageAt: agents.lastMessageAt, createdAt: agents.createdAt })
      .from(agents)
      .where(eq(agents.id, agentId))
    const lastActive = row?.lastMessageAt ?? row?.createdAt
    if (!lastActive || lastActive.getTime() >= cutoff.getTime()) return 'was active recently'
    return null
  }
}

export type IdleDormancyOutcome =
  | { outcome: 'dormant' }
  | { outcome: 'deferred' }
  | { outcome: 'skipped'; reason: string }

/**
 * Make one consultant dormant only if it is still idle. Unlike the user's
 * terminate action, this never stops or waits behind work: it re-checks under
 * the agent's queue lock and refuses if anything arrived since selection.
 */
export async function dormantIfStillIdle(agentId: string, cutoff: Date): Promise<IdleDormancyOutcome> {
  const agent = await Agent.find(agentId, { eager: false })
  if (!agent) return { outcome: 'skipped', reason: 'Agent not found' }
  const check = await agent.canTerminate()
  if (!check.canTerminate) return { outcome: 'skipped', reason: check.reason }
  const { DormancyRefusedError, makeDormant } = await import('../agent/lifecycle')
  try {
    await makeDormant(agent, { idleOnly: stillIdleGuard(cutoff) })
  } catch (error) {
    if (error instanceof DormancyRefusedError) return { outcome: 'skipped', reason: error.reason }
    throw error
  }
  const fresh = await Agent.find(agentId, { eager: false })
  if (fresh?.status === 'dormant') return { outcome: 'dormant' }
  if (fresh?.pendingDormancyAt) return { outcome: 'deferred' }
  return { outcome: 'skipped', reason: 'did not become dormant' }
}

/**
 * Make a squad's idle consultants dormant. The set is always recomputed here;
 * `agentIds` (what a client previewed) can only narrow it, never add to it.
 * Each agent goes through dormantIfStillIdle, so nothing that became active is touched.
 */
export async function makeIdleConsultantsDormant(
  squadId: string,
  days: number,
  options: {
    agentIds?: string[]
    now?: Date
    /** Stop after this many agents became (or will become) dormant. */
    maxDormant?: number
    /** Stop after this many attempts, successful or not. */
    maxAttempts?: number
    /** Leave these agents alone this time (e.g. backing off after a failure). */
    exclude?: (agentId: string) => boolean
    reason?: string
  } = {}
): Promise<IdleConsultantsDormancyResult> {
  const now = options.now ?? new Date()
  const cutoff = new Date(now.getTime() - days * DAY_MS)
  const idle = await findIdleConsultants(squadId, days, now)
  const idleIds = new Set(idle.map((row) => row.id))
  const result: IdleConsultantsDormancyResult = { dormant: [], deferred: [], skipped: [] }
  let targets = idle.map((row) => row.id)
  if (options.agentIds) {
    const requested = new Set(options.agentIds)
    targets = targets.filter((id) => requested.has(id))
    for (const id of requested)
      if (!idleIds.has(id)) result.skipped.push({ id, reason: `not a consultant idle for ${days} days in this squad` })
  }
  if (options.exclude) targets = targets.filter((id) => !options.exclude!(id))
  let attempts = 0
  for (const id of targets) {
    if (options.maxDormant !== undefined && result.dormant.length + result.deferred.length >= options.maxDormant) break
    if (options.maxAttempts !== undefined && attempts >= options.maxAttempts) break
    attempts++
    try {
      const outcome = await dormantIfStillIdle(id, cutoff)
      if (outcome.outcome === 'skipped') {
        result.skipped.push({ id, reason: outcome.reason })
        continue
      }
      result[outcome.outcome].push(id)
      log.info(
        `Made idle consultant ${id} in squad ${squadId} ${outcome.outcome === 'dormant' ? 'dormant' : 'dormant after its current turn'} (idle at least ${days} days${options.reason ? `; ${options.reason}` : ''})`
      )
    } catch (error) {
      result.skipped.push({ id, reason: publicErrorMessage(error) })
    }
  }
  return result
}

// Worker-local: an agent that failed is left alone for an hour, so one bad
// agent can neither warn every minute nor take other agents' turns.
const backoffUntil = new Map<string, number>()

export function resetIdleConsultantBackoffForTest(): void {
  backoffUntil.clear()
}

/**
 * Lifecycle-sweep step: for each squad with `consultant_idle_dormancy_days`
 * set (every squad by default; null means the squad turned it off), make its
 * idle consultants dormant. At most `maxAgents` become dormant
 * per tick (failures are not charged), with a bounded number of attempts.
 * @returns the number of agents made (or requested to become) dormant.
 */
export async function runIdleConsultantDormancySweep(
  options: { now?: Date; maxAgents?: number; squadIds?: string[] } = {}
): Promise<number> {
  const now = options.now ?? new Date()
  const maxAgents = Math.max(1, options.maxAgents ?? 10)
  let remaining = maxAgents
  let attemptsLeft = maxAgents * 5
  for (const [id, until] of backoffUntil) if (until <= now.getTime()) backoffUntil.delete(id)
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
    if (remaining <= 0 || attemptsLeft <= 0) break
    const result = await makeIdleConsultantsDormant(squad.id, squad.days!, {
      now,
      maxDormant: remaining,
      maxAttempts: attemptsLeft,
      exclude: (id) => (backoffUntil.get(id) ?? 0) > now.getTime(),
      reason: 'squad idle-consultant setting',
    })
    const made = result.dormant.length + result.deferred.length
    for (const skipped of result.skipped) {
      backoffUntil.set(skipped.id, now.getTime() + FAILURE_BACKOFF_MS)
      // Refusals because the consultant is in use are expected; only real failures warn.
      const message = `Idle consultant ${skipped.id} in squad ${squad.id} stays live for now: ${skipped.reason}`
      if (EXPECTED_REFUSALS.has(skipped.reason)) log.info(message)
      else log.warn(message)
    }
    count += made
    remaining -= made
    attemptsLeft -= made + result.skipped.length
  }
  return count
}
