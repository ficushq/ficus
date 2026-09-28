import { workflowSourceSchema } from '@ficus/shared'
import { and, eq, lte, isNotNull, isNull, desc, or, sql, inArray, type SQL } from 'drizzle-orm'
import { CronExpressionParser } from 'cron-parser'
import { db } from '../db'
import { agents, scheduleHealthEvents, schedules, squads } from '../db/schema'
import { uuidPrefixCondition, AmbiguousPrefixError } from '../db/prefix-match'
import { eventEmitter } from '../lib/infra/event-emitter'
import { generateWebhookToken, hashWebhookToken, verifyWebhookToken } from '../lib/utils'
import { BaseEntity } from './base'
import { createLogger } from '../lib/infra/logger'
import { formatSubagentStatuses } from '../lib/prompts/subagent-status'
import { validateScheduleReferences } from '../services/scheduling/reference-validation'
import {
  classifyScheduleFailure,
  publicScheduleError,
  ScheduleExecutionError,
} from '../services/scheduling/failure-classifier'
import {
  claimScheduleAttempt,
  emitScheduleHealthTransitions,
  recordScheduleFailure,
  recordScheduleSuccess,
  reconcileStaleScheduleAttemptBeforeReenable,
  type ScheduleAttemptSource,
} from '../services/scheduling/health-store'
import { scheduleHealthNotifier } from '../services/scheduling/failure-notifications'
import { isLiveAgentStatus } from '@ficus/shared'
import { acquireAgentQueueLock } from '../services/execution/agent-admission'
import type { DbTransaction } from '../services/machines/queries'

const log = createLogger('schedule')
import type {
  Schedule as ScheduleJson,
  ScheduleConfig,
  ScheduleAction,
  ScheduleScopeType,
  WorkStreamStatus,
  CreateScheduleInput,
  UpdateScheduleInput,
  WebhookEnableResult,
  WebhookTriggerResult,
  ScheduleHealthStatus,
} from '@ficus/shared'

type ScheduleRow = typeof schedules.$inferSelect

let scheduleLifecycleLockedHook: (() => Promise<void>) | undefined
let scheduleAgentLockAttemptedHook: ((agentId: string) => Promise<void>) | undefined
let scheduleAgentLockAcquiredHook: ((agentId: string) => Promise<void>) | undefined
export function setScheduleAgentLockAttemptedHookForTest(hook: ((agentId: string) => Promise<void>) | undefined): void {
  scheduleAgentLockAttemptedHook = hook
}
export function setScheduleAgentLockAcquiredHookForTest(hook: ((agentId: string) => Promise<void>) | undefined): void {
  scheduleAgentLockAcquiredHook = hook
}
export function setScheduleLifecycleLockedHookForTest(hook: (() => Promise<void>) | undefined): void {
  scheduleLifecycleLockedHook = hook
}

async function lockDeliverableScheduleAgents(
  tx: DbTransaction,
  input: { scopeType: ScheduleScopeType; scopeId: string; action: ScheduleAction },
  requireLive: boolean
): Promise<void> {
  const ids = new Set<string>()
  if (input.scopeType === 'agent') ids.add(input.scopeId)
  if (input.action.type === 'inbox_message') {
    if (input.action.target.type === 'agent') ids.add(input.action.target.agentId)
    else {
      const [squad] = await tx
        .select({ managerAgentId: squads.managerAgentId })
        .from(squads)
        .where(eq(squads.id, input.scopeId))
        .limit(1)
      if (squad?.managerAgentId) ids.add(squad.managerAgentId)
    }
  } else if (input.action.type === 'create_work_stream') {
    for (const id of input.action.agentIds ?? []) ids.add(id)
    if (input.action.assigneeAgentId) ids.add(input.action.assigneeAgentId)
  }
  const sortedIds = [...ids].sort()
  for (const id of sortedIds) {
    // Start the advisory-lock query before exposing the attempted boundary so
    // concurrency tests prove the loser is actually waiting on the lock.
    const lockAttempt = acquireAgentQueueLock(tx, id)
    await scheduleAgentLockAttemptedHook?.(id)
    await lockAttempt
    await scheduleAgentLockAcquiredHook?.(id)
  }
  if (requireLive && sortedIds.length > 0) {
    const rows = await tx
      .select({ id: agents.id, status: agents.status })
      .from(agents)
      .where(inArray(agents.id, sortedIds))
    if (rows.length !== sortedIds.length) {
      throw new ScheduleExecutionError('target_agent_not_found', 'permanent', 'Schedule target agent does not exist.')
    }
    const unavailable = rows.find((row) => !isLiveAgentStatus(row.status))
    if (unavailable) {
      throw new ScheduleExecutionError(
        unavailable.status === 'dormant' ? 'target_agent_dormant' : 'target_agent_terminated',
        'permanent',
        `Schedule agent ${unavailable.id} is ${unavailable.status}.`
      )
    }
  }
  await scheduleLifecycleLockedHook?.()
}

export interface ListSchedulesFilters {
  scopeType?: ScheduleScopeType
  scopeId?: string
  enabled?: boolean
  /** Match against metadata.kind (e.g. 'subagent-watchdog') */
  kind?: string
  /** Exclude rows whose metadata.kind equals this (rows with no kind are kept) */
  excludeKind?: string
}

/**
 * The `listDue` predicate, exported so the index test can EXPLAIN the exact
 * query the 30s scheduler tick runs rather than a hand-copied lookalike.
 *
 * Both arms are index-backed (`idx_schedules_next_trigger_due` and
 * `idx_schedules_schedule_expires_at`); Postgres needs a BitmapOr to use either,
 * and a BitmapOr needs every arm indexable, so changing one arm here without
 * checking `schema.ts` drops the whole query back to a sequential scan.
 */
export function scheduleDueCondition(now: Date): SQL {
  return or(
    and(eq(schedules.enabled, true), isNotNull(schedules.nextTriggerAt), lte(schedules.nextTriggerAt, now)),
    sql`(
      (${schedules.enabled} = true OR ${schedules.webhookEnabled} = true)
      AND ${schedules.schedule}->>'expiresAt' IS NOT NULL
      AND (${schedules.schedule}->>'expiresAt')::timestamptz <= ${now.toISOString()}::timestamptz
    )`
  )!
}

export class Schedule extends BaseEntity<ScheduleJson, UpdateScheduleInput> implements ScheduleRow {
  // Row fields
  declare id: string
  declare scopeType: ScheduleScopeType
  declare scopeId: string
  declare name: string
  declare enabled: boolean
  declare schedule: ScheduleConfig
  declare action: ScheduleAction
  declare metadata: Record<string, unknown>
  declare triggerCount: number
  declare lastTriggeredAt: Date | null
  declare lastSkippedAt: Date | null
  declare skipCount: number
  declare lastWebhookTriggerAt: Date | null
  declare nextTriggerAt: Date | null
  declare webhookEnabled: boolean
  declare webhookTokenHash: string | null
  declare lastSuccessAt: Date | null
  declare lastFailureAt: Date | null
  declare lastRecoveredAt: Date | null
  declare failureCount: number
  declare consecutiveFailureCount: number
  declare lastErrorCode: string | null
  declare lastErrorSummary: string | null
  declare automaticallyDisabledAt: Date | null
  declare automaticDisableReason: string | null
  declare openFailureIncidentId: string | null
  declare activeAttemptId: string | null
  declare activeAttemptSource: 'scheduled' | 'manual' | 'webhook' | null
  declare activeAttemptStartedAt: Date | null
  declare activeAttemptLeaseUntil: Date | null
  declare systemKey: string | null
  declare createdAt: Date
  declare updatedAt: Date

  constructor(data: ScheduleRow) {
    super()
    Object.assign(this, {
      ...data,
      schedule: data.schedule as ScheduleConfig,
      action: data.action as ScheduleAction,
      metadata: (data.metadata as Record<string, unknown>) ?? {},
    })
  }

  // ---------------------------------------------------------------------------
  // Static Utils
  // ---------------------------------------------------------------------------

  static parseInterval(interval: string): number {
    const match = interval.match(/^(\d+)(s|m|h)$/)
    if (!match) {
      throw new Error(`Invalid interval format: "${interval}". Expected format like "15m", "2h", "30s".`)
    }
    const [, value, unit] = match
    const multipliers: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000 }
    return parseInt(value) * multipliers[unit]
  }

  static calculateNextTrigger(
    config: ScheduleConfig,
    lastTriggered: Date | null,
    referenceDate = new Date()
  ): Date | null {
    let candidate: Date | null = null
    if (config.runAt) {
      const runAt = new Date(config.runAt)
      candidate = !lastTriggered && runAt > referenceDate ? runAt : null
    } else if (config.interval) {
      const intervalMs = Schedule.parseInterval(config.interval)
      const base = lastTriggered ?? referenceDate
      candidate = new Date(base.getTime() + intervalMs)
    } else if (config.cron) {
      candidate = CronExpressionParser.parse(config.cron, { currentDate: referenceDate }).next().toDate()
    }
    if (candidate && config.expiresAt && candidate >= new Date(config.expiresAt)) return null
    return candidate
  }

  static isStrictIsoDateTime(value: string): boolean {
    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/)
    if (!match || !Number.isFinite(Date.parse(value))) return false
    const [, year, month, day, hour, minute, second, zone] = match
    const y = Number(year)
    const m = Number(month)
    const d = Number(day)
    const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate()
    if (m < 1 || m > 12 || d < 1 || d > daysInMonth) return false
    if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return false
    if (zone !== 'Z') {
      const [offsetHour, offsetMinute] = zone.slice(1).split(':').map(Number)
      if (offsetHour > 23 || offsetMinute > 59) return false
    }
    return true
  }

  // ---------------------------------------------------------------------------
  // Validation
  // ---------------------------------------------------------------------------

  static actionCreatesWorkStream(action: ScheduleAction): boolean {
    return action.type === 'create_work_stream' || (action.type === 'spawn_agent' && Boolean(action.workStream))
  }

  static validateSkipPolicy(config: ScheduleConfig, action: ScheduleAction): void {
    if (config.skipIfUnresolved !== true) return
    if (Schedule.actionCreatesWorkStream(action)) return
    throw new Error(
      'skipIfUnresolved requires an action that creates a work stream (create_work_stream, or spawn_agent with workStream set)'
    )
  }

  static async hasUnresolvedWorkStreams(scheduleId: string): Promise<boolean> {
    const { WorkStream } = await import('./WorkStream')
    const { getFlow } = await import('../services/workflows/execution')
    const terminal: WorkStreamStatus[] = ['done', 'canceled']
    const all = await WorkStream.findByMetadata({ scheduleId })
    for (const ws of all) {
      if (ws.status !== 'active' || ws.assigneeAgentId || (await getFlow(ws.id))) continue
      const runtime = await ws.getRuntime()
      if (runtime.activeCount > 0) continue
      // Flag the orphaned stream for a human/manager decision: a review wait
      // carries the reason (statuses no longer encode "review").
      await ws.handoffForReview({
        message:
          'This schedule-created work stream had no assignee or active execution. Reassign it, explicitly verify and complete it, or cancel it.',
        createdBy: 'system',
      })
      await ws.update({
        metadata: {
          ...ws.metadata,
          scheduleRecovery: {
            reason: 'unassigned-in-progress',
            reconciledAt: new Date().toISOString(),
          },
        },
      })
    }
    return all.some((ws) => !terminal.includes(ws.status))
  }

  static validateAction(scopeType: ScheduleScopeType, action: ScheduleAction): void {
    switch (action.type) {
      case 'inbox_message':
        if (action.target.type === 'squad_manager' && scopeType !== 'squad') {
          throw new Error('squad_manager target requires squad scope')
        }
        break
      case 'spawn_agent':
        if (action.workStream)
          throw new Error('Use create_work_stream with a workflow instead of spawn_agent.workStream')
        if (scopeType !== 'squad') {
          throw new Error('spawn_agent action requires squad scope')
        }
        break
      case 'create_work_stream':
        if (
          action.agentTypes !== undefined ||
          action.agentIds !== undefined ||
          action.assigneeAgentId !== undefined ||
          action.assigneeAgentIndex !== undefined ||
          action.completionMode !== undefined
        )
          throw new Error('Legacy work-stream creation is no longer supported; configure a workflow.')
        if (action.workflow) workflowSourceSchema.parse(action.workflow)
        if (scopeType !== 'squad') {
          throw new Error('create_work_stream action requires squad scope')
        }
        break
    }
  }

  /**
   * Validate schedule config.
   * @param config - The schedule configuration
   * @param allowEmpty - If true, allows empty config (for webhook-only schedules)
   */
  static validateScheduleConfig(config: ScheduleConfig, allowEmpty = false): void {
    const hasTimeTrigger = config.interval || config.cron || config.runAt
    if (!hasTimeTrigger && !allowEmpty) {
      throw new Error('Schedule must have interval, cron, or runAt (or be webhook-only)')
    }
    if (config.interval) {
      Schedule.parseInterval(config.interval)
    }
    if (config.cron) {
      try {
        CronExpressionParser.parse(config.cron)
      } catch {
        throw new Error(`Invalid cron expression: ${config.cron}`)
      }
    }
    if (config.expiresAt && !Schedule.isStrictIsoDateTime(config.expiresAt)) {
      throw new Error('expiresAt must be an ISO-8601 datetime with timezone')
    }
  }

  // ---------------------------------------------------------------------------
  // Static CRUD
  // ---------------------------------------------------------------------------

  static async find(id: string): Promise<Schedule | null> {
    if (id.length >= 36) {
      const [row] = await db.select().from(schedules).where(eq(schedules.id, id))
      return row ? new Schedule(row) : null
    }
    const rows = await db.select().from(schedules).where(uuidPrefixCondition(schedules.id, id)).limit(2)
    if (rows.length === 0) return null
    if (rows.length > 1) throw new AmbiguousPrefixError('schedule', id)
    return new Schedule(rows[0])
  }

  static async mustFind(id: string): Promise<Schedule> {
    const schedule = await Schedule.find(id)
    if (!schedule) throw new Error(`Schedule ${id} not found`)
    return schedule
  }

  static async list(filters?: ListSchedulesFilters): Promise<Schedule[]> {
    const conditions = []
    if (filters?.scopeType) conditions.push(eq(schedules.scopeType, filters.scopeType))
    if (filters?.scopeId) conditions.push(eq(schedules.scopeId, filters.scopeId))
    if (filters?.enabled !== undefined) conditions.push(eq(schedules.enabled, filters.enabled))
    if (filters?.kind !== undefined) conditions.push(sql`${schedules.metadata}->>'kind' = ${filters.kind}`)
    if (filters?.excludeKind !== undefined)
      conditions.push(
        sql`(${schedules.metadata}->>'kind' <> ${filters.excludeKind} OR ${schedules.metadata}->>'kind' IS NULL)`
      )

    const rows = await db
      .select()
      .from(schedules)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(schedules.createdAt))

    return rows.map((row) => new Schedule(row))
  }

  static async listTargetingAgent(agentId: string): Promise<Schedule[]> {
    const rows = await db
      .select({ schedule: schedules })
      .from(schedules)
      .where(
        and(
          isNull(schedules.systemKey),
          sql`(${schedules.metadata}->>'kind' IS NULL OR ${schedules.metadata}->>'kind' <> 'subagent-watchdog')`,
          or(
            and(eq(schedules.scopeType, 'agent'), eq(schedules.scopeId, agentId)),
            sql`${schedules.action}->'target'->>'agentId' = ${agentId}`,
            sql`${schedules.action}->>'assigneeAgentId' = ${agentId}`,
            sql`${schedules.action}->'agentIds' @> ${JSON.stringify([agentId])}::jsonb`,
            sql`(
              ${schedules.scopeType} = 'squad'
              AND ${schedules.action}->'target'->>'type' = 'squad_manager'
              AND EXISTS (
                SELECT 1 FROM ${squads}
                WHERE ${squads.id} = ${schedules.scopeId}
                  AND ${squads.managerAgentId} = ${agentId}
              )
            )`
          )
        )
      )
    return rows.map((row) => new Schedule(row.schedule))
  }

  static async listDue(): Promise<Schedule[]> {
    const rows = await db.select().from(schedules).where(scheduleDueCondition(new Date()))

    return rows.map((row) => new Schedule(row))
  }

  static async create(input: CreateScheduleInput): Promise<Schedule> {
    // Allow empty schedule config for webhook-only schedules
    Schedule.validateScheduleConfig(input.schedule, input.webhookOnly)
    Schedule.validateAction(input.scopeType, input.action)
    Schedule.validateSkipPolicy(input.schedule, input.action)
    await validateScheduleReferences({ scopeType: input.scopeType, scopeId: input.scopeId, action: input.action })

    const nextTriggerAt = input.webhookOnly ? null : Schedule.calculateNextTrigger(input.schedule, null)

    const row = await db.transaction(async (tx) => {
      await lockDeliverableScheduleAgents(
        tx,
        { scopeType: input.scopeType, scopeId: input.scopeId, action: input.action },
        (input.enabled ?? true) || input.webhookOnly === true
      )
      const [created] = await tx
        .insert(schedules)
        .values({
          scopeType: input.scopeType,
          scopeId: input.scopeId,
          name: input.name,
          enabled: input.enabled ?? true,
          schedule: input.schedule,
          action: input.action,
          metadata: input.metadata ?? {},
          nextTriggerAt,
          // Auto-enable webhook for webhook-only schedules
          webhookEnabled: input.webhookOnly ? true : false,
        })
        .returning()
      return created
    })

    const schedule = new Schedule(row)
    eventEmitter.emit('schedule.created', { scheduleId: schedule.id })

    // If webhook-only, generate and return the token
    // Note: The token is only available via enableWebhook() call
    return schedule
  }

  static async delete(id: string): Promise<void> {
    const schedule = await Schedule.find(id)
    if (!schedule) return
    await db.delete(schedules).where(eq(schedules.id, schedule.id))
    eventEmitter.emit('schedule.deleted', {
      scheduleId: schedule.id,
      scopeType: schedule.scopeType,
      scopeId: schedule.scopeId,
    })
  }

  // ---------------------------------------------------------------------------
  // Instance Methods
  // ---------------------------------------------------------------------------

  async update(input: UpdateScheduleInput): Promise<this> {
    if (input.enabled === true) return this.reenable(input)
    if (input.schedule) {
      // Allow empty config if webhook is enabled (webhook-only schedule)
      const isWebhookOnly =
        this.webhookEnabled && !input.schedule.interval && !input.schedule.cron && !input.schedule.runAt
      Schedule.validateScheduleConfig(input.schedule, isWebhookOnly)
    }
    if (input.action) {
      Schedule.validateAction(this.scopeType, input.action)
    }
    Schedule.validateSkipPolicy(input.schedule ?? this.schedule, input.action ?? this.action)
    await validateScheduleReferences({
      scopeType: this.scopeType,
      scopeId: this.scopeId,
      action: input.action ?? this.action,
    })

    const row = await db.transaction(async (tx) => {
      const [current] = await tx.select().from(schedules).where(eq(schedules.id, this.id)).for('update')
      if (!current) throw new ScheduleExecutionError('scope_not_found', 'permanent', 'Schedule does not exist.')
      const action = (input.action ?? current.action) as ScheduleAction
      await lockDeliverableScheduleAgents(
        tx,
        { scopeType: current.scopeType as ScheduleScopeType, scopeId: current.scopeId, action },
        (input.enabled ?? current.enabled) || current.webhookEnabled
      )
      const updates: Record<string, unknown> = { updatedAt: new Date() }
      if (input.name !== undefined) updates.name = input.name
      if (input.enabled !== undefined) updates.enabled = input.enabled
      if (input.schedule !== undefined) {
        updates.schedule = input.schedule
        const hasTimeTrigger = input.schedule.interval || input.schedule.cron || input.schedule.runAt
        updates.nextTriggerAt = hasTimeTrigger
          ? Schedule.calculateNextTrigger(input.schedule, current.lastTriggeredAt)
          : null
      }
      if (input.action !== undefined) updates.action = input.action
      if (input.metadata !== undefined) updates.metadata = input.metadata
      const [updated] = await tx.update(schedules).set(updates).where(eq(schedules.id, this.id)).returning()
      return updated
    })

    Object.assign(this, new Schedule(row))
    eventEmitter.emit('schedule.updated', { scheduleId: this.id })
    return this
  }

  async reload(): Promise<this> {
    const fresh = await Schedule.mustFind(this.id)
    Object.assign(this, fresh)
    return this
  }

  private healthStatus(): ScheduleHealthStatus {
    if (this.automaticallyDisabledAt) return 'automatically_disabled'
    if (this.openFailureIncidentId || this.consecutiveFailureCount > 0) return 'failing'
    if (this.lastSuccessAt) return 'healthy'
    return 'never_run'
  }

  toJson(): ScheduleJson {
    return {
      id: this.id,
      scopeType: this.scopeType,
      scopeId: this.scopeId,
      name: this.name,
      enabled: this.enabled,
      schedule: this.schedule,
      action: this.action,
      metadata: this.metadata,
      triggerCount: this.triggerCount,
      lastTriggeredAt: this.lastTriggeredAt,
      lastSkippedAt: this.lastSkippedAt,
      skipCount: this.skipCount,
      lastWebhookTriggerAt: this.lastWebhookTriggerAt,
      nextTriggerAt: this.nextTriggerAt,
      webhookEnabled: this.webhookEnabled,
      healthStatus: this.healthStatus(),
      lastSuccessAt: this.lastSuccessAt,
      lastFailureAt: this.lastFailureAt,
      lastRecoveredAt: this.lastRecoveredAt,
      failureCount: this.failureCount,
      consecutiveFailureCount: this.consecutiveFailureCount,
      lastErrorCode: this.lastErrorCode,
      lastErrorSummary: this.lastErrorSummary,
      automaticallyDisabledAt: this.automaticallyDisabledAt,
      automaticDisableReason: this.automaticDisableReason,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    }
  }

  // ---------------------------------------------------------------------------
  // Business Logic
  // ---------------------------------------------------------------------------

  private async reenable(input: UpdateScheduleInput = {}, webhookTokenHash?: string): Promise<this> {
    const now = new Date()
    await reconcileStaleScheduleAttemptBeforeReenable(this.id, now)
    // Reference validation runs BEFORE the transaction: its Squad/Agent/
    // AgentType lookups hit the shared pool, and pool reads while holding a
    // row lock are hold-and-wait (pool self-deadlock under concurrency). The
    // pre-read/lock TOCTOU on `action` is acceptable — reference existence
    // was never serialized against squad/agent deletion in the first place.
    const [preread] = await db.select().from(schedules).where(eq(schedules.id, this.id))
    if (preread) {
      await validateScheduleReferences({
        scopeType: preread.scopeType as ScheduleScopeType,
        scopeId: preread.scopeId,
        action: (input.action ?? preread.action) as ScheduleAction,
      })
    }
    const row = await db.transaction(async (tx) => {
      const [current] = await tx.select().from(schedules).where(eq(schedules.id, this.id)).for('update')
      if (!current) throw new ScheduleExecutionError('scope_not_found', 'permanent', 'Schedule does not exist.')
      if (current.activeAttemptId) {
        throw new ScheduleExecutionError(
          'attempt_in_progress',
          'transient',
          'Schedule has an active execution attempt.'
        )
      }
      const mergedSchedule = (input.schedule ?? current.schedule) as ScheduleConfig
      const mergedAction = (input.action ?? current.action) as ScheduleAction
      const isWebhookOnly = Boolean(
        (webhookTokenHash || current.webhookEnabled) &&
        !mergedSchedule.interval &&
        !mergedSchedule.cron &&
        !mergedSchedule.runAt
      )
      Schedule.validateScheduleConfig(mergedSchedule, isWebhookOnly)
      Schedule.validateAction(current.scopeType as ScheduleScopeType, mergedAction)
      Schedule.validateSkipPolicy(mergedSchedule, mergedAction)
      await lockDeliverableScheduleAgents(
        tx,
        { scopeType: current.scopeType as ScheduleScopeType, scopeId: current.scopeId, action: mergedAction },
        true
      )
      const nextTriggerAt = Schedule.calculateNextTrigger(mergedSchedule, current.lastTriggeredAt, now)
      const enableTime =
        input.enabled === true || webhookTokenHash === undefined || current.automaticallyDisabledAt != null
      const [updated] = await tx
        .update(schedules)
        .set({
          ...(input.name !== undefined && { name: input.name }),
          ...(input.schedule !== undefined && { schedule: mergedSchedule }),
          ...(input.action !== undefined && { action: mergedAction }),
          ...(input.metadata !== undefined && { metadata: input.metadata }),
          enabled: enableTime ? true : current.enabled,
          nextTriggerAt,
          ...(webhookTokenHash !== undefined && { webhookEnabled: true, webhookTokenHash }),
          consecutiveFailureCount: 0,
          automaticallyDisabledAt: null,
          automaticDisableReason: null,
          updatedAt: now,
        })
        .where(eq(schedules.id, this.id))
        .returning()
      return updated
    })
    Object.assign(this, new Schedule(row))
    eventEmitter.emit('schedule.updated', { scheduleId: this.id })
    return this
  }

  async enable(): Promise<this> {
    return this.reenable({ enabled: true })
  }

  async disable(): Promise<this> {
    const [row] = await db
      .update(schedules)
      .set({ enabled: false, updatedAt: new Date() })
      .where(eq(schedules.id, this.id))
      .returning()

    Object.assign(this, new Schedule(row))
    eventEmitter.emit('schedule.updated', { scheduleId: this.id })
    return this
  }

  /** Record a skip without opening an execution attempt or changing health. */
  private async recordSkip(requireDue: boolean): Promise<boolean> {
    const skippedAt = new Date()
    const nominalNext = Schedule.calculateNextTrigger(this.schedule, this.nextTriggerAt ?? skippedAt, skippedAt)
    const expiresAt = this.schedule.expiresAt ? new Date(this.schedule.expiresAt) : null
    const nextTriggerAt = nominalNext ?? (expiresAt && expiresAt > skippedAt ? expiresAt : null)
    const conditions = [
      eq(schedules.id, this.id),
      isNull(schedules.activeAttemptId),
      isNull(schedules.automaticallyDisabledAt),
      sql`(${schedules.schedule}->>'expiresAt' IS NULL OR (${schedules.schedule}->>'expiresAt')::timestamptz > ${skippedAt.toISOString()}::timestamptz)`,
    ]
    if (requireDue) {
      conditions.push(
        eq(schedules.enabled, true),
        isNotNull(schedules.nextTriggerAt),
        lte(schedules.nextTriggerAt, skippedAt)
      )
    }
    const [row] = await db
      .update(schedules)
      .set({
        nextTriggerAt,
        enabled: nextTriggerAt !== null ? sql`${schedules.enabled}` : false,
        lastSkippedAt: skippedAt,
        skipCount: sql`${schedules.skipCount} + 1`,
        updatedAt: skippedAt,
      })
      .where(and(...conditions))
      .returning()
    if (!row) return false
    Object.assign(this, new Schedule(row))
    eventEmitter.emit('schedule.triggered', { scheduleId: this.id })
    return true
  }

  async expireIfNeeded(now: Date, noFutureOccurrence = false): Promise<boolean> {
    const result = await db.transaction(async (tx) => {
      const [current] = await tx.select().from(schedules).where(eq(schedules.id, this.id)).for('update')
      if (!current) return { expired: false, event: null }
      const config = current.schedule as ScheduleConfig
      if (!config.expiresAt || (!noFutureOccurrence && now < new Date(config.expiresAt))) {
        return { expired: false, event: null }
      }
      if (current.activeAttemptId) return { expired: false, event: null }
      if (current.automaticallyDisabledAt) return { expired: true, event: null }
      const incidentId = crypto.randomUUID()
      const [event] = await tx
        .insert(scheduleHealthEvents)
        .values({
          scheduleId: this.id,
          attemptId: null,
          incidentId,
          kind: 'automatically_disabled',
          occurredAt: now,
          errorCode: null,
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
          automaticallyDisabledAt: now,
          automaticDisableReason: `Schedule expired at ${config.expiresAt}.`,
          updatedAt: now,
        })
        .where(eq(schedules.id, this.id))
      return { expired: true, event }
    })
    if (!result.expired) return false
    try {
      await this.reload()
    } catch (reloadError) {
      log.error('Failed to refresh expired schedule projection', reloadError)
    }
    if (result.event)
      emitScheduleHealthTransitions([
        { kind: 'automatically_disabled', scheduleId: this.id, healthEventId: result.event.id },
      ])
    return true
  }

  private async runAttempt(input: {
    source: ScheduleAttemptSource
    requireDue?: boolean
    context?: Record<string, unknown>
  }): Promise<{ claimed: boolean; result?: { agentId?: string; workStreamId?: string } }> {
    let attempt: Awaited<ReturnType<typeof claimScheduleAttempt>>
    try {
      if (input.source !== 'webhook' && Schedule.actionCreatesWorkStream(this.action)) {
        await this.reload()
        if (this.automaticallyDisabledAt) {
          throw new ScheduleExecutionError(
            'invalid_action_reference',
            'permanent',
            'Automatically disabled schedule must be re-enabled before it can run.'
          )
        }
        if (this.schedule.expiresAt && (await this.expireIfNeeded(new Date()))) {
          if (input.source === 'scheduled') return { claimed: false }
          throw new ScheduleExecutionError('invalid_action_reference', 'permanent', 'Schedule has expired.')
        }
        if (await this.shouldSkip()) {
          const claimed = await this.recordSkip(input.requireDue ?? false)
          if (claimed) {
            log.info(`Skipped "${this.name}": prior work stream still unresolved`)
            return { claimed }
          }
        }
      }
      attempt = await claimScheduleAttempt(this.id, {
        source: input.source,
        requireDue: input.requireDue,
      })
    } catch (preActionError) {
      const classified = classifyScheduleFailure(preActionError)
      log.error(`Schedule pre-action failed for "${this.name}" (${this.id}):`, preActionError)
      throw publicScheduleError(classified)
    }
    if (!attempt) {
      if (input.source === 'scheduled') return { claimed: false }
      try {
        await this.reload()
      } catch (reloadError) {
        log.error('Failed to refresh unclaimed schedule projection', reloadError)
      }
      if (this.automaticDisableReason?.startsWith('Schedule expired at ')) {
        throw new ScheduleExecutionError('invalid_action_reference', 'permanent', 'Schedule has expired.')
      }
      if (this.lastErrorCode === 'execution_interrupted') {
        throw new ScheduleExecutionError(
          'execution_interrupted',
          'transient',
          'An abandoned schedule attempt was reconciled; retry after its backoff.'
        )
      }
      throw new ScheduleExecutionError('attempt_in_progress', 'transient', 'Schedule execution could not be claimed.')
    }

    let result: { agentId?: string; workStreamId?: string }
    try {
      await this.reload()
      await validateScheduleReferences({ scopeType: this.scopeType, scopeId: this.scopeId, action: this.action })
      result = await this.executeAction({ source: input.source, context: input.context })
    } catch (actionError) {
      log.error(`Error executing "${this.name}" (${this.id}):`, actionError)
      const classified = classifyScheduleFailure(actionError)
      let transitions
      try {
        transitions = await recordScheduleFailure(this.id, attempt.id, classified, new Date())
      } catch (persistenceError) {
        log.error('Schedule health settlement failed', persistenceError)
        throw new ScheduleExecutionError(
          'health_persistence_failed',
          'transient',
          'Schedule action failed and its health record could not be persisted.'
        )
      }
      emitScheduleHealthTransitions(transitions)
      try {
        await this.reload()
      } catch (reloadError) {
        log.error('Failed to refresh committed schedule failure projection', reloadError)
      }
      scheduleHealthNotifier.drainSoon()
      throw publicScheduleError(classified)
    }

    let transitions
    try {
      transitions = await recordScheduleSuccess(this.id, attempt.id, new Date())
    } catch (persistenceError) {
      log.error('Schedule success settlement failed', persistenceError)
      throw new ScheduleExecutionError(
        'health_persistence_failed',
        'transient',
        'Schedule action completed but its health record could not be persisted.'
      )
    }
    emitScheduleHealthTransitions(transitions)
    try {
      await this.reload()
    } catch (reloadError) {
      log.error('Failed to refresh committed schedule success projection', reloadError)
    }
    if (input.source === 'webhook') eventEmitter.emit('schedule.webhook_triggered', { scheduleId: this.id })
    else eventEmitter.emit('schedule.triggered', { scheduleId: this.id })
    scheduleHealthNotifier.drainSoon()
    return { claimed: true, result }
  }

  async trigger(): Promise<void> {
    await this.runAttempt({ source: 'manual' })
  }

  async triggerIfDue(): Promise<boolean> {
    return (await this.runAttempt({ source: 'scheduled', requireDue: true })).claimed
  }

  private async shouldSkip(): Promise<boolean> {
    if (!Schedule.actionCreatesWorkStream(this.action)) return false
    if (this.schedule.skipIfUnresolved === false) return false
    return Schedule.hasUnresolvedWorkStreams(this.id)
  }

  private async executeAction(input: {
    source: ScheduleAttemptSource
    context?: Record<string, unknown>
  }): Promise<{ agentId?: string; workStreamId?: string }> {
    const action = this.action
    const { InboxMessage } = await import('./InboxMessage')
    const { WorkStream } = await import('./WorkStream')
    const { Squad } = await import('./Squad')
    const contextSuffix = input.context
      ? `\n\n## Webhook Context\n\`\`\`json\n${JSON.stringify(input.context, null, 2)}\n\`\`\``
      : ''
    let agentId: string | undefined
    let workStreamId: string | undefined

    switch (action.type) {
      case 'inbox_message': {
        let targetAgentId: string
        if (action.target.type === 'squad_manager') {
          const squad = await Squad.find(this.scopeId)
          if (!squad?.managerAgentId) {
            throw new ScheduleExecutionError('squad_manager_missing', 'permanent', 'Schedule scope has no manager.')
          }
          targetAgentId = squad.managerAgentId
        } else {
          targetAgentId = action.target.agentId
        }
        let content = action.content
        if (
          this.scopeType === 'agent' &&
          this.scopeId === targetAgentId &&
          (this.systemKey === `subagent-watchdog:${targetAgentId}` || this.metadata?.kind === 'subagent-watchdog')
        ) {
          // Read at delivery time, including for legacy watchdog rows. Persisting
          // a snapshot in the schedule would repeat stale statuses on every tick.
          const { Subagent } = await import('./Subagent')
          const children = await Subagent.listChildren(targetAgentId)
          content = `Current and recent subagent statuses:\n\n${formatSubagentStatuses(children)}\n\nReview these statuses and intervene if needed. If work is progressing normally, keep waiting; final results arrive separately.`
        }
        await InboxMessage.send({
          recipientType: 'agent',
          recipientId: targetAgentId,
          senderType: 'system',
          // Timer ticks are housekeeping and never wake dormant agents. Manual
          // operator triggers and authenticated inbound webhooks are explicit work.
          wakeEligible: input.source !== 'scheduled',
          subject: action.subject ?? `${input.source === 'webhook' ? 'Webhook' : 'Scheduled'}: ${this.name}`,
          content: content + contextSuffix,
          metadata: {
            scheduleId: this.id,
            type: input.source === 'webhook' ? 'webhook' : 'schedule',
            ...(input.context && { webhookContext: input.context }),
          },
        })
        agentId = targetAgentId
        break
      }
      case 'spawn_agent': {
        if (action.workStream)
          throw new Error('Use create_work_stream with a workflow instead of spawn_agent.workStream')
        const squad = await Squad.mustFind(this.scopeId)
        const agent = await squad.spawnAgent(action.agentTypeId)
        agentId = agent.id
        const prompt = action.prompt + contextSuffix
        await agent.queueExecution({ message: prompt })
        break
      }
      case 'create_work_stream': {
        Schedule.validateAction(this.scopeType, action)
        const stream = await WorkStream.create({
          squadId: this.scopeId,
          title: action.title,
          description: [action.description, action.handoffMessage, contextSuffix].filter(Boolean).join('\n\n'),
          workflow: action.workflow,
          metadata: { scheduleId: this.id },
        })
        workStreamId = stream.id
        agentId = stream.assigneeAgentId ?? undefined
        break
      }
    }
    return { agentId, workStreamId }
  }

  // ---------------------------------------------------------------------------
  // Webhook Methods
  // ---------------------------------------------------------------------------

  /**
   * Enable webhook triggering and generate a new token.
   * Returns the plain token (only shown once).
   */
  async enableWebhook(baseUrl: string): Promise<WebhookEnableResult> {
    const plainToken = generateWebhookToken()
    const tokenHash = hashWebhookToken(plainToken)
    await this.reenable({}, tokenHash)
    return {
      webhookEnabled: true,
      token: plainToken,
      webhookUrl: `${baseUrl}/api/webhooks/trigger/${this.id}`,
    }
  }

  /**
   * Disable webhook triggering.
   */
  async disableWebhook(): Promise<this> {
    const [row] = await db
      .update(schedules)
      .set({
        webhookEnabled: false,
        webhookTokenHash: null,
        updatedAt: new Date(),
      })
      .where(eq(schedules.id, this.id))
      .returning()

    Object.assign(this, new Schedule(row))
    eventEmitter.emit('schedule.updated', { scheduleId: this.id })
    return this
  }

  /**
   * Regenerate the webhook token.
   * Returns the new plain token (only shown once).
   */
  async regenerateWebhookToken(baseUrl: string): Promise<WebhookEnableResult> {
    if (!this.webhookEnabled) {
      throw new Error('Webhook is not enabled for this schedule')
    }

    const plainToken = generateWebhookToken()
    const tokenHash = hashWebhookToken(plainToken)

    const [row] = await db
      .update(schedules)
      .set({
        webhookTokenHash: tokenHash,
        updatedAt: new Date(),
      })
      .where(eq(schedules.id, this.id))
      .returning()

    Object.assign(this, new Schedule(row))
    eventEmitter.emit('schedule.updated', { scheduleId: this.id })

    return {
      webhookEnabled: true,
      token: plainToken,
      webhookUrl: `${baseUrl}/api/webhooks/trigger/${this.id}`,
    }
  }

  /**
   * Verify a webhook token against this schedule's stored hash.
   */
  verifyToken(token: string): boolean {
    if (!this.webhookEnabled || !this.webhookTokenHash) {
      return false
    }
    return verifyWebhookToken(token, this.webhookTokenHash)
  }

  /**
   * Trigger the schedule via webhook, with optional context injection.
   * Returns information about what was triggered.
   */
  async triggerViaWebhook(context?: Record<string, unknown>): Promise<WebhookTriggerResult> {
    const attempt = await this.runAttempt({ source: 'webhook', context })
    if (!attempt.claimed) {
      throw new ScheduleExecutionError('attempt_in_progress', 'transient', 'Schedule execution could not be claimed.')
    }
    return {
      triggered: true,
      scheduleId: this.id,
      scheduleName: this.name,
      agentId: attempt.result?.agentId,
      workStreamId: attempt.result?.workStreamId,
    }
  }
}
