import { Agent } from '../../entities/Agent'
import { isAutoDormancyExempt } from './crew-dormancy'
import {
  claimAgentLifecycleSweepCandidates,
  dormantAtEpochMsSql,
  REMOVE_NOW_DORMANT_AT_KEY,
  REMOVE_NOW_FAILED_DORMANT_AT_KEY,
  REMOVE_NOW_FAILED_REASON_KEY,
  REMOVE_NOW_FAILURES_KEY,
  REMOVE_NOW_LAST_ERROR_KEY,
  removeNowRequestedSql,
} from '../../entities/agent-queries'
import { eventEmitter } from '../../lib/infra/event-emitter'
import { createLogger } from '../../lib/infra/logger'
import { monitorSupervisor } from '../monitors'
import { getSettingsStore } from '../settings'
import type { SandboxStopOutcome } from '../sandbox/types'
import { and, eq, inArray, isNotNull, notInArray, sql } from 'drizzle-orm'
import { STORAGE_DORMANCY_EXEMPT_AGENT_TYPES, type RemoveDormantAgentsResult } from '@ficus/shared'
import { agents, db } from '../../db'
import { publicErrorMessage } from '../../db/errors'

const log = createLogger('agent-cleanup')

type CleanupDeps = {
  loadAgent?: (id: string) => Promise<Pick<Agent, 'id' | 'status' | 'agentTypeId' | 'tryTerminate'> | null>
  stopAndArchive?: (agentId: string) => Promise<void>
}

/**
 * Terminate one agent for a work-stream transition, or — if it already
 * terminated mid-stream — retry its sandbox reclamation. Termination-time
 * reclamation is best-effort and can be missed (e.g. a transient k8s failure),
 * and `tryTerminate` refuses already-terminated agents, so without this retry
 * their pods would linger until the idle reaper collects them.
 * Errors are intentionally swallowed so cleanup never breaks work-stream transitions.
 */
async function terminateOrReclaimAgent(agentId: string, deps: CleanupDeps): Promise<void> {
  const loadAgent = deps.loadAgent ?? ((id: string) => Agent.find(id, { eager: false }))
  const stopAndArchive = deps.stopAndArchive ?? stopAndArchivePersonalSandbox
  try {
    const agent = await loadAgent(agentId)
    if (!agent) return
    if (isAutoDormancyExempt(agent.agentTypeId)) {
      // Managers own the squad and consultants are ephemeral managers: a
      // stream going terminal says nothing about whether either is still
      // needed. `canTerminate` deliberately still allows an operator to
      // unspawn them by hand — only this automatic path abstains, which is
      // also what markCrewForDormancy's durable request does.
      return
    }
    if (agent.status === 'terminated') {
      await stopAndArchive(agentId)
    } else if (agent.status !== 'dormant') {
      // The user-facing transition stops compute but retains recoverable storage.
      await agent.tryTerminate()
    }
  } catch (error) {
    // Was a bare `catch {}`. A swallowed failure here used to be permanent:
    // this call was the only teardown trigger, so a miss left an agent idle
    // forever with no trace. The durable request in markCrewForDormancy now
    // makes the sweep retry it, but the failure is still worth seeing.
    log.warn(`Deferred teardown for agent ${agentId} to the lifecycle sweep`, error)
  }
}

/**
 * Check all agents bound to a terminal work stream for cleanup.
 */
export async function cleanupAgentsForTerminalWorkStream(agentIds: string[], deps: CleanupDeps = {}): Promise<void> {
  for (const agentId of agentIds) {
    await terminateOrReclaimAgent(agentId, deps)
  }
}

/**
 * Check whether a removed work-stream agent should be terminated (or, if
 * already terminated, whether its sandbox still needs reclaiming).
 */
export async function cleanupRemovedAgent(agentId: string, deps: CleanupDeps = {}): Promise<void> {
  await terminateOrReclaimAgent(agentId, deps)
}

// Backwards-compatible names used by existing tests/imports.
export const handleWorkStreamTerminal = cleanupAgentsForTerminalWorkStream
export const handleAgentRemoved = cleanupRemovedAgent

/**
 * On final termination, reclaim an agent's PERSONAL sandbox and archive its
 * /private data for the independent archive-retention window. Scoped to personal boxes
 * (sandboxId === agent_<id>), which excludes subagents (parent's box) and shared
 * system-manager boxes. Best-effort; never throws.
 */
type ReclaimManager = {
  stopSandbox?: (sandboxId: string, options?: { lifecycleGeneration?: string | null }) => Promise<SandboxStopOutcome>
  removeSandbox: (sandboxId: string) => Promise<void>
  reclaimSandboxStorage?: (sandboxId: string) => Promise<void>
}

type ReclaimDeps = {
  getManager?: () => ReclaimManager
  archive?: (sandboxId: string, when: Date) => string | null
  warn?: (message: string, error: unknown) => void
}

/** Idempotent personal-box cleanup. False means durable retry is still required. */
export async function reclaimPersonalSandbox(
  agentId: string,
  sandboxId: string,
  deps: ReclaimDeps = {}
): Promise<boolean> {
  if (sandboxId !== `agent_${agentId}`) return true

  const warn = deps.warn ?? ((message: string, error: unknown) => log.warn(message, error))
  try {
    const manager = deps.getManager ? deps.getManager() : (await import('../sandbox')).getSandboxManager()
    let complete = true
    let removed = false
    try {
      await manager.removeSandbox(sandboxId)
      removed = true
    } catch (error) {
      complete = false
      warn(`Failed to remove personal sandbox ${sandboxId} for agent ${agentId}`, error)
    }

    if (removed && manager.reclaimSandboxStorage) {
      try {
        await manager.reclaimSandboxStorage(sandboxId)
      } catch (error) {
        complete = false
        warn(`Failed to reclaim sandbox storage ${sandboxId} for agent ${agentId}`, error)
      }
    }

    // ONLY archive once the box is actually gone.
    //
    // Archiving is a rename of HOME_DIR/private/<sandboxId> out to the archive
    // root. That is only meaningful when nothing is still writing to it: a
    // sandbox that failed to remove is still LIVE, and recreates its private
    // dir immediately — so the next sweep archives it again, and the next, and
    // the next.
    //
    // That is not hypothetical. A tenant's `removeSandbox` began timing out
    // ("ssh command timed out after 30000ms"), the lifecycle sweep retried
    // every 60s as designed, and each retry archived a freshly-recreated 159MB
    // directory. Three agents produced 728 archive copies and 67GB in five and
    // a half hours, filling the box's disk to 100% — and because archives carry
    // their own multi-day retention, the disk would have stayed full for a week
    // after the loop stopped.
    //
    // Skipping here is safe and loses nothing: `complete` is already false, so
    // the caller retries, and the archive happens on the pass where removal
    // finally succeeds. The failure mode this replaces is unbounded; the one it
    // introduces is "archived slightly later".
    if (removed) {
      try {
        const archive = deps.archive ?? (await import('../sandbox/private-archive')).archiveAgentPrivateDir
        archive(sandboxId, new Date())
      } catch (error) {
        warn(`Failed to archive private data for sandbox ${sandboxId} and agent ${agentId}`, error)
        return false
      }
    }
    return complete
  } catch (error) {
    warn(`Failed to reclaim personal sandbox ${sandboxId} for agent ${agentId}`, error)
    return false
  }
}

/** Reap a dormant agent's compute while retaining its private storage. */
export async function stopPersonalSandbox(
  agentId: string,
  deps: {
    lifecycleGeneration?: string | null
    loadAgent?: (
      id: string
    ) => Promise<{ status: Agent['status']; getPersonalSandboxIdForCleanup: () => string | null } | null>
    getManager?: () => ReclaimManager
    warn?: (message: string, error: unknown) => void
  } = {}
): Promise<SandboxStopOutcome | false> {
  try {
    const agent = await (deps.loadAgent ?? ((id: string) => Agent.find(id, { eager: false })))(agentId)
    if (!agent || agent.status !== 'dormant') return { kind: 'not-found' }
    const sandboxId = agent.getPersonalSandboxIdForCleanup()
    if (!sandboxId || sandboxId !== `agent_${agentId}`) return { kind: 'not-found' }
    const manager = deps.getManager ? deps.getManager() : (await import('../sandbox')).getSandboxManager()
    if (manager.stopSandbox) {
      return await manager.stopSandbox(
        sandboxId,
        deps.lifecycleGeneration !== undefined ? { lifecycleGeneration: deps.lifecycleGeneration } : undefined
      )
    }
    await manager.removeSandbox(sandboxId)
    return { kind: 'stopped' }
  } catch (error) {
    ;(deps.warn ?? ((message: string, cause: unknown) => log.warn(message, cause)))(
      `Failed to stop personal sandbox for dormant agent ${agentId}`,
      error
    )
    return false
  }
}

type DormantFinalizeDeps = {
  completePending?: (agentId: string) => Promise<boolean>
  finalize?: (agent: Agent, expectedDormantAt?: Date) => Promise<void>
}

/**
 * Finalize one dormant agent: settle any pending dormancy completion, then
 * terminate it (archiving /private and reclaiming its personal box). `cutoff`
 * (epoch ms) refuses agents that became dormant after it, unless an operator
 * asked to remove this exact dormancy episode now; null finalizes now.
 */
async function finalizeDormantAgent(
  agentId: string,
  cutoff: number | null,
  deps: DormantFinalizeDeps
): Promise<'finalized' | 'completion-pending' | 'not-finalized' | 'changed'> {
  const completed = await (
    deps.completePending ??
    ((id) =>
      import('../agent/lifecycle').then(({ completeDormancyIfPending }) =>
        completeDormancyIfPending(id, { timeoutMs: 0 })
      ))
  )(agentId)
  if (!completed) return 'completion-pending'

  // The sweep list and completion preflight may both be stale after a wake.
  const agent = await Agent.find(agentId, { eager: false })
  if (agent?.status !== 'dormant' || !agent.dormantAt) return 'changed'
  const removeNow =
    (agent.metadata as Record<string, unknown> | null)?.[REMOVE_NOW_DORMANT_AT_KEY] === agent.dormantAt.getTime()
  if (cutoff !== null && agent.dormantAt.getTime() > cutoff && !removeNow) return 'changed'
  await (
    deps.finalize ??
    ((candidate, expectedDormantAt) =>
      import('../agent/lifecycle').then(({ terminate }) => terminate(candidate, { expectedDormantAt })))
  )(agent, agent.dormantAt)
  return (await Agent.find(agent.id, { eager: false }))?.status === 'terminated' ? 'finalized' : 'not-finalized'
}

export async function runDormantAgentSweep(
  deps: {
    now?: Date
    getRetentionDays?: () => number
    listDormant?: () => Promise<Agent[]>
    maxCandidates?: number
  } & DormantFinalizeDeps = {}
): Promise<number> {
  const now = deps.now ?? new Date()
  const configured = deps.getRetentionDays?.() ?? Number(getSettingsStore().getTyped('AGENT_DORMANT_RETENTION_DAYS'))
  const retentionDays = Number.isFinite(configured) && configured > 0 ? configured : 7
  const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1000
  const maxCandidates = Math.max(1, deps.maxCandidates ?? 25)
  const dormant = deps.listDormant
    ? (await deps.listDormant()).slice(0, maxCandidates)
    : (
        await Promise.all(
          (
            await claimAgentLifecycleSweepCandidates({
              kind: 'dormant-retention',
              maxCandidates,
              dormantCutoff: new Date(cutoff),
            })
          ).map((id) => Agent.find(id, { eager: false }))
        )
      ).filter((agent): agent is Agent => agent !== null)
  let finalized = 0
  for (const listedAgent of dormant) {
    try {
      const outcome = await finalizeDormantAgent(listedAgent.id, cutoff, deps)
      if (outcome === 'finalized') finalized++
      else if (outcome === 'completion-pending')
        await recordRemoveNowFailure(listedAgent.id, 'Stopping the agent has not finished yet.')
      else if (outcome === 'not-finalized')
        await recordRemoveNowFailure(listedAgent.id, 'The agent could not be removed.')
    } catch (error) {
      log.warn(`Dormant retention cleanup remains pending for agent ${listedAgent.id}`, error)
      await recordRemoveNowFailure(listedAgent.id, publicErrorMessage(error)).catch(() => {})
    }
  }
  return finalized
}

/** Failed attempts allowed for an operator "remove now" before it is given up and reported. */
export const REMOVE_NOW_MAX_ATTEMPTS = 5

/**
 * Count a failed attempt against an operator "remove now" request (only while
 * the request still matches the agent's dormancy episode). After
 * REMOVE_NOW_MAX_ATTEMPTS the mark is cleared so the agent stops showing as
 * Removing…, and the last reason is kept for the storage view. Ordinary
 * retention removal is unaffected and keeps retrying.
 */
async function recordRemoveNowFailure(agentId: string, reason: string): Promise<void> {
  const attempts = sql`(COALESCE((${agents.metadata}->>${REMOVE_NOW_FAILURES_KEY})::int, 0) + 1)`
  const [row] = await db
    .update(agents)
    .set({
      metadata: sql`CASE WHEN ${attempts} >= ${REMOVE_NOW_MAX_ATTEMPTS}
        THEN (COALESCE(${agents.metadata}, '{}'::jsonb) - ${REMOVE_NOW_DORMANT_AT_KEY}::text - ${REMOVE_NOW_FAILURES_KEY}::text - ${REMOVE_NOW_LAST_ERROR_KEY}::text)
          || jsonb_build_object(${REMOVE_NOW_FAILED_REASON_KEY}::text, ${reason}::text, ${REMOVE_NOW_FAILED_DORMANT_AT_KEY}::text, ${dormantAtEpochMsSql})
        ELSE COALESCE(${agents.metadata}, '{}'::jsonb)
          || jsonb_build_object(${REMOVE_NOW_FAILURES_KEY}::text, ${attempts}, ${REMOVE_NOW_LAST_ERROR_KEY}::text, ${reason}::text)
        END`,
      updatedAt: new Date(),
    })
    .where(and(eq(agents.id, agentId), eq(agents.status, 'dormant'), removeNowRequestedSql))
    .returning({ metadata: agents.metadata })
  if (row && (row.metadata as Record<string, unknown> | null)?.[REMOVE_NOW_FAILED_REASON_KEY] !== undefined)
    log.warn(`Gave up removing dormant agent ${agentId} now after ${REMOVE_NOW_MAX_ATTEMPTS} attempts: ${reason}`)
}

/**
 * Operator "remove now": mark dormant agents so the next dormant-retention
 * sweep ticks finalize them (archive and remove their homes) without waiting
 * for AGENT_DORMANT_RETENTION_DAYS. Nothing slow happens here; the sweep stays
 * bounded per tick. Irreversible once the sweep runs. Live agents and the
 * types the storage view never offers are refused.
 */
export async function requestDormantRemoval(agentIds: string[]): Promise<RemoveDormantAgentsResult> {
  const ids = [...new Set(agentIds)]
  if (!ids.length) return { accepted: [], skipped: [] }
  const marked = await db
    .update(agents)
    .set({
      metadata: sql`(COALESCE(${agents.metadata}, '{}'::jsonb) - ${REMOVE_NOW_FAILURES_KEY}::text - ${REMOVE_NOW_LAST_ERROR_KEY}::text - ${REMOVE_NOW_FAILED_REASON_KEY}::text - ${REMOVE_NOW_FAILED_DORMANT_AT_KEY}::text) || jsonb_build_object(${REMOVE_NOW_DORMANT_AT_KEY}::text, ${dormantAtEpochMsSql})`,
      updatedAt: new Date(),
    })
    .where(
      and(
        inArray(agents.id, ids),
        eq(agents.status, 'dormant'),
        isNotNull(agents.dormantAt),
        notInArray(agents.agentTypeId, [...STORAGE_DORMANCY_EXEMPT_AGENT_TYPES])
      )
    )
    .returning({ id: agents.id })
  const accepted = new Set(marked.map((row) => row.id))
  const others = ids.filter((id) => !accepted.has(id))
  const rows = others.length
    ? await db
        .select({ id: agents.id, status: agents.status, agentTypeId: agents.agentTypeId })
        .from(agents)
        .where(inArray(agents.id, others))
    : []
  const byId = new Map(rows.map((row) => [row.id, row]))
  const result: RemoveDormantAgentsResult = { accepted: ids.filter((id) => accepted.has(id)), skipped: [] }
  for (const id of others) {
    const row = byId.get(id)
    result.skipped.push({
      id,
      reason: !row
        ? 'Agent not found.'
        : STORAGE_DORMANCY_EXEMPT_AGENT_TYPES.includes(row.agentTypeId)
          ? `${row.agentTypeId} agents are not removed from here.`
          : 'Only dormant agents can be removed now.',
    })
  }
  if (result.accepted.length)
    log.info(`Dormant agents queued for removal by operator request: ${result.accepted.join(', ')}`)
  return result
}

export async function stopAndArchivePersonalSandbox(
  agentId: string,
  deps: ReclaimDeps & {
    loadAgent?: (id: string) => Promise<{ getPersonalSandboxIdForCleanup: () => string | null } | null>
  } = {}
): Promise<boolean> {
  try {
    const loadAgent = deps.loadAgent ?? ((id: string) => Agent.find(id, { eager: false }))
    const agent = await loadAgent(agentId)
    if (!agent) return true
    const sandboxId = agent.getPersonalSandboxIdForCleanup()
    if (!sandboxId) return true
    return reclaimPersonalSandbox(agentId, sandboxId, deps)
  } catch (error) {
    log.warn(`Failed to resolve personal sandbox for agent ${agentId}`, error)
    return false
  }
}

export async function completeFinalAgentCleanup(
  agentId: string,
  cleanup: (id: string) => Promise<boolean | void> = stopAndArchivePersonalSandbox,
  workBudget?: { remaining: number },
  progress?: { madeProgress: boolean }
): Promise<boolean> {
  const { completeFinalization } = await import('../agent/lifecycle')
  return completeFinalization(agentId, { finalCleanup: cleanup, workBudget, progress })
}

export async function runFinalAgentCleanupSweep(
  deps: {
    listTerminated?: () => Promise<Agent[]>
    cleanup?: (id: string) => Promise<boolean | void>
    maxCandidates?: number
    maxWorkItems?: number
  } = {}
): Promise<number> {
  const maxWorkItems = Math.max(1, deps.maxWorkItems ?? 25)
  const maxCandidates = Math.min(Math.max(1, deps.maxCandidates ?? 25), maxWorkItems)
  const terminated = deps.listTerminated
    ? (await deps.listTerminated()).slice(0, maxCandidates)
    : (
        await Promise.all(
          (
            await claimAgentLifecycleSweepCandidates({
              kind: 'final-cleanup',
              maxCandidates,
            })
          ).map((id) => Agent.find(id, { eager: false }))
        )
      ).filter((agent): agent is Agent => agent !== null)
  let completed = 0
  let sharedRemaining = maxWorkItems
  let remaining = terminated.filter(
    (agent) => (agent.metadata as Record<string, unknown> | null)?.finalCleanupPending === true
  )
  // One credit per root per round. Successful durable progress earns another
  // round; a busy/failed root is dropped until the next tick, so a poison
  // effect cannot burn the budget on immediate retries.
  while (sharedRemaining > 0 && remaining.length > 0) {
    const nextRound: Agent[] = []
    for (const agent of remaining) {
      if (sharedRemaining <= 0) break
      const quantum = { remaining: 1 }
      const progress = { madeProgress: false }
      try {
        if (
          await completeFinalAgentCleanup(agent.id, deps.cleanup ?? stopAndArchivePersonalSandbox, quantum, progress)
        ) {
          completed++
        } else if (progress.madeProgress) {
          nextRound.push(agent)
        }
      } catch (error) {
        log.warn(`Final cleanup retry failed for agent ${agent.id}`, error)
      }
      sharedRemaining -= 1 - quantum.remaining
    }
    remaining = nextRound
  }
  return completed
}

/** Reconcile a lifecycle request after an execution settles, without waiting. */
export async function reconcileSettledAgentLifecycle(agentId?: string): Promise<void> {
  if (!agentId) return
  try {
    const agent = await Agent.find(agentId, { eager: false })
    if (!agent || agent.status === 'terminated' || !agent.pendingDormancyAt) return
    if (await agent.getActiveExecution()) return
    const lifecycle = await import('../agent/lifecycle')
    const target = (agent.metadata as Record<string, unknown> | null)?.pendingLifecycleTarget
    if (target === 'dormant' || target === 'terminated')
      await lifecycle.reconcileAgentLifecycleRequest(agent.id, { dormancyTimeoutMs: 0 })
    else await agent.tryTerminate()
  } catch {
    // Best-effort; the durable request and lifecycle sweeps retry it.
  }
}

/**
 * Register cleanup event handlers as idempotent fallbacks.
 */
export function registerCleanupHandlers(): () => void {
  const unsubscribers = [
    eventEmitter.on('workStream.done', async ({ agentIds }) => {
      await cleanupAgentsForTerminalWorkStream(agentIds ?? [])
    }),
    eventEmitter.on('workStream.canceled', async ({ agentIds }) => {
      await cleanupAgentsForTerminalWorkStream(agentIds ?? [])
    }),
    eventEmitter.on('workStream.agentRemoved', async ({ agentId }) => {
      await cleanupRemovedAgent(agentId)
    }),
    eventEmitter.on('agent.terminated', async ({ agentId }) => {
      await monitorSupervisor.stopAllForAgent(agentId, { notifyAgent: false }).catch(() => {})
      // Belt and braces for the 2026-09-04 dead-fleet incident: settle the
      // agent's surviving non-terminal executions terminally so fleet demand
      // stops counting them. Best-effort like its siblings — the startup sweep
      // (settleOrphanedExecutionsOnce) retries anything missed.
      const { settleExecutionsForRemovedAgent } = await import('../execution/orphan-settlement')
      await settleExecutionsForRemovedAgent(agentId).catch((error) => {
        log.warn(`Execution settlement after termination remains pending for agent ${agentId}`, error)
      })
      const agent = await Agent.find(agentId, { eager: false })
      if ((agent?.metadata as Record<string, unknown> | null)?.finalCleanupPending === true) {
        await completeFinalAgentCleanup(agentId)
      }
    }),
    // Graceful dormancy after the current turn, without holding the event path
    // for a completion claim another process owns.
    eventEmitter.on('execution.completed', async ({ agentId }) => reconcileSettledAgentLifecycle(agentId)),
    eventEmitter.on('execution.failed', async ({ agentId }) => reconcileSettledAgentLifecycle(agentId)),
    eventEmitter.on('execution.stopped', async ({ agentId }) => reconcileSettledAgentLifecycle(agentId)),
  ]
  return () => unsubscribers.forEach((unsubscribe) => unsubscribe())
}
