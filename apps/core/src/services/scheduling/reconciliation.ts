import { and, eq, inArray, lte, sql } from 'drizzle-orm'
import { LIVE_AGENT_STATUSES, isLiveAgentStatus } from '@ficus/shared'
import type { Agent } from '../../entities/Agent'
import { db } from '../../db'
import { agents, schedules, squads } from '../../db/schema'
import {
  emitScheduleHealthTransitions,
  recordScheduleLifecycleFailure,
  reconcileExpiredScheduleAttemptsWithSummary,
} from './health-store'
import { scheduleHealthNotifier } from './failure-notifications'
import { validateScheduleReferences } from './reference-validation'
import { createLogger } from '../../lib/infra/logger'
import type { ClassifiedScheduleFailure } from './failure-classifier'

const log = createLogger('schedule-reconciliation')
export interface ReconciliationSummary {
  scanned: number
  repaired: number
  failed: number
}
const emptySummary = (): ReconciliationSummary => ({ scanned: 0, repaired: 0, failed: 0 })

const WATCHDOG_KIND = 'subagent-watchdog'
let unavailableScheduleDiscoveredHook: ((scheduleId: string) => Promise<void>) | undefined
export function setUnavailableScheduleDiscoveredHookForTest(
  hook: ((scheduleId: string) => Promise<void>) | undefined
): void {
  unavailableScheduleDiscoveredHook = hook
}
const watchdogKey = (parentId: string) => `subagent-watchdog:${parentId}`

async function reconcileSchedulesForUnavailableAgent(
  agent: Agent,
  lifecycle: 'dormant' | 'terminated'
): Promise<ReconciliationSummary> {
  const summary = emptySummary()
  const { Schedule } = await import('../../entities/Schedule')
  const lifecycleAt = lifecycle === 'dormant' ? agent.dormantAt : agent.terminatedAt
  const failure: ClassifiedScheduleFailure =
    lifecycle === 'dormant'
      ? {
          class: 'permanent' as const,
          code: 'target_agent_dormant',
          summary: 'Target agent is dormant; automatic schedule delivery was permanently disabled.',
        }
      : {
          class: 'permanent' as const,
          code: 'target_agent_terminated',
          summary: 'Target agent is terminated.',
        }
  try {
    for (const schedule of await Schedule.listTargetingAgent(agent.id)) {
      if (
        schedule.systemKey ||
        (schedule.metadata as Record<string, unknown> | null)?.kind === WATCHDOG_KIND ||
        (!schedule.enabled && !schedule.webhookEnabled)
      )
        continue
      summary.scanned++
      try {
        await unavailableScheduleDiscoveredHook?.(schedule.id)
        const failedAt = lifecycleAt ?? new Date()
        const transitions = await recordScheduleLifecycleFailure(schedule.id, failure, failedAt, agent.id)
        // A retarget may win after discovery. Only disable webhook delivery if
        // this exact lifecycle generation still owns an active reference.
        await db
          .update(schedules)
          .set({ webhookEnabled: false, updatedAt: new Date() })
          .where(
            and(
              eq(schedules.id, schedule.id),
              sql`(
                (${schedules.scopeType} = 'agent' AND ${schedules.scopeId} = ${agent.id})
                OR ${schedules.action}->'target'->>'agentId' = ${agent.id}
                OR ${schedules.action}->>'assigneeAgentId' = ${agent.id}
                OR ${schedules.action}->'agentIds' @> ${JSON.stringify([agent.id])}::jsonb
                OR (
                  ${schedules.scopeType} = 'squad'
                  AND ${schedules.action}->'target'->>'type' = 'squad_manager'
                  AND EXISTS (
                    SELECT 1 FROM ${squads}
                    WHERE ${squads.id} = ${schedules.scopeId}
                      AND ${squads.managerAgentId} = ${agent.id}
                  )
                )
              )`
            )
          )
        emitScheduleHealthTransitions(transitions)
        if (transitions.length) summary.repaired++
      } catch (error) {
        summary.failed++
        log.error(`Failed to reconcile ${lifecycle} target schedule ${schedule.id}`, error)
      }
    }
  } catch (error) {
    summary.failed++
    log.error(`Failed to discover schedules for ${lifecycle} agent ${agent.id}`, error)
  }
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${watchdogKey(agent.id)}))`)
      const [current] = await tx
        .select({
          status: agents.status,
          dormantAt: agents.dormantAt,
          terminatedAt: agents.terminatedAt,
          metadata: agents.metadata,
        })
        .from(agents)
        .where(eq(agents.id, agent.id))
        .for('share')
      const currentAt = lifecycle === 'dormant' ? current?.dormantAt : current?.terminatedAt
      if (current?.status !== lifecycle || currentAt?.getTime() !== lifecycleAt?.getTime()) return
      if (lifecycle === 'dormant') {
        const expectedMetadata = agent.metadata as Record<string, unknown> | null
        const currentMetadata = current.metadata as Record<string, unknown> | null
        if (
          typeof expectedMetadata?.dormancyCompletionId !== 'string' ||
          currentMetadata?.dormancyCompletionId !== expectedMetadata.dormancyCompletionId ||
          currentMetadata.resourceGeneration !== expectedMetadata.resourceGeneration
        )
          return
      }
      await tx.delete(schedules).where(
        and(
          sql`${schedules.scopeId} = ${agent.id} AND (
            ${schedules.systemKey} = ${watchdogKey(agent.id)} OR ${schedules.metadata}->>'kind' = ${WATCHDOG_KIND}
          )`,
          lifecycleAt ? lte(schedules.updatedAt, lifecycleAt) : undefined
        )
      )
    })
  } catch (error) {
    summary.failed++
    log.error(`Failed to delete watchdogs for ${lifecycle} agent ${agent.id}`, error)
  }
  scheduleHealthNotifier.drainSoon()
  return summary
}

export function reconcileSchedulesForDormantAgent(agent: Agent): Promise<ReconciliationSummary> {
  return reconcileSchedulesForUnavailableAgent(agent, 'dormant')
}

export function reconcileSchedulesForTerminatedAgent(agent: Agent): Promise<ReconciliationSummary> {
  return reconcileSchedulesForUnavailableAgent(agent, 'terminated')
}

export async function reconcileWatchdog(parentAgentId: string): Promise<void> {
  const systemKey = watchdogKey(parentAgentId)
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${systemKey}))`)
    const [parent] = await tx.select().from(agents).where(eq(agents.id, parentAgentId)).for('share')
    const liveChildren = await tx
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.parentAgentId, parentAgentId), inArray(agents.status, [...LIVE_AGENT_STATUSES])))
    const existing = await tx
      .select()
      .from(schedules)
      .where(
        sql`${schedules.scopeId} = ${parentAgentId} AND (
      ${schedules.systemKey} = ${systemKey} OR ${schedules.metadata}->>'kind' = ${WATCHDOG_KIND}
    )`
      )
      .for('update')
    if (!parent || !isLiveAgentStatus(parent.status) || liveChildren.length === 0) {
      for (const row of existing) await tx.delete(schedules).where(eq(schedules.id, row.id))
      return
    }
    const commonValues = {
      scopeType: 'agent' as const,
      scopeId: parentAgentId,
      name: 'Subagent watchdog',
      schedule: { interval: '15m' },
      action: {
        type: 'inbox_message' as const,
        target: { type: 'agent' as const, agentId: parentAgentId },
        subject: 'Subagent watchdog',
        content: 'Review current and recent subagent statuses.',
      },
      metadata: { kind: WATCHDOG_KIND },
      systemKey,
      updatedAt: new Date(),
    }
    const keeper = existing.find((row) => row.systemKey === systemKey) ?? existing[0]
    if (keeper) {
      await tx
        .update(schedules)
        .set({
          ...commonValues,
          enabled: keeper.automaticallyDisabledAt ? false : true,
          nextTriggerAt: keeper.automaticallyDisabledAt ? null : new Date(Date.now() + 15 * 60_000),
        })
        .where(eq(schedules.id, keeper.id))
      for (const row of existing) if (row.id !== keeper.id) await tx.delete(schedules).where(eq(schedules.id, row.id))
    } else {
      await tx
        .insert(schedules)
        .values({ ...commonValues, enabled: true, nextTriggerAt: new Date(Date.now() + 15 * 60_000) })
        .onConflictDoNothing({ target: schedules.systemKey })
    }
  })
}

export async function reconcileAllWatchdogs(): Promise<ReconciliationSummary> {
  const summary = emptySummary()
  const parents = await db
    .selectDistinct({ id: agents.parentAgentId })
    .from(agents)
    .where(sql`${agents.parentAgentId} IS NOT NULL`)
  const watchdogs = await db
    .selectDistinct({ id: schedules.scopeId })
    .from(schedules)
    .where(sql`${schedules.systemKey} LIKE 'subagent-watchdog:%' OR ${schedules.metadata}->>'kind' = ${WATCHDOG_KIND}`)
  for (const id of new Set([...parents, ...watchdogs].map((row) => row.id).filter(Boolean))) {
    summary.scanned++
    try {
      await reconcileWatchdog(id!)
      summary.repaired++
    } catch (error) {
      summary.failed++
      log.error(`Failed to reconcile watchdog for parent ${id}`, error)
    }
  }
  return summary
}

export async function reconcileSchedulesOnStartup(now = new Date()): Promise<ReconciliationSummary> {
  const summary = emptySummary()
  const stale = await reconcileExpiredScheduleAttemptsWithSummary(now)
  for (const transitions of stale.transitions) {
    emitScheduleHealthTransitions(transitions)
    if (transitions.length) summary.repaired++
  }
  summary.scanned += stale.scanned
  summary.failed += stale.failed
  const watchdogSummary = await reconcileAllWatchdogs()
  summary.scanned += watchdogSummary.scanned
  summary.repaired += watchdogSummary.repaired
  summary.failed += watchdogSummary.failed
  const { Schedule } = await import('../../entities/Schedule')
  for (const schedule of await Schedule.list()) {
    if (schedule.systemKey || (!schedule.enabled && !schedule.webhookEnabled)) continue
    summary.scanned++
    try {
      if (await schedule.expireIfNeeded(now)) {
        summary.repaired++
        continue
      }
      await validateScheduleReferences({
        scopeType: schedule.scopeType,
        scopeId: schedule.scopeId,
        action: schedule.action,
      })
    } catch (error) {
      try {
        const { classifyScheduleFailure } = await import('./failure-classifier')
        const failure = classifyScheduleFailure(error)
        if (failure.class === 'permanent') {
          const transitions = await recordScheduleLifecycleFailure(schedule.id, failure, now)
          emitScheduleHealthTransitions(transitions)
          if (transitions.length) summary.repaired++
        } else {
          summary.failed++
        }
      } catch (repairError) {
        summary.failed++
        log.error(`Failed startup reconciliation for schedule ${schedule.id}`, repairError)
      }
    }
  }
  if (summary.failed) log.warn('Schedule startup reconciliation completed with failures', summary)
  else log.info('Schedule startup reconciliation complete', summary)
  return summary
}
