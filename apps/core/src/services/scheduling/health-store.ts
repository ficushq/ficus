import { CronExpressionParser } from 'cron-parser'
import { and, eq, isNotNull, lte } from 'drizzle-orm'
import type { ScheduleConfig } from '@ficus/shared'
import { db } from '../../db'
import { eventEmitter } from '../../lib/infra/event-emitter'
import { createLogger } from '../../lib/infra/logger'
import { agents, scheduleHealthEvents, scheduleHealthNotifications, schedules, squads } from '../../db/schema'
import type { ClassifiedScheduleFailure } from './failure-classifier'
import { ScheduleExecutionError } from './failure-classifier'

const log = createLogger('schedule-health')

export const TRANSIENT_ALERT_THRESHOLD = 3
export const CIRCUIT_BREAKER_THRESHOLD = 10
export const SCHEDULE_ATTEMPT_LEASE_MS = 15 * 60_000
const ONE_SHOT_RETRY_MS = 30_000

export type ScheduleAttemptSource = 'scheduled' | 'manual' | 'webhook'

export interface ScheduleAttempt {
  id: string
  attemptedAt: Date
  source: ScheduleAttemptSource
  leaseUntil: Date
}

export interface ScheduleHealthTransition {
  kind: 'failed' | 'recovered' | 'automatically_disabled'
  scheduleId: string
  healthEventId: string
}

export function emitScheduleHealthTransitions(transitions: ScheduleHealthTransition[]): void {
  for (const transition of transitions) {
    try {
      const payload = { scheduleId: transition.scheduleId, healthEventId: transition.healthEventId }
      if (transition.kind === 'failed') eventEmitter.emit('schedule.failed', payload)
      else if (transition.kind === 'recovered') eventEmitter.emit('schedule.recovered', payload)
      else eventEmitter.emit('schedule.automatically_disabled', payload)
    } catch (error) {
      log.error('Failed to publish committed schedule health transition', error)
    }
  }
}

export function failureBackoffMs(consecutiveFailureCount: number): number {
  if (consecutiveFailureCount < TRANSIENT_ALERT_THRESHOLD) return 0
  return Math.min(60_000 * 2 ** (consecutiveFailureCount - TRANSIENT_ALERT_THRESHOLD), 60 * 60_000)
}

function parseInterval(interval: string): number {
  const match = interval.match(/^(\d+)(s|m|h)$/)
  if (!match) throw new Error('Invalid persisted schedule interval')
  const multiplier = { s: 1_000, m: 60_000, h: 3_600_000 }[match[2] as 's' | 'm' | 'h']
  return Number(match[1]) * multiplier
}

function calculateNominalNext(config: ScheduleConfig, attemptedAt: Date, priorNext: Date | null): Date | null {
  if (config.runAt) return null
  const base = new Date(Math.max(attemptedAt.getTime(), priorNext?.getTime() ?? 0))
  let candidate: Date | null = null
  if (config.interval) candidate = new Date(base.getTime() + parseInterval(config.interval))
  else if (config.cron) candidate = CronExpressionParser.parse(config.cron, { currentDate: base }).next().toDate()
  if (candidate && config.expiresAt && candidate >= new Date(config.expiresAt)) return null
  return candidate
}

function attemptMismatch(): never {
  throw new ScheduleExecutionError(
    'attempt_in_progress',
    'transient',
    'Schedule attempt is no longer active or is owned by another execution.'
  )
}

export async function claimScheduleAttempt(
  scheduleId: string,
  input: { source: ScheduleAttemptSource; attemptedAt?: Date; requireDue?: boolean }
): Promise<ScheduleAttempt | null> {
  const attemptedAt = input.attemptedAt ?? new Date()
  const result = await db.transaction(
    async (
      tx
    ): Promise<
      | { kind: 'attempt'; attempt: ScheduleAttempt }
      | { kind: 'stale'; attemptId: string }
      | { kind: 'expired'; transition: ScheduleHealthTransition | null }
      | { kind: 'not_due' }
    > => {
      const [current] = await tx.select().from(schedules).where(eq(schedules.id, scheduleId)).for('update')
      if (!current) throw new ScheduleExecutionError('scope_not_found', 'permanent', 'Schedule does not exist.')
      const config = current.schedule as ScheduleConfig
      if (current.activeAttemptId) {
        if (current.activeAttemptLeaseUntil && current.activeAttemptLeaseUntil.getTime() > attemptedAt.getTime()) {
          if (
            input.requireDue &&
            (!current.enabled || !current.nextTriggerAt || current.nextTriggerAt.getTime() > attemptedAt.getTime())
          ) {
            return { kind: 'not_due' }
          }
          attemptMismatch()
        }
        // Fence the abandoned attempt before leaving the lock. The caller then
        // settles it and deliberately does not replay the action in this claim.
        await tx
          .update(schedules)
          .set({
            activeAttemptLeaseUntil: new Date(attemptedAt.getTime() + SCHEDULE_ATTEMPT_LEASE_MS),
            updatedAt: attemptedAt,
          })
          .where(eq(schedules.id, scheduleId))
        return { kind: 'stale', attemptId: current.activeAttemptId }
      }
      if (config.expiresAt && attemptedAt >= new Date(config.expiresAt)) {
        if (current.automaticallyDisabledAt) return { kind: 'expired', transition: null }
        const incidentId = crypto.randomUUID()
        const [event] = await tx
          .insert(scheduleHealthEvents)
          .values({
            scheduleId,
            attemptId: null,
            incidentId,
            kind: 'automatically_disabled',
            occurredAt: attemptedAt,
            errorSummary: 'Schedule expired.',
            consecutiveFailureCount: current.consecutiveFailureCount,
          })
          .returning()
        await tx
          .update(schedules)
          .set({
            enabled: false,
            webhookEnabled: false,
            nextTriggerAt: null,
            automaticallyDisabledAt: attemptedAt,
            automaticDisableReason: `Schedule expired at ${config.expiresAt}.`,
            updatedAt: attemptedAt,
          })
          .where(eq(schedules.id, scheduleId))
        return {
          kind: 'expired',
          transition: { kind: 'automatically_disabled', scheduleId, healthEventId: event.id },
        }
      }
      if (
        !current.activeAttemptId &&
        current.openFailureIncidentId &&
        current.lastErrorCode === 'execution_interrupted' &&
        current.lastFailureAt
      ) {
        const retryBoundary =
          current.nextTriggerAt && current.nextTriggerAt > current.lastFailureAt
            ? current.nextTriggerAt
            : new Date(current.lastFailureAt.getTime() + ONE_SHOT_RETRY_MS)
        if (attemptedAt < retryBoundary) return { kind: 'not_due' }
      }
      if (input.requireDue) {
        if (!current.enabled || !current.nextTriggerAt || current.nextTriggerAt.getTime() > attemptedAt.getTime()) {
          return { kind: 'not_due' }
        }
      }
      if (current.automaticallyDisabledAt) {
        throw new ScheduleExecutionError(
          'invalid_action_reference',
          'permanent',
          'Automatically disabled schedule must be re-enabled before it can run.'
        )
      }

      const id = crypto.randomUUID()
      const leaseUntil = new Date(attemptedAt.getTime() + SCHEDULE_ATTEMPT_LEASE_MS)
      const nextTriggerAt =
        input.source === 'webhook'
          ? current.nextTriggerAt
          : calculateNominalNext(config, attemptedAt, current.nextTriggerAt)
      const updates: Record<string, unknown> = {
        activeAttemptId: id,
        activeAttemptSource: input.source,
        activeAttemptStartedAt: attemptedAt,
        activeAttemptLeaseUntil: leaseUntil,
        triggerCount: current.triggerCount + 1,
        nextTriggerAt,
        enabled: input.source === 'webhook' ? current.enabled : nextTriggerAt !== null && current.enabled,
        updatedAt: attemptedAt,
      }
      if (input.source === 'webhook') updates.lastWebhookTriggerAt = attemptedAt
      else updates.lastTriggeredAt = attemptedAt

      await tx.update(schedules).set(updates).where(eq(schedules.id, scheduleId))
      return { kind: 'attempt', attempt: { id, attemptedAt, source: input.source, leaseUntil } }
    }
  )

  if (result.kind === 'attempt') return result.attempt
  if (result.kind === 'expired') {
    if (result.transition) emitScheduleHealthTransitions([result.transition])
    return null
  }
  if (result.kind === 'stale') {
    const transitions = await recordScheduleFailure(
      scheduleId,
      result.attemptId,
      {
        class: 'transient',
        code: 'execution_interrupted',
        summary: 'Schedule execution was interrupted before its outcome was recorded.',
      },
      attemptedAt
    )
    emitScheduleHealthTransitions(transitions)
  }
  return null
}

export async function reconcileStaleScheduleAttemptBeforeReenable(
  scheduleId: string,
  now = new Date()
): Promise<boolean> {
  const staleAttemptId = await db.transaction(async (tx) => {
    const [current] = await tx.select().from(schedules).where(eq(schedules.id, scheduleId)).for('update')
    if (!current?.activeAttemptId) return null
    if (current.activeAttemptLeaseUntil && current.activeAttemptLeaseUntil > now) {
      throw new ScheduleExecutionError('attempt_in_progress', 'transient', 'Schedule has an active execution attempt.')
    }
    await tx
      .update(schedules)
      .set({ activeAttemptLeaseUntil: new Date(now.getTime() + SCHEDULE_ATTEMPT_LEASE_MS), updatedAt: now })
      .where(eq(schedules.id, scheduleId))
    return current.activeAttemptId
  })
  if (!staleAttemptId) return false
  const transitions = await recordScheduleFailure(
    scheduleId,
    staleAttemptId,
    {
      class: 'transient',
      code: 'execution_interrupted',
      summary: 'Schedule execution was interrupted before its outcome was recorded.',
    },
    now
  )
  emitScheduleHealthTransitions(transitions)
  return true
}

async function snapshotSquadId(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  row: typeof schedules.$inferSelect
): Promise<string | null> {
  if (row.scopeType === 'squad') return row.scopeId
  const [agent] = await tx.select({ squadId: agents.squadId }).from(agents).where(eq(agents.id, row.scopeId))
  return agent?.squadId ?? null
}

async function enqueueNotification(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  input: {
    scheduleId: string
    eventId: string
    incidentId: string
    kind: 'failure' | 'permanent_failure' | 'disabled' | 'recovery'
    squadId: string | null
    occurredAt: Date
  }
): Promise<void> {
  await tx
    .insert(scheduleHealthNotifications)
    .values({
      scheduleId: input.scheduleId,
      eventId: input.eventId,
      incidentId: input.incidentId,
      kind: input.kind,
      squadId: input.squadId,
      idempotencyKey: `schedule-health:${input.incidentId}:${input.kind}`,
      nextAttemptAt: input.occurredAt,
    })
    .onConflictDoNothing()
}

export async function recordScheduleFailure(
  scheduleId: string,
  attemptId: string | null,
  failure: ClassifiedScheduleFailure,
  failedAt = new Date(),
  options: {
    preserveActiveAttempt?: boolean
    lifecycleTarget?: { agentId: string; lifecycleAt: Date }
  } = {}
): Promise<ScheduleHealthTransition[]> {
  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(schedules).where(eq(schedules.id, scheduleId)).for('update')
    if (!current) attemptMismatch()
    if (options.lifecycleTarget) {
      const action = current.action as {
        target?: { type?: string; agentId?: string }
        assigneeAgentId?: string
        agentIds?: string[]
      }
      let targetsSquadManager = false
      if (current.scopeType === 'squad' && action.target?.type === 'squad_manager') {
        const [scope] = await tx
          .select({ managerAgentId: squads.managerAgentId })
          .from(squads)
          .where(eq(squads.id, current.scopeId))
          .limit(1)
        targetsSquadManager = scope?.managerAgentId === options.lifecycleTarget.agentId
      }
      const stillTargetsAgent =
        (current.scopeType === 'agent' && current.scopeId === options.lifecycleTarget.agentId) ||
        action.target?.agentId === options.lifecycleTarget.agentId ||
        action.assigneeAgentId === options.lifecycleTarget.agentId ||
        action.agentIds?.includes(options.lifecycleTarget.agentId) === true ||
        targetsSquadManager
      const [target] = await tx
        .select({ status: agents.status, dormantAt: agents.dormantAt, terminatedAt: agents.terminatedAt })
        .from(agents)
        .where(eq(agents.id, options.lifecycleTarget.agentId))
        .limit(1)
        .for('share')
      const expectedStatus = failure.code === 'target_agent_dormant' ? 'dormant' : 'terminated'
      const lifecycleAt = expectedStatus === 'dormant' ? target?.dormantAt : target?.terminatedAt
      if (
        !stillTargetsAgent ||
        target?.status !== expectedStatus ||
        lifecycleAt?.getTime() !== options.lifecycleTarget.lifecycleAt.getTime() ||
        (!current.enabled && !current.webhookEnabled)
      ) {
        return []
      }
    }
    if (attemptId !== null && current.activeAttemptId === attemptId && current.automaticallyDisabledAt) {
      await tx
        .update(schedules)
        .set({
          activeAttemptId: null,
          activeAttemptSource: null,
          activeAttemptStartedAt: null,
          activeAttemptLeaseUntil: null,
          updatedAt: failedAt,
        })
        .where(eq(schedules.id, scheduleId))
      return []
    }
    if (attemptId === null) {
      if (current.activeAttemptId && !options.preserveActiveAttempt) attemptMismatch()
      if (current.automaticallyDisabledAt) return []
    } else if (current.activeAttemptId !== attemptId) {
      attemptMismatch()
    }

    const incidentId = current.openFailureIncidentId ?? crypto.randomUUID()
    const consecutiveFailureCount = current.consecutiveFailureCount + 1
    const [failedEvent] = await tx
      .insert(scheduleHealthEvents)
      .values({
        scheduleId,
        attemptId,
        incidentId,
        kind: 'failed',
        occurredAt: failedAt,
        failureClass: failure.class,
        errorCode: failure.code,
        errorSummary: failure.summary,
        consecutiveFailureCount,
      })
      .returning()
    const transitions: ScheduleHealthTransition[] = [{ kind: 'failed', scheduleId, healthEventId: failedEvent.id }]
    const squadId = await snapshotSquadId(tx, current)
    const isPermanent = failure.class === 'permanent'
    const circuitBroken = !isPermanent && consecutiveFailureCount >= CIRCUIT_BREAKER_THRESHOLD
    const config = current.schedule as ScheduleConfig
    const hasTimeTrigger = Boolean(config.interval || config.cron || config.runAt)
    let nextTriggerAt = current.nextTriggerAt
    let enabled = current.enabled

    if (!isPermanent && !circuitBroken && hasTimeTrigger) {
      const retryMs =
        config.runAt && !nextTriggerAt
          ? Math.max(ONE_SHOT_RETRY_MS, failureBackoffMs(consecutiveFailureCount))
          : failureBackoffMs(consecutiveFailureCount)
      if (retryMs > 0) {
        const retryAt = new Date(failedAt.getTime() + retryMs)
        const expiresAt = config.expiresAt ? new Date(config.expiresAt) : null
        if (!expiresAt || retryAt < expiresAt) {
          if (!nextTriggerAt || nextTriggerAt < retryAt) nextTriggerAt = retryAt
        } else {
          nextTriggerAt = expiresAt
        }
      }
      if (!nextTriggerAt && config.expiresAt) nextTriggerAt = new Date(config.expiresAt)
      if (nextTriggerAt) enabled = true
    }

    let automaticallyDisabledAt: Date | null = current.automaticallyDisabledAt
    let automaticDisableReason: string | null = current.automaticDisableReason
    if (isPermanent || circuitBroken) {
      enabled = false
      nextTriggerAt = null
      automaticallyDisabledAt = failedAt
      automaticDisableReason = isPermanent
        ? failure.summary
        : `Automatically disabled after ${CIRCUIT_BREAKER_THRESHOLD} consecutive transient failures.`
      const [disabledEvent] = await tx
        .insert(scheduleHealthEvents)
        .values({
          scheduleId,
          attemptId,
          incidentId,
          kind: 'automatically_disabled',
          occurredAt: failedAt,
          failureClass: failure.class,
          errorCode: failure.code,
          errorSummary: automaticDisableReason,
          consecutiveFailureCount,
        })
        .returning()
      transitions.push({ kind: 'automatically_disabled', scheduleId, healthEventId: disabledEvent.id })
      await enqueueNotification(tx, {
        scheduleId,
        eventId: disabledEvent.id,
        incidentId,
        kind: isPermanent ? 'permanent_failure' : 'disabled',
        squadId,
        occurredAt: failedAt,
      })
    } else if (consecutiveFailureCount === TRANSIENT_ALERT_THRESHOLD) {
      await enqueueNotification(tx, {
        scheduleId,
        eventId: failedEvent.id,
        incidentId,
        kind: 'failure',
        squadId,
        occurredAt: failedAt,
      })
    }

    await tx
      .update(schedules)
      .set({
        enabled,
        webhookEnabled: isPermanent || circuitBroken ? false : current.webhookEnabled,
        nextTriggerAt,
        lastFailureAt: failedAt,
        failureCount: current.failureCount + 1,
        consecutiveFailureCount,
        lastErrorCode: failure.code,
        lastErrorSummary: failure.summary,
        automaticallyDisabledAt,
        automaticDisableReason,
        openFailureIncidentId: incidentId,
        ...(!options.preserveActiveAttempt && {
          activeAttemptId: null,
          activeAttemptSource: null,
          activeAttemptStartedAt: null,
          activeAttemptLeaseUntil: null,
        }),
        updatedAt: failedAt,
      })
      .where(eq(schedules.id, scheduleId))

    return transitions
  })
}

export async function recordScheduleSuccess(
  scheduleId: string,
  attemptId: string,
  succeededAt = new Date()
): Promise<ScheduleHealthTransition[]> {
  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(schedules).where(eq(schedules.id, scheduleId)).for('update')
    if (!current || current.activeAttemptId !== attemptId) attemptMismatch()
    if (current.automaticallyDisabledAt) {
      await tx
        .update(schedules)
        .set({
          lastSuccessAt: succeededAt,
          activeAttemptId: null,
          activeAttemptSource: null,
          activeAttemptStartedAt: null,
          activeAttemptLeaseUntil: null,
          updatedAt: succeededAt,
        })
        .where(eq(schedules.id, scheduleId))
      return []
    }
    const transitions: ScheduleHealthTransition[] = []
    if (current.openFailureIncidentId) {
      const incidentId = current.openFailureIncidentId
      const [recoveredEvent] = await tx
        .insert(scheduleHealthEvents)
        .values({
          scheduleId,
          attemptId,
          incidentId,
          kind: 'recovered',
          occurredAt: succeededAt,
          consecutiveFailureCount: 0,
        })
        .returning()
      transitions.push({ kind: 'recovered', scheduleId, healthEventId: recoveredEvent.id })
      const priorNotifications = await tx
        .select({ id: scheduleHealthNotifications.id })
        .from(scheduleHealthNotifications)
        .where(eq(scheduleHealthNotifications.incidentId, incidentId))
        .limit(1)
      if (priorNotifications.length > 0) {
        await enqueueNotification(tx, {
          scheduleId,
          eventId: recoveredEvent.id,
          incidentId,
          kind: 'recovery',
          squadId: await snapshotSquadId(tx, current),
          occurredAt: succeededAt,
        })
      }
    }

    const config = current.schedule as ScheduleConfig
    const finalExpiry = Boolean(
      current.activeAttemptSource !== 'webhook' && config.expiresAt && !config.runAt && current.nextTriggerAt === null
    )
    if (finalExpiry) {
      const [expiredEvent] = await tx
        .insert(scheduleHealthEvents)
        .values({
          scheduleId,
          attemptId,
          incidentId: crypto.randomUUID(),
          kind: 'automatically_disabled',
          occurredAt: succeededAt,
          errorSummary: 'Schedule expired.',
          consecutiveFailureCount: 0,
        })
        .returning()
      transitions.push({ kind: 'automatically_disabled', scheduleId, healthEventId: expiredEvent.id })
    }

    await tx
      .update(schedules)
      .set({
        lastSuccessAt: succeededAt,
        lastRecoveredAt: current.openFailureIncidentId ? succeededAt : current.lastRecoveredAt,
        consecutiveFailureCount: 0,
        openFailureIncidentId: null,
        activeAttemptId: null,
        activeAttemptSource: null,
        activeAttemptStartedAt: null,
        activeAttemptLeaseUntil: null,
        ...(finalExpiry && {
          enabled: false,
          webhookEnabled: false,
          nextTriggerAt: null,
          automaticallyDisabledAt: succeededAt,
          automaticDisableReason: `Schedule expired at ${config.expiresAt}.`,
        }),
        updatedAt: succeededAt,
      })
      .where(eq(schedules.id, scheduleId))
    return transitions
  })
}

export function recordScheduleLifecycleFailure(
  scheduleId: string,
  failure: ClassifiedScheduleFailure,
  failedAt = new Date(),
  expectedAgentId?: string
): Promise<ScheduleHealthTransition[]> {
  return recordScheduleFailure(scheduleId, null, failure, failedAt, {
    preserveActiveAttempt: true,
    ...(expectedAgentId ? { lifecycleTarget: { agentId: expectedAgentId, lifecycleAt: failedAt } } : {}),
  })
}

export async function reconcileExpiredScheduleAttemptsWithSummary(now = new Date()): Promise<{
  transitions: ScheduleHealthTransition[][]
  scanned: number
  failed: number
}> {
  const expired = await db
    .select({ scheduleId: schedules.id, attemptId: schedules.activeAttemptId })
    .from(schedules)
    .where(
      and(
        isNotNull(schedules.activeAttemptId),
        isNotNull(schedules.activeAttemptLeaseUntil),
        lte(schedules.activeAttemptLeaseUntil, now)
      )
    )
  const settled: ScheduleHealthTransition[][] = []
  let failed = 0
  for (const row of expired) {
    if (!row.attemptId) continue
    try {
      settled.push(
        await recordScheduleFailure(
          row.scheduleId,
          row.attemptId,
          {
            class: 'transient',
            code: 'execution_interrupted',
            summary: 'Schedule execution was interrupted before its outcome was recorded.',
          },
          now
        )
      )
    } catch (error) {
      if (!(error instanceof ScheduleExecutionError) || error.code !== 'attempt_in_progress') {
        failed++
        log.error(`Failed to reconcile expired schedule attempt ${row.scheduleId}`, error)
      }
    }
  }
  return { transitions: settled, scanned: expired.length, failed }
}

export async function reconcileExpiredScheduleAttempts(now = new Date()): Promise<ScheduleHealthTransition[][]> {
  return (await reconcileExpiredScheduleAttemptsWithSummary(now)).transitions
}
