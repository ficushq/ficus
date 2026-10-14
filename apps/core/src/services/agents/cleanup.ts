import { Agent } from '../../entities/Agent'
import { isAutoDormancyExempt } from './crew-dormancy'
import { claimAgentLifecycleSweepCandidates } from '../../entities/agent-queries'
import { eventEmitter } from '../../lib/infra/event-emitter'
import { createLogger } from '../../lib/infra/logger'
import { monitorSupervisor } from '../monitors'
import { getSettingsStore } from '../settings'
import type { SandboxStopOutcome } from '../sandbox/types'
import type { RemoveDormantAgentsResult } from '@ficus/shared'
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
 * (epoch ms) refuses agents that became dormant after it; null finalizes now.
 */
async function finalizeDormantAgent(
  agentId: string,
  cutoff: number | null,
  deps: DormantFinalizeDeps
): Promise<'finalized' | 'pending' | 'changed'> {
  const completed = await (
    deps.completePending ??
    ((id) =>
      import('../agent/lifecycle').then(({ completeDormancyIfPending }) =>
        completeDormancyIfPending(id, { timeoutMs: 0 })
      ))
  )(agentId)
  if (!completed) return 'pending'

  // The sweep list and completion preflight may both be stale after a wake.
  const agent = await Agent.find(agentId, { eager: false })
  if (agent?.status !== 'dormant' || !agent.dormantAt || (cutoff !== null && agent.dormantAt.getTime() > cutoff))
    return 'changed'
  await (
    deps.finalize ??
    ((candidate, expectedDormantAt) =>
      import('../agent/lifecycle').then(({ terminate }) => terminate(candidate, { expectedDormantAt })))
  )(agent, agent.dormantAt)
  return (await Agent.find(agent.id, { eager: false }))?.status === 'terminated' ? 'finalized' : 'pending'
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
      if ((await finalizeDormantAgent(listedAgent.id, cutoff, deps)) === 'finalized') finalized++
    } catch (error) {
      log.warn(`Dormant retention cleanup remains pending for agent ${listedAgent.id}`, error)
    }
  }
  return finalized
}

/**
 * Operator "remove now": the dormant-retention finalization, without waiting
 * for AGENT_DORMANT_RETENTION_DAYS. Irreversible — the agent's home is
 * archived and removed and it can no longer be woken. Live agents are refused.
 */
export async function removeDormantAgentsNow(
  agentIds: string[],
  deps: DormantFinalizeDeps = {}
): Promise<RemoveDormantAgentsResult> {
  const result: RemoveDormantAgentsResult = { removed: [], pending: [], skipped: [] }
  for (const id of new Set(agentIds)) {
    try {
      const agent = await Agent.find(id, { eager: false })
      if (!agent) {
        result.skipped.push({ id, reason: 'Agent not found.' })
        continue
      }
      if (agent.status !== 'dormant') {
        result.skipped.push({ id, reason: 'Only dormant agents can be removed now.' })
        continue
      }
      const outcome = await finalizeDormantAgent(id, null, deps)
      if (outcome === 'finalized') {
        result.removed.push(id)
        log.info(`Removed dormant agent ${id} before its retention period ended (operator request)`)
      } else if (outcome === 'pending') result.pending.push(id)
      else result.skipped.push({ id, reason: 'The agent changed state and was not removed.' })
    } catch (error) {
      log.warn(`Removing dormant agent ${id} failed`, error)
      result.skipped.push({ id, reason: publicErrorMessage(error) })
    }
  }
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
