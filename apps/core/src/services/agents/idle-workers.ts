import { and, asc, eq, inArray, isNotNull, isNull, lt, notExists, or, sql, type SQL } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { LIVE_AGENT_STATUSES } from '@ficus/shared'
import { agentQuestions, agents, db, monitors, slotClaims, slotWaiters, workStreams } from '../../db'
import type { DbTransaction } from '../machines/queries'
import { Agent } from '../../entities/Agent'
import { Monitor } from '../../entities/Monitor'
import { createLogger } from '../../lib/infra/logger'
import { publicErrorMessage } from '../../db/errors'
import { AUTO_DORMANCY_EXEMPT_TYPES, isAutoDormancyExempt } from './crew-dormancy'
import { activeExecutionOf, undeliveredInboxOf, waitingMessageOf, type Executor } from './idle-consultants'
import type { IdleDormancyOutcome } from './idle-consultants'

const log = createLogger('idle-workers')

/**
 * How long a worker with nothing open must stay idle before it goes dormant.
 * Long enough that a human trading messages with a finished worker does not
 * see it sleep between replies; a later message wakes it again anyway.
 */
export const IDLE_WORKER_GRACE_MS = 60 * 60 * 1000
const FAILURE_BACKOFF_MS = 60 * 60 * 1000
/** Refusals from the under-lock re-check: the worker is in use, nothing is wrong. */
const EXPECTED_REFUSALS = new Set([
  'became active',
  'has a message waiting',
  'was active recently',
  'is on an open work stream',
  'has live work in flight',
  'is no longer an automatic-dormancy candidate',
])

type AgentRef = SQL | typeof agents.id

/**
 * An open (non-terminal) work stream the agent is crewed on, assigned to or owns.
 * A reopened stream is open again, so its crew counts as busy.
 */
const openWorkStreamOf = (agentId: AgentRef, executor: Executor = db) =>
  executor
    .select({ one: sql`1` })
    .from(workStreams)
    .where(
      and(
        sql`${workStreams.status} NOT IN ('done', 'canceled')`,
        or(
          sql`${agentId} = ANY(${workStreams.agentIds})`,
          eq(workStreams.assigneeAgentId, agentId),
          eq(workStreams.ownerAgentId, agentId)
        )
      )
    )
// Aliased: the candidate query selects from `agents` too, and an unaliased
// subquery would compare each child with itself.
const childAgents = alias(agents, 'idle_worker_children')
const liveSubagentOf = (agentId: AgentRef, executor: Executor = db) =>
  executor
    .select({ one: sql`1` })
    .from(childAgents)
    .where(
      and(
        sql`${childAgents.parentAgentId} = ${agentId}`,
        sql`${childAgents.status} = ANY(${sql.param([...LIVE_AGENT_STATUSES])}::agent_status[])`
      )
    )
const activeMonitorOf = (agentId: AgentRef, executor: Executor = db) =>
  executor
    .select({ one: sql`1` })
    .from(monitors)
    .where(and(eq(monitors.agentId, agentId), inArray(monitors.status, Monitor.activeStatuses())))
/** Held or queued slot claims. makeDormant releases these, so they must keep the worker live. */
const heldSlotOf = (agentId: AgentRef, executor: Executor = db) =>
  executor
    .select({ one: sql`1` })
    .from(slotClaims)
    .where(and(eq(slotClaims.ownerAgentId, agentId), eq(slotClaims.status, 'active')))
const queuedSlotOf = (agentId: AgentRef, executor: Executor = db) =>
  executor
    .select({ one: sql`1` })
    .from(slotWaiters)
    .where(and(eq(slotWaiters.ownerAgentId, agentId), eq(slotWaiters.status, 'queued')))
/** A question the agent asked that is still open, or answered with the answer still on its way. */
const openQuestionOf = (agentId: AgentRef, executor: Executor = db) =>
  executor
    .select({ one: sql`1` })
    .from(agentQuestions)
    .where(
      and(
        eq(agentQuestions.agentId, agentId),
        or(
          eq(agentQuestions.status, 'open'),
          and(
            eq(agentQuestions.status, 'answered'),
            inArray(agentQuestions.answerDeliveryStatus, ['pending', 'delivering'])
          )
        )
      )
    )
const inFlightChecks = [liveSubagentOf, activeMonitorOf, heldSlotOf, queuedSlotOf, openQuestionOf]

/**
 * Top-level, non-persistent workers (any type not exempt from automatic
 * dormancy) that are plainly idle with nothing open: no open work stream, no
 * active or queued execution, no pending message or undelivered inbox item,
 * no live subagent, active monitor, held or queued slot claim or open
 * question, no wake or lifecycle request in progress, and no message for at
 * least the grace period (or never messaged and created before it). Includes
 * workers that were never bound to any stream. Oldest activity first.
 */
export async function findIdleWorkers(
  options: { now?: Date; graceMs?: number; limit?: number; excludeIds?: string[]; squadIds?: string[] } = {}
): Promise<Array<{ id: string; squadId: string | null }>> {
  const now = options.now ?? new Date()
  const cutoff = new Date(now.getTime() - (options.graceMs ?? IDLE_WORKER_GRACE_MS))
  const query = db
    .select({ id: agents.id, squadId: agents.squadId })
    .from(agents)
    .where(
      and(
        options.squadIds ? inArray(agents.squadId, options.squadIds) : undefined,
        options.excludeIds?.length
          ? sql`NOT (${agents.id} = ANY(${sql.param(options.excludeIds)}::uuid[]))`
          : undefined,
        eq(agents.status, 'idle'),
        eq(agents.persist, false),
        isNull(agents.parentAgentId),
        sql`${agents.agentTypeId} <> ALL(${sql.param([...AUTO_DORMANCY_EXEMPT_TYPES])}::text[])`,
        sql`${agents.metadata}->>'pendingLifecycleTarget' IS NULL`,
        sql`coalesce(${agents.metadata}->>'wakeCompletionPending', 'false') <> 'true'`,
        // canTerminate refuses agents on open work streams; never select one, or
        // a stuck candidate would be retried (and spend the sweep budget) forever.
        notExists(openWorkStreamOf(agents.id)),
        notExists(activeExecutionOf(agents.id)),
        notExists(waitingMessageOf(agents.id)),
        notExists(undeliveredInboxOf(agents.id)),
        ...inFlightChecks.map((check) => notExists(check(agents.id))),
        or(
          and(isNotNull(agents.lastMessageAt), lt(agents.lastMessageAt, cutoff)),
          and(isNull(agents.lastMessageAt), lt(agents.createdAt, cutoff))
        )
      )
    )
    .orderBy(asc(sql`coalesce(${agents.lastMessageAt}, ${agents.createdAt})`), asc(agents.id))
  return options.limit === undefined ? query : query.limit(options.limit)
}

/**
 * Re-checked under the agent queue lock (after makeDormant's own plain-idle,
 * no-active-execution and no-wake checks), so work that arrived after
 * selection — a message, a stream assignment that committed, a reopened
 * stream — leaves the worker untouched.
 */
function stillIdleWorkerGuard(cutoff: Date) {
  return async (tx: DbTransaction, agentId: string): Promise<string | null> => {
    const id = sql`${agentId}::uuid`
    const [row] = await tx
      .select({
        persist: agents.persist,
        parentAgentId: agents.parentAgentId,
        agentTypeId: agents.agentTypeId,
        metadata: agents.metadata,
        lastMessageAt: agents.lastMessageAt,
        createdAt: agents.createdAt,
      })
      .from(agents)
      .where(eq(agents.id, agentId))
    const metadata = row?.metadata as Record<string, unknown> | null | undefined
    if (
      !row ||
      row.persist ||
      row.parentAgentId ||
      isAutoDormancyExempt(row.agentTypeId) ||
      metadata?.pendingLifecycleTarget != null
    )
      return 'is no longer an automatic-dormancy candidate'
    if ((await waitingMessageOf(id, tx).limit(1)).length || (await undeliveredInboxOf(id, tx).limit(1)).length)
      return 'has a message waiting'
    if ((await openWorkStreamOf(id, tx).limit(1)).length) return 'is on an open work stream'
    for (const check of inFlightChecks) if ((await check(id, tx).limit(1)).length) return 'has live work in flight'
    const lastActive = row.lastMessageAt ?? row.createdAt
    if (!lastActive || lastActive.getTime() >= cutoff.getTime()) return 'was active recently'
    return null
  }
}

/**
 * Make one worker dormant only if it is still idle with nothing open. Never
 * stops or waits behind work: makeDormant's idle-only mode re-checks under
 * the agent's queue lock and refuses if anything arrived since selection.
 */
export async function dormantIfIdleWorker(agentId: string, cutoff: Date): Promise<IdleDormancyOutcome> {
  const agent = await Agent.find(agentId, { eager: false })
  if (!agent) return { outcome: 'skipped', reason: 'Agent not found' }
  const check = await agent.canTerminate()
  if (!check.canTerminate) return { outcome: 'skipped', reason: check.reason }
  const { DormancyRefusedError, makeDormant } = await import('../agent/lifecycle')
  try {
    await makeDormant(agent, { idleOnly: stillIdleWorkerGuard(cutoff) })
  } catch (error) {
    if (error instanceof DormancyRefusedError) return { outcome: 'skipped', reason: error.reason }
    throw error
  }
  const fresh = await Agent.find(agentId, { eager: false })
  if (fresh?.status === 'dormant') return { outcome: 'dormant' }
  return { outcome: 'skipped', reason: 'did not become dormant' }
}

// Worker-local: an agent that was refused or failed is left alone for an hour,
// so one stuck agent can neither warn every minute nor take other agents' turns.
const backoffUntil = new Map<string, number>()

export function resetIdleWorkerBackoffForTest(): void {
  backoffUntil.clear()
}

/**
 * Lifecycle-sweep step (always on): make idle workers with nothing open
 * dormant after the grace period. At most `maxAgents` become dormant per tick
 * and at most five times that many are attempted; refused or failing agents
 * back off for an hour and are not charged to the dormant budget.
 * @returns the number of agents made dormant.
 */
export async function runIdleWorkerDormancySweep(
  options: { now?: Date; maxAgents?: number; graceMs?: number; squadIds?: string[] } = {}
): Promise<number> {
  const now = options.now ?? new Date()
  const graceMs = options.graceMs ?? IDLE_WORKER_GRACE_MS
  const cutoff = new Date(now.getTime() - graceMs)
  const maxAgents = Math.max(1, options.maxAgents ?? 10)
  const maxAttempts = maxAgents * 5
  for (const [id, until] of backoffUntil) if (until <= now.getTime()) backoffUntil.delete(id)
  const candidates = await findIdleWorkers({
    now,
    graceMs,
    limit: maxAttempts,
    excludeIds: [...backoffUntil.keys()],
    squadIds: options.squadIds,
  })
  let dormant = 0
  for (const { id, squadId } of candidates) {
    if (dormant >= maxAgents) break
    let reason: string
    try {
      const outcome = await dormantIfIdleWorker(id, cutoff)
      if (outcome.outcome === 'dormant') {
        dormant++
        log.info(
          `Made idle worker ${id} in squad ${squadId} dormant: nothing open for at least ${graceMs / 60_000} minutes`
        )
        continue
      }
      reason = outcome.outcome === 'skipped' ? outcome.reason : 'did not become dormant'
    } catch (error) {
      reason = publicErrorMessage(error)
    }
    backoffUntil.set(id, now.getTime() + FAILURE_BACKOFF_MS)
    const message = `Idle worker ${id} in squad ${squadId} stays live for now: ${reason}`
    if (EXPECTED_REFUSALS.has(reason)) log.info(message)
    else log.warn(message)
  }
  return dormant
}
