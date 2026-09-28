import { maintenanceStore } from '../maintenance/store'
import { listActiveSlotWaits } from '../slots/active-waits'
import { acquireAgentQueueLock } from '../execution/agent-admission'
import { externalDeliveryStreamIds } from '../workflows/delivery-state'
import { activeWorkflowAttempts } from '@ficus/shared'
import { waitsForAgent, waitingAssigneeStreamIds } from './wait-scope'
import { and, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, or, sql } from 'drizzle-orm'
import { db } from '../../db'
import { readDatabaseClock } from '../../db/clock'
import {
  agents,
  executions,
  inbox,
  messages,
  squads,
  workStreamContinuations,
  workStreamFlowRuns,
  workStreams,
  workStreamWaits,
} from '../../db/schema'
import { Agent } from '../../entities/Agent'
import { Execution } from '../../entities/Execution'
import { InboxMessage } from '../../entities/InboxMessage'
import { WorkStream } from '../../entities/WorkStream'
import { createPeriodicRunner, type PeriodicRunner } from '../../lib/infra/PeriodicRunner'
import { refreshAgentActivity } from '../agents/activity-summary'
import { jsonbObjectRecovered } from '../../db/jsonb'
import { eventEmitter } from '../../lib/infra/event-emitter'
import { prepareInboxDelivery } from '../inbox/inboxDelivery'
import {
  notifyWorkStreamBlocked,
  persistWorkStreamPersistentIdleInTransaction,
} from '../squad/work-stream-notifications'
import { closeOpenWaits, openWait } from './waits'
import { ACTIVE_EXECUTION_STATUSES } from '../execution/status'
import { isDurableProviderTransportFailure } from '../../lib/error'
import { executionOutcomeOf } from '../execution/failure-classification'
import { createLogger } from '../../lib/infra/logger'
import {
  listTrustedContinuationExecutionIds,
  listTrustedWorkStreamOriginsForExecution,
  type DbExecutor,
} from './execution-provenance'
import { resetContinuationCycle } from './continuation-state'

const log = createLogger('work-stream-continuation')

export const CONTINUATION_SWEEP_MS = 30_000
export const CONTINUATION_BASE_BACKOFF_MS = 30_000
export const CONTINUATION_MAX_BACKOFF_MS = 5 * 60_000
const NORMAL_CONTINUATION_MAX_ATTEMPTS = 1
export const TRANSPORT_CONTINUATION_MAX_ATTEMPTS = 3
export const CONTINUATION_MAX_ATTEMPTS = TRANSPORT_CONTINUATION_MAX_ATTEMPTS
export const CONTINUATION_CLAIM_LEASE_MS = 2 * 60_000
export const CONTINUATION_MAX_DELIVERY_ATTEMPTS = 5
export const NORMAL_IDLE_NOTICE_DELAY_MS = 60_000

let continuationRunner: PeriodicRunner | null = null
let continuationEventUnsubscribe: (() => void) | null = null

export function registerWorkStreamContinuationEventHandlers(): void {
  if (continuationEventUnsubscribe) return
  continuationEventUnsubscribe = eventEmitter.on('execution.started', ({ executionId, agentId }) => {
    void resolveContinuationWaitOnExecutionStarted(executionId, agentId).catch((error) =>
      log.error('Failed to resolve a continuation wait on execution start', { executionId, agentId, error })
    )
  })
}

export function startWorkStreamContinuationSweep(): void {
  if (continuationRunner) return
  registerWorkStreamContinuationEventHandlers()
  continuationRunner = createPeriodicRunner({
    name: 'work-stream-continuation',
    intervalMs: CONTINUATION_SWEEP_MS,
    runImmediately: true,
    task: () => reconcileWorkStreamContinuationsOnce(),
  })
  continuationRunner.start()
}

export async function stopWorkStreamContinuationSweep(): Promise<void> {
  continuationEventUnsubscribe?.()
  continuationEventUnsubscribe = null
  if (!continuationRunner) return
  await continuationRunner.stop()
  continuationRunner = null
}

export function continuationDelay(attempt: number): number {
  return Math.min(CONTINUATION_BASE_BACKOFF_MS * 2 ** (attempt - 1), CONTINUATION_MAX_BACKOFF_MS)
}

function stableHash(value: string): number {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

export function transportContinuationDelay(attempt: number, seed: string): number {
  const base = continuationDelay(attempt)
  const jitterWindow = Math.floor(base * 0.2)
  return Math.min(CONTINUATION_MAX_BACKOFF_MS, base + (stableHash(seed) % (jitterWindow + 1)))
}

const TRANSPORT_EXHAUSTION_MESSAGE =
  'The assigned agent encountered trusted provider transport failures after 3 automatic continuation attempts while this work stream remained in progress. Inspect the execution history, then respond to continue with a fresh retry budget, reassign the stream, or cancel it.'

const DELIVERY_EXHAUSTION_MESSAGE =
  'Automatic continuation delivery repeatedly failed. Inspect the execution history, then respond to continue with a fresh retry budget, reassign the stream, or cancel it.'

function isContinuationWatchdogMessage(message: string | null): boolean {
  return Boolean(
    message?.startsWith(
      'The assigned agent encountered trusted provider transport failures after 3 automatic continuation attempts'
    ) ||
    message?.startsWith('The assigned agent became idle after 3 automatic continuation attempts') ||
    message?.startsWith('Automatic continuation delivery repeatedly failed')
  )
}

function safeExecutionErrorCategory(
  execution: Pick<typeof executions.$inferSelect, 'status' | 'error' | 'failureClass'>
): string {
  if (execution.status === 'stopped') return 'execution_stopped'
  if (execution.status === 'failed') {
    // Stored structural class first; the prose sentinel is only the fallback
    // for legacy rows written before classification existed.
    if (execution.failureClass === 'platform_pre_tool_refusal') return 'platform_pre_tool_refusal'
    if (execution.failureClass === 'provider_transport') return 'provider_transport_failure'
    if (execution.failureClass == null && isDurableProviderTransportFailure(execution.error)) {
      return 'provider_transport_failure'
    }
  }
  return 'execution_failed'
}

export async function blockCurrentContinuation(
  workStreamId: string,
  generation: number,
  assigneeAgentId: string,
  message: string,
  condition: (cycle: typeof workStreamContinuations.$inferSelect) => boolean,
  triggerExecutionId?: string,
  observationEndedAt?: Date,
  lastDeliveryFailureAt?: Date
): Promise<boolean> {
  // Callers pass the trigger's `endedAt`, which the database stamped; the fallback reads the same
  // clock rather than the host's, because `now` is compared against `executions.ended_at` below.
  const now = observationEndedAt ?? (await readDatabaseClock())
  const blockedRow = await db.transaction(async (tx) => {
    await tx.execute(sql`select id from work_streams where id = ${workStreamId} for update`)
    const [stream] = await tx.select().from(workStreams).where(eq(workStreams.id, workStreamId))
    const [cycle] = await tx
      .select()
      .from(workStreamContinuations)
      .where(eq(workStreamContinuations.workStreamId, workStreamId))
    if (
      !stream ||
      stream.status !== 'active' ||
      stream.pause ||
      stream.assigneeAgentId !== assigneeAgentId ||
      !cycle ||
      cycle.generation !== generation ||
      !condition(cycle)
    ) {
      return null
    }
    if ((await externalDeliveryStreamIds(tx, [stream])).has(workStreamId)) return null
    // Execution.start updates the agent row in its transition transaction. Lock
    // that same row so this final fact check and wait insertion serialize with
    // a concurrent start rather than trusting the earlier idle snapshot.
    await acquireAgentQueueLock(tx, assigneeAgentId)
    if ((await listActiveSlotWaits(tx, [assigneeAgentId])).length) return null
    await tx.execute(sql`select id from agents where id = ${assigneeAgentId} for update`)
    const [activeExecution] = await tx
      .select({ id: executions.id, status: executions.status })
      .from(executions)
      .where(and(eq(executions.agentId, assigneeAgentId), inArray(executions.status, [...ACTIVE_EXECUTION_STATUSES])))
      .limit(1)
    if (activeExecution) {
      // A concurrent start may have updated the execution to running before it
      // reaches its agent-row update; in that serialization order this reader
      // sees the still-queued committed version. Either active fact makes the
      // stale exhaustion decision invalid and grants a fresh strike budget.
      await resetContinuationCycle(tx, workStreamId, assigneeAgentId, now)
      return null
    }
    if (triggerExecutionId) {
      const [trigger] = await tx
        .select({ endedAt: executions.endedAt })
        .from(executions)
        .where(and(eq(executions.id, triggerExecutionId), eq(executions.agentId, assigneeAgentId)))
        .limit(1)
      const [executionStartedAfterTrigger] = trigger?.endedAt
        ? await tx
            .select({ id: executions.id })
            .from(executions)
            .where(
              and(
                eq(executions.agentId, assigneeAgentId),
                isNotNull(executions.runStartedAt),
                gt(executions.runStartedAt, trigger.endedAt)
              )
            )
            .limit(1)
        : []
      // The start event may have committed (and even completed) before this
      // transaction acquired the stream lock. Do not create a wait its already
      // delivered event can no longer close.
      if (executionStartedAfterTrigger) {
        await resetContinuationCycle(tx, workStreamId, assigneeAgentId, now)
        return null
      }
    }

    const [completionCount] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(executions)
      .where(
        and(
          eq(executions.agentId, assigneeAgentId),
          eq(executions.status, 'completed'),
          isNotNull(executions.endedAt),
          gt(executions.endedAt, cycle.cycleStartedAt),
          lte(executions.endedAt, now)
        )
      )
    const [lastCompletion] = await tx
      .select({ endedAt: executions.endedAt })
      .from(executions)
      .where(
        and(
          eq(executions.agentId, assigneeAgentId),
          eq(executions.status, 'completed'),
          isNotNull(executions.endedAt),
          gt(executions.endedAt, cycle.cycleStartedAt),
          lte(executions.endedAt, now)
        )
      )
      .orderBy(desc(executions.endedAt), desc(executions.id))
      .limit(1)
    const [lastTerminalError] = await tx
      .select({
        status: executions.status,
        error: executions.error,
        endedAt: executions.endedAt,
        failureClass: executions.failureClass,
      })
      .from(executions)
      .where(
        and(
          eq(executions.agentId, assigneeAgentId),
          inArray(executions.status, ['failed', 'stopped']),
          isNotNull(executions.endedAt),
          gte(executions.endedAt, cycle.cycleStartedAt),
          lte(executions.endedAt, now)
        )
      )
      .orderBy(desc(executions.endedAt), desc(executions.id))
      .limit(1)
    const terminalError = lastTerminalError?.endedAt
      ? { category: safeExecutionErrorCategory(lastTerminalError), at: lastTerminalError.endedAt }
      : null
    const deliveryError = cycle.lastError
      ? { category: 'continuation_delivery_failure', at: lastDeliveryFailureAt ?? cycle.updatedAt }
      : null
    const lastError =
      deliveryError && (!terminalError || deliveryError.at >= terminalError.at)
        ? `${deliveryError.category} at ${deliveryError.at.toISOString()}`
        : terminalError
          ? `${terminalError.category} at ${terminalError.at.toISOString()}`
          : 'none'
    const evidence = [
      `Observation window: ${cycle.cycleStartedAt.toISOString()} to ${now.toISOString()}`,
      `Completed executions in window: ${completionCount?.count ?? 0}`,
      `Last completion: ${lastCompletion?.endedAt?.toISOString() ?? 'none'}`,
      `Last error: ${lastError}`,
    ].join('\n')

    await tx
      .update(workStreamContinuations)
      .set({ status: 'exhausted', ...(triggerExecutionId ? { triggerExecutionId } : {}), updatedAt: now })
      .where(
        and(eq(workStreamContinuations.workStreamId, workStreamId), eq(workStreamContinuations.generation, generation))
      )
    // Status stays `active`: the exhaustion is recorded as an open manual
    // wait (created_by system) — the maintenance pass parks the stream after
    // the squad grace, and clearing the wait makes it schedulable again.
    const [flow] = await tx.select().from(workStreamFlowRuns).where(eq(workStreamFlowRuns.workStreamId, workStreamId))
    const flowAttemptId = flow?.activated
      ? activeWorkflowAttempts(flow.state).find((attempt) => flow.attemptAgents[String(attempt.id)] === assigneeAgentId)
          ?.id
      : undefined
    const { wait } = await openWait(tx, {
      flowAttemptId,
      workStreamId,
      type: 'manual',
      message: `${message}\n\nWatchdog evidence:\n${evidence}`,
      createdBy: 'system',
    })
    const [blocked] = await tx
      .update(workStreams)
      .set({ updatedAt: now })
      .where(and(eq(workStreams.id, workStreamId), eq(workStreams.status, 'active')))
      .returning()
    return blocked ? { blocked, wait } : null
  })

  if (!blockedRow) return false
  log.info('Work stream continuation exhausted', {
    strategy: 'continuation-exhausted',
    workStreamId,
    triggerExecutionId,
    generation,
  })
  const blocked = new WorkStream(blockedRow.blocked)
  const actionId = `workstream-blocked:${blocked.id}:${blockedRow.wait.id}`
  await notifyWorkStreamBlocked(blocked, { waitId: blockedRow.wait.id, actionId })
  const payload = { workStreamId: blocked.id, squadId: blocked.squadId, waitId: blockedRow.wait.id }
  eventEmitter.emit('workStream.blocked', payload)
  eventEmitter.emit('workStream.updated', payload)
  const { ensureFlowDispatch } = await import('../workflows/execution')
  await ensureFlowDispatch(workStreamId)
  return true
}

export async function recordContinuationDeliveryFailure(input: {
  workStreamId: string
  generation: number
  assigneeAgentId: string
  clientId: string
  claimToken: string
  error: unknown
  now: Date
}): Promise<number | null> {
  const failedCandidate = await db.transaction(async (tx) => {
    await tx.execute(sql`select id from work_streams where id = ${input.workStreamId} for update`)
    const [cycle] = await tx
      .select()
      .from(workStreamContinuations)
      .where(eq(workStreamContinuations.workStreamId, input.workStreamId))
    if (
      !cycle ||
      cycle.generation !== input.generation ||
      cycle.assigneeAgentId !== input.assigneeAgentId ||
      cycle.clientId !== input.clientId ||
      cycle.claimToken !== input.claimToken ||
      cycle.status !== 'pending'
    ) {
      return null
    }

    const deliveryAttemptCount = cycle.deliveryAttemptCount + 1
    const [updated] = await tx
      .update(workStreamContinuations)
      .set({
        claimedAt: null,
        claimToken: null,
        deliveryAttemptCount,
        nextAttemptAt: new Date(input.now.getTime() + continuationDelay(deliveryAttemptCount)),
        lastError: String(input.error).slice(0, 1_000),
        updatedAt: input.now,
      })
      .where(
        and(
          eq(workStreamContinuations.workStreamId, input.workStreamId),
          eq(workStreamContinuations.generation, input.generation),
          eq(workStreamContinuations.clientId, input.clientId),
          eq(workStreamContinuations.claimToken, input.claimToken),
          eq(workStreamContinuations.status, 'pending')
        )
      )
      .returning({ deliveryAttemptCount: workStreamContinuations.deliveryAttemptCount })
    return updated ?? null
  })
  if (!failedCandidate) return null

  if (failedCandidate.deliveryAttemptCount >= CONTINUATION_MAX_DELIVERY_ATTEMPTS) {
    await blockCurrentContinuation(
      input.workStreamId,
      input.generation,
      input.assigneeAgentId,
      DELIVERY_EXHAUSTION_MESSAGE,
      (current) =>
        current.status === 'pending' &&
        current.clientId === input.clientId &&
        current.deliveryAttemptCount === failedCandidate.deliveryAttemptCount,
      undefined,
      input.now,
      input.now
    )
  }
  return failedCandidate.deliveryAttemptCount
}

type ContinuationKind = 'normal' | 'transport'

function isLegacyContinuationClientId(workStreamId: string, generation: number, clientId: string | null): boolean {
  if (!clientId?.startsWith(`work-stream-continuation:${workStreamId}:${generation}:`)) return false
  return !clientId.includes(':normal:') && !clientId.includes(':transport:')
}

export function buildNormalContinuationPrompt(workStream: Pick<WorkStream, 'id' | 'title'>): string {
  return `It seems like you stopped working on work stream ${workStream.id}: ${workStream.title} without handing it off. If you are intentionally waiting for an event, keep waiting; otherwise continue working.`
}

function buildTransportContinuationPrompt(workStream: Pick<WorkStream, 'id' | 'title'>): string {
  return `Continue working on work stream ${workStream.id}: ${workStream.title}.`
}

export function buildContinuationPrompt(workStream: Pick<WorkStream, 'id' | 'title'>): string {
  return buildNormalContinuationPrompt(workStream)
}

export async function resolveContinuationWaitOnExecutionStarted(
  executionId: string,
  agentId: string,
  testHooks: { beforeCandidateLock?: () => Promise<void>; beforeClose?: () => Promise<void> } = {}
): Promise<boolean> {
  const [execution] = await db
    .select({ id: executions.id, agentId: executions.agentId, runStartedAt: executions.runStartedAt })
    .from(executions)
    .where(and(eq(executions.id, executionId), eq(executions.agentId, agentId)))
    .limit(1)
  const runStartedAt = execution?.runStartedAt
  if (!runStartedAt) return false

  const candidates = await db
    .select({ workStreamId: workStreamContinuations.workStreamId, generation: workStreamContinuations.generation })
    .from(workStreamContinuations)
    .where(and(eq(workStreamContinuations.assigneeAgentId, agentId), eq(workStreamContinuations.status, 'exhausted')))
  let resolved = false
  for (const candidate of candidates) {
    await testHooks.beforeCandidateLock?.()
    const closed = await db.transaction(async (tx) => {
      await tx.execute(sql`select id from work_streams where id = ${candidate.workStreamId} for update`)
      const [stream] = await tx.select().from(workStreams).where(eq(workStreams.id, candidate.workStreamId))
      const [cycle] = await tx
        .select()
        .from(workStreamContinuations)
        .where(eq(workStreamContinuations.workStreamId, candidate.workStreamId))
      if (
        !stream ||
        stream.status !== 'active' ||
        stream.pause ||
        stream.assigneeAgentId !== agentId ||
        !cycle ||
        cycle.generation !== candidate.generation ||
        cycle.assigneeAgentId !== agentId ||
        cycle.status !== 'exhausted'
      ) {
        return null
      }
      const openManualWaits = await tx
        .select()
        .from(workStreamWaits)
        .where(
          and(
            eq(workStreamWaits.workStreamId, stream.id),
            eq(workStreamWaits.type, 'manual'),
            eq(workStreamWaits.createdBy, 'system'),
            isNull(workStreamWaits.closedAt),
            lte(workStreamWaits.openedAt, runStartedAt)
          )
        )
        .orderBy(desc(workStreamWaits.openedAt))
      const watchdogWait = openManualWaits.find((wait) => isContinuationWatchdogMessage(wait.message))
      if (!watchdogWait) return null
      await testHooks.beforeClose?.()
      const [closedWait] = await closeOpenWaits(
        tx,
        { workStreamId: stream.id, type: 'manual', waitId: watchdogWait.id },
        'cleared',
        { note: `Execution ${executionId} started for the current assignee.` }
      )
      if (!closedWait) return null
      await resetContinuationCycle(tx, stream.id, agentId, runStartedAt)
      await tx.update(workStreams).set({ updatedAt: new Date() }).where(eq(workStreams.id, stream.id))
      return { workStreamId: stream.id, squadId: stream.squadId, waitId: closedWait.id }
    })
    if (!closed) continue
    resolved = true
    // This automatic stale-wait cleanup is an audit/UI transition, not a
    // response for the assignee to process as another inbox turn.
    eventEmitter.emit('workStream.updated', {
      workStreamId: closed.workStreamId,
      squadId: closed.squadId,
    })
  }
  return resolved
}

async function trustedWorkStreamMessageIdsForExecution(
  executor: DbExecutor,
  executionId: string,
  agentId: string,
  workStreamId: string
): Promise<string[]> {
  const origins = await listTrustedWorkStreamOriginsForExecution(executor, { agentId, executionId })
  return origins.find((origin) => origin.workStreamId === workStreamId)?.messageIds ?? []
}

export async function reportPersistentIdleIfCurrent(input: {
  workStreamId: string
  assigneeAgentId: string
  generation: number
  clientId: string
  triggerExecutionId: string
  deliveryExecutionId: string
  endedAt: Date
  now: Date
  /** Test seam for proving the lock-owning transaction needs one connection. */
  executor?: typeof db
  afterAgentLock?: () => void
}): Promise<boolean> {
  const afterCommit: Array<() => void> = []
  const settled = await (input.executor ?? db).transaction(async (tx) => {
    await tx.execute(sql`select id from work_streams where id = ${input.workStreamId} for update`)
    const [stream] = await tx.select().from(workStreams).where(eq(workStreams.id, input.workStreamId))
    if (!stream || stream.status !== 'active' || stream.pause || stream.assigneeAgentId !== input.assigneeAgentId)
      return false

    if ((await externalDeliveryStreamIds(tx, [stream])).has(input.workStreamId)) return false
    const [activeWait] = await waitsForAgent(tx, input.workStreamId, input.assigneeAgentId)
    const [squad] = await tx
      .select({ status: squads.status })
      .from(squads)
      .where(eq(squads.id, stream.squadId))
      .limit(1)
    const [cycle] = await tx
      .select()
      .from(workStreamContinuations)
      .where(eq(workStreamContinuations.workStreamId, input.workStreamId))
    if (
      activeWait ||
      squad?.status !== 'active' ||
      !cycle ||
      cycle.generation !== input.generation ||
      cycle.assigneeAgentId !== input.assigneeAgentId ||
      cycle.status !== 'delivered' ||
      cycle.normalAttemptCount !== 1 ||
      cycle.clientId !== input.clientId ||
      cycle.triggerExecutionId !== input.triggerExecutionId ||
      cycle.deliveryExecutionId !== input.deliveryExecutionId
    ) {
      return false
    }

    await acquireAgentQueueLock(tx, input.assigneeAgentId)
    if ((await listActiveSlotWaits(tx, [input.assigneeAgentId])).length) return false
    await tx.execute(sql`select id from agents where id = ${input.assigneeAgentId} for update`)
    const [agent] = await tx.select().from(agents).where(eq(agents.id, input.assigneeAgentId)).limit(1)
    const [normalTrigger] = await tx
      .select({ status: executions.status })
      .from(executions)
      .where(and(eq(executions.id, input.triggerExecutionId), eq(executions.agentId, input.assigneeAgentId)))
      .limit(1)
    const [normalDelivery] = await tx
      .select({ status: executions.status, endedAt: executions.endedAt })
      .from(executions)
      .where(and(eq(executions.id, input.deliveryExecutionId), eq(executions.agentId, input.assigneeAgentId)))
      .limit(1)
    const [activeExecution] = await tx
      .select({ id: executions.id })
      .from(executions)
      .where(
        and(eq(executions.agentId, input.assigneeAgentId), inArray(executions.status, [...ACTIVE_EXECUTION_STATUSES]))
      )
      .limit(1)
    const laterExecutions = await tx
      .select({ id: executions.id, agentId: executions.agentId })
      .from(executions)
      .where(
        and(
          eq(executions.agentId, input.assigneeAgentId),
          isNotNull(executions.runStartedAt),
          gt(executions.runStartedAt, input.endedAt)
        )
      )
    const laterWatchdogExecutionIds = await listTrustedContinuationExecutionIds(
      tx,
      laterExecutions.map((execution) => ({ agentId: execution.agentId, executionId: execution.id }))
    )
    const laterIndependentExecution = laterExecutions.find((execution) => !laterWatchdogExecutionIds.has(execution.id))
    if (
      !agent ||
      agent.status !== 'idle' ||
      agent.terminatedAt ||
      agent.pendingDormancyAt ||
      activeExecution ||
      laterIndependentExecution ||
      (normalTrigger?.status !== 'completed' && normalTrigger?.status !== 'stopped') ||
      !normalDelivery?.endedAt ||
      !['completed', 'stopped'].includes(normalDelivery.status) ||
      normalDelivery.endedAt.getTime() !== input.endedAt.getTime() ||
      input.endedAt.getTime() + NORMAL_IDLE_NOTICE_DELAY_MS > input.now.getTime()
    ) {
      return false
    }

    input.afterAgentLock?.()
    let notified = false
    try {
      notified = await persistWorkStreamPersistentIdleInTransaction(
        tx,
        stream,
        {
          generation: input.generation,
          normalExecutionId: input.deliveryExecutionId,
          endedAt: input.endedAt,
        },
        afterCommit
      )
    } catch (error) {
      log.error('Failed to record persistent idle notice', {
        workStreamId: input.workStreamId,
        generation: input.generation,
        normalExecutionId: input.deliveryExecutionId,
        error,
      })
      return false
    }
    if (!notified) return false

    const [settled] = await tx
      .update(workStreamContinuations)
      .set({
        status: 'idle',
        triggerExecutionId: null,
        clientId: null,
        nextAttemptAt: null,
        claimToken: null,
        claimedAt: null,
        deliveryPrompt: null,
        deliveryMessageId: null,
        deliveryExecutionId: null,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(workStreamContinuations.workStreamId, input.workStreamId),
          eq(workStreamContinuations.generation, input.generation),
          eq(workStreamContinuations.clientId, input.clientId),
          eq(workStreamContinuations.deliveryExecutionId, input.deliveryExecutionId),
          eq(workStreamContinuations.status, 'delivered')
        )
      )
      .returning({ id: workStreamContinuations.workStreamId })
    return Boolean(settled)
  })
  afterCommit.forEach((callback) => callback())
  return settled
}

async function settleContinuationAfterDirectCompletion(input: {
  workStreamId: string
  assigneeAgentId: string
  cycle: typeof workStreamContinuations.$inferSelect
  completionExecutionId: string
  completionEndedAt: Date
  now: Date
}): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select id from work_streams where id = ${input.workStreamId} for update`)
    const [freshStream] = await tx.select().from(workStreams).where(eq(workStreams.id, input.workStreamId))
    if (
      !freshStream ||
      freshStream.status !== 'active' ||
      freshStream.pause ||
      freshStream.assigneeAgentId !== input.assigneeAgentId
    ) {
      return
    }
    const cycle = input.cycle
    await tx
      .update(workStreamContinuations)
      .set({
        status: 'idle',
        triggerExecutionId: null,
        clientId: null,
        nextAttemptAt: null,
        claimToken: null,
        claimedAt: null,
        deliveryPrompt: null,
        deliveryMessageId: null,
        deliveryExecutionId: null,
        deliveryAttemptCount: 0,
        transportAttemptCount: 0,
        cycleStartedAt: input.completionEndedAt,
        progressExecutionId: input.completionExecutionId,
        lastError: null,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(workStreamContinuations.workStreamId, input.workStreamId),
          eq(workStreamContinuations.generation, cycle.generation),
          eq(workStreamContinuations.assigneeAgentId, input.assigneeAgentId),
          eq(workStreamContinuations.status, cycle.status),
          eq(workStreamContinuations.normalAttemptCount, cycle.normalAttemptCount),
          eq(workStreamContinuations.transportAttemptCount, cycle.transportAttemptCount),
          eq(workStreamContinuations.cycleStartedAt, cycle.cycleStartedAt),
          cycle.progressExecutionId === null
            ? isNull(workStreamContinuations.progressExecutionId)
            : eq(workStreamContinuations.progressExecutionId, cycle.progressExecutionId),
          cycle.clientId === null
            ? isNull(workStreamContinuations.clientId)
            : eq(workStreamContinuations.clientId, cycle.clientId),
          cycle.deliveryExecutionId === null
            ? isNull(workStreamContinuations.deliveryExecutionId)
            : eq(workStreamContinuations.deliveryExecutionId, cycle.deliveryExecutionId)
        )
      )
  })
}

function isAfterProgressHighWater(
  execution: { id: string; endedAt: Date | null },
  cycle: Pick<typeof workStreamContinuations.$inferSelect, 'cycleStartedAt' | 'progressExecutionId'>
): boolean {
  if (!execution.endedAt) return false
  const timeDelta = execution.endedAt.getTime() - cycle.cycleStartedAt.getTime()
  return (
    timeDelta > 0 ||
    (timeDelta === 0 && (cycle.progressExecutionId === null || execution.id > cycle.progressExecutionId))
  )
}

export interface WorkStreamContinuationSweepOptions {
  now?: Date
  /** Optional bounded maintenance scope; ordinary worker sweeps cover all squads. */
  squadId?: string
  /** Deterministic concurrency boundaries used by behavior-level race tests. */
  testHooks?: {
    beforeCandidateSchedule?: () => Promise<void>
    beforeExhaustionBlock?: () => Promise<void>
    beforeIdleNoticeCheck?: () => Promise<void>
    beforeDispatchQueue?: () => Promise<void>
  }
}

export async function reconcileWorkStreamContinuationsOnce(
  options: WorkStreamContinuationSweepOptions = {}
): Promise<void> {
  // Every comparison this sweep makes against `now` is against a column the DATABASE stamped
  // (`executions.ended_at`, and `cycleStartedAt`, which now follows the same clock). Taking `now`
  // from the app host would reintroduce exactly the skew those columns were changed to remove:
  // a host running ahead makes a fresh completion look older than the window and a delivered
  // stream look idle. One round trip per sweep.
  const now = options.now ?? (await readDatabaseClock())
  const allActive = await WorkStream.list({ status: 'active', squadId: options.squadId })
  // An active stream with an OPEN WAIT is waiting on something recorded
  // (review verdict, answer, dependency, manual hold) — the continuation
  // nudge must not fire for it. Pre-consolidation this exclusion happened via
  // the blocked/review statuses; now it reads the waits table.
  const waiting = await waitingAssigneeStreamIds(db, allActive)
  const externalDelivery = await externalDeliveryStreamIds(db, allActive)
  const streams = allActive.filter(
    (stream) => !stream.pause && stream.assigneeAgentId && !waiting.has(stream.id) && !externalDelivery.has(stream.id)
  )

  // Every lookup below used to run once PER ACTIVE STREAM — 4-5 round trips per
  // stream on a 30s cadence (assignee+squad, active-execution probe, the
  // continuation cycle, and the latest settled execution). They are now
  // set-based, so the pre-schedule phase costs a fixed handful of statements no
  // matter how many streams are active. Decision semantics are unchanged: the
  // same rows are read, just in batches, and every write below still re-reads
  // and fences its own row inside a transaction.
  const assigneeIds = [...new Set(streams.map((s) => s.assigneeAgentId!))]
  const assignees = assigneeIds.length
    ? await db
        .select({
          id: agents.id,
          status: agents.status,
          pendingDormancyAt: agents.pendingDormancyAt,
          squadStatus: squads.status,
        })
        .from(agents)
        .innerJoin(squads, eq(squads.id, agents.squadId))
        .where(and(inArray(agents.id, assigneeIds), eq(squads.status, 'active')))
    : []
  const idleAgentIds = assignees
    .filter((agent) => agent.status === 'idle' && !agent.pendingDormancyAt)
    .map((agent) => agent.id)
  const busyAgentIds = new Set(
    idleAgentIds.length
      ? (
          await db
            .selectDistinct({ agentId: executions.agentId })
            .from(executions)
            .where(
              and(inArray(executions.agentId, idleAgentIds), inArray(executions.status, [...ACTIVE_EXECUTION_STATUSES]))
            )
        ).map((row) => row.agentId)
      : []
  )
  const slotWaitingAgentIds = new Set((await listActiveSlotWaits(db, idleAgentIds)).map((wait) => wait.agentId))
  const readyAgentIds = new Set(idleAgentIds.filter((id) => !busyAgentIds.has(id) && !slotWaitingAgentIds.has(id)))
  const candidates = streams.filter((s) => readyAgentIds.has(s.assigneeAgentId!))

  const cycleByStreamId = new Map<string, typeof workStreamContinuations.$inferSelect>()
  if (candidates.length) {
    const existing = await db
      .select()
      .from(workStreamContinuations)
      .where(
        inArray(
          workStreamContinuations.workStreamId,
          candidates.map((s) => s.id)
        )
      )
    for (const row of existing) cycleByStreamId.set(row.workStreamId, row)
    const missing = candidates.filter((s) => !cycleByStreamId.has(s.id))
    if (missing.length) {
      const inserted = await db
        .insert(workStreamContinuations)
        .values(
          missing.map((s) => ({
            workStreamId: s.id,
            assigneeAgentId: s.assigneeAgentId!,
            // KNOWN RESIDUAL (single-clock): `work_streams.updated_at` defaults to the database
            // clock but is also written from host `new Date()` values by several stream writers,
            // so a backfilled high-water mark can still carry host skew. Deliberately not changed
            // here — seeding from "when the stream last changed" is the point of this backfill,
            // and converting every `work_streams.updated_at` writer is a separate change. The
            // exposure is one sweep for a stream that had no continuation row at all.
            cycleStartedAt: s.updatedAt,
          }))
        )
        .onConflictDoNothing()
        .returning()
      for (const row of inserted) cycleByStreamId.set(row.workStreamId, row)
      const raced = missing.filter((s) => !cycleByStreamId.has(s.id))
      if (raced.length) {
        const rows = await db
          .select()
          .from(workStreamContinuations)
          .where(
            inArray(
              workStreamContinuations.workStreamId,
              raced.map((s) => s.id)
            )
          )
        for (const row of rows) cycleByStreamId.set(row.workStreamId, row)
      }
    }
  }

  const scheduleCandidates = candidates.filter((s) => {
    const cycle = cycleByStreamId.get(s.id)
    return Boolean(cycle && cycle.assigneeAgentId === s.assigneeAgentId)
  })

  // Only these five columns are read below; the old per-stream lookup was a
  // `select *` that dragged `message`, `usage` and `error` payloads back for
  // every active stream every tick.
  const latestExecutionColumns = {
    id: executions.id,
    agentId: executions.agentId,
    status: executions.status,
    error: executions.error,
    failureClass: executions.failureClass,
    failureReason: executions.failureReason,
    endedAt: executions.endedAt,
  }
  const settledStatuses = ['completed', 'stopped', 'failed'] as const
  const pinnedExecutionIds = [
    ...new Set(
      scheduleCandidates
        .map((s) => cycleByStreamId.get(s.id)!.deliveryExecutionId)
        .filter((id): id is string => Boolean(id))
    ),
  ]
  const pinnedById = new Map(
    (pinnedExecutionIds.length
      ? await db
          .select(latestExecutionColumns)
          .from(executions)
          .where(
            and(
              inArray(executions.id, pinnedExecutionIds),
              inArray(executions.status, [...settledStatuses]),
              isNotNull(executions.endedAt)
            )
          )
      : []
    ).map((row) => [row.id, row] as const)
  )
  const triggerExecutionIds = [
    ...new Set(
      scheduleCandidates
        .map((s) => cycleByStreamId.get(s.id)!.triggerExecutionId)
        .filter((id): id is string => Boolean(id))
    ),
  ]
  const triggerById = new Map(
    (triggerExecutionIds.length
      ? await db
          .select({ id: executions.id, status: executions.status })
          .from(executions)
          .where(inArray(executions.id, triggerExecutionIds))
      : []
    ).map((row) => [row.id, row] as const)
  )
  const pinnedAgentIds = [
    ...new Set(
      scheduleCandidates.filter((s) => cycleByStreamId.get(s.id)!.deliveryExecutionId).map((s) => s.assigneeAgentId!)
    ),
  ]
  const unpinnedAgentIds = [
    ...new Set(
      scheduleCandidates.filter((s) => !cycleByStreamId.get(s.id)!.deliveryExecutionId).map((s) => s.assigneeAgentId!)
    ),
  ]
  const evidenceAgentIds = [...new Set([...pinnedAgentIds, ...unpinnedAgentIds])]
  const oldestEvidenceAt = scheduleCandidates.reduce<Date | null>((oldest, stream) => {
    const startedAt = cycleByStreamId.get(stream.id)!.cycleStartedAt
    return !oldest || startedAt < oldest ? startedAt : oldest
  }, null)
  // Read every potentially relevant terminal fact once, then classify all
  // watchdog-created executions in a fixed number of set-wise queries. This
  // permits falling back past a newer watchdog completion to the newest real
  // direct fact without adding per-stream provenance lookups.
  const settledEvidence =
    evidenceAgentIds.length && oldestEvidenceAt
      ? await db
          .select(latestExecutionColumns)
          .from(executions)
          .where(
            and(
              inArray(executions.agentId, evidenceAgentIds),
              inArray(executions.status, [...settledStatuses]),
              isNotNull(executions.endedAt),
              gte(executions.endedAt, oldestEvidenceAt)
            )
          )
          .orderBy(executions.agentId, desc(executions.endedAt), desc(executions.id))
      : []
  const watchdogExecutionIds = await listTrustedContinuationExecutionIds(
    db,
    settledEvidence.map((row) => ({ agentId: row.agentId, executionId: row.id }))
  )
  const pinnedAgentIdSet = new Set(pinnedAgentIds)
  const unpinnedAgentIdSet = new Set(unpinnedAgentIds)
  const latestSettledByPinnedAgentId = new Map<string, (typeof settledEvidence)[number]>()
  const latestCompletionByPinnedAgentId = new Map<string, (typeof settledEvidence)[number]>()
  const latestByAgentId = new Map<string, (typeof settledEvidence)[number]>()
  for (const row of settledEvidence) {
    if (watchdogExecutionIds.has(row.id)) continue
    if (pinnedAgentIdSet.has(row.agentId)) {
      if (!latestSettledByPinnedAgentId.has(row.agentId)) latestSettledByPinnedAgentId.set(row.agentId, row)
      if (row.status === 'completed' && !latestCompletionByPinnedAgentId.has(row.agentId)) {
        latestCompletionByPinnedAgentId.set(row.agentId, row)
      }
    }
    if (unpinnedAgentIdSet.has(row.agentId) && !latestByAgentId.has(row.agentId)) {
      latestByAgentId.set(row.agentId, row)
    }
  }

  for (const workStream of scheduleCandidates) {
    const agentId = workStream.assigneeAgentId!
    const cycle = cycleByStreamId.get(workStream.id)!
    const trigger = cycle.triggerExecutionId ? triggerById.get(cycle.triggerExecutionId) : undefined
    const legacyDeliveredNormal =
      cycle.status === 'delivered' &&
      cycle.normalAttemptCount === 0 &&
      isLegacyContinuationClientId(workStream.id, cycle.generation, cycle.clientId) &&
      (trigger?.status === 'completed' || trigger?.status === 'stopped')
    if (legacyDeliveredNormal) {
      const adopted = await db.transaction(async (tx) => {
        await tx.execute(sql`select id from work_streams where id = ${workStream.id} for update`)
        const [freshStream] = await tx.select().from(workStreams).where(eq(workStreams.id, workStream.id))
        const [freshTrigger] = await tx
          .select({ status: executions.status })
          .from(executions)
          .where(eq(executions.id, cycle.triggerExecutionId!))
          .limit(1)
        if (
          !freshStream ||
          freshStream.status !== 'active' ||
          freshStream.pause ||
          freshStream.assigneeAgentId !== cycle.assigneeAgentId ||
          (freshTrigger?.status !== 'completed' && freshTrigger?.status !== 'stopped')
        ) {
          return false
        }
        const [updated] = await tx
          .update(workStreamContinuations)
          .set({ normalAttemptCount: 1, transportAttemptCount: 0, updatedAt: now })
          .where(
            and(
              eq(workStreamContinuations.workStreamId, workStream.id),
              eq(workStreamContinuations.generation, cycle.generation),
              eq(workStreamContinuations.status, 'delivered'),
              eq(workStreamContinuations.normalAttemptCount, 0),
              eq(workStreamContinuations.transportAttemptCount, cycle.transportAttemptCount),
              eq(workStreamContinuations.clientId, cycle.clientId!),
              eq(workStreamContinuations.triggerExecutionId, cycle.triggerExecutionId!)
            )
          )
          .returning({ id: workStreamContinuations.workStreamId })
        return Boolean(updated)
      })
      if (!adopted) continue
      cycle.normalAttemptCount = 1
      cycle.transportAttemptCount = 0
    }

    const pinned = cycle.deliveryExecutionId ? pinnedById.get(cycle.deliveryExecutionId) : undefined
    const latestSettled = cycle.deliveryExecutionId ? latestSettledByPinnedAgentId.get(agentId) : undefined
    const latestCompletion = cycle.deliveryExecutionId ? latestCompletionByPinnedAgentId.get(agentId) : undefined
    const newerSettled =
      pinned?.endedAt &&
      latestSettled?.endedAt &&
      (latestSettled.endedAt.getTime() > pinned.endedAt.getTime() ||
        (latestSettled.endedAt.getTime() === pinned.endedAt.getTime() && latestSettled.id > pinned.id))
        ? latestSettled
        : undefined
    const newerCompletion =
      pinned?.endedAt &&
      latestCompletion?.endedAt &&
      (latestCompletion.endedAt.getTime() > pinned.endedAt.getTime() ||
        (latestCompletion.endedAt.getTime() === pinned.endedAt.getTime() && latestCompletion.id > pinned.id))
        ? latestCompletion
        : undefined
    const latest = cycle.deliveryExecutionId
      ? (newerSettled ?? (pinned && pinned.agentId === agentId ? pinned : undefined))
      : latestByAgentId.get(agentId)
    if (!latest || !latest.endedAt) continue
    // A pending row already represents a claimed logical continuation. Do not
    // replace its trigger-specific idempotency key while its delivery is still
    // retryable; the due-delivery phase below owns that transition.
    if (cycle.status === 'pending') continue
    const substantiveCompletion = cycle.deliveryExecutionId ? Boolean(newerCompletion) : latest.status === 'completed'
    const substantiveCompletionExecutionId = newerCompletion?.id ?? (substantiveCompletion ? latest.id : undefined)
    const substantiveCompletionEndedAt = newerCompletion?.endedAt ?? latest.endedAt
    const outcome = executionOutcomeOf(latest)
    // Stored class is authoritative: a transport failure is recognized from
    // failure_class='provider_transport' without prose matching. The sentinel
    // text check remains ONLY as the legacy fallback for pre-classification
    // rows whose failure_class is NULL.
    const providerTransportFailure =
      (outcome.kind === 'provider_failure' && outcome.retryableTransport) ||
      (latest.failureClass == null &&
        latest.status === 'failed' &&
        latest.error != null &&
        isDurableProviderTransportFailure(latest.error))
    if (latest.status === 'failed' && !providerTransportFailure) {
      // Non-transport failures — including platform_pre_tool_refusal — are
      // NEVER nudged: this branch skips both budgets entirely (no settle
      // write, no attempt counters, no scheduled candidate), so a pre-tool
      // admission refusal cannot consume the `agent stopped` nudge path.
      // Surfacing that condition belongs to the derived `execution_failed`
      // state and the exactly-once owner notification, not this watchdog.
      if (substantiveCompletion && substantiveCompletionEndedAt) {
        await settleContinuationAfterDirectCompletion({
          workStreamId: workStream.id,
          assigneeAgentId: agentId,
          cycle,
          completionExecutionId: substantiveCompletionExecutionId!,
          completionEndedAt: substantiveCompletionEndedAt,
          now,
        })
      }
      continue
    }
    if (
      providerTransportFailure &&
      (await trustedWorkStreamMessageIdsForExecution(db, latest.id, agentId, workStream.id)).length === 0
    ) {
      if (substantiveCompletion && substantiveCompletionEndedAt) {
        await settleContinuationAfterDirectCompletion({
          workStreamId: workStream.id,
          assigneeAgentId: agentId,
          cycle,
          completionExecutionId: substantiveCompletionExecutionId!,
          completionEndedAt: substantiveCompletionEndedAt,
          now,
        })
      }
      continue
    }
    if (!isAfterProgressHighWater(latest, cycle) || latest.id === cycle.triggerExecutionId) continue
    const kind: ContinuationKind = providerTransportFailure ? 'transport' : 'normal'
    // Only a completion outside the watchdog's own delivered nudge is
    // substantive progress. A direct completed turn proves provider transport
    // is functioning again, so it clears the transport failure streak, but the
    // generation's one normal nudge remains consumed. Keep this progress fact
    // even when a later terminal failure is the action selected for recovery.
    const observedTransportAttemptCount = substantiveCompletion ? 0 : cycle.transportAttemptCount
    if (kind === 'normal' && cycle.normalAttemptCount >= NORMAL_CONTINUATION_MAX_ATTEMPTS) {
      if (
        !substantiveCompletion &&
        cycle.status === 'delivered' &&
        cycle.clientId &&
        cycle.triggerExecutionId &&
        cycle.deliveryExecutionId === latest.id &&
        (trigger?.status === 'completed' || trigger?.status === 'stopped') &&
        latest.endedAt.getTime() + NORMAL_IDLE_NOTICE_DELAY_MS <= now.getTime()
      ) {
        await options.testHooks?.beforeIdleNoticeCheck?.()
        await reportPersistentIdleIfCurrent({
          workStreamId: workStream.id,
          assigneeAgentId: agentId,
          generation: cycle.generation,
          clientId: cycle.clientId,
          triggerExecutionId: cycle.triggerExecutionId,
          deliveryExecutionId: latest.id,
          endedAt: latest.endedAt,
          now,
        })
      }
      if (substantiveCompletion && substantiveCompletionEndedAt) {
        await settleContinuationAfterDirectCompletion({
          workStreamId: workStream.id,
          assigneeAgentId: agentId,
          cycle,
          completionExecutionId: substantiveCompletionExecutionId!,
          completionEndedAt: substantiveCompletionEndedAt,
          now,
        })
      }
      continue
    }
    if (kind === 'transport' && observedTransportAttemptCount >= TRANSPORT_CONTINUATION_MAX_ATTEMPTS) {
      await options.testHooks?.beforeExhaustionBlock?.()
      await blockCurrentContinuation(
        workStream.id,
        cycle.generation,
        cycle.assigneeAgentId!,
        TRANSPORT_EXHAUSTION_MESSAGE,
        (current) =>
          current.transportAttemptCount >= TRANSPORT_CONTINUATION_MAX_ATTEMPTS &&
          current.triggerExecutionId !== latest.id,
        latest.id,
        now
      )
      continue
    }

    const ordinal = kind === 'normal' ? 1 : observedTransportAttemptCount + 1
    const latestEndedAt = latest.endedAt
    const clientId = ['work-stream-continuation', workStream.id, cycle.generation, kind, ordinal, latest.id].join(':')
    const delayMs = kind === 'transport' ? transportContinuationDelay(ordinal, clientId) : continuationDelay(ordinal)
    await options.testHooks?.beforeCandidateSchedule?.()
    const scheduled = await db.transaction(async (tx) => {
      await tx.execute(sql`select id from work_streams where id = ${workStream.id} for update`)
      const [freshStream] = await tx.select().from(workStreams).where(eq(workStreams.id, workStream.id))
      if (
        !freshStream ||
        freshStream.status !== 'active' ||
        freshStream.pause ||
        freshStream.assigneeAgentId !== cycle.assigneeAgentId
      ) {
        return false
      }
      await acquireAgentQueueLock(tx, agentId)
      if ((await listActiveSlotWaits(tx, [agentId])).length) return false
      const [updated] = await tx
        .update(workStreamContinuations)
        .set({
          status: 'pending',
          triggerExecutionId: latest.id,
          clientId,
          deliveryPrompt:
            kind === 'normal'
              ? buildNormalContinuationPrompt(freshStream)
              : buildTransportContinuationPrompt(freshStream),
          deliveryMessageId: null,
          deliveryExecutionId: null,
          nextAttemptAt: new Date(latestEndedAt.getTime() + delayMs),
          claimToken: null,
          claimedAt: null,
          deliveryAttemptCount: 0,
          lastError: null,
          transportAttemptCount: observedTransportAttemptCount,
          cycleStartedAt:
            substantiveCompletion && substantiveCompletionEndedAt ? substantiveCompletionEndedAt : cycle.cycleStartedAt,
          progressExecutionId: substantiveCompletionExecutionId ?? cycle.progressExecutionId,
          updatedAt: now,
        })
        .where(
          and(
            eq(workStreamContinuations.workStreamId, workStream.id),
            eq(workStreamContinuations.generation, cycle.generation),
            eq(workStreamContinuations.assigneeAgentId, cycle.assigneeAgentId!),
            eq(workStreamContinuations.status, cycle.status),
            eq(workStreamContinuations.normalAttemptCount, cycle.normalAttemptCount),
            eq(workStreamContinuations.transportAttemptCount, cycle.transportAttemptCount),
            eq(workStreamContinuations.cycleStartedAt, cycle.cycleStartedAt),
            cycle.progressExecutionId === null
              ? isNull(workStreamContinuations.progressExecutionId)
              : eq(workStreamContinuations.progressExecutionId, cycle.progressExecutionId),
            cycle.triggerExecutionId === null
              ? isNull(workStreamContinuations.triggerExecutionId)
              : eq(workStreamContinuations.triggerExecutionId, cycle.triggerExecutionId),
            cycle.claimedAt === null
              ? isNull(workStreamContinuations.claimedAt)
              : eq(workStreamContinuations.claimedAt, cycle.claimedAt)
          )
        )
        .returning({ workStreamId: workStreamContinuations.workStreamId })
      return Boolean(updated)
    })
    if (scheduled && providerTransportFailure) {
      log.info('Scheduled provider transport continuation', {
        strategy: 'durable-transport-continuation',
        workStreamId: workStream.id,
        triggerExecutionId: latest.id,
        generation: cycle.generation,
        attempt: ordinal,
        delayMs,
      })
    }
  }

  const dueCandidates = await db
    .select()
    .from(workStreamContinuations)
    .where(
      and(
        options.squadId === undefined
          ? undefined
          : inArray(
              workStreamContinuations.workStreamId,
              db.select({ id: workStreams.id }).from(workStreams).where(eq(workStreams.squadId, options.squadId))
            ),
        eq(workStreamContinuations.status, 'pending'),
        lte(workStreamContinuations.nextAttemptAt, now),
        or(
          isNull(workStreamContinuations.claimedAt),
          lt(workStreamContinuations.claimedAt, new Date(now.getTime() - CONTINUATION_CLAIM_LEASE_MS))
        )
      )
    )

  for (const candidate of dueCandidates) {
    if (!candidate.clientId || !candidate.assigneeAgentId) continue
    const [triggerExecution] = candidate.triggerExecutionId
      ? await db
          .select({ status: executions.status, error: executions.error, failureClass: executions.failureClass })
          .from(executions)
          .where(eq(executions.id, candidate.triggerExecutionId))
          .limit(1)
      : []
    const transportTrigger =
      triggerExecution?.status === 'failed' &&
      (triggerExecution.failureClass === 'provider_transport' ||
        (triggerExecution.failureClass == null && isDurableProviderTransportFailure(triggerExecution.error)))
    if (!triggerExecution || (triggerExecution.status === 'failed' && !transportTrigger)) continue
    const clientId = candidate.clientId
    const assigneeAgentId = candidate.assigneeAgentId
    const claimToken = crypto.randomUUID()
    const claimed = await db.transaction(async (tx) => {
      await tx.execute(sql`select id from work_streams where id = ${candidate.workStreamId} for update`)
      const [currentStream] = await tx.select().from(workStreams).where(eq(workStreams.id, candidate.workStreamId))
      const [currentCycle] = await tx
        .select()
        .from(workStreamContinuations)
        .where(eq(workStreamContinuations.workStreamId, candidate.workStreamId))
      if (
        !currentStream ||
        currentStream.status !== 'active' ||
        currentStream.assigneeAgentId !== candidate.assigneeAgentId ||
        !currentCycle ||
        currentCycle.generation !== candidate.generation ||
        currentCycle.clientId !== candidate.clientId ||
        currentCycle.status !== 'pending'
      )
        return false
      if (
        transportTrigger &&
        (!candidate.triggerExecutionId ||
          (
            await trustedWorkStreamMessageIdsForExecution(
              tx,
              candidate.triggerExecutionId,
              assigneeAgentId,
              candidate.workStreamId
            )
          ).length === 0)
      ) {
        return false
      }

      const [won] = await tx
        .update(workStreamContinuations)
        .set({ claimToken, claimedAt: now, updatedAt: now })
        .where(
          and(
            eq(workStreamContinuations.workStreamId, candidate.workStreamId),
            eq(workStreamContinuations.generation, candidate.generation),
            eq(workStreamContinuations.clientId, clientId),
            eq(workStreamContinuations.status, 'pending'),
            or(
              isNull(workStreamContinuations.claimedAt),
              lt(workStreamContinuations.claimedAt, new Date(now.getTime() - CONTINUATION_CLAIM_LEASE_MS))
            )
          )
        )
        .returning({ workStreamId: workStreamContinuations.workStreamId })
      return Boolean(won)
    })
    if (!claimed) continue

    const afterCommit: Array<() => void | Promise<void>> = []
    let delivered = false
    try {
      await db.transaction(async (tx) => {
        // queueExecutionInTransaction uses maintenance -> stream -> agent queue.
        // Acquire maintenance first, before taking the new enqueue/nudge fence.
        await maintenanceStore.readLocked(tx)
        await tx.execute(sql`select id from work_streams where id = ${candidate.workStreamId} for update`)
        const [currentStream] = await tx.select().from(workStreams).where(eq(workStreams.id, candidate.workStreamId))
        const [currentCycle] = await tx
          .select()
          .from(workStreamContinuations)
          .where(eq(workStreamContinuations.workStreamId, candidate.workStreamId))
        if (
          !currentStream ||
          currentStream.status !== 'active' ||
          currentStream.assigneeAgentId !== candidate.assigneeAgentId ||
          !currentCycle ||
          currentCycle.generation !== candidate.generation ||
          currentCycle.clientId !== candidate.clientId ||
          currentCycle.claimToken !== claimToken ||
          currentCycle.status !== 'pending'
        )
          return

        const deferClaim = async () => {
          await tx
            .update(workStreamContinuations)
            .set({
              claimToken: null,
              claimedAt: null,
              nextAttemptAt: new Date(now.getTime() + CONTINUATION_SWEEP_MS),
              updatedAt: now,
            })
            .where(
              and(
                eq(workStreamContinuations.workStreamId, candidate.workStreamId),
                eq(workStreamContinuations.claimToken, claimToken)
              )
            )
        }
        const [activeWait] = await waitsForAgent(tx, candidate.workStreamId, assigneeAgentId)
        if (activeWait || (await externalDeliveryStreamIds(tx, [currentStream!])).has(candidate.workStreamId)) {
          await deferClaim()
          return
        }

        const triggerMessageIds =
          transportTrigger && candidate.triggerExecutionId
            ? await trustedWorkStreamMessageIdsForExecution(
                tx,
                candidate.triggerExecutionId,
                assigneeAgentId,
                candidate.workStreamId
              )
            : []
        if (transportTrigger && triggerMessageIds.length === 0) {
          await deferClaim()
          return
        }

        const [agentRow] = await tx.select().from(agents).where(eq(agents.id, assigneeAgentId)).limit(1)
        const [activeExecution] = await tx
          .select({ id: executions.id })
          .from(executions)
          .where(
            and(eq(executions.agentId, assigneeAgentId), inArray(executions.status, [...ACTIVE_EXECUTION_STATUSES]))
          )
          .limit(1)
        if (!agentRow || agentRow.status !== 'idle' || agentRow.pendingDormancyAt || activeExecution) {
          await deferClaim()
          return
        }

        await options.testHooks?.beforeDispatchQueue?.()
        // claim/subscribe acquire this same lock before enqueueing a waiter.
        // Keep it through inbox persistence AND execution queueing: an earlier
        // idle scan (or a pending continuation from a prior scan) is not a fence.
        // This is deliberately not a general execution-admission restriction;
        // human steering, real grants and other inbox notifications still wake.
        await acquireAgentQueueLock(tx, assigneeAgentId)
        if ((await listActiveSlotWaits(tx, [assigneeAgentId])).length) {
          await deferClaim()
          return
        }
        const [lockedTrigger] = candidate.triggerExecutionId
          ? await tx
              .select({ endedAt: executions.endedAt })
              .from(executions)
              .where(
                and(
                  eq(executions.id, candidate.triggerExecutionId),
                  eq(executions.agentId, assigneeAgentId),
                  isNotNull(executions.endedAt)
                )
              )
              .limit(1)
          : []
        if (!lockedTrigger?.endedAt) {
          await deferClaim()
          return
        }
        const newerExecutions = await tx
          .select({
            id: executions.id,
            agentId: executions.agentId,
            status: executions.status,
            endedAt: executions.endedAt,
          })
          .from(executions)
          .where(
            and(
              eq(executions.agentId, assigneeAgentId),
              sql`${executions.id} <> ${candidate.triggerExecutionId}`,
              isNotNull(executions.runStartedAt),
              gte(executions.runStartedAt, lockedTrigger.endedAt)
            )
          )
          .orderBy(desc(executions.endedAt), desc(executions.id))
        const newerWatchdogExecutionIds = await listTrustedContinuationExecutionIds(
          tx,
          newerExecutions.map((execution) => ({ agentId: execution.agentId, executionId: execution.id }))
        )
        const newerIndependentExecutions = newerExecutions.filter(
          (execution) => !newerWatchdogExecutionIds.has(execution.id)
        )
        if (newerIndependentExecutions.length > 0) {
          const directCompletion = newerIndependentExecutions.find(
            (execution) => execution.status === 'completed' && execution.endedAt
          )
          await tx
            .update(workStreamContinuations)
            .set({
              status: 'idle',
              triggerExecutionId: null,
              clientId: null,
              nextAttemptAt: null,
              claimToken: null,
              claimedAt: null,
              deliveryPrompt: null,
              deliveryMessageId: null,
              deliveryExecutionId: null,
              deliveryAttemptCount: 0,
              transportAttemptCount: directCompletion ? 0 : currentCycle.transportAttemptCount,
              cycleStartedAt: directCompletion?.endedAt ?? currentCycle.cycleStartedAt,
              progressExecutionId: directCompletion?.id ?? currentCycle.progressExecutionId,
              lastError: null,
              updatedAt: now,
            })
            .where(
              and(
                eq(workStreamContinuations.workStreamId, candidate.workStreamId),
                eq(workStreamContinuations.generation, currentCycle.generation),
                eq(workStreamContinuations.clientId, clientId),
                eq(workStreamContinuations.claimToken, claimToken),
                eq(workStreamContinuations.status, 'pending'),
                eq(workStreamContinuations.normalAttemptCount, currentCycle.normalAttemptCount),
                eq(workStreamContinuations.transportAttemptCount, currentCycle.transportAttemptCount),
                eq(workStreamContinuations.cycleStartedAt, currentCycle.cycleStartedAt),
                currentCycle.progressExecutionId === null
                  ? isNull(workStreamContinuations.progressExecutionId)
                  : eq(workStreamContinuations.progressExecutionId, currentCycle.progressExecutionId),
                eq(workStreamContinuations.triggerExecutionId, candidate.triggerExecutionId!)
              )
            )
          return
        }
        if (triggerMessageIds.length > 0) {
          await tx
            .update(messages)
            .set({
              pending: false,
              // jsonbObjectRecovered, not coalesce: coalesce only guards SQL NULL, so a
              // double-encoded (jsonb string) metadata made this jsonb_set throw 22023
              // `cannot set path in scalar`. That aborted the delivery, which re-queued it,
              // which is how one driver-level corruption turned into a continuation retry
              // storm (noah, 2026-08-29). Recovering also preserves the row's real metadata.
              metadata: sql`jsonb_set(
                ${jsonbObjectRecovered(messages.metadata)},
                '{terminalTransportReconciledAt}',
                to_jsonb(statement_timestamp()),
                true
              )`,
            })
            .where(
              and(
                inArray(messages.id, triggerMessageIds),
                eq(messages.agentId, assigneeAgentId),
                eq(messages.pending, true)
              )
            )
          // This flip changes the agent's denormalized conversation summary —
          // a pending row becoming delivered enters the `pending = false` set
          // that lastMessageAt/lastMessagePreview are computed from. Unlike
          // pending-delivery.ts this path emits no message event, so the
          // event subscriber in services/agents/activity-summary.ts cannot see
          // it and the refresh has to be explicit. In the caller's tx, so the
          // summary commits with the flip or not at all.
          await refreshAgentActivity(assigneeAgentId, tx)
        }
        const kind: ContinuationKind = transportTrigger ? 'transport' : 'normal'
        const logicalAttempt = kind === 'normal' ? 1 : currentCycle.transportAttemptCount + 1
        const continuationContent =
          currentCycle.deliveryPrompt ??
          (kind === 'normal'
            ? buildNormalContinuationPrompt(currentStream)
            : buildTransportContinuationPrompt(currentStream))
        const continuationMetadata = {
          source: 'work-stream-continuation',
          workStreamId: currentStream.id,
          generation: currentCycle.generation,
          kind,
          attempt: logicalAttempt,
          clientId,
        }
        const inboxMessage = await InboxMessage.persistSystemAgentOnceInTransaction(
          tx,
          {
            recipientId: assigneeAgentId,
            content: continuationContent,
            metadata: continuationMetadata,
            deliveryMode: 'steer',
            wakeEligible: true,
          },
          clientId,
          afterCommit
        )
        const [inboxDeliveryClaim] = await tx
          .update(inbox)
          .set({ deliveredAt: now })
          .where(and(eq(inbox.id, inboxMessage.id), isNull(inbox.deliveredAt)))
          .returning({ id: inbox.id })
        const [existingMessage] = await tx
          .select()
          .from(messages)
          .where(
            and(
              eq(messages.agentId, assigneeAgentId),
              eq(messages.role, 'human'),
              sql`${messages.metadata}->'inboxMessageIds' @> ${JSON.stringify([inboxMessage.id])}::jsonb`
            )
          )
          .limit(1)
        if (!inboxDeliveryClaim && !existingMessage) {
          await deferClaim()
          return
        }
        const agent = new Agent(agentRow)
        let execution
        if (existingMessage?.pending && !existingMessage.injectedAt) {
          execution = await agent.queueExecutionInTransaction(tx, {}, afterCommit)
        } else if (!existingMessage) {
          const delivery = prepareInboxDelivery([inboxMessage], 'steer', 'steer')
          execution = await agent.queueExecutionInTransaction(
            tx,
            {
              message: delivery.prompt,
              metadata: { ...delivery.metadata, clientId: `${clientId}:inbox` },
            },
            afterCommit
          )
        } else {
          const executionId = (existingMessage.metadata as { executionId?: string } | null)?.executionId
          const [executionRow] = executionId
            ? await tx.select().from(executions).where(eq(executions.id, executionId)).limit(1)
            : []
          execution = executionRow ? new Execution(executionRow).setAgent(agent) : null
        }
        if (!execution) throw new Error('Continuation delivery is missing its exact execution')
        const messageId =
          existingMessage?.id ??
          (
            await tx
              .select({ id: messages.id })
              .from(messages)
              .where(
                and(
                  eq(messages.agentId, assigneeAgentId),
                  sql`${messages.metadata}->'inboxMessageIds' @> ${JSON.stringify([inboxMessage.id])}::jsonb`
                )
              )
              .limit(1)
          )[0]?.id
        if (!messageId) throw new Error('Continuation delivery is missing its exact message')
        const [settled] = await tx
          .update(workStreamContinuations)
          .set({
            status: 'delivered',
            normalAttemptCount: kind === 'normal' ? 1 : currentCycle.normalAttemptCount,
            transportAttemptCount:
              kind === 'transport'
                ? logicalAttempt
                : isLegacyContinuationClientId(
                      currentCycle.workStreamId,
                      currentCycle.generation,
                      currentCycle.clientId
                    )
                  ? 0
                  : currentCycle.transportAttemptCount,
            deliveryAttemptCount: 0,
            claimToken: null,
            claimedAt: null,
            deliveryMessageId: messageId,
            deliveryExecutionId: execution.id,
            lastDeliveredAt: now,
            lastError: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(workStreamContinuations.workStreamId, candidate.workStreamId),
              eq(workStreamContinuations.generation, candidate.generation),
              eq(workStreamContinuations.clientId, clientId),
              eq(workStreamContinuations.claimToken, claimToken),
              eq(workStreamContinuations.status, 'pending')
            )
          )
          .returning({ workStreamId: workStreamContinuations.workStreamId })
        if (!settled) throw new Error('Continuation delivery claim was superseded')
        delivered = true
      })
      for (const emit of afterCommit) await emit()
      if (delivered && transportTrigger) {
        log.info('Delivered provider transport continuation', {
          strategy: 'durable-transport-continuation',
          workStreamId: candidate.workStreamId,
          triggerExecutionId: candidate.triggerExecutionId,
          generation: candidate.generation,
          attempt: candidate.transportAttemptCount + 1,
        })
      }
    } catch (error) {
      await recordContinuationDeliveryFailure({
        workStreamId: candidate.workStreamId,
        generation: candidate.generation,
        assigneeAgentId,
        clientId,
        claimToken,
        error,
        now,
      })
    }
  }
}
