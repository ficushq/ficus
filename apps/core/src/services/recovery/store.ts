import { recoveryRecipients } from './recipients'
import { z } from 'zod'
import { stripVTControlCharacters } from 'node:util'
import { createHash } from 'node:crypto'
import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import { manualWaitDecisionSchema, type ManualWaitDecision, type StructuredManualWait } from '@ficus/shared'
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
} from '../../db'
import { initialRecoveryState, failedRecovery, continueRecovery, recoverySummary } from './policy'
import { openWait, type DbHandle } from '../work-streams/waits'
import { getContentSafetyRegistry } from '../security/content-safety-registry'
import { eventEmitter } from '../../lib/infra/event-emitter'
import { restartContextForCommandError } from '../sandbox/command-drain'

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

async function trustedOrigin(tx: Tx, origin: RecoveryOrigin) {
  const [execution] = await tx.select().from(executions).where(eq(executions.id, origin.executionId))
  if (!execution || execution.agentId !== origin.agentId)
    throw new Error('Recovery execution does not belong to this agent')
  let workStreamId = execution.flowContext?.workStreamId ?? null
  const flowAttemptId = execution.flowContext?.attemptId ?? null
  if (!workStreamId) {
    const assigned = await tx
      .select({ id: workStreams.id })
      .from(workStreams)
      .where(and(eq(workStreams.assigneeAgentId, origin.agentId), inArray(workStreams.status, ['active', 'queued'])))
      .limit(2)
    if (assigned.length === 1) workStreamId = assigned[0]!.id
  }
  if (workStreamId) await tx.select().from(workStreams).where(eq(workStreams.id, workStreamId)).for('update')
  // Common mutex even for two first failures racing to create the active episode.
  await tx.select({ id: agents.id }).from(agents).where(eq(agents.id, origin.agentId)).for('update')
  return { execution, workStreamId, flowAttemptId }
}

function scopedOperation(
  source: { workStreamId: string | null; flowAttemptId: number | null },
  operation: string
): string {
  return createHash('sha256')
    .update(JSON.stringify([source.workStreamId, source.flowAttemptId, operation]))
    .digest('hex')
}

export class RecoveryHeldError extends Error {
  constructor() {
    super('Recovery is held; an authorized decision is required before retrying this operation')
  }
}

async function databaseNow(tx: Tx): Promise<number> {
  const [clock] = await tx.execute<{ now: string }>(sql`SELECT clock_timestamp() AS now`)
  return new Date(clock!.now).getTime()
}

/** The timestamp comes from durable state, never a tool argument or a new process's clock baseline. */
export async function recoveryRetryDelay(origin: RecoveryOrigin, operation: string): Promise<number> {
  return db.transaction(async (tx) => {
    const source = await trustedOrigin(tx, origin)
    const [record] = await tx
      .select()
      .from(recoveryEpisodes)
      .where(
        and(
          eq(recoveryEpisodes.agentId, origin.agentId),
          eq(recoveryEpisodes.operationKey, scopedOperation(source, operation)),
          sql`${recoveryEpisodes.state}->>'state' <> 'resolved'`
        )
      )
      .for('update')
    if (!record) return 0
    if (record.state.state !== 'recovering') throw new RecoveryHeldError()
    return Math.max(0, (record.state.nextRetryAt ?? 0) - (await databaseNow(tx)))
  })
}

/** A confirmed result closes only this exact operation, not unrelated recovery or approval waits. */
export async function settleRecoveryOperation(
  origin: RecoveryOrigin,
  operation: string,
  invocationId: string,
  outcome: 'success' | 'explained' = 'success'
): Promise<void> {
  await db.transaction(async (tx) => {
    const source = await trustedOrigin(tx, origin)
    const [record] = await tx
      .select()
      .from(recoveryEpisodes)
      .where(
        and(
          eq(recoveryEpisodes.agentId, origin.agentId),
          eq(recoveryEpisodes.operationKey, scopedOperation(source, operation)),
          sql`${recoveryEpisodes.state}->>'state' = 'recovering'`
        )
      )
      .for('update')
    if (!record) return
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
  if (!['waiting-manager', 'waiting-owner'].includes(record.state.state))
    throw new Error('Recovery budget is not exhausted')
  const recipients = await recoveryRecipients(record, tx)
  if (recipients.target === 'owner' && record.state.state === 'waiting-manager') {
    const [routed] = await tx
      .update(recoveryEpisodes)
      .set({ state: { ...record.state, state: 'waiting-owner', ownerEscalated: true }, version: record.version + 1 })
      .where(eq(recoveryEpisodes.id, record.id))
      .returning()
    record = routed!
  }
  if (!record.workStreamId) return record
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
  const payload = recoveryWaitSnapshot(record)
  const { wait } = await openWait(tx, {
    workStreamId: record.workStreamId,
    flowAttemptId: record.flowAttemptId,
    type: 'manual',
    createdBy: 'system',
    createdByAgentId: record.agentId,
    actor: record.state.state === 'waiting-owner' ? 'human' : 'manager',
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
    let [current] = await tx
      .select()
      .from(recoveryEpisodes)
      .where(
        and(
          eq(recoveryEpisodes.agentId, origin.agentId),
          eq(recoveryEpisodes.operationKey, scopedOperation(source, input.operationKey)),
          sql`${recoveryEpisodes.state}->>'state' <> 'resolved'`
        )
      )
      .for('update')
    if (!current) {
      ;[current] = await tx
        .insert(recoveryEpisodes)
        .values({
          agentId: origin.agentId,
          executionId: origin.executionId,
          workStreamId: source.workStreamId,
          flowAttemptId: source.flowAttemptId,
          operationKey: scopedOperation(source, input.operationKey),
          state: initialRecoveryState(input.attempted),
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
    const nextState = failedRecovery(
      current.state,
      restart ? { kind: 'restart' } : { kind: 'unknown', error: error! },
      await databaseNow(tx)
    )
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
    let state = target === 'owner' ? { ...current.state, ownerEscalated: true } : current.state
    if (parsed.action === 'continue') state = continueRecovery(state, target, await databaseNow(tx))
    else if (parsed.action === 'stop') {
      if (!['waiting-manager', 'waiting-owner'].includes(state.state))
        throw new Error('Recovery is not awaiting a decision')
      state = { ...state, state: 'stopped' }
    } else if (parsed.action === 'forward') {
      if (target !== 'manager' || state.state !== 'waiting-manager')
        throw new Error('Only the manager may forward an exhausted recovery')
      state = { ...state, state: 'waiting-owner', ownerEscalated: true }
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
    if (parsed.action === 'continue') await persistRecoveryContinuation(tx, updated!, afterCommit)
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

export async function assertNoPendingRecovery(dbx: DbHandle, agentId: string): Promise<void> {
  const [record] = await dbx
    .select({ id: recoveryEpisodes.id })
    .from(recoveryEpisodes)
    .where(
      and(
        eq(recoveryEpisodes.agentId, agentId),
        sql`${recoveryEpisodes.state}->>'state' IN ('waiting-manager', 'waiting-owner', 'stopped')`
      )
    )
    .limit(1)
  if (record)
    throw new Error('Use the existing typed recovery decision; task inputs cannot bypass an exhausted recovery')
}
