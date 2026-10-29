import {
  isRestartContext,
  restartPauseNotice,
  restartResumeNotice,
  type RestartContext,
} from '@ficus/shared/restart-context'
import { createRestartContext } from '../sandbox/command-drain'
import { and, desc, eq, inArray, or, sql } from 'drizzle-orm'
import { agents, db, executionAdmissionReservations, executions, messages } from '../../db'
import { eventEmitter } from '../../lib/infra/event-emitter'
import { mapMessage } from '../../entities/message-mapper'
import { messageEventData } from '../../entities/message-event'
import { restoreQueueOwnedAdmission, restoreStrandedQueuedAdmission } from './agent-admission'
import { isLeaseBearingReservation } from '../maintenance/admission-reservation'
import {
  ADMISSION_LIVENESS_HASH_SEED,
  ADMISSION_LIVENESS_LOCK_VERSION,
  admissionProcessIncarnation,
} from '../maintenance/process-liveness'

/**
 * The system notice each recovery path posts to the agent's chat. Three paths,
 * three truthful messages — they were one wording, and the shared "after a
 * process restart" once sent a live debugging session hunting for a restart
 * that never occurred:
 *  - startup: ownership was lost; without a shutdown marker the cause is unknown;
 *  - shutdown: posted BEFORE the restart, as this process hands the work off;
 *  - lease sweep: the owner stopped renewing; no restart is implied.
 */
export const PROCESS_RESTART_NOTICE =
  '[System] Agent recovered after an interruption of unknown cause. Check the affected state and retry safely within the bounded recovery budget.'
export const ABANDONED_LEASE_NOTICE =
  '[System] Agent recovered after its execution was interrupted (admission lease lapsed).'

/**
 * Requeue only executions whose exact admission owner is this incarnation or
 * is provably dead. Lock order is maintenance -> execution -> reservation ->
 * agent/message. The notice and queued CAS commit atomically; events emit only
 * after commit.
 */
export async function recoverInterruptedExecutionsForStartup(options?: {
  afterExecutionLocked?: (executionId: string) => Promise<void>
  beforeExactCas?: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0], executionId: string) => Promise<void>
}): Promise<string[]> {
  const candidates = await db
    .select({ id: executions.id })
    .from(executions)
    .where(inArray(executions.status, ['running', 'queued']))
  return recoverExecutions(candidates, { ...options, requireLivenessProof: true })
}

/**
 * Requeue executions whose admission lease has EXPIRED with no fresh heartbeat.
 *
 * The safety net for {@link recoverInterruptedExecutionsForStartup}, which runs
 * once at boot and, for a foreign incarnation, requeues only when
 * `pg_try_advisory_xact_lock` proves the previous owner dead. That proof answers
 * "is that process alive?" and gets it wrong whenever the answer is "not quite
 * yet" — notably while a gracefully-shutting-down worker still holds its lock as
 * the next one boots. A candidate skipped that way is never revisited, so the
 * row stays `running` forever: the agent looks busy, does nothing, and holds a
 * concurrency slot. Measured on the dev instance: 9 of 9 `running` executions
 * orphaned this way, oldest ~2 hours.
 *
 * An expired lease with a stale heartbeat needs no inference — the owner has
 * provably stopped renewing, which is a fact in the database rather than a guess
 * about a process. So this pass deliberately skips the liveness proof and runs
 * periodically instead of once.
 *
 * Recovery semantics are unchanged and shared with startup: status back to
 * `queued`, a `[System] Agent recovered…` notice, and the admission handed back,
 * so the agent RESUMES rather than being terminated or reshuffled.
 */
export async function requeueAbandonedLeaseExecutions(options?: {
  afterExecutionLocked?: (executionId: string) => Promise<void>
  beforeExactCas?: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0], executionId: string) => Promise<void>
}): Promise<string[]> {
  // clock_timestamp(), not now(): now() is frozen at BEGIN, so a deadline judged
  // after a lock wait would use a stale reading (frozen-clock rule).
  const candidates = await db
    .select({ id: executions.id, agentId: executions.agentId })
    .from(executions)
    .innerJoin(executionAdmissionReservations, eq(executionAdmissionReservations.executionId, executions.id))
    .where(
      and(
        eq(executions.status, 'running'),
        sql`${executionAdmissionReservations.leaseExpiresAt} IS NOT NULL`,
        sql`${executionAdmissionReservations.leaseExpiresAt} < clock_timestamp()`
      )
    )
  // An expired lease proves the lease stopped being RENEWED, not that the work
  // stopped. A genuinely running execution whose heartbeat lags — host load, a
  // slow provider turn — also has an expired lease. Requeuing it starts a second
  // copy that collides with the first one's still-held session reservation and
  // dies as "Execution session capacity reservation was refused". Measured after
  // this watchdog shipped: 67 recoveries and 46 such refusals in one 20-minute
  // window across 31 agents.
  //
  // This process knows without inference which executions it is running right
  // now. Never requeue those — the lease sweep exists for work NO ONE is doing.
  const { isSessionHeldFor } = await import('./session-state')
  const abandoned = candidates.filter(({ id, agentId }) => !isSessionHeldFor(agentId, id))
  return recoverExecutions(abandoned, {
    ...options,
    requireLivenessProof: false,
    // Say what actually happened: this is a lapsed lease, not a process restart.
    // The startup wording here once sent a live debugging session hunting for a
    // restart that never occurred.
    notice: ABANDONED_LEASE_NOTICE,
  })
}

/**
 * Requeue live-session executions and every `running` execution this process
 * still owns at shutdown. The first safely recoverable row for each agent is
 * authoritative: its paused notice and admission downgrade commit atomically.
 * Same-agent duplicate owned rows intentionally remain for duplicate-active
 * reconciliation or later startup/abandoned-lease recovery; a later lease
 * sweep may therefore emit its distinct abandoned-lease notice for that event.
 */
export async function requeueOwnedExecutionsForShutdown(
  liveExecutionIds: string[] = [],
  options?: {
    restart?: RestartContext
    beforeExactCas?: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0], executionId: string) => Promise<void>
  }
): Promise<string[]> {
  const restart = options?.restart ?? createRestartContext()
  const liveExecutionIdSet = new Set(liveExecutionIds)
  const ownershipPredicates = [
    eq(executionAdmissionReservations.ownerIncarnation, admissionProcessIncarnation),
    ...(liveExecutionIds.length > 0 ? [inArray(executions.id, liveExecutionIds)] : []),
  ]
  const candidates = await db
    .select({ id: executions.id, agentId: executions.agentId })
    .from(executions)
    .innerJoin(executionAdmissionReservations, eq(executionAdmissionReservations.executionId, executions.id))
    .where(and(eq(executions.status, 'running'), or(...ownershipPredicates)))
  candidates.sort((left, right) => Number(!liveExecutionIdSet.has(left.id)) - Number(!liveExecutionIdSet.has(right.id)))

  const recoveredAgentIds = new Set<string>()
  const recovered: string[] = []
  for (const candidate of candidates) {
    if (recoveredAgentIds.has(candidate.agentId)) continue
    const recoveredCandidateIds = await recoverExecutions([candidate], {
      requireLivenessProof: false,
      notice: restartPauseNotice(restart),
      restart,
      beforeExactCas: options?.beforeExactCas,
    })
    recovered.push(...recoveredCandidateIds)
    if (recoveredCandidateIds.length > 0) recoveredAgentIds.add(candidate.agentId)
  }
  return recovered
}

async function recoverExecutions(
  candidates: { id: string }[],
  options: {
    afterExecutionLocked?: (executionId: string) => Promise<void>
    beforeExactCas?: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0], executionId: string) => Promise<void>
    requireLivenessProof: boolean
    /** The system notice posted to the agent's chat. Defaults to the unknown-interruption wording. */
    notice?: string
    restart?: RestartContext
  }
): Promise<string[]> {
  const notice = options.notice ?? PROCESS_RESTART_NOTICE
  const recovered: string[] = []
  for (const candidate of candidates) {
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM instance_maintenance_state WHERE id = 'global' FOR SHARE`)
      const [execution] = await tx.select().from(executions).where(eq(executions.id, candidate.id)).for('update')
      if (!execution || !['running', 'queued'].includes(execution.status)) return null
      await options.afterExecutionLocked?.(execution.id)
      const [reservation] = await tx
        .select()
        .from(executionAdmissionReservations)
        .where(eq(executionAdmissionReservations.executionId, candidate.id))
        .for('update')
      if (!reservation) return null
      if (execution.status === 'queued') {
        const [clock] = await tx
          .select({ now: sql<Date>`clock_timestamp()` })
          .from(executions)
          .where(eq(executions.id, execution.id))
        if (!clock) return null
        const restored = await restoreStrandedQueuedAdmission(tx, {
          execution,
          reservation,
          now: new Date(clock.now),
        })
        if (restored.kind === 'cas-lost') throw new Error('Startup queued recovery lost its exact admission CAS')
        if (restored.kind !== 'restored') return null
        return { kind: 'queued' as const, execution }
      }
      // Ownerless admissions and incomplete legacy rows do not prove a runner
      // identity and cannot authorize startup takeover.
      if (!isLeaseBearingReservation(reservation)) return null
      if (
        execution.runnerClaimToken !== reservation.token ||
        execution.runnerClaimGeneration !== reservation.admittedGeneration
      )
        return null
      // Terminal reservation state does not prove the process is dead: the
      // original runner may be between exact revoke and exact terminalization.
      if (options.requireLivenessProof && reservation.ownerIncarnation !== admissionProcessIncarnation) {
        const [proof] = await tx
          .select({
            dead: sql<boolean>`pg_try_advisory_xact_lock(hashtextextended(${ADMISSION_LIVENESS_LOCK_VERSION} || ${reservation.ownerIncarnation}, ${ADMISSION_LIVENESS_HASH_SEED}))`,
          })
          .from(executions)
          .where(eq(executions.id, candidate.id))
        if (!proof?.dead) return null
      }
      const now = new Date()
      const [message] = await tx
        .insert(messages)
        .values({
          agentId: execution.agentId,
          role: 'assistant',
          content: notice,
          metadata: {
            isSystem: true,
            ...(options.restart ? { restart: options.restart, restartPhase: 'pause' } : {}),
            admissionRecoveryExecutionId: execution.id,
            executionId: execution.id,
          },
        })
        .returning()
      await tx.update(agents).set({ updatedAt: now }).where(eq(agents.id, execution.agentId))
      await options.beforeExactCas?.(tx, execution.id)
      const [updated] = await tx
        .update(executions)
        .set({ status: 'queued' })
        .where(
          and(
            eq(executions.id, candidate.id),
            eq(executions.status, 'running'),
            eq(executions.runnerClaimToken, reservation.token),
            eq(executions.runnerClaimGeneration, reservation.admittedGeneration)
          )
        )
        .returning()
      if (!updated || !message) throw new Error('Startup recovery lost its exact transactional CAS')
      const downgraded = await restoreQueueOwnedAdmission(tx, {
        agentId: execution.agentId,
        executionId: execution.id,
        expectedLease: {
          token: reservation.token,
          claimEpoch: reservation.claimEpoch,
          ownerId: reservation.ownerId,
          ownerIncarnation: reservation.ownerIncarnation,
          admittedGeneration: reservation.admittedGeneration,
          admittedHolderRevision: reservation.admittedHolderRevision,
        },
      })
      if (!downgraded) throw new Error('Startup recovery lost its exact admission downgrade')
      return { kind: 'running' as const, execution: updated, message: mapMessage(message) }
    })
    if (!result) continue
    recovered.push(result.execution.id)
    if (result.kind === 'queued') continue
    eventEmitter.emit('message.created', messageEventData(result.message))
    const [agent] = await db
      .select({ squadId: agents.squadId })
      .from(agents)
      .where(eq(agents.id, result.execution.agentId))
    eventEmitter.emit('agent.updated', { agentId: result.execution.agentId, squadId: agent?.squadId ?? null })
  }
  return recovered
}

/**
 * Read only a shutdown-committed marker for this exact execution and agent. A
 * process boot, stale lease or nearby transport failure is not restart proof.
 * Commit the resume notice before sandbox/session startup, once per restart.
 * The execution lock serializes concurrent pickup attempts without consuming
 * the context: every startup retry still needs it in its first model prompt.
 */
export async function prepareRestartResume(executionId: string, agentId: string): Promise<RestartContext | undefined> {
  const result = await db.transaction(async (tx) => {
    const [execution] = await tx
      .select({ id: executions.id })
      .from(executions)
      .where(and(eq(executions.id, executionId), eq(executions.agentId, agentId)))
      .for('update')
    if (!execution) return undefined
    const [pause] = await tx
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.agentId, agentId),
          sql`${messages.metadata}->>'admissionRecoveryExecutionId' = ${executionId}`,
          sql`${messages.metadata}->>'isSystem' = 'true'`
        )
      )
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(1)
    const metadata = pause?.metadata as { restart?: unknown; restartPhase?: unknown } | null
    const restart = metadata?.restartPhase === 'pause' ? metadata.restart : undefined
    if (!isRestartContext(restart)) return undefined
    const [existing] = await tx
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.agentId, agentId),
          sql`${messages.metadata}->>'executionId' = ${executionId}`,
          sql`${messages.metadata}->>'restartPhase' = 'resume'`,
          sql`${messages.metadata}->'restart'->>'restartId' = ${restart.restartId}`
        )
      )
      .limit(1)
    if (existing) return { restart }
    const [message] = await tx
      .insert(messages)
      .values({
        agentId,
        role: 'assistant',
        content: restartResumeNotice(restart),
        metadata: { isSystem: true, executionId, restart, restartPhase: 'resume' },
      })
      .returning()
    return { restart, message: message ? mapMessage(message) : undefined }
  })
  if (result?.message) eventEmitter.emit('message.created', messageEventData(result.message))
  return result?.restart
}
