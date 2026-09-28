import { and, eq, inArray, sql } from 'drizzle-orm'
import { LIVE_AGENT_STATUSES, isLiveAgentStatus, type AgentStatus } from '@ficus/shared'
import { agents, db, withDedicatedDbTransaction } from '../db'
import { Agent, AgentTargetUnavailableError } from './Agent'
import { InboxMessage } from './InboxMessage'
import { createLogger } from '../lib/infra/logger'
import { requestAgentLifecycle, type ParentDormancyFence } from '../services/agent/lifecycle'

const log = createLogger('subagent')

/** Agent type ID for ephemeral subagents. */
export const SUBAGENT_AGENT_TYPE_ID = 'subagent'
/** Runner type for subagents (see agent-runners/base.ts AgentRunnerType). */
export const SUBAGENT_RUNNER_TYPE = 'subagent'
/** Per-parent concurrent-live subagent cap (enforced in Subagent.dispatch). */
export const SUBAGENT_MAX_PER_PARENT = 10
/** schedules.metadata.kind marker identifying the subagent watchdog (Phase B). */
export const SUBAGENT_WATCHDOG_KIND = 'subagent-watchdog'
/** Default watchdog interval in minutes (Phase B). */
export const SUBAGENT_WATCHDOG_INTERVAL_MINUTES = 15
/** Default age window for terminated subagents shown by check_subagents. */
export const SUBAGENT_LIST_RECENT_WITHIN_DAYS = 7

const DISPATCH_AGENT_TYPE_ALLOWLIST = [SUBAGENT_AGENT_TYPE_ID] as const

export type DispatchSpec = {
  agentType?: string
  model?: string
  inheritModel?: boolean
  systemPrompt?: string
  instructions: string
  label?: string
}

export type DispatchResult = { subagents: Array<{ subagentId: string; label: string }> }

/** Safe, server-derived snapshot of the parent's effective execution environment. */
export type SubagentParentExecutionContext = {
  version: 1
  squadId: string | null
  environmentToolNames: string[]
}

let cascadeDormantChildBeforeRequestHook: ((parentAgentId: string, childId: string) => Promise<void>) | undefined

export function setCascadeDormantChildBeforeRequestHookForTest(
  hook: ((parentAgentId: string, childId: string) => Promise<void>) | undefined
): void {
  cascadeDormantChildBeforeRequestHook = hook
}

export class Subagent {
  static async dispatch(input: {
    parentAgentId: string
    parentExecutionContext?: SubagentParentExecutionContext
    subagents: DispatchSpec[]
  }): Promise<DispatchResult> {
    const { parentAgentId, parentExecutionContext, subagents } = input
    const { forbidUntrackedDelegation } = await import('../services/workflows/execution')
    await forbidUntrackedDelegation(parentAgentId)
    if (subagents.length === 0) throw new Error('dispatch requires at least one subagent spec')
    for (const spec of subagents) {
      const agentType = spec.agentType ?? SUBAGENT_AGENT_TYPE_ID
      if (!DISPATCH_AGENT_TYPE_ALLOWLIST.includes(agentType as (typeof DISPATCH_AGENT_TYPE_ALLOWLIST)[number])) {
        throw new Error(
          `Unsupported subagent agentType "${agentType}" (allowed: ${DISPATCH_AGENT_TYPE_ALLOWLIST.join(', ')})`
        )
      }
      if (!spec.instructions?.trim()) throw new Error('Each subagent spec requires non-empty instructions')
      if (spec.model !== undefined && spec.inheritModel === true) {
        throw new Error('model and inheritModel=true are mutually exclusive')
      }
    }
    const createdAgents: Agent[] = []
    try {
      // Dedicated connection, NOT the shared pool: this transaction holds the
      // parent row lock while Agent.create and queueExecution acquire pool
      // connections (queueExecution opens a whole nested transaction). On the
      // pool that is hold-and-wait — two concurrent dispatches were enough to
      // wedge a 4-connection pool (observed live as a worker crash loop).
      const created = await withDedicatedDbTransaction(async (tx) => {
        // Serialize against the parent's termination UPDATE. If dispatch wins,
        // termination waits and its central cascade observes every new child; if
        // termination wins, this locked read observes a non-live status and refuses.
        const [parentRow] = await tx.select().from(agents).where(eq(agents.id, parentAgentId)).for('no key update')
        if (!parentRow) throw new Error(`Parent agent ${parentAgentId} not found`)
        if (!isLiveAgentStatus(parentRow.status)) throw new Error(`Parent agent ${parentAgentId} is not live`)
        if (
          parentExecutionContext &&
          (parentExecutionContext.version !== 1 ||
            !Array.isArray(parentExecutionContext.environmentToolNames) ||
            !parentExecutionContext.environmentToolNames.every((name) => typeof name === 'string'))
        ) {
          throw new Error('Invalid parent execution context')
        }
        if (parentExecutionContext && parentExecutionContext.squadId !== parentRow.squadId) {
          throw new Error('Parent execution context squad does not match the locked parent')
        }
        const normalizedParentExecutionContext = parentExecutionContext
          ? {
              version: 1 as const,
              squadId: parentExecutionContext.squadId,
              environmentToolNames: [...new Set(parentExecutionContext.environmentToolNames)].sort(),
            }
          : undefined
        const [{ count }] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(agents)
          .where(and(eq(agents.parentAgentId, parentAgentId), inArray(agents.status, [...LIVE_AGENT_STATUSES])))
        const free = SUBAGENT_MAX_PER_PARENT - count
        if (subagents.length > free) {
          throw new Error(`Subagent cap exceeded: ${free} slots free, requested ${subagents.length}`)
        }
        const parent = new Agent(parentRow)
        const inheritedParentChain = subagents.some((spec) => spec.inheritModel)
          ? await parent.getEffectiveModelSpec()
          : null
        const rows: Array<{ subagentId: string; label: string }> = []
        for (let i = 0; i < subagents.length; i++) {
          const spec = subagents[i]
          const label = spec.label ?? `subagent-${i + 1}`
          const child = await Agent.create({
            agentTypeId: spec.agentType ?? SUBAGENT_AGENT_TYPE_ID,
            parentAgentId,
            squadId: parent.squadId,
            ownerUserId: parent.ownerUserId,
            persist: false,
            modelOverride: spec.inheritModel ? inheritedParentChain : (spec.model ?? null),
            metadata: {
              label,
              purpose: label,
              ...(spec.systemPrompt ? { systemPrompt: spec.systemPrompt } : {}),
              ...(spec.model ? { requestedModel: spec.model } : {}),
              ...(spec.inheritModel ? { inheritModel: true } : {}),
              ...(normalizedParentExecutionContext ? { parentExecutionContext: normalizedParentExecutionContext } : {}),
            },
          })
          createdAgents.push(child)
          await child.queueExecution({ message: spec.instructions })
          rows.push({ subagentId: child.id, label })
        }
        return rows
      })
      await Subagent.reconcileWatchdog(parentAgentId)
      return { subagents: created }
    } catch (error) {
      // Persist the stronger final target before stopping work. The lifecycle
      // request is sweepable even if an external teardown effect fails.
      const cleanup = await Promise.allSettled(
        createdAgents.map((child) =>
          requestAgentLifecycle(child, {
            target: 'terminated',
            metadata: { ...(child.metadata ?? {}), resultStatus: 'stopped', dispatchCompensation: true },
            reason: 'partial-subagent-dispatch',
            stopActive: true,
          })
        )
      )
      cleanup.forEach((result, index) => {
        if (result.status === 'rejected') {
          log.error(`Failed lifecycle cleanup for partial subagent ${createdAgents[index].id}`, result.reason)
        }
      })
      await Subagent.reconcileWatchdog(parentAgentId)
      throw error
    }
  }

  /** List subagent children with correlation/status fields. */
  static async listChildren(
    parentAgentId: string,
    options: { recentWithinDays?: number } = {}
  ): Promise<
    Array<{
      subagentId: string
      label: string
      status: AgentStatus
      lastActivityAt: string | null
      resultStatus: string | null
    }>
  > {
    const recentWithinDays =
      options.recentWithinDays !== undefined &&
      Number.isFinite(options.recentWithinDays) &&
      options.recentWithinDays >= 0
        ? options.recentWithinDays
        : SUBAGENT_LIST_RECENT_WITHIN_DAYS
    const cutoff = new Date(Date.now() - recentWithinDays * 24 * 60 * 60 * 1000)
    const children = await Agent.list({ parentAgentId }, 'recentlyCreated')
    return children
      .filter((child) => child.status !== 'terminated' || child.updatedAt > cutoff)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .map((child) => {
        const metadata = (child.metadata ?? {}) as Record<string, unknown>
        return {
          subagentId: child.id,
          label: typeof metadata.label === 'string' ? metadata.label : child.id,
          status: child.status,
          lastActivityAt: child.updatedAt?.toISOString?.() ?? null,
          resultStatus: typeof metadata.resultStatus === 'string' ? metadata.resultStatus : null,
        }
      })
  }

  /** Idempotently create/update/delete the per-parent watchdog schedule. */
  static async reconcileWatchdog(parentAgentId: string): Promise<void> {
    const { reconcileWatchdog } = await import('../services/scheduling/reconciliation')
    await reconcileWatchdog(parentAgentId)
  }

  /** Wake a dormant child; final termination is irreversible. */
  static async revive(input: { parentAgentId: string; subagentId: string; instructions: string }): Promise<void> {
    const child = await Agent.mustFind(input.subagentId)
    if (child.parentAgentId !== input.parentAgentId) throw new Error('Subagent does not belong to parent')
    if (child.status === 'terminated') throw new Error('Subagent is terminated and cannot be revived')
    if (child.status !== 'dormant') throw new Error('Subagent is already live')
    if (!(await child.wake())) {
      throw new AgentTargetUnavailableError(
        child.id,
        `Subagent ${child.id} is dormant while teardown completes; retry shortly`
      )
    }
    await db
      .update(agents)
      .set({
        metadata: sql`(COALESCE(${agents.metadata}, '{}'::jsonb) - 'completionDelivered' - 'completion' - 'status') || ${JSON.stringify({ resultStatus: null })}::jsonb`,
        updatedAt: new Date(),
      })
      .where(and(eq(agents.id, child.id), inArray(agents.status, [...LIVE_AGENT_STATUSES])))
    await child.reload()
    await Subagent.reconcileWatchdog(input.parentAgentId)
  }

  /** Stop a subagent, optionally notifying its parent with a stopped result. */
  static async stop(input: {
    parentAgentId: string
    subagentId: string
    reason?: string
  }): Promise<{ status: 'stopped' | 'already-terminated' }> {
    const child = await Agent.mustFind(input.subagentId)
    if (child.parentAgentId !== input.parentAgentId) throw new Error('Subagent does not belong to parent')
    if (!isLiveAgentStatus(child.status)) return { status: 'already-terminated' }

    await requestAgentLifecycle(child, {
      target: 'dormant',
      metadata: { resultStatus: 'stopped' },
      reason: input.reason ?? 'Subagent stopped',
      stopActive: true,
    })
    await child.reload()
    try {
      const parent = await Agent.find(input.parentAgentId)
      if (parent && isLiveAgentStatus(parent.status)) {
        await InboxMessage.send({
          recipientType: 'agent',
          recipientId: input.parentAgentId,
          content: input.reason ? `Subagent stopped: ${input.reason}` : 'Subagent stopped',
          senderType: 'agent',
          senderId: child.id,
          deliveryMode: 'steer',
          metadata: {
            parentAgentId: input.parentAgentId,
            subagentId: child.id,
            label: (child.metadata as Record<string, unknown> | null)?.label,
            resultStatus: 'stopped',
          },
        })
      }
    } finally {
      await Subagent.reconcileWatchdog(input.parentAgentId)
    }
    return { status: 'stopped' }
  }

  static async cascadeDormantChildren(
    parentAgentId: string,
    _dormantAt: Date,
    parentFence?: ParentDormancyFence
  ): Promise<boolean> {
    const children = await Agent.list({ parentAgentId })
    const failures: unknown[] = []
    let deferred = false
    for (const child of children) {
      if (child.status === 'terminated') continue
      try {
        await cascadeDormantChildBeforeRequestHook?.(parentAgentId, child.id)
        const { completeDormancyIfPending } = await import('../services/agent/lifecycle')
        if (isLiveAgentStatus(child.status)) {
          if (
            !(await requestAgentLifecycle(child, {
              target: 'dormant',
              metadata: { resultStatus: 'stopped' },
              reason: 'Parent became dormant',
              stopActive: true,
              expectedResourceGeneration: (child.metadata as Record<string, unknown> | null)?.resourceGeneration as
                | string
                | undefined,
              parentFence,
            }))
          ) {
            if (parentFence) {
              const parent = await Agent.find(parentFence.parentAgentId)
              const metadata = parent?.metadata as Record<string, unknown> | null
              if (
                parent?.status !== 'dormant' ||
                metadata?.dormancyCompletionPending !== true ||
                metadata.dormancyCompletionId !== parentFence.episodeId ||
                metadata.dormancyCompletionClaimId !== parentFence.claimId ||
                metadata.resourceGeneration !== parentFence.resourceGeneration
              ) {
                return false
              }
            }
            deferred = true
          }
        } else if (!(await completeDormancyIfPending(child.id, { timeoutMs: 0 }))) {
          deferred = true
        }
      } catch (error) {
        log.error(`Failed to make subagent ${child.id} dormant`, error)
        failures.push(error)
      }
    }
    await Subagent.reconcileWatchdog(parentAgentId)
    if (failures.length) throw new AggregateError(failures, `Failed to make ${failures.length} subagent(s) dormant`)
    return !deferred
  }

  static async cascadeStopChildren(parentAgentId: string, _reason = 'Parent terminated'): Promise<void> {
    const { finalizeDescendants } = await import('../services/agent/lifecycle')
    if (!(await finalizeDescendants(parentAgentId))) {
      throw new Error(`Failed to finalize one or more descendants of agent ${parentAgentId}`)
    }
    await Subagent.reconcileWatchdog(parentAgentId)
  }

  static async countLive(parentAgentId: string): Promise<number> {
    const rows = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.parentAgentId, parentAgentId), inArray(agents.status, [...LIVE_AGENT_STATUSES])))
    return rows.length
  }
}
