import { createLogger } from '../../lib/infra/logger'
import { recoveryRecipients, reportUnroutableRecovery } from './recipients'
import { z } from 'zod'
import { stripVTControlCharacters } from 'node:util'
import { createHash } from 'node:crypto'
import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import {
  activeWorkflowAttempts,
  RECOVERY_ATTEMPT_BUDGET,
  manualWaitDecisionSchema,
  type ManualWaitDecision,
  type StructuredManualWait,
} from '@ficus/shared'
import {
  db,
  agents,
  inbox,
  executions,
  recoveryAttempts,
  recoveryDecisions,
  recoveryEpisodes,
  workStreams,
  workStreamWaits,
  workStreamFlowRuns,
  workStreamContinuations,
} from '../../db'
import { successorRecoveryState, failedRecovery, continueRecovery, recoverySummary } from './policy'
import { openWait, type DbHandle } from '../work-streams/waits'
import { getContentSafetyRegistry } from '../security/content-safety-registry'
import { eventEmitter } from '../../lib/infra/event-emitter'
import { restartContextForCommandError } from '../sandbox/command-drain'

const log = createLogger('recovery-store')

export type RecoveryRecord = typeof recoveryEpisodes.$inferSelect
export interface RecoveryOrigin {
  agentId: string
  executionId: string
}
export interface RecoveryActor {
  agentId?: string | null
  userId?: string | null
}
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/** Never stores raw output, command arguments, a stack or an unredacted error. */
function lastErrorLine(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  const safe = getContentSafetyRegistry().redact(stripVTControlCharacters(text))
  const line = safe
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1)
  return (line || 'The operation stopped without a confirmed result.')
    .replace(/\/(?:home|tmp|run|proc|var)\/[^\s"'<>),;]+/g, '[internal path]')
    .replace(/\s+/g, ' ')
    .slice(0, 240)
}

/** Scope is a stream across its successor attempts, or this agent's standalone work. */
export async function recoveryScopeForAgent(
  tx: DbHandle,
  agentId: string,
  flowContext?: { workStreamId: string } | null
): Promise<string | null> {
  if (flowContext === undefined) {
    const running = await tx
      .select({ flowContext: executions.flowContext })
      .from(executions)
      .where(and(eq(executions.agentId, agentId), eq(executions.status, 'running')))
      .limit(2)
    if (running.length === 1) flowContext = running[0]!.flowContext
  }
  if (flowContext) return flowContext.workStreamId
  const assigned = await tx
    .select({ id: workStreams.id })
    .from(workStreams)
    .where(and(eq(workStreams.assigneeAgentId, agentId), inArray(workStreams.status, ['active', 'queued'])))
    .limit(2)
  return assigned.length === 1 ? assigned[0]!.id : null
}

async function trustedOrigin(tx: DbHandle, origin: RecoveryOrigin, lock = true) {
  const [execution] = await tx.select().from(executions).where(eq(executions.id, origin.executionId))
  if (!execution || execution.agentId !== origin.agentId)
    throw new Error('Recovery execution does not belong to this agent')
  const workStreamId = await recoveryScopeForAgent(tx, origin.agentId, execution.flowContext)
  const flowAttemptId = execution.flowContext?.attemptId ?? null
  if (lock) {
    if (workStreamId) await tx.select().from(workStreams).where(eq(workStreams.id, workStreamId)).for('update')
    await tx.select({ id: agents.id }).from(agents).where(eq(agents.id, origin.agentId)).for('update')
  }
  const [run] =
    workStreamId && flowAttemptId != null
      ? await tx.select().from(workStreamFlowRuns).where(eq(workStreamFlowRuns.workStreamId, workStreamId))
      : []
  const attempt = run?.state.attempts.find((item) => item.id === flowAttemptId)
  const participant = attempt?.step?.kind === 'agent' ? attempt.step.participant : undefined
  const active = run?.activated ? activeWorkflowAttempts(run.state).map((item) => item.id) : []
  return {
    execution,
    workStreamId,
    flowAttemptId,
    participant,
    active,
    current:
      flowAttemptId != null &&
      active.includes(flowAttemptId) &&
      run?.attemptAgents[String(flowAttemptId)] === origin.agentId,
  }
}

function scopedOperation(
  source: { workStreamId: string | null; flowAttemptId: number | null; participant?: string },
  operation: string
): string {
  return createHash('sha256')
    .update(JSON.stringify([source.workStreamId, source.participant, operation]))
    .digest('hex')
}

type RecoverySource = Awaited<ReturnType<typeof trustedOrigin>>

async function activeRecovery(executor: DbHandle, source: RecoverySource, operation: string, lock = false) {
  const query = executor
    .select()
    .from(recoveryEpisodes)
    .where(
      and(
        eq(recoveryEpisodes.operationKey, scopedOperation(source, operation)),
        source.participant && source.workStreamId
          ? eq(recoveryEpisodes.workStreamId, source.workStreamId)
          : eq(recoveryEpisodes.agentId, source.execution.agentId),
        sql`${recoveryEpisodes.state}->>'state' <> 'resolved'`
      )
    )
    .orderBy(desc(recoveryEpisodes.updatedAt))
  const records = await (lock ? query.for('update') : query)
  const own = records.find((record) => record.agentId === source.execution.agentId)
  if (own) return own
  if (!source.participant) return undefined
  const predecessors = records.filter(
    (record) => record.flowAttemptId != null && !source.active.includes(record.flowAttemptId)
  )
  // A revised participant may get a fresh agent, but not a fresh retry allowance.
  // Never merge concurrently active sibling records or guess an ambiguous lineage.
  if (source.current && predecessors.length === 1) return predecessors[0]
  if (!source.current && records.length === 1) return records[0]
  return undefined
}

async function adoptRecovery(tx: Tx, source: RecoverySource, record: RecoveryRecord): Promise<RecoveryRecord> {
  if (
    !source.current ||
    record.agentId === source.execution.agentId ||
    (record.flowAttemptId != null && source.active.includes(record.flowAttemptId))
  )
    return record
  const [adopted] = await tx
    .update(recoveryEpisodes)
    .set({
      agentId: source.execution.agentId,
      flowAttemptId: source.flowAttemptId,
      waitId: null,
      version: record.version + 1,
    })
    .where(eq(recoveryEpisodes.id, record.id))
    .returning()
  return adopted!
}

export class RecoveryHeldError extends Error {
  constructor() {
    super('Recovery is held; an authorized decision is required before retrying this operation')
  }
}

async function databaseNow(tx: DbHandle): Promise<number> {
  const [clock] = await tx.execute<{ now: string }>(sql`SELECT clock_timestamp() AS now`)
  return new Date(clock!.now).getTime()
}

/** The timestamp comes from durable state, never a tool argument or a new process's clock baseline. */
export async function recoveryRetryDelay(origin: RecoveryOrigin, operation: string): Promise<number> {
  const source = await trustedOrigin(db, origin, false)
  const record =
    (await pendingRecoveryRecord(db, origin.agentId, source.workStreamId, true)) ??
    (await activeRecovery(db, source, operation))
  if (!record) return 0
  if (record.state.state === 'recovering') return Math.max(0, (record.state.nextRetryAt ?? 0) - (await databaseNow(db)))
  try {
    const held = await db.transaction(async (tx) => {
      const latestSource = await trustedOrigin(tx, origin)
      let current =
        (await pendingRecoveryRecord(tx, origin.agentId, latestSource.workStreamId, true, true)) ??
        (await activeRecovery(tx, latestSource, operation, true))
      if (current) current = await adoptRecovery(tx, latestSource, current)
      if (!current || current.state.state === 'resolved') return null
      if (current.state.state === 'recovering')
        return Math.max(0, (current.state.nextRetryAt ?? 0) - (await databaseNow(tx)))
      return ensureExhaustedWait(tx, current)
    })
    if (held === null) return 0
    if (typeof held === 'number') return held
    if (held.state.state !== 'stopped') await publish(held)
  } catch (error) {
    // Recording can fail open for a healthy tool, never for a hold already read
    // from authoritative state. A failed wake/rebind is not permission to retry.
    log.warn('Unable to refresh an observed recovery hold; keeping it held', error)
  }
  throw new RecoveryHeldError()
}

/** This boundary is called by the model's first tool, not an execution-start event.
 * A model tool proves startup/continuation progress, but not completion of an
 * execution that previously failed after startup. It grants no held retry cycle.
 */
export async function settleRecoveryOnModelTool(origin: RecoveryOrigin): Promise<void> {
  const source = await trustedOrigin(db, origin, false)
  if (source.execution.status !== 'running' || (source.participant && !source.current)) return
  const startup = await activeRecovery(db, source, 'execution:run')
  if (startup?.state.startupOnly && startup.state.state === 'recovering')
    await settleRecoveryOperation(origin, 'execution:run', `${origin.executionId}:model-tool`)
  if (!source.workStreamId) return
  const [candidate] = await db
    .select()
    .from(recoveryEpisodes)
    .where(
      and(
        eq(recoveryEpisodes.operationKey, `continuation:${source.workStreamId}`),
        eq(recoveryEpisodes.agentId, origin.agentId),
        sql`${recoveryEpisodes.state}->>'state' = 'recovering'`
      )
    )
  if (!candidate) return
  await db.transaction(async (tx) => {
    const currentSource = await trustedOrigin(tx, origin)
    if (currentSource.execution.status !== 'running' || (currentSource.participant && !currentSource.current)) return
    const [record] = await tx
      .select()
      .from(recoveryEpisodes)
      .where(
        and(
          eq(recoveryEpisodes.id, candidate.id),
          eq(recoveryEpisodes.version, candidate.version),
          sql`${recoveryEpisodes.state}->>'state' = 'recovering'`
        )
      )
      .for('update')
    if (!record) return
    await tx
      .insert(recoveryAttempts)
      .values({
        recoveryId: record.id,
        executionId: origin.executionId,
        invocationId: `${origin.executionId}:model-tool`,
        outcome: 'success',
      })
      .onConflictDoNothing()
    await tx
      .update(recoveryEpisodes)
      .set({
        state: { ...record.state, state: 'resolved', nextRetryAt: null },
        version: record.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(recoveryEpisodes.id, record.id))
  })
}

/** A confirmed result settles this normalized operation, never unrelated scopes or approval waits. */
export async function settleRecoveryOperation(
  origin: RecoveryOrigin,
  operation: string,
  invocationId: string,
  outcome: 'success' | 'explained' = 'success'
): Promise<void> {
  const source = await trustedOrigin(db, origin, false)
  const candidate = await activeRecovery(db, source, operation)
  if (candidate?.state.state !== 'recovering' || (source.participant && !source.current)) return
  await db.transaction(async (tx) => {
    const settlementSource = candidate.agentId !== source.execution.agentId ? await trustedOrigin(tx, origin) : source
    let [record] = await tx
      .select()
      .from(recoveryEpisodes)
      .where(
        and(
          eq(recoveryEpisodes.id, candidate.id),
          eq(recoveryEpisodes.version, candidate.version),
          sql`${recoveryEpisodes.state}->>'state' = 'recovering'`
        )
      )
      .for('update')
    if (!record) return
    record = await adoptRecovery(tx, settlementSource, record)
    const [attempt] = await tx
      .insert(recoveryAttempts)
      .values({ recoveryId: record.id, executionId: origin.executionId, invocationId, outcome })
      .onConflictDoNothing()
      .returning()
    if (!attempt) return
    await tx
      .update(recoveryEpisodes)
      .set({
        state: { ...record.state, state: 'resolved', nextRetryAt: null },
        version: record.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(recoveryEpisodes.id, record.id))
  })
}

async function lockRecord(tx: Tx, recoveryId: string): Promise<RecoveryRecord> {
  const [candidate] = await tx.select().from(recoveryEpisodes).where(eq(recoveryEpisodes.id, recoveryId))
  if (!candidate) throw new Error('Recovery record not found')
  if (candidate.workStreamId)
    await tx.select().from(workStreams).where(eq(workStreams.id, candidate.workStreamId)).for('update')
  const [record] = await tx.select().from(recoveryEpisodes).where(eq(recoveryEpisodes.id, recoveryId)).for('update')
  if (!record) throw new Error('Recovery record not found')
  return record
}

export function recoveryWaitSnapshot(record: RecoveryRecord): StructuredManualWait {
  return {
    request: { schemaVersion: 1, kind: 'continue', recoveryId: record.id, expectedRecoveryVersion: record.version },
    summary: recoverySummary(record.state),
    version: record.version,
    ...(record.state.state === 'stopped' ? { stopped: true } : {}),
  }
}

async function ensureExhaustedWait(tx: Tx, record: RecoveryRecord): Promise<RecoveryRecord> {
  if (!['waiting-manager', 'waiting-owner', 'stopped'].includes(record.state.state))
    throw new Error('Recovery budget is not exhausted')
  const recipients = await recoveryRecipients(record, tx)
  if (recipients.target === 'owner' && !record.state.ownerEscalated) {
    const [routed] = await tx
      .update(recoveryEpisodes)
      .set({
        state: {
          ...record.state,
          state: record.state.state === 'stopped' ? 'stopped' : 'waiting-owner',
          ownerEscalated: true,
          ownerFallback: true,
        },
        version: record.version + 1,
      })
      .where(eq(recoveryEpisodes.id, record.id))
      .returning()
    record = routed!
  }
  const workStreamId = record.workStreamId
  if (!workStreamId) return record
  if (record.waitId) {
    const [existing] = await tx
      .select()
      .from(workStreamWaits)
      .where(and(eq(workStreamWaits.id, record.waitId), isNull(workStreamWaits.closedAt)))
    if (existing) {
      await tx
        .update(workStreamWaits)
        .set({ actor: record.state.ownerEscalated ? 'human' : 'manager', structured: recoveryWaitSnapshot(record) })
        .where(eq(workStreamWaits.id, existing.id))
      return record
    }
  }
  const [run] = await tx.select().from(workStreamFlowRuns).where(eq(workStreamFlowRuns.workStreamId, workStreamId))
  if (run?.activated) {
    const current = activeWorkflowAttempts(run.state).filter(
      (attempt) => run.attemptAgents[String(attempt.id)] === record.agentId
    )
    // A late failure is durable even when its original attempt has ended. Never
    // bind an unrelated/ambiguous successor or roll the failure back with a stale wait.
    const target =
      current.find((attempt) => attempt.id === record.flowAttemptId) ?? (current.length === 1 ? current[0] : undefined)
    if (!target) {
      await reportUnroutableRecovery(record, 'attempt', tx)
      return record
    }
    if (record.flowAttemptId !== target.id) {
      const [rebound] = await tx
        .update(recoveryEpisodes)
        .set({ flowAttemptId: target.id, waitId: null, version: record.version + 1 })
        .where(eq(recoveryEpisodes.id, record.id))
        .returning()
      record = rebound!
    }
  } else if (record.flowAttemptId != null) {
    await reportUnroutableRecovery(record, 'attempt', tx)
    return record
  }
  const payload = recoveryWaitSnapshot(record)
  const { wait } = await openWait(tx, {
    workStreamId,
    flowAttemptId: record.flowAttemptId,
    type: 'manual',
    createdBy: 'system',
    createdByAgentId: record.agentId,
    actor: record.state.ownerEscalated ? 'human' : 'manager',
    message: payload.summary.text,
    structured: payload,
  })
  const [updated] = await tx
    .update(recoveryEpisodes)
    .set({ waitId: wait.id })
    .where(eq(recoveryEpisodes.id, record.id))
    .returning()
  return updated!
}

async function publish(record: RecoveryRecord): Promise<void> {
  if (!['waiting-manager', 'waiting-owner'].includes(record.state.state)) return
  // A late outcome with no current owning attempt remains durable. A later
  // valid retry must rebind its hold before executing the operation.
  if (record.workStreamId && !record.waitId) {
    await reportUnroutableRecovery(record, 'attempt')
    return
  }
  const audience = await recoveryRecipients(record)
  const owner = audience.target === 'owner'
  const recipientIds = owner ? audience.ownerUserIds : [audience.managerAgentId!]
  const { InboxMessage } = await import('../../entities/InboxMessage')
  const summary = recoverySummary(record.state).text
  for (const recipientId of recipientIds) {
    await InboxMessage.sendOnce(
      {
        recipientType: owner ? 'user' : 'agent',
        recipientId,
        senderType: 'system',
        ...(owner ? {} : { deliveryMode: 'steer' as const, wakeEligible: true }),
        subject: 'Continue or stop recovery',
        content: owner
          ? summary
          : `${summary}\n\nRecovery ${record.id} belongs to agent ${record.agentId}. Use ${record.workStreamId ? `ficus workstream resolve-input ${record.workStreamId} ${record.waitId}` : `ficus agent recovery ${record.agentId} ${record.id}`} with a typed decision and expectedVersion ${record.version}. You may grant one extra cycle, stop, or forward to the owner.`,
        metadata: {
          source: 'recovery-decision-required',
          recoveryId: record.id,
          agentId: record.agentId,
          squadId: audience.squadId,
          ...(record.workStreamId
            ? { workStreamId: record.workStreamId, event: 'blocked', waitId: record.waitId }
            : {}),
          actionId: record.workStreamId
            ? `workstream-blocked:${record.workStreamId}:${record.waitId}`
            : `agent-recovery:${record.id}`,
        },
      },
      `recovery-decision:${record.id}:${record.version}:${recipientId}`
    )
  }
  if (record.workStreamId && audience.squadId)
    eventEmitter.emit('workStream.updated', { workStreamId: record.workStreamId, squadId: audience.squadId })
}

export async function publishRecoveryDecision(id: string): Promise<void> {
  const [record] = await db.select().from(recoveryEpisodes).where(eq(recoveryEpisodes.id, id))
  if (record && ['waiting-manager', 'waiting-owner'].includes(record.state.state)) await publish(record)
}

/** Import only the watchdog's locked, durable counters, never model-supplied counts. */
export async function exhaustContinuationRecovery(
  tx: Tx,
  cycle: typeof workStreamContinuations.$inferSelect,
  kind: 'transport' | 'delivery',
  flowAttemptId: number | null,
  triggerExecutionId?: string
): Promise<RecoveryRecord> {
  if (!cycle.assigneeAgentId) throw new Error('Continuation recovery needs its current assignee')
  const count = kind === 'delivery' ? cycle.deliveryAttemptCount : cycle.transportAttemptCount
  if (count < RECOVERY_ATTEMPT_BUDGET) throw new Error('Continuation budget is not exhausted')
  const operationKey = `continuation:${cycle.workStreamId}`
  let [record] = await tx
    .select()
    .from(recoveryEpisodes)
    .where(and(eq(recoveryEpisodes.operationKey, operationKey), sql`${recoveryEpisodes.state}->>'state' <> 'resolved'`))
    .for('update')
  if (!record) {
    const [previous] = await tx
      .select()
      .from(recoveryEpisodes)
      .where(eq(recoveryEpisodes.operationKey, operationKey))
      .orderBy(desc(recoveryEpisodes.createdAt))
      .limit(1)
    ;[record] = await tx
      .insert(recoveryEpisodes)
      .values({
        agentId: cycle.assigneeAgentId,
        executionId: triggerExecutionId ?? null,
        workStreamId: cycle.workStreamId,
        flowAttemptId,
        operationKey,
        state: successorRecoveryState('continue the retained task', previous?.state),
      })
      .returning()
  }
  const error =
    kind === 'delivery'
      ? 'The retained task could not be delivered.'
      : 'The model connection closed before the task could continue.'
  let state = record!.state
  let version = record!.version
  for (let n = 1; n <= count; n++) {
    const [inserted] = await tx
      .insert(recoveryAttempts)
      .values({
        recoveryId: record!.id,
        executionId: n === count ? (triggerExecutionId ?? null) : null,
        invocationId: `continuation:${cycle.generation}:${kind}:${n}`,
        outcome: 'unknown',
        // Only the final failure has a retained error/trigger; do not invent earlier details.
        error: n === count ? error : null,
      })
      .onConflictDoNothing()
      .returning({ id: recoveryAttempts.id })
    if (!inserted) continue
    state =
      state.state === 'recovering'
        ? failedRecovery(state, { kind: 'unknown', error }, await databaseNow(tx))
        : { ...state, failures: state.failures + 1, lastError: error }
    version++
  }
  const [updated] = await tx
    .update(recoveryEpisodes)
    .set({ state, version, agentId: cycle.assigneeAgentId, flowAttemptId, updatedAt: new Date() })
    .where(eq(recoveryEpisodes.id, record!.id))
    .returning()
  return ensureExhaustedWait(tx, updated!)
}

/** Called only by runtime tool/execution boundaries; not exposed as an agent API. */
export async function recordRecoveryFailure(
  origin: RecoveryOrigin,
  input: {
    operationKey: string
    attempted: string
    invocationId: string
    error: unknown
    /** Only a fenced, pre-model startup failure may automatically retry. */
    retryStartupMessage?: string
  }
): Promise<RecoveryRecord> {
  const restart = restartContextForCommandError(input.error)
  const outcome = restart ? 'restart' : 'unknown'
  const error = restart ? null : lastErrorLine(input.error)
  const afterCommit: Array<() => void> = []
  const record = await db.transaction(async (tx) => {
    const source = await trustedOrigin(tx, origin)
    let current = await activeRecovery(tx, source, input.operationKey, true)
    if (current) current = await adoptRecovery(tx, source, current)
    if (!current) {
      const [predecessor] = await tx
        .select()
        .from(recoveryEpisodes)
        .where(
          and(
            source.participant && source.workStreamId
              ? eq(recoveryEpisodes.workStreamId, source.workStreamId)
              : eq(recoveryEpisodes.agentId, origin.agentId),
            eq(recoveryEpisodes.operationKey, scopedOperation(source, input.operationKey))
          )
        )
        .orderBy(desc(recoveryEpisodes.createdAt))
        .limit(1)
      ;[current] = await tx
        .insert(recoveryEpisodes)
        .values({
          agentId: origin.agentId,
          executionId: origin.executionId,
          workStreamId: source.workStreamId,
          flowAttemptId: source.flowAttemptId,
          operationKey: scopedOperation(source, input.operationKey),
          state: {
            ...successorRecoveryState(input.attempted, predecessor?.state),
            startupOnly: input.retryStartupMessage !== undefined,
          },
        })
        .returning()
    }
    if (!current) throw new Error('Recovery record could not be created')
    const [prior] = await tx
      .select()
      .from(recoveryAttempts)
      .where(
        and(
          eq(recoveryAttempts.recoveryId, current.id),
          or(
            eq(recoveryAttempts.invocationId, input.invocationId),
            ...(restart
              ? [and(eq(recoveryAttempts.outcome, 'restart'), eq(recoveryAttempts.restartId, restart.restartId))]
              : [])
          )
        )
      )
    if (prior) return current
    const nextState =
      current.state.state !== 'recovering'
        ? {
            ...current.state,
            failures: current.state.failures + (restart ? 0 : 1),
            ...(error ? { lastError: error } : {}),
          }
        : failedRecovery(
            current.state,
            restart ? { kind: 'restart' } : { kind: 'unknown', error: error! },
            await databaseNow(tx)
          )
    if (!restart && input.retryStartupMessage === undefined && nextState.startupOnly) nextState.startupOnly = false
    await tx.insert(recoveryAttempts).values({
      recoveryId: current.id,
      executionId: origin.executionId,
      invocationId: input.invocationId,
      outcome,
      error,
      restartId: restart?.restartId,
    })
    const [updated] = await tx
      .update(recoveryEpisodes)
      .set({ state: nextState, version: current.version + 1, updatedAt: new Date() })
      .where(eq(recoveryEpisodes.id, current.id))
      .returning()
    if (nextState.state === 'recovering' && input.retryStartupMessage !== undefined) {
      const { InboxMessage } = await import('../../entities/InboxMessage')
      await InboxMessage.persistSystemAgentOnceInTransaction(
        tx,
        {
          recipientId: updated!.agentId,
          subject: 'Retry retained startup request',
          content: `The task could not start before a model prompt was dispatched. The runtime has authorized one bounded startup retry with backoff. Preserve the original scope and all other gates. Retained request:\n\n${input.retryStartupMessage}`,
          metadata: {
            source: updated!.flowAttemptId == null ? 'recovery-retry' : 'workflow-wait-resolution',
            recoveryId: updated!.id,
            retryVersion: updated!.version,
            workStreamId: updated!.workStreamId,
            attemptId: updated!.flowAttemptId,
          },
          wakeEligible: true,
          recordOnly: true,
        },
        `recovery-startup:${updated!.id}:${updated!.version}`,
        afterCommit
      )
    }
    return nextState.state === 'recovering' ? updated! : ensureExhaustedWait(tx, updated!)
  })
  afterCommit.forEach((callback) => callback())
  if (['waiting-manager', 'waiting-owner'].includes(record.state.state)) await publish(record)
  else if (input.retryStartupMessage !== undefined) {
    const { deliverInboxMessagesToAgent } = await import('../inbox/inboxDelivery')
    await deliverInboxMessagesToAgent(record.agentId)
  }
  return record
}

export async function openRecoveryWait(recoveryId: string, version: number, agentId: string, workStreamId: string) {
  const record = await db.transaction(async (tx) => {
    const record = await lockRecord(tx, recoveryId)
    if (record.agentId !== agentId || record.workStreamId !== workStreamId)
      throw new Error('Recovery reference is not authorized for this scope')
    if (record.version !== version) throw new Error('Recovery version changed; refresh before deciding')
    return ensureExhaustedWait(tx, record)
  })
  await publish(record)
  return record
}

export async function decideRecovery(
  recoveryId: string,
  decision: ManualWaitDecision,
  actor: RecoveryActor,
  expectedWait?: { id: string; workStreamId: string }
): Promise<RecoveryRecord> {
  const parsed = manualWaitDecisionSchema.parse(decision)
  const afterCommit: Array<() => void> = []
  const record = await db.transaction(async (tx) => {
    const current = await lockRecord(tx, recoveryId)
    if (expectedWait && (current.waitId !== expectedWait.id || current.workStreamId !== expectedWait.workStreamId))
      throw new Error('Recovery wait changed; refresh before deciding')
    if (current.version !== parsed.expectedVersion) throw new Error('Recovery version changed; refresh before deciding')
    const [stream] = current.workStreamId
      ? await tx.select().from(workStreams).where(eq(workStreams.id, current.workStreamId))
      : []
    if (stream && ['done', 'canceled'].includes(stream.status)) throw new Error('Recovery work stream is terminal')
    const audience = await recoveryRecipients(current, tx)
    const target = audience.target
    const authorized =
      target === 'manager'
        ? Boolean(actor.agentId && actor.agentId === audience.managerAgentId)
        : Boolean(actor.userId && audience.ownerUserIds.includes(actor.userId))
    if (!authorized) throw new Error(`Only the authorized ${target} may decide this recovery`)
    let state =
      target === 'owner'
        ? {
            ...current.state,
            ownerEscalated: true,
            ownerFallback: current.state.ownerEscalated ? current.state.ownerFallback : true,
          }
        : current.state
    if (parsed.action === 'continue') state = continueRecovery(state, target, await databaseNow(tx))
    else if (parsed.action === 'stop') {
      if (!['waiting-manager', 'waiting-owner'].includes(state.state))
        throw new Error('Recovery is not awaiting a decision')
      state = { ...state, state: 'stopped' }
    } else if (parsed.action === 'forward') {
      if (target !== 'manager' || state.state !== 'waiting-manager')
        throw new Error('Only the manager may forward an exhausted recovery')
      state = { ...state, state: 'waiting-owner', ownerEscalated: true, ownerFallback: false }
    } else throw new Error('Recovery accepts only Continue, Stop or manager forwarding')
    await tx.insert(recoveryDecisions).values({
      recoveryId,
      version: current.version,
      action: parsed.action,
      agentId: actor.agentId,
      userId: actor.userId,
    })
    let [updated] = await tx
      .update(recoveryEpisodes)
      .set({ state, version: current.version + 1, updatedAt: new Date() })
      .where(eq(recoveryEpisodes.id, recoveryId))
      .returning()
    if (current.waitId) {
      if (parsed.action === 'continue') {
        await tx
          .update(workStreamWaits)
          .set({
            closedAt: new Date(),
            resolution: 'cleared',
            resolutionNote: 'Continue with one bounded recovery cycle.',
          })
          .where(and(eq(workStreamWaits.id, current.waitId), isNull(workStreamWaits.closedAt)))
        ;[updated] = await tx
          .update(recoveryEpisodes)
          .set({ waitId: null })
          .where(eq(recoveryEpisodes.id, recoveryId))
          .returning()
      } else {
        const payload = recoveryWaitSnapshot(updated!)
        await tx
          .update(workStreamWaits)
          .set({
            actor: state.ownerEscalated ? 'human' : 'manager',
            structured: payload,
            message: payload.summary.text,
          })
          .where(and(eq(workStreamWaits.id, current.waitId), isNull(workStreamWaits.closedAt)))
      }
    }
    if (parsed.action === 'continue') {
      if (updated!.workStreamId && updated!.operationKey.startsWith('continuation:')) {
        const { resetContinuationCycle } = await import('../work-streams/continuation-state')
        await resetContinuationCycle(tx, updated!.workStreamId, updated!.agentId)
      }
      await persistRecoveryContinuation(tx, updated!, afterCommit)
    }
    return updated!
  })
  afterCommit.forEach((callback) => callback())
  if (record.state.state === 'waiting-owner') await publish(record)
  if (record.workStreamId) {
    const { WorkStream } = await import('../../entities/WorkStream')
    const stream = await WorkStream.mustFind(record.workStreamId)
    eventEmitter.emit('workStream.updated', { workStreamId: stream.id, squadId: stream.squadId })
    if (parsed.action === 'continue') {
      const { promoteEligibleQueuedStreams } = await import('../work-streams/admission')
      await promoteEligibleQueuedStreams(stream.squadId)
    }
    const { ensureFlowDispatch } = await import('../workflows/execution')
    await ensureFlowDispatch(record.workStreamId)
  }
  if (parsed.action === 'continue') {
    const { deliverInboxMessagesToAgent } = await import('../inbox/inboxDelivery')
    await deliverInboxMessagesToAgent(record.agentId)
  }
  return record
}

/** The authorized cycle and its wake intent commit together; admission delivers it. */
async function persistRecoveryContinuation(tx: Tx, record: RecoveryRecord, afterCommit: Array<() => void>) {
  const { InboxMessage } = await import('../../entities/InboxMessage')
  await InboxMessage.persistSystemAgentOnceInTransaction(
    tx,
    {
      recipientId: record.agentId,
      subject: 'Bounded recovery continued',
      content:
        'Continue was authorized for one bounded recovery cycle. Inspect affected state before a safe retry; do not blindly repeat unknown side effects. Other input, provider, dependency, pause and approval gates still apply.',
      metadata: {
        source: record.flowAttemptId == null ? 'recovery-decision' : 'workflow-wait-resolution',
        recoveryId: record.id,
        decisionVersion: record.version,
        workStreamId: record.workStreamId,
        attemptId: record.flowAttemptId,
      },
      wakeEligible: true,
      recordOnly: true,
    },
    `recovery-continued:${record.id}:${record.version}`,
    afterCommit
  )
}

/** Rechecked before delivery and under the normal queue/admission locks. */
export async function recoveryContinuationIsCurrent(
  dbx: DbHandle,
  messageId: string,
  agentId: string
): Promise<boolean> {
  const [message] = await dbx.select().from(inbox).where(eq(inbox.id, messageId))
  const id = message?.metadata?.recoveryId
  const automatic = message?.metadata?.retryVersion !== undefined
  const version = automatic ? message?.metadata?.retryVersion : message?.metadata?.decisionVersion
  if (
    message?.senderType !== 'system' ||
    message.recipientId !== agentId ||
    typeof id !== 'string' ||
    !z.uuid().safeParse(id).success ||
    !Number.isInteger(version) ||
    message.idempotencyKey !== `${automatic ? 'recovery-startup' : 'recovery-continued'}:${id}:${version}`
  )
    return false
  const [record] = await dbx.select().from(recoveryEpisodes).where(eq(recoveryEpisodes.id, id))
  if (!record || record.agentId !== agentId || record.state.state !== 'recovering') return false
  if (automatic) {
    if (record.version !== version) return false
  } else {
    const [latest] = await dbx
      .select()
      .from(recoveryDecisions)
      .where(eq(recoveryDecisions.recoveryId, id))
      .orderBy(desc(recoveryDecisions.version))
      .limit(1)
    if (!latest || latest.action !== 'continue' || latest.version + 1 !== version) return false
  }
  const [agent] = await dbx.select().from(agents).where(eq(agents.id, agentId))
  if (!agent || ['waiting-input', 'terminated'].includes(agent.status)) return false
  if (record.workStreamId) {
    const [stream] = await dbx.select().from(workStreams).where(eq(workStreams.id, record.workStreamId))
    if (!stream || stream.status !== 'active' || stream.pause) return false
    const { waitsForAgent, isCurrentWaitAttempt } = await import('../work-streams/wait-scope')
    if ((await waitsForAgent(dbx, stream.id, agentId)).length) return false
    if (record.flowAttemptId != null && !(await isCurrentWaitAttempt(dbx, stream.id, record.flowAttemptId, agentId)))
      return false
  }
  return true
}

async function pendingRecoveryRecord(
  dbx: DbHandle,
  agentId: string,
  workStreamId: string | null,
  heldOnly = false,
  lock = false
) {
  const [run] = workStreamId
    ? await dbx.select().from(workStreamFlowRuns).where(eq(workStreamFlowRuns.workStreamId, workStreamId))
    : []
  const current = run?.activated
    ? activeWorkflowAttempts(run.state).find((attempt) => run.attemptAgents[String(attempt.id)] === agentId)
    : undefined
  const participant = current?.step?.kind === 'agent' ? current.step.participant : undefined
  const relatedAttempts = participant
    ? run!.state.attempts
        .filter((attempt) => attempt.step?.kind === 'agent' && attempt.step.participant === participant)
        .map((attempt) => attempt.id)
    : []
  const query = dbx
    .select()
    .from(recoveryEpisodes)
    .where(
      and(
        or(
          eq(recoveryEpisodes.agentId, agentId),
          ...(relatedAttempts.length ? [inArray(recoveryEpisodes.flowAttemptId, relatedAttempts)] : [])
        ),
        workStreamId ? eq(recoveryEpisodes.workStreamId, workStreamId) : isNull(recoveryEpisodes.workStreamId),
        heldOnly
          ? sql`${recoveryEpisodes.state}->>'state' IN ('waiting-manager', 'waiting-owner', 'stopped')`
          : sql`${recoveryEpisodes.state}->>'state' <> 'resolved'`,
        heldOnly ? undefined : sql`(${recoveryEpisodes.state}->>'failures')::int > 0`
      )
    )
    .limit(1)
  const [record] = await (lock ? query.for('update') : query)
  return record
}

/**
 * Refuse task inputs, questions and messages only while this agent's own recovery (or its
 * participant lineage's, in its current stream scope) is held for a typed Continue / Stop decision.
 * A recovery that is still retrying automatically has no decision to bypass, so it never blocks
 * asking a person; neither do flow waits such as an attempt-limit pause, which are not recoveries.
 */
export async function assertNoPendingRecovery(
  dbx: DbHandle,
  agentId: string,
  workStreamId: string | null
): Promise<void> {
  const held = await pendingRecoveryRecord(dbx, agentId, workStreamId, true)
  if (held)
    throw new Error(
      `Use the existing typed recovery decision (recovery ${held.id}, ${held.state.state}); task inputs cannot bypass an unresolved recovery`
    )
}
