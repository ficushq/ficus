/**
 * Agent lifecycle transitions — terminate/delete guards, queue clearing,
 * compaction and reset choreography. Functions take the live Agent entity;
 * the entity keeps thin delegates.
 */

import { randomUUID } from 'node:crypto'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { isLiveAgentStatus, LIVE_AGENT_STATUSES } from '@ficus/shared'
import { ACTIVE_EXECUTION_STATUSES } from '../execution/status'
import { agents, agentTokens, db, executions } from '../../db'
import { acquireAgentQueueLock } from '../execution/agent-admission'
import type { DbTransaction } from '../machines/queries'
import { eventEmitter } from '../../lib/infra/event-emitter'
import { notify } from '../../lib/infra/local-events'
import { createLogger } from '../../lib/infra/logger'
import type { Agent } from '../../entities/Agent'
import {
  claimAgentLifecycleSweepCandidates,
  claimAgentLifecycleSweepCandidatesForTest,
  findAgentLifecycleState,
} from '../../entities/agent-queries'

const log = createLogger('agent')
const LIFECYCLE_COMPLETION_CLAIM_LEASE_MS = 5 * 60 * 1000

/** Millisecond-stable UTC wall timestamp for timestamp-without-zone audit columns. */
export const agentLifecycleDbTimestampSql = sql`date_trunc('milliseconds', clock_timestamp()) AT TIME ZONE 'UTC'`

type LifecycleTeardownClaimDecision<TClaim> =
  | { kind: 'claimed'; claim: TClaim }
  | { kind: 'complete' }
  | { kind: 'busy' }

/** Shared short-claim / external-effects / conditional-settle lifecycle shape. */
async function runLifecycleEpisodeTeardown<TClaim>(input: {
  claim: () => Promise<LifecycleTeardownClaimDecision<TClaim>>
  effects: (claim: TClaim) => Promise<boolean>
  settle: (claim: TClaim) => Promise<boolean>
  release: (claim: TClaim) => Promise<void>
}): Promise<boolean> {
  const decision = await input.claim()
  if (decision.kind === 'complete') return true
  if (decision.kind === 'busy') return false
  let settled = false
  try {
    if (!(await input.effects(decision.claim))) return false
    settled = await input.settle(decision.claim)
    return settled
  } finally {
    if (!settled) await input.release(decision.claim)
  }
}

let completeWakeBeforeClearHook: (() => Promise<void>) | undefined
let finalizationBeforeCasHook: (() => Promise<void>) | undefined
let makeDormantBeforeExecutionLockHook: (() => Promise<void>) | undefined
export function setMakeDormantBeforeExecutionLockHookForTest(hook: (() => Promise<void>) | undefined): void {
  makeDormantBeforeExecutionLockHook = hook
}
let finalizationEffectHook:
  | ((stage: 'tokens' | 'descendants' | 'questions' | 'schedules' | 'storage') => Promise<void>)
  | undefined
export function setFinalizationBeforeCasHookForTest(hook: (() => Promise<void>) | undefined): void {
  finalizationBeforeCasHook = hook
}
export function setFinalizationEffectHookForTest(
  hook: ((stage: 'tokens' | 'descendants' | 'questions' | 'schedules' | 'storage') => Promise<void>) | undefined
): void {
  finalizationEffectHook = hook
}
let dormancyEffectHook:
  | ((stage: 'monitors' | 'tokens' | 'children' | 'schedules' | 'sandbox') => Promise<void>)
  | undefined
export function setDormancyEffectHookForTest(
  hook: ((stage: 'monitors' | 'tokens' | 'children' | 'schedules' | 'sandbox') => Promise<void>) | undefined
): void {
  dormancyEffectHook = hook
}
export function setCompleteWakeBeforeClearHookForTest(hook: (() => Promise<void>) | undefined): void {
  completeWakeBeforeClearHook = hook
}

/**
 * Check if the agent can be safely terminated.
 * @returns True if the agent can be safely deleted, false otherwise.
 */
export async function canTerminate(
  agent: Agent
): Promise<{ canTerminate: false; reason: string } | { canTerminate: true }> {
  if (agent.status === 'terminated') {
    return { canTerminate: false, reason: 'Agent is already terminated.' }
  }
  if (agent.status === 'dormant') {
    return { canTerminate: false, reason: 'Agent is already dormant.' }
  }
  if (agent.status === 'compacting' || agent.status === 'resetting') {
    return { canTerminate: false, reason: `Agent is ${agent.status}.` }
  }

  if (agent.agentTypeId === 'manager') {
    return { canTerminate: false, reason: 'Cannot terminate manager agents.' }
  }

  if (agent.persist) {
    return { canTerminate: false, reason: 'Cannot terminate persistent agent. Set persist=false first.' }
  }

  // Lazy import: WorkStream value-imports Agent (it constructs live agents for
  // getActiveExecution), and Agent value-imports this module — a top-level
  // import here would close an eval-time module cycle Agent → lifecycle →
  // WorkStream → Agent.
  const { WorkStream } = await import('../../entities/WorkStream')
  const workStreams = await WorkStream.findByAgent(agent.id)
  const allTerminal = workStreams.every((ws) => ws.status === 'done' || ws.status === 'canceled')
  if (!allTerminal) {
    return { canTerminate: false, reason: 'Agent has active work streams.' }
  }

  return { canTerminate: true }
}

/**
 * Apply the user-facing terminate action by making the agent dormant.
 * @throws When the agent is ineligible for dormancy.
 */
export async function tryTerminate(agent: Agent): Promise<void> {
  const check = await canTerminate(agent)
  if (!check.canTerminate) {
    throw new Error(`Agent ${agent.id} cannot be terminated: ${check.reason}`)
  }
  await makeDormant(agent)
}

export type ParentDormancyFence = {
  parentAgentId: string
  episodeId: string
  claimId: string
  resourceGeneration: string
}

/** Live -> dormant, serialized with every execution producer and pickup. */
export async function makeDormant(
  agent: Agent,
  options: {
    metadata?: Record<string, unknown>
    expectedResourceGeneration?: string
    parentFence?: ParentDormancyFence
  } = {}
): Promise<boolean> {
  const decision = await db.transaction(async (tx) => {
    await acquireAgentQueueLock(tx, agent.id)
    if (options.parentFence) {
      const [parent] = await tx
        .select({ status: agents.status, metadata: agents.metadata })
        .from(agents)
        .where(eq(agents.id, options.parentFence.parentAgentId))
        .for('share')
      const parentMetadata = parent?.metadata as Record<string, unknown> | null
      if (
        parent?.status !== 'dormant' ||
        parentMetadata?.dormancyCompletionPending !== true ||
        parentMetadata.dormancyCompletionId !== options.parentFence.episodeId ||
        parentMetadata.dormancyCompletionClaimId !== options.parentFence.claimId ||
        parentMetadata.resourceGeneration !== options.parentFence.resourceGeneration
      ) {
        return { kind: 'superseded' as const }
      }
    }
    // Settlement locks execution before agent. Match that order while the
    // advisory lock keeps producers/pickup from overlapping this path.
    await makeDormantBeforeExecutionLockHook?.()
    const [active] = await tx
      .select({ id: executions.id, status: executions.status })
      .from(executions)
      .where(and(eq(executions.agentId, agent.id), inArray(executions.status, [...ACTIVE_EXECUTION_STATUSES])))
      .limit(1)
      .for('update')

    const [locked] = await tx
      .select({
        status: agents.status,
        pendingDormancyAt: agents.pendingDormancyAt,
        metadata: agents.metadata,
      })
      .from(agents)
      .where(eq(agents.id, agent.id))
      .for('update')
    if (!locked) throw new Error(`Agent ${agent.id} not found`)
    const effectiveMetadata = options.metadata ? { ...options.metadata } : undefined
    const lockedMetadata = locked.metadata as Record<string, unknown> | null
    if (
      effectiveMetadata &&
      lockedMetadata?.pendingLifecycleTarget === 'terminated' &&
      effectiveMetadata.pendingLifecycleTarget !== 'terminated'
    ) {
      effectiveMetadata.pendingLifecycleTarget = 'terminated'
      if (typeof lockedMetadata.pendingLifecycleRequestId === 'string') {
        effectiveMetadata.pendingLifecycleRequestId = lockedMetadata.pendingLifecycleRequestId
      }
    }
    if (
      options.expectedResourceGeneration &&
      (locked.metadata as Record<string, unknown> | null)?.resourceGeneration !== options.expectedResourceGeneration
    ) {
      return { kind: 'superseded' as const }
    }
    if (locked.status === 'terminated') return { kind: 'already' as const, dormancyCompletionId: null }
    if (locked.status === 'dormant') {
      const id = lockedMetadata?.dormancyCompletionId
      if (effectiveMetadata && Object.keys(effectiveMetadata).length > 0) {
        await tx
          .update(agents)
          .set({
            metadata: sql`COALESCE(${agents.metadata}, '{}'::jsonb) || ${JSON.stringify(effectiveMetadata)}::jsonb`,
            updatedAt: new Date(),
          })
          .where(eq(agents.id, agent.id))
      }
      return { kind: 'already' as const, dormancyCompletionId: typeof id === 'string' ? id : null }
    }
    if (locked.status === 'compacting' || locked.status === 'resetting') {
      throw new Error(`Agent ${agent.id} cannot become dormant while ${locked.status}`)
    }

    if (active) {
      if (!locked.pendingDormancyAt || (effectiveMetadata && Object.keys(effectiveMetadata).length > 0)) {
        await tx
          .update(agents)
          .set({
            pendingDormancyAt: new Date(),
            ...(effectiveMetadata && Object.keys(effectiveMetadata).length > 0
              ? {
                  metadata: sql`COALESCE(${agents.metadata}, '{}'::jsonb) || ${JSON.stringify(effectiveMetadata)}::jsonb`,
                }
              : {}),
            updatedAt: new Date(),
          })
          .where(eq(agents.id, agent.id))
      }
      return { kind: 'active' as const, executionId: active.id, executionStatus: active.status }
    }

    const dormantTokenRows = await tx
      .select({ id: agentTokens.id })
      .from(agentTokens)
      .where(and(eq(agentTokens.agentId, agent.id), isNull(agentTokens.revokedAt)))
      .for('update')
    const dormancyTokenIds = dormantTokenRows.map((row) => row.id)
    const { cleanupAgentSlotsInTransaction } = await import('../slots/store')
    const slotCleanup = await cleanupAgentSlotsInTransaction(tx, agent.id, 'agent_dormant')
    const dormancyCompletionId = randomUUID()
    const existingGeneration = (locked.metadata as Record<string, unknown> | null)?.resourceGeneration
    const resourceGeneration = typeof existingGeneration === 'string' ? existingGeneration : randomUUID()
    const [updated] = await tx
      .update(agents)
      .set({
        status: 'dormant',
        dormantAt: agentLifecycleDbTimestampSql,
        questionData: null,
        pendingDormancyAt: null,
        metadata: sql`COALESCE(${agents.metadata}, '{}'::jsonb) || ${JSON.stringify({ ...(effectiveMetadata ?? {}), resourceGeneration, dormancyResourceGeneration: typeof existingGeneration === 'string' ? existingGeneration : null, dormancyTokenIds, dormancyEpisodeId: dormancyCompletionId, dormancyCompletionPending: true, dormancyCompletionId })}::jsonb`,
        updatedAt: agentLifecycleDbTimestampSql,
      })
      .where(and(eq(agents.id, agent.id), eq(agents.status, locked.status)))
      .returning()
    if (!updated) throw new Error(`Agent ${agent.id} lifecycle changed while becoming dormant`)
    return { kind: 'dormant' as const, row: updated, dormancyCompletionId, slotCleanup }
  })

  // Prompt outbox draining happens only after the granting transaction commits.
  if (decision.kind === 'dormant' && decision.slotCleanup.promoted) {
    if (agent.squadId) eventEmitter.emit('slots.updated', { squadId: agent.squadId })
    const { drainSlotNotificationsSoon } = await import('../slots/store')
    drainSlotNotificationsSoon()
  }

  if (decision.kind === 'superseded') return false
  if (decision.kind === 'already') {
    if (decision.dormancyCompletionId) await completeDormancy(agent.id, decision.dormancyCompletionId)
    return true
  }
  if (decision.kind === 'active') {
    const { Execution } = await import('../../entities/Execution')
    const active = await Execution.find(decision.executionId)
    if (!active) {
      const fresh = await (await import('../../entities/Agent')).Agent.mustFind(agent.id, { eager: false })
      return makeDormant(fresh, options)
    }
    if (decision.executionStatus === 'running' || decision.executionStatus === 'stopping') return true
    await active.requestStopWithSignal()
    const fresh = await (await import('../../entities/Agent')).Agent.mustFind(agent.id, { eager: false })
    if (!(await fresh.getActiveExecution())) return makeDormant(fresh, options)
    return true
  }

  Object.assign(agent, decision.row)
  eventEmitter.emit('agent.updated', { agentId: agent.id, squadId: agent.squadId })
  await completeDormancy(agent.id, decision.dormancyCompletionId)
  return true
}

export type AgentLifecycleTarget = 'dormant' | 'terminated'

export function sanitizeLifecycleMetadataPatch(metadata: Record<string, unknown> = {}): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(metadata).filter(
      ([key]) =>
        key !== 'resourceGeneration' &&
        !key.startsWith('dormancy') &&
        !key.startsWith('finalization') &&
        !key.startsWith('finalCleanup') &&
        !key.startsWith('wakeCompletion') &&
        !key.startsWith('pendingLifecycle')
    )
  )
}

export async function reconcileAgentLifecycleRequest(
  agentId: string,
  options: { dormancyTimeoutMs?: number } = {}
): Promise<boolean> {
  const target = await (await import('../../entities/Agent')).Agent.mustFind(agentId, { eager: false })
  const metadata = (target.metadata ?? {}) as Record<string, unknown>
  const requestTarget = metadata.pendingLifecycleTarget
  const requestId = metadata.pendingLifecycleRequestId
  if ((requestTarget !== 'dormant' && requestTarget !== 'terminated') || typeof requestId !== 'string') return true

  if (isLiveAgentStatus(target.status)) {
    await makeDormant(target)
    await target.reload()
  }
  const active = await target.getActiveExecution()
  if (active) {
    if (metadata.pendingLifecycleStopActive === true) await active.requestStopWithSignal()
    return false
  }
  if (target.status === 'dormant') {
    if (!(await completeDormancyIfPending(target.id, { timeoutMs: options.dormancyTimeoutMs }))) return false
    await target.reload()
  }
  if (requestTarget === 'terminated' && target.status === 'dormant') {
    await terminate(target)
    await target.reload()
  }
  if (
    requestTarget === 'terminated' &&
    target.status === 'terminated' &&
    (target.metadata as Record<string, unknown> | null)?.finalCleanupPending === true
  ) {
    await completeFinalization(target.id)
    await target.reload()
  }

  const currentMetadata = (target.metadata ?? {}) as Record<string, unknown>
  const settled =
    requestTarget === 'dormant'
      ? target.status === 'dormant' && currentMetadata.dormancyCompletionPending !== true
      : target.status === 'terminated' && currentMetadata.finalCleanupPending !== true
  if (!settled) return false
  const [cleared] = await db
    .update(agents)
    .set({
      metadata: sql`COALESCE(${agents.metadata}, '{}'::jsonb) - 'pendingLifecycleTarget' - 'pendingLifecycleRequestId' - 'pendingLifecycleReason' - 'pendingLifecycleStopActive'`,
      pendingDormancyAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(agents.id, agentId),
        sql`${agents.metadata}->>'pendingLifecycleRequestId' = ${requestId}`,
        sql`${agents.metadata}->>'pendingLifecycleTarget' = ${requestTarget}`
      )
    )
    .returning({ id: agents.id })
  return Boolean(cleared)
}

export async function requestAgentLifecycle(
  agent: Agent,
  input: {
    target: AgentLifecycleTarget
    metadata?: Record<string, unknown>
    reason?: string
    stopActive?: boolean
    expectedResourceGeneration?: string
    parentFence?: ParentDormancyFence
  }
): Promise<boolean> {
  await agent.reload()
  const currentMetadata = (agent.metadata ?? {}) as Record<string, unknown>
  const currentTarget = currentMetadata.pendingLifecycleTarget
  const target: AgentLifecycleTarget = currentTarget === 'terminated' ? 'terminated' : input.target
  const requestId = randomUUID()
  const requestMetadata = sanitizeLifecycleMetadataPatch(input.metadata)
  const accepted = await makeDormant(agent, {
    expectedResourceGeneration: input.expectedResourceGeneration,
    parentFence: input.parentFence,
    metadata: {
      ...requestMetadata,
      pendingLifecycleTarget: target,
      pendingLifecycleRequestId: requestId,
      ...(input.reason ? { pendingLifecycleReason: input.reason } : {}),
      ...(input.stopActive ? { pendingLifecycleStopActive: true } : {}),
    },
  })
  if (!accepted) return false
  await agent.reload()
  return reconcileAgentLifecycleRequest(agent.id, { dormancyTimeoutMs: 0 })
}

export async function reconcileLegacyTerminatedAgent(
  agentId: string
): Promise<{ agentId: string; squadId: string | null } | null> {
  const finalCleanupId = randomUUID()
  const repairTime = new Date()
  return db.transaction(async (tx) => {
    await acquireAgentQueueLock(tx, agentId)
    const [updated] = await tx
      .update(agents)
      .set({
        status: 'terminated',
        terminatedAt: sql`COALESCE(${agents.terminatedAt}, ${repairTime.toISOString()}::timestamptz)`,
        pendingDormancyAt: null,
        metadata: sql`COALESCE(${agents.metadata}, '{}'::jsonb) || jsonb_build_object('finalCleanupPending', true, 'finalCleanupId', COALESCE(${agents.metadata}->>'finalCleanupId', ${finalCleanupId}))`,
        updatedAt: repairTime,
      })
      .where(
        and(
          eq(agents.id, agentId),
          inArray(agents.status, [...LIVE_AGENT_STATUSES]),
          sql`(${agents.terminatedAt} IS NOT NULL OR ${agents.metadata}->>'finalCleanupPending' = 'true')`
        )
      )
      .returning({ agentId: agents.id, squadId: agents.squadId })
    return updated ?? null
  })
}

async function runLegacyTerminatedAgentSweepScoped(options: {
  maxCandidates?: number
  agentIdsForTest?: readonly string[]
}): Promise<number> {
  const maxCandidates = Math.max(1, options.maxCandidates ?? 25)
  const claim = { kind: 'legacy-terminated' as const, maxCandidates }
  const candidateIds = options.agentIdsForTest
    ? await claimAgentLifecycleSweepCandidatesForTest(claim, options.agentIdsForTest)
    : await claimAgentLifecycleSweepCandidates(claim)
  let reconciled = 0
  for (const agentId of candidateIds) {
    try {
      const repaired = await reconcileLegacyTerminatedAgent(agentId)
      if (repaired) {
        eventEmitter.emit('agent.updated', repaired)
        eventEmitter.emit('agent.terminated', repaired)
        reconciled++
      }
    } catch (error) {
      log.warn(`Legacy terminated row remains non-canonical for agent ${agentId}`, error)
    }
  }
  return reconciled
}

/** Reconcile late writes made by a pre-lifecycle Core during migrate-before-restart. */
export function runLegacyTerminatedAgentSweep(options: { maxCandidates?: number } = {}): Promise<number> {
  return runLegacyTerminatedAgentSweepScoped(options)
}

/** Exact test scope prevents destructive global repair from touching another fixture. */
export function runLegacyTerminatedAgentSweepForTest(
  agentIds: readonly string[],
  options: { maxCandidates?: number } = {}
): Promise<number> {
  if (agentIds.length === 0) throw new Error('Legacy termination sweep test scope must not be empty')
  return runLegacyTerminatedAgentSweepScoped({ ...options, agentIdsForTest: agentIds })
}

export async function runPendingAgentLifecycleSweep(options: { maxCandidates?: number } = {}): Promise<number> {
  const maxCandidates = Math.max(1, options.maxCandidates ?? 25)
  const candidateIds = await claimAgentLifecycleSweepCandidates({ kind: 'pending', maxCandidates })
  let settled = 0
  for (const agentId of candidateIds) {
    try {
      if (await reconcileAgentLifecycleRequest(agentId, { dormancyTimeoutMs: 0 })) settled++
    } catch (error) {
      log.warn(`Pending lifecycle request remains for agent ${agentId}`, error)
    }
  }
  return settled
}

/** Promptly retry durable dormant teardown and then redeliver wake-eligible mail. */
export async function runDormancyCompletionSweep(
  options: { maxCandidates?: number; deliver?: (agentId: string) => Promise<void> } = {}
): Promise<number> {
  const maxCandidates = Math.max(1, options.maxCandidates ?? 25)
  const candidateIds = await claimAgentLifecycleSweepCandidates({ kind: 'dormancy-completion', maxCandidates })
  const deliver =
    options.deliver ??
    (async (agentId: string) => {
      const { deliverInboxMessagesToAgent } = await import('../inbox/inboxDelivery')
      await deliverInboxMessagesToAgent(agentId)
    })
  let settled = 0
  for (const agentId of candidateIds) {
    try {
      if (!(await completeDormancyIfPending(agentId, { timeoutMs: 0 }))) continue
      settled++
      const redeliveryState = await findAgentLifecycleState(agentId)
      const redeliveryId = redeliveryState?.metadata?.pendingInboxRedelivery
      if (redeliveryId === undefined) continue
      if (typeof redeliveryId !== 'string') {
        const invalidMarker = JSON.stringify(redeliveryId)
        await db
          .update(agents)
          .set({
            metadata: sql`COALESCE(${agents.metadata}, '{}'::jsonb) - 'pendingInboxRedelivery'`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(agents.id, agentId),
              sql`${agents.metadata}->'pendingInboxRedelivery' IS NOT DISTINCT FROM ${invalidMarker}::jsonb`
            )
          )
        continue
      }
      await deliver(agentId)
      await db
        .update(agents)
        .set({
          metadata: sql`COALESCE(${agents.metadata}, '{}'::jsonb) - 'pendingInboxRedelivery'`,
          updatedAt: new Date(),
        })
        .where(and(eq(agents.id, agentId), sql`${agents.metadata}->>'pendingInboxRedelivery' = ${redeliveryId}`))
    } catch (error) {
      log.warn(`Dormancy completion remains pending for agent ${agentId}`, error)
    }
  }
  return settled
}

type DormancyCompletionClaim = { id: string; episodeId: string }

async function claimDormancyCompletion(
  agentId: string,
  episodeId: string
): Promise<LifecycleTeardownClaimDecision<DormancyCompletionClaim>> {
  const id = randomUUID()
  const claimedAt = new Date()
  const expiredBefore = new Date(claimedAt.getTime() - LIFECYCLE_COMPLETION_CLAIM_LEASE_MS).toISOString()
  const [claimed] = await db
    .update(agents)
    .set({
      metadata: sql`COALESCE(${agents.metadata}, '{}'::jsonb) || ${JSON.stringify({ dormancyCompletionClaimId: id, dormancyCompletionClaimedAt: claimedAt.toISOString() })}::jsonb`,
      updatedAt: claimedAt,
    })
    .where(
      and(
        eq(agents.id, agentId),
        eq(agents.status, 'dormant'),
        sql`COALESCE(${agents.metadata}->>'dormancyCompletionPending', 'false') = 'true'`,
        sql`${agents.metadata}->>'dormancyCompletionId' = ${episodeId}`,
        sql`(${agents.metadata}->>'dormancyCompletionClaimId' IS NULL OR COALESCE(NULLIF(${agents.metadata}->>'dormancyCompletionClaimedAt', ''), '1970-01-01T00:00:00.000Z')::timestamptz <= ${expiredBefore}::timestamptz)`
      )
    )
    .returning({ id: agents.id })
  if (claimed) return { kind: 'claimed', claim: { id, episodeId } }
  const [current] = await db
    .select({ status: agents.status, metadata: agents.metadata })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1)
  const metadata = current?.metadata as Record<string, unknown> | null
  if (current?.status === 'dormant' && metadata?.dormancyCompletionPending !== true) return { kind: 'complete' }
  return { kind: 'busy' }
}

async function isDormancyClaimCurrent(agentId: string, episodeId: string, claimId: string): Promise<boolean> {
  const [current] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(
        eq(agents.id, agentId),
        eq(agents.status, 'dormant'),
        sql`COALESCE(${agents.metadata}->>'dormancyCompletionPending', 'false') = 'true'`,
        sql`${agents.metadata}->>'dormancyCompletionId' = ${episodeId}`,
        sql`${agents.metadata}->>'dormancyCompletionClaimId' = ${claimId}`
      )
    )
    .limit(1)
  return Boolean(current)
}

async function releaseDormancyClaim(agentId: string, episodeId: string, claimId: string): Promise<void> {
  await db
    .update(agents)
    .set({
      metadata: sql`COALESCE(${agents.metadata}, '{}'::jsonb) - 'dormancyCompletionClaimId' - 'dormancyCompletionClaimedAt'`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(agents.id, agentId),
        eq(agents.status, 'dormant'),
        sql`${agents.metadata}->>'dormancyCompletionId' = ${episodeId}`,
        sql`${agents.metadata}->>'dormancyCompletionClaimId' = ${claimId}`
      )
    )
}

async function runDormancyCompletionEffects(agentId: string, claim: DormancyCompletionClaim): Promise<boolean> {
  const target = await (await import('../../entities/Agent')).Agent.mustFind(agentId, { eager: false })
  const targetMetadata = target.metadata as Record<string, unknown> | null
  const resourceGeneration = targetMetadata?.dormancyResourceGeneration
  const parentResourceGeneration = targetMetadata?.resourceGeneration
  const runStage = async (
    stage: 'monitors' | 'tokens' | 'children' | 'schedules' | 'sandbox',
    effect: () => Promise<boolean | void>
  ): Promise<boolean> => {
    await dormancyEffectHook?.(stage)
    if (!(await isDormancyClaimCurrent(agentId, claim.episodeId, claim.id))) return false
    return (await effect()) !== false
  }

  if (
    !(await runStage('monitors', async () => {
      const { monitorSupervisor } = await import('../monitors')
      await monitorSupervisor.stopAllForAgent(agentId, {
        notifyAgent: false,
        createdBefore: target.dormantAt ?? undefined,
      })
    }))
  )
    return false
  if (
    !(await runStage('tokens', async () => {
      const tokenIds = (target.metadata as Record<string, unknown> | null)?.dormancyTokenIds
      await target.revokeTokensForAgent({
        tokenIds: Array.isArray(tokenIds) ? tokenIds.filter((id): id is string => typeof id === 'string') : undefined,
        createdBefore: target.dormantAt ?? undefined,
        lifecycleFence: {
          status: 'dormant',
          claimKey: 'dormancyCompletionClaimId',
          claimId: claim.id,
          episodeKey: 'dormancyCompletionId',
          episodeId: claim.episodeId,
        },
      })
    }))
  )
    return false
  if (
    !(await runStage('children', async () => {
      if (typeof parentResourceGeneration !== 'string') throw new Error(`Agent ${agentId} has no resource generation`)
      const { Subagent } = await import('../../entities/Subagent')
      return Subagent.cascadeDormantChildren(agentId, target.dormantAt ?? new Date(), {
        parentAgentId: agentId,
        episodeId: claim.episodeId,
        claimId: claim.id,
        resourceGeneration: parentResourceGeneration,
      })
    }))
  )
    return false
  if (
    !(await runStage('schedules', async () => {
      const { reconcileSchedulesForDormantAgent } = await import('../scheduling/reconciliation')
      const scheduleResult = await reconcileSchedulesForDormantAgent(target)
      if (scheduleResult.failed > 0) {
        throw new Error(`Failed to reconcile ${scheduleResult.failed} dormant schedule(s)`)
      }
    }))
  )
    return false
  return runStage('sandbox', async () => {
    const { stopPersonalSandbox } = await import('../agents/cleanup')
    let expectedGeneration: string | null = typeof resourceGeneration === 'string' ? resourceGeneration : null
    for (let attempt = 0; attempt < 2; attempt++) {
      const outcome = await stopPersonalSandbox(agentId, { lifecycleGeneration: expectedGeneration })
      if (outcome === false) throw new Error(`Failed to stop personal sandbox for dormant agent ${agentId}`)
      if (outcome.kind === 'stopped' || outcome.kind === 'not-found') return true
      if (outcome.kind === 'unverified') return false
      // A mismatch is not success. Revalidate the exact dormant episode/claim,
      // then fence the newly observed stale incarnation. A concurrent wake
      // loses this claim check, so its successor generation is never touched.
      if (!(await isDormancyClaimCurrent(agentId, claim.episodeId, claim.id))) return false
      expectedGeneration = outcome.actualLifecycleGeneration
    }
    throw new Error(`Sandbox generation kept changing for dormant agent ${agentId}`)
  })
}

async function settleDormancyCompletion(agentId: string, claim: DormancyCompletionClaim): Promise<boolean> {
  const [settled] = await db
    .update(agents)
    .set({
      metadata: sql`jsonb_set(COALESCE(${agents.metadata}, '{}'::jsonb) - 'dormancyCompletionPending' - 'dormancyCompletionId' - 'dormancyCompletionClaimId' - 'dormancyCompletionClaimedAt', '{pendingInboxRedelivery}', to_jsonb(${claim.episodeId}::text), true)`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(agents.id, agentId),
        eq(agents.status, 'dormant'),
        sql`${agents.metadata}->>'dormancyCompletionId' = ${claim.episodeId}`,
        sql`${agents.metadata}->>'dormancyCompletionClaimId' = ${claim.id}`
      )
    )
    .returning({ id: agents.id })
  return Boolean(settled)
}

/**
 * Complete one durable dormant teardown. DEFAULT_POOL_MAX invariant: no pool
 * connection may survive an external/global-pool effect (see db/connection.ts).
 */
export function completeDormancy(agentId: string, dormancyCompletionId: string): Promise<boolean> {
  // DEFAULT_POOL_MAX hold-and-wait invariant (db/connection.ts): never retain a pool connection across effects.
  return runLifecycleEpisodeTeardown({
    claim: () => claimDormancyCompletion(agentId, dormancyCompletionId),
    effects: (claim) => runDormancyCompletionEffects(agentId, claim),
    settle: (claim) => settleDormancyCompletion(agentId, claim),
    release: (claim) => releaseDormancyClaim(agentId, claim.episodeId, claim.id),
  })
}

export async function completeDormancyIfPending(
  agentId: string,
  options: { timeoutMs?: number; wait?: (delayMs: number) => Promise<void> } = {}
): Promise<boolean> {
  const deadline = Date.now() + (options.timeoutMs ?? 30_000)
  const wait = options.wait ?? ((delayMs: number) => Bun.sleep(delayMs))
  let delayMs = 25
  while (true) {
    const agent = await findAgentLifecycleState(agentId)
    if (!agent) throw new Error(`Agent ${agentId} not found`)
    const id = (agent.metadata as Record<string, unknown> | null)?.dormancyCompletionId
    if (agent.status !== 'dormant' || typeof id !== 'string') return true
    if (await completeDormancy(agentId, id)) return true
    if (Date.now() >= deadline) return false
    await wait(Math.min(delayMs, Math.max(0, deadline - Date.now())))
    delayMs = Math.min(delayMs * 2, 1_000)
  }
}

/** Wake a dormant row while the caller holds the per-agent queue lock. */
export async function wakeInTransaction(tx: DbTransaction, agentId: string): Promise<string | null> {
  const wakeCompletionId = randomUUID()
  const [row] = await tx
    .update(agents)
    .set({
      status: 'idle',
      dormantAt: null,
      terminatedAt: null,
      questionData: null,
      // Revival metadata belongs to the shared wake transition so inbox,
      // queue, pickup, and explicit subagent wake paths cannot diverge.
      metadata: sql`((CASE WHEN ${agents.parentAgentId} IS NOT NULL THEN jsonb_set(COALESCE(${agents.metadata}, '{}'::jsonb), '{resultStatus}', 'null'::jsonb, true) ELSE COALESCE(${agents.metadata}, '{}'::jsonb) END) - 'dormancyEpisodeId' - 'dormancyTokenIds' - 'dormancyResourceGeneration' - 'pendingInboxRedelivery') || ${JSON.stringify({ resourceGeneration: wakeCompletionId, wakeCompletionPending: true, wakeCompletionId })}::jsonb`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(agents.id, agentId),
        eq(agents.status, 'dormant'),
        sql`COALESCE(${agents.metadata}->>'dormancyCompletionPending', 'false') <> 'true'`
      )
    )
    .returning({ id: agents.id })
  if (row) return wakeCompletionId
  const [current] = await tx.select({ status: agents.status }).from(agents).where(eq(agents.id, agentId)).limit(1)
  if (!current) throw new Error(`Agent ${agentId} not found`)
  if (current.status === 'terminated') {
    const { AgentTerminatedError } = await import('../../entities/Agent')
    throw new AgentTerminatedError(agentId)
  }
  return null
}

function isCurrentWakeGeneration(agent: Agent, wakeCompletionId: string): boolean {
  const metadata = agent.metadata as Record<string, unknown> | null
  return (
    isLiveAgentStatus(agent.status) &&
    metadata?.wakeCompletionPending === true &&
    metadata.wakeCompletionId === wakeCompletionId &&
    metadata.resourceGeneration === wakeCompletionId
  )
}

/** Complete non-transactional wake effects and clear their durable retry marker. */
export async function completeWake(
  agentId: string,
  projected?: Agent,
  expectedWakeCompletionId?: string
): Promise<boolean> {
  let agent = await (await import('../../entities/Agent')).Agent.mustFind(agentId, { eager: false })
  if (agent.status === 'dormant' || agent.status === 'terminated') return false
  const initialMetadata = agent.metadata as Record<string, unknown> | null
  const wakeCompletionId =
    expectedWakeCompletionId ??
    (typeof initialMetadata?.wakeCompletionId === 'string' ? initialMetadata.wakeCompletionId : undefined)
  if (!wakeCompletionId || !isCurrentWakeGeneration(agent, wakeCompletionId)) return false

  const { ensureAgentSandbox } = await import('../sandbox/agent-warmup')
  const ensureResult = await ensureAgentSandbox(agent)
  if (ensureResult === 'skipped-agent-unavailable') return false
  agent = await (await import('../../entities/Agent')).Agent.mustFind(agentId, { eager: false })
  if (!isCurrentWakeGeneration(agent, wakeCompletionId)) return false

  await agent.getOrCreateToken({ expectedResourceGeneration: wakeCompletionId })
  agent = await (await import('../../entities/Agent')).Agent.mustFind(agentId, { eager: false })
  if (!isCurrentWakeGeneration(agent, wakeCompletionId)) return false

  await completeWakeBeforeClearHook?.()
  const cleared = await db.transaction(async (tx) => {
    await acquireAgentQueueLock(tx, agentId)
    const [row] = await tx
      .update(agents)
      .set({
        metadata: sql`COALESCE(${agents.metadata}, '{}'::jsonb) - 'wakeCompletionPending' - 'wakeCompletionId'`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(agents.id, agentId),
          inArray(agents.status, [...LIVE_AGENT_STATUSES]),
          sql`${agents.metadata}->>'wakeCompletionPending' = 'true'`,
          sql`${agents.metadata}->>'wakeCompletionId' = ${wakeCompletionId}`
        )
      )
      .returning({ id: agents.id })
    return Boolean(row)
  })
  if (!cleared) {
    agent = await (await import('../../entities/Agent')).Agent.mustFind(agentId, { eager: false })
    const currentMetadata = agent.metadata as Record<string, unknown> | null
    const pending = currentMetadata?.wakeCompletionPending === true
    const currentWakeCompletionId = currentMetadata?.wakeCompletionId
    if (typeof currentWakeCompletionId === 'string' && currentWakeCompletionId !== wakeCompletionId) return false
    if (isLiveAgentStatus(agent.status) && !pending) return true
    return false
  }
  if (projected) Object.assign(projected, agent, { metadata: { ...(agent.metadata ?? {}) } })
  if (projected?.metadata) {
    delete (projected.metadata as Record<string, unknown>).wakeCompletionPending
    delete (projected.metadata as Record<string, unknown>).wakeCompletionId
  }
  return true
}

/** Attempt committed wake effects without changing durable acceptance semantics. */
export async function completeWakeAfterCommit(
  agentId: string,
  projected: Agent | undefined,
  wakeCompletionId: string
): Promise<boolean> {
  try {
    return await completeWake(agentId, projected, wakeCompletionId)
  } catch (error) {
    log.warn(`Deferred wake completion failed for agent ${agentId}; pickup will retry`, error)
    return false
  }
}

/** Dormant -> idle. Final termination is deliberately irreversible. */
export async function wake(agent: Agent): Promise<boolean> {
  if (!(await completeDormancyIfPending(agent.id, { timeoutMs: 0 }))) {
    await agent.reload()
    return false
  }
  await agent.reload()
  const wakeCompletionId = await db.transaction(async (tx) => {
    await acquireAgentQueueLock(tx, agent.id)
    return wakeInTransaction(tx, agent.id)
  })
  const currentWakeCompletionId =
    wakeCompletionId ??
    (
      (await (await import('../../entities/Agent')).Agent.mustFind(agent.id, { eager: false })).metadata as Record<
        string,
        unknown
      > | null
    )?.wakeCompletionId
  if (typeof currentWakeCompletionId !== 'string' || !(await completeWake(agent.id, agent, currentWakeCompletionId))) {
    throw new Error(`Agent ${agent.id} wake was superseded by a lifecycle transition`)
  }
  return true
}

export type FinalizationWorkBudget = { remaining: number }
export type FinalizationProgress = { madeProgress: boolean }

type FinalizationDeps = {
  finalCleanup?: (agentId: string) => Promise<boolean | void>
  completeDormancy?: (agentId: string) => Promise<boolean>
  expectedDormantAt?: Date
  workBudget?: FinalizationWorkBudget
  progress?: FinalizationProgress
}
type DescendantRow = { id: string; depth: number }

/**
 * Resolve the whole tree before finalization starts. The query releases its
 * pool client before any lifecycle effect; callers then walk the materialized
 * rows iteratively, deepest-first, so connection use is O(1) in tree depth.
 */
async function resolveFinalizationDescendants(agentId: string, maxRows = 25): Promise<DescendantRow[]> {
  return (await db.execute(sql`
    WITH RECURSIVE descendants AS (
      SELECT ${agents.id} AS id, 1::int AS depth
      FROM ${agents}
      WHERE ${agents.parentAgentId} = ${agentId}
      UNION ALL
      SELECT child.id, parent.depth + 1
      FROM ${agents} child
      JOIN descendants parent ON child.parent_agent_id = parent.id
    )
    SELECT descendants.id, descendants.depth
    FROM descendants
    JOIN ${agents} target ON target.id = descendants.id
    WHERE target.status <> 'terminated'
       OR COALESCE(target.metadata->>'finalCleanupPending', 'false') = 'true'
    ORDER BY
      descendants.depth DESC,
      CASE
        WHEN jsonb_typeof(target.metadata->'finalizationDescendantSweepAt') = 'number'
          THEN (target.metadata->>'finalizationDescendantSweepAt')::numeric
        ELSE 0
      END,
      descendants.id ASC
    LIMIT ${Math.max(1, maxRows)}
  `)) as unknown as DescendantRow[]
}

async function rotateFinalizationDescendant(agentId: string): Promise<void> {
  await db
    .update(agents)
    .set({
      metadata: sql`jsonb_set(COALESCE(${agents.metadata}, '{}'::jsonb), '{finalizationDescendantSweepAt}', to_jsonb(GREATEST(CASE WHEN jsonb_typeof(${agents.metadata}->'finalizationDescendantSweepAt') = 'number' THEN (${agents.metadata}->>'finalizationDescendantSweepAt')::numeric + 1 ELSE 1 END, EXTRACT(EPOCH FROM clock_timestamp()))), true)`,
      updatedAt: new Date(),
    })
    .where(eq(agents.id, agentId))
}

type FinalizationClaim = { id: string; episodeId: string }

async function claimFinalization(agentId: string): Promise<LifecycleTeardownClaimDecision<FinalizationClaim>> {
  const id = randomUUID()
  const claimedAt = new Date()
  const fallbackEpisodeId = randomUUID()
  const expiredBefore = new Date(claimedAt.getTime() - LIFECYCLE_COMPLETION_CLAIM_LEASE_MS).toISOString()
  const [claimed] = await db
    .update(agents)
    .set({
      metadata: sql`COALESCE(${agents.metadata}, '{}'::jsonb) || ${JSON.stringify({ finalizationClaimId: id, finalizationClaimedAt: claimedAt.toISOString() })}::jsonb || jsonb_build_object('finalCleanupId', COALESCE(${agents.metadata}->>'finalCleanupId', ${fallbackEpisodeId}))`,
      updatedAt: claimedAt,
    })
    .where(
      and(
        eq(agents.id, agentId),
        eq(agents.status, 'terminated'),
        sql`COALESCE(${agents.metadata}->>'finalCleanupPending', 'false') = 'true'`,
        sql`(${agents.metadata}->>'finalizationClaimId' IS NULL OR COALESCE(NULLIF(${agents.metadata}->>'finalizationClaimedAt', ''), '1970-01-01T00:00:00.000Z')::timestamptz <= ${expiredBefore}::timestamptz)`
      )
    )
    .returning({ id: agents.id, metadata: agents.metadata })
  if (claimed) {
    const episodeId = (claimed.metadata as Record<string, unknown> | null)?.finalCleanupId
    if (typeof episodeId !== 'string') throw new Error(`Final cleanup ${agentId} has no episode id`)
    return { kind: 'claimed', claim: { id, episodeId } }
  }
  const [current] = await db
    .select({ status: agents.status, metadata: agents.metadata })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1)
  if (
    current?.status === 'terminated' &&
    (current.metadata as Record<string, unknown> | null)?.finalCleanupPending !== true
  ) {
    return { kind: 'complete' }
  }
  return { kind: 'busy' }
}

async function isFinalizationClaimCurrent(agentId: string, claim: FinalizationClaim): Promise<boolean> {
  const [current] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(
        eq(agents.id, agentId),
        eq(agents.status, 'terminated'),
        sql`${agents.metadata}->>'finalCleanupId' = ${claim.episodeId}`,
        sql`${agents.metadata}->>'finalizationClaimId' = ${claim.id}`
      )
    )
    .limit(1)
  return Boolean(current)
}

async function releaseFinalizationClaim(agentId: string, claimId: string): Promise<void> {
  await db
    .update(agents)
    .set({
      metadata: sql`COALESCE(${agents.metadata}, '{}'::jsonb) - 'finalizationClaimId' - 'finalizationClaimedAt'`,
      updatedAt: new Date(),
    })
    .where(and(eq(agents.id, agentId), sql`${agents.metadata}->>'finalizationClaimId' = ${claimId}`))
}

async function clearFinalizationMarker(agentId: string, claim: FinalizationClaim): Promise<boolean> {
  const [cleared] = await db
    .update(agents)
    .set({
      metadata: sql`COALESCE(${agents.metadata}, '{}'::jsonb) - 'finalCleanupPending' - 'finalCleanupId' - 'finalizationClaimId' - 'finalizationClaimedAt' - 'finalizationStageEpisode' - 'finalizationCompletedStages'`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(agents.id, agentId),
        eq(agents.status, 'terminated'),
        sql`COALESCE(${agents.metadata}->>'finalCleanupPending', 'false') = 'true'`,
        sql`${agents.metadata}->>'finalCleanupId' = ${claim.episodeId}`,
        sql`${agents.metadata}->>'finalizationClaimId' = ${claim.id}`
      )
    )
    .returning({ id: agents.id })
  if (cleared) return true
  const [current] = await db
    .select({ status: agents.status, metadata: agents.metadata })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1)
  return (
    current?.status === 'terminated' &&
    (current.metadata as Record<string, unknown> | null)?.finalCleanupPending !== true
  )
}

async function transitionDormantAgentToFinal(agent: Agent, deps: FinalizationDeps = {}): Promise<boolean> {
  const dormancyCompleted = deps.completeDormancy
    ? await deps.completeDormancy(agent.id)
    : await completeDormancyIfPending(agent.id, { timeoutMs: 0 })
  if (!dormancyCompleted) return false
  await agent.reload()
  if (agent.status === 'terminated') return true
  if (agent.status !== 'dormant') throw new Error(`Agent ${agent.id} must be dormant before final termination`)

  await finalizationBeforeCasHook?.()
  const terminatedAt = new Date()
  const finalCleanupId = randomUUID()
  const { updated, slotCleanup } = await db.transaction(async (tx) => {
    await acquireAgentQueueLock(tx, agent.id)
    const { cleanupAgentSlotsInTransaction } = await import('../slots/store')
    const slotCleanup = await cleanupAgentSlotsInTransaction(tx, agent.id, 'pool_cleanup')
    const [row] = await tx
      .update(agents)
      .set({
        status: 'terminated',
        terminatedAt,
        metadata: sql`(COALESCE(${agents.metadata}, '{}'::jsonb) - 'pendingInboxRedelivery') || ${JSON.stringify({ finalCleanupPending: true, finalCleanupId })}::jsonb`,
        updatedAt: terminatedAt,
      })
      .where(
        and(
          eq(agents.id, agent.id),
          eq(agents.status, 'dormant'),
          deps.expectedDormantAt ? eq(agents.dormantAt, deps.expectedDormantAt) : undefined,
          sql`COALESCE(${agents.metadata}->>'dormancyCompletionPending', 'false') <> 'true'`
        )
      )
      .returning()
    return { updated: row ?? null, slotCleanup }
  })
  // Prompt outbox draining happens only after the granting transaction commits.
  if (slotCleanup.promoted) {
    if (agent.squadId) eventEmitter.emit('slots.updated', { squadId: agent.squadId })
    const { drainSlotNotificationsSoon } = await import('../slots/store')
    drainSlotNotificationsSoon()
  }
  if (!updated) {
    const fresh = await (await import('../../entities/Agent')).Agent.mustFind(agent.id, { eager: false })
    Object.assign(agent, fresh)
    return fresh.status === 'terminated'
  }
  Object.assign(agent, updated)
  eventEmitter.emit('agent.updated', { agentId: agent.id, squadId: agent.squadId })
  eventEmitter.emit('agent.terminated', { agentId: agent.id, squadId: agent.squadId })
  return true
}

const lifecycleStageLocks = new Map<string, Promise<void>>()

async function withLifecycleStageLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = lifecycleStageLocks.get(key) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous.then(() => current)
  lifecycleStageLocks.set(key, tail)
  await previous
  try {
    return await operation()
  } finally {
    release()
    if (lifecycleStageLocks.get(key) === tail) lifecycleStageLocks.delete(key)
  }
}

async function runFinalizationStage(
  agentId: string,
  claim: FinalizationClaim,
  stage: 'tokens' | 'descendants' | 'questions' | 'schedules' | 'storage',
  effect: () => Promise<boolean | number | void>,
  afterRecorded?: () => Promise<void>,
  workBudget?: FinalizationWorkBudget,
  progress?: FinalizationProgress
): Promise<boolean> {
  return withLifecycleStageLock(`${agentId}:${claim.episodeId}:${stage}`, async () => {
    const [current] = await db
      .select({ metadata: agents.metadata })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.status, 'terminated')))
      .limit(1)
    const metadata = (current?.metadata ?? {}) as Record<string, unknown>
    const completed = Array.isArray(metadata.finalizationCompletedStages)
      ? (metadata.finalizationCompletedStages as unknown[])
      : []
    if (metadata.finalizationStageEpisode === claim.episodeId && completed.includes(stage)) return true
    if (!(await isFinalizationClaimCurrent(agentId, claim))) return false
    if (workBudget) {
      if (workBudget.remaining <= 0) return false
      workBudget.remaining--
    }
    if ((await effect()) === false) return false
    const [recorded] = await db
      .update(agents)
      .set({
        metadata: sql`jsonb_set(jsonb_set(COALESCE(${agents.metadata}, '{}'::jsonb), '{finalizationStageEpisode}', to_jsonb(${claim.episodeId}::text), true), '{finalizationCompletedStages}', CASE WHEN ${agents.metadata}->>'finalizationStageEpisode' = ${claim.episodeId} THEN COALESCE(${agents.metadata}->'finalizationCompletedStages', '[]'::jsonb) || jsonb_build_array(${stage}::text) ELSE jsonb_build_array(${stage}::text) END, true)`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(agents.id, agentId),
          eq(agents.status, 'terminated'),
          sql`${agents.metadata}->>'finalCleanupId' = ${claim.episodeId}`
        )
      )
      .returning({ id: agents.id })
    if (!recorded) return false
    if (progress) progress.madeProgress = true
    await afterRecorded?.()
    return true
  })
}

async function runFinalizationTailEffects(
  target: Agent,
  deps: FinalizationDeps,
  claim: FinalizationClaim
): Promise<boolean> {
  if (
    !(await runFinalizationStage(
      target.id,
      claim,
      'questions',
      async () => {
        const { reconcileQuestionsForTerminatedAgent } = await import('../agents/questions')
        await reconcileQuestionsForTerminatedAgent(target.id)
      },
      () => finalizationEffectHook?.('questions') ?? Promise.resolve(),
      deps.workBudget,
      deps.progress
    ))
  )
    return false
  if (
    !(await runFinalizationStage(
      target.id,
      claim,
      'schedules',
      async () => {
        const { reconcileSchedulesForTerminatedAgent, reconcileWatchdog } = await import('../scheduling/reconciliation')
        const scheduleResult = await reconcileSchedulesForTerminatedAgent(target)
        if (scheduleResult.failed > 0) throw new Error(`Failed to reconcile ${scheduleResult.failed} schedule(s)`)
        if (target.parentAgentId) await reconcileWatchdog(target.parentAgentId)
      },
      () => finalizationEffectHook?.('schedules') ?? Promise.resolve(),
      deps.workBudget,
      deps.progress
    ))
  )
    return false
  return runFinalizationStage(
    target.id,
    claim,
    'storage',
    async () => {
      const { stopAndArchivePersonalSandbox } = await import('../agents/cleanup')
      return (deps.finalCleanup ?? stopAndArchivePersonalSandbox)(target.id)
    },
    () => finalizationEffectHook?.('storage') ?? Promise.resolve(),
    deps.workBudget,
    deps.progress
  )
}

async function completeOneFinalDescendant(agentId: string, clearMarker: boolean): Promise<boolean> {
  const target = await (await import('../../entities/Agent')).Agent.mustFind(agentId, { eager: false })
  if (isLiveAgentStatus(target.status)) {
    const active = await target.getActiveExecution()
    if (active) {
      await requestAgentLifecycle(target, {
        target: 'terminated',
        metadata: { resultStatus: 'stopped' },
        reason: 'Ancestor terminated',
        stopActive: true,
      })
      return false
    }
    await makeDormant(target, { metadata: { resultStatus: 'stopped' } })
    await target.reload()
  }
  if (target.status === 'dormant' && !(await transitionDormantAgentToFinal(target))) return false
  await target.reload()
  if (target.status !== 'terminated') return false
  const metadata = target.metadata as Record<string, unknown> | null
  if (metadata?.finalCleanupPending !== true) return true

  return runLifecycleEpisodeTeardown({
    claim: () => claimFinalization(target.id),
    effects: async (claim) => {
      if (
        !(await runFinalizationStage(target.id, claim, 'tokens', () =>
          target.revokeTokensForAgent({
            lifecycleFence: {
              status: 'terminated',
              claimKey: 'finalizationClaimId',
              claimId: claim.id,
              episodeKey: 'finalCleanupId',
              episodeId: claim.episodeId,
            },
          })
        ))
      )
        return false
      return runFinalizationTailEffects(target, {}, claim)
    },
    settle: async (claim) => {
      if (clearMarker) return clearFinalizationMarker(target.id, claim)
      await releaseFinalizationClaim(target.id, claim.id)
      return true
    },
    release: (claim) => releaseFinalizationClaim(target.id, claim.id),
  })
}

async function finalizeResolvedDescendants(
  rows: DescendantRow[],
  workBudget: FinalizationWorkBudget,
  progress?: FinalizationProgress
): Promise<boolean> {
  for (let index = 0; index < rows.length; ) {
    const depth = rows[index]!.depth
    let depthComplete = true
    const failedAtDepth: string[] = []
    while (index < rows.length && rows[index]!.depth === depth) {
      const row = rows[index++]!
      if (workBudget.remaining <= 0) return false
      workBudget.remaining--
      await rotateFinalizationDescendant(row.id)
      try {
        if (await completeOneFinalDescendant(row.id, depthComplete)) {
          if (progress) progress.madeProgress = true
        } else {
          depthComplete = false
          failedAtDepth.push(row.id)
        }
      } catch (error) {
        log.warn(`Finalization remains pending for descendant ${row.id}`, error)
        depthComplete = false
        failedAtDepth.push(row.id)
      }
    }
    // Move poisoned siblings behind peers that also remain pending at this
    // depth. The marker is durable, so rotation survives process restarts.
    if (!depthComplete) {
      for (const failedId of failedAtDepth) await rotateFinalizationDescendant(failedId)
      return false
    }
    // Never start a shallower depth while a deeper generation is unresolved.
  }
  return true
}

async function finalizationDescendantsConverged(parentAgentId: string): Promise<boolean> {
  return (await resolveFinalizationDescendants(parentAgentId, 1)).length === 0
}

export async function finalizeDescendants(parentAgentId: string): Promise<boolean> {
  return finalizeResolvedDescendants(await resolveFinalizationDescendants(parentAgentId, 25), { remaining: 25 })
}

/**
 * DEFAULT_POOL_MAX invariant: no pool connection may survive an external or
 * global-pool effect (see db/connection.ts); descendants are materialized first.
 */
export async function completeFinalization(agentId: string, deps: FinalizationDeps = {}): Promise<boolean> {
  // DEFAULT_POOL_MAX hold-and-wait invariant (db/connection.ts): never retain a pool connection across effects.
  try {
    const workBudget = deps.workBudget ?? { remaining: 25 }
    const descendants = await resolveFinalizationDescendants(agentId, workBudget.remaining)
    const target = await (await import('../../entities/Agent')).Agent.mustFind(agentId, { eager: false })
    if (target.status !== 'terminated') return false
    const metadata = target.metadata as Record<string, unknown> | null
    if (metadata?.finalCleanupPending !== true) return true

    return await runLifecycleEpisodeTeardown({
      claim: () => claimFinalization(agentId),
      effects: async (claim) => {
        if (
          !(await runFinalizationStage(
            agentId,
            claim,
            'tokens',
            () =>
              target.revokeTokensForAgent({
                lifecycleFence: {
                  status: 'terminated',
                  claimKey: 'finalizationClaimId',
                  claimId: claim.id,
                  episodeKey: 'finalCleanupId',
                  episodeId: claim.episodeId,
                },
              }),
            () => finalizationEffectHook?.('tokens') ?? Promise.resolve(),
            workBudget,
            deps.progress
          ))
        )
          return false
        if (
          !(await runFinalizationStage(
            agentId,
            claim,
            'descendants',
            async () =>
              (await finalizeResolvedDescendants(descendants, workBudget, deps.progress)) &&
              (await finalizationDescendantsConverged(agentId)),
            () => finalizationEffectHook?.('descendants') ?? Promise.resolve(),
            undefined,
            deps.progress
          ))
        )
          return false
        return runFinalizationTailEffects(target, { ...deps, workBudget }, claim)
      },
      settle: (claim) => clearFinalizationMarker(agentId, claim),
      release: (claim) => releaseFinalizationClaim(agentId, claim.id),
    })
  } catch (error) {
    log.warn(`Finalization attempt failed for agent ${agentId}`, error)
    return false
  }
}

/** Final dormant -> terminated transition, used only by backend cleanup. */
export async function terminate(agent: Agent, deps: FinalizationDeps = {}): Promise<void> {
  if (!(await transitionDormantAgentToFinal(agent, deps))) return
  if (await completeFinalization(agent.id, deps)) {
    const { finalCleanupPending: _pending, ...metadata } = (agent.metadata ?? {}) as Record<string, unknown>
    agent.metadata = metadata
  }
}

export interface ClearQueueResult {
  /**
   * True only when the queue is KNOWN to be empty: either there was no running
   * execution (so the DB rows were the whole queue), or a worker acked success.
   *
   * The in-memory SDK queue lives in the worker and the API cannot reach it, so
   * anything else — a worker error, or no ack at all — must report false. This
   * used to return an unconditional `true`, which is why a timed-out clear
   * surfaced in the UI as `success: true` while the agent went on to answer
   * every message the user thought they had cleared.
   */
  ok: boolean
  /** Messages removed from the worker's in-memory SDK queue. */
  cleared: number
  /** Pending rows removed from the database. */
  deleted: number
  code: 'no_active_execution' | 'worker_ack' | 'worker_error' | 'ack_timeout'
}

/**
 * Clear the agent's queue: the worker's in-memory SDK queue AND the pending
 * message rows.
 */
export async function clearQueue(agent: Agent, options: { ackTimeoutMs?: number } = {}): Promise<ClearQueueResult> {
  const activeExecution = await agent.getActiveExecution()
  if (!activeExecution || activeExecution.status !== 'running') {
    // No running execution — there is no SDK queue, so the DB rows are the
    // entire queue and deleting them genuinely clears it.
    const deleted = await agent.deletePendingMessages()
    return { ok: true, cleared: 0, deleted, code: 'no_active_execution' }
  }

  const ackTimeoutMs = options.ackTimeoutMs ?? 10_000

  // Running execution — send clear-queue and wait for the worker ack. The
  // worker clears the SDK queue before deleting DB rows and acking, and acks
  // even when it fails, so the timeout below now only fires when no worker is
  // listening at all.
  const ackPromise = new Promise<ClearQueueResult>((resolve) => {
    const timeout = setTimeout(async () => {
      unsub()
      // Best-effort DB cleanup, but this does NOT clear the SDK queue, so the
      // result stays `ok: false` — the caller must be able to tell the user
      // their messages may still be delivered.
      let deleted = 0
      try {
        deleted = await agent.deletePendingMessages()
        log.warn(
          `clearQueue: timed out waiting for queue-cleared ack for agent ${agent.id}; deleted ${deleted} pending messages from DB (SDK queue NOT cleared)`
        )
      } catch (error) {
        log.warn(
          `clearQueue: timed out waiting for queue-cleared ack for agent ${agent.id}; fallback DB delete failed`,
          error
        )
      }
      resolve({ ok: false, cleared: 0, deleted, code: 'ack_timeout' })
    }, ackTimeoutMs)

    const unsub = eventEmitter.on('agent.queue-cleared', (data) => {
      if (data.agentId !== agent.id) return
      clearTimeout(timeout)
      unsub()
      // `ok` is absent on acks from an older worker mid-deploy; treat that as
      // success so a version skew does not report spurious failures.
      const acked = data.ok !== false
      resolve({
        ok: acked,
        cleared: data.cleared ?? 0,
        deleted: data.deleted ?? 0,
        code: acked ? 'worker_ack' : 'worker_error',
      })
    })
  })

  // Send clear-queue signal to worker and wait for ack
  await notify('agent_control', JSON.stringify({ action: 'clear-queue', agentId: agent.id }))
  return ackPromise
}

/**
 * Check if the agent can be safely deleted.
 * @returns True if the agent can be safely deleted, false otherwise.
 */
export async function canDelete(agent: Agent): Promise<{ canDelete: false; reason: string } | { canDelete: true }> {
  if (agent.squadId) {
    return { canDelete: false, reason: 'Agent is assigned to a squad' }
  }
  if (agent.status === 'active') {
    return { canDelete: false, reason: 'Agent is currently active' }
  }
  // Check for active execution
  const activeExecution = await agent.getActiveExecution()
  if (activeExecution) {
    return { canDelete: false, reason: 'Agent has an active execution' }
  }
  return { canDelete: true }
}

/**
 * Delete the agent.
 * @throws An error if the agent is not found or the deletion fails.
 *
 * Named `deleteAgent` here (not `delete`, a reserved-ish word that's awkward
 * as an exported function name); the Agent delegate keeps the name `delete`.
 */
export async function deleteAgent(
  agent: Agent,
  deps: { reclaim?: (agentId: string, sandboxId: string) => Promise<void> } = {}
): Promise<void> {
  const check = await canDelete(agent)
  if (!check.canDelete) {
    throw new Error(`Agent ${agent.id} cannot be deleted: ${check.reason}`)
  }

  // Capture before deletion because sandbox ownership resolution needs the row.
  // Failure is non-fatal: deleting the authoritative lifecycle record comes first.
  const sandboxId = agent.getPersonalSandboxIdForCleanup()

  // Delete agent (cascade will handle related data)
  await db.delete(agents).where(eq(agents.id, agent.id))
  eventEmitter.emit('agent.deleted', {
    agentId: agent.id,
    squadId: agent.squadId,
    ownerUserId: agent.ownerUserId,
  })

  // Retry best-effort storage cleanup only after the deletion has committed.
  if (sandboxId && sandboxId === agent.getAgentWorkspaceSandboxId()) {
    try {
      const reclaim = deps.reclaim ?? (await import('../agents/cleanup')).reclaimPersonalSandbox
      await reclaim(agent.id, sandboxId)
    } catch (error) {
      log.warn(`Failed to reclaim sandbox after deleting agent ${agent.id}`, error)
    }
  }
}

type RuntimeTransitionResult = 'applied' | 'wrong-status' | 'active-execution'

/** Serialize worker/control housekeeping with lifecycle and execution admission. */
async function transitionRuntimeStatus(
  agent: Agent,
  expectedStatus: 'idle' | 'compacting' | 'resetting' | 'waiting-input',
  nextStatus: 'idle' | 'compacting' | 'resetting',
  options: { clearQuestion?: boolean; requireNoActiveExecution?: boolean } = {}
): Promise<RuntimeTransitionResult> {
  const result = await db.transaction(async (tx) => {
    await acquireAgentQueueLock(tx, agent.id)
    if (options.requireNoActiveExecution) {
      // Match execution settlement/dormancy ordering: advisory lock, execution
      // row, then agent row. The row lock keeps settlement from crossing this
      // housekeeping admission decision.
      const [active] = await tx
        .select({ id: executions.id })
        .from(executions)
        .where(and(eq(executions.agentId, agent.id), inArray(executions.status, [...ACTIVE_EXECUTION_STATUSES])))
        .limit(1)
        .for('update')
      if (active) return 'active-execution' as const
    }
    const [current] = await tx
      .select({ status: agents.status })
      .from(agents)
      .where(eq(agents.id, agent.id))
      .for('update')
    if (current?.status !== expectedStatus) return 'wrong-status' as const
    const updatedAt = new Date()
    await tx
      .update(agents)
      .set({
        status: nextStatus,
        ...(options.clearQuestion ? { questionData: null } : {}),
        updatedAt,
      })
      .where(and(eq(agents.id, agent.id), eq(agents.status, expectedStatus)))
    return { kind: 'applied' as const, updatedAt }
  })
  if (typeof result === 'string') return result
  agent.status = nextStatus
  agent.updatedAt = result.updatedAt
  if (options.clearQuestion) agent.questionData = null
  eventEmitter.emit('agent.updated', { agentId: agent.id, squadId: agent.squadId })
  return 'applied'
}

/**
 * Start compaction for this agent. Sets status to 'compacting' and sends
 * a control signal to the worker.
 * @param instructions - Optional instructions for the compaction.
 * @throws If agent is not idle or has an active execution.
 */
export async function startCompaction(agent: Agent, instructions?: string): Promise<void> {
  if (agent.status !== 'idle') {
    throw new Error(`Agent is not idle (status: ${agent.status})`)
  }

  const activeExecution = await agent.getActiveExecution()
  if (activeExecution) {
    throw new Error(`Agent has active execution (status: ${activeExecution.status})`)
  }

  const transition = await transitionRuntimeStatus(agent, 'idle', 'compacting', { requireNoActiveExecution: true })
  if (transition === 'wrong-status') throw new Error('Agent lifecycle changed before compaction started')
  if (transition === 'active-execution') throw new Error('Agent has active execution')

  await notify('agent_control', JSON.stringify({ action: 'compact', agentId: agent.id, message: instructions }))
}

/**
 * Finish compaction for this agent. Called by the worker after compaction completes.
 * Sets status back to 'idle'.
 */
export async function finishCompaction(agent: Agent): Promise<void> {
  if ((await transitionRuntimeStatus(agent, 'compacting', 'idle')) !== 'applied') return
  await emitQueuedExecutionWake(agent)

  try {
    const { deliverInboxMessagesToAgent } = await import('../inbox/inboxDelivery')
    await deliverInboxMessagesToAgent(agent.id)
  } catch (error) {
    log.error(`finishCompaction: inbox retry failed for agent ${agent.id.slice(0, 8)}:`, error)
  }
}

/**
 * Start a session reset for this agent. Only allowed when idle with no active execution.
 * Sets status to 'resetting' and sends control signal to worker.
 */
export async function startReset(agent: Agent): Promise<void> {
  if (agent.status !== 'idle') {
    throw new Error(`Agent is not idle (status: ${agent.status})`)
  }

  const activeExecution = await agent.getActiveExecution()
  if (activeExecution) {
    throw new Error(`Agent has active execution (status: ${activeExecution.status})`)
  }

  const transition = await transitionRuntimeStatus(agent, 'idle', 'resetting', { requireNoActiveExecution: true })
  if (transition === 'wrong-status') throw new Error('Agent lifecycle changed before reset started')
  if (transition === 'active-execution') throw new Error('Agent has active execution')

  await notify('agent_control', JSON.stringify({ action: 'reset', agentId: agent.id }))
}

/**
 * Finish reset for this agent. Called by the worker after reset completes.
 * Sets status back to 'idle'.
 */
export async function finishReset(agent: Agent): Promise<void> {
  if ((await transitionRuntimeStatus(agent, 'resetting', 'idle')) !== 'applied') return
  await emitQueuedExecutionWake(agent)
}

async function emitQueuedExecutionWake(agent: Agent): Promise<void> {
  const [queued] = await db
    .select()
    .from(executions)
    .where(and(eq(executions.agentId, agent.id), eq(executions.status, 'queued')))
    .limit(1)

  if (queued) {
    eventEmitter.emit('execution.queued', {
      executionId: queued.id,
      agentId: agent.id,
      status: 'queued',
    })
  }
}

/**
 * Clear waiting-input state. Sets questionData to null and status to idle.
 */
export async function clearWaitingInput(agent: Agent): Promise<void> {
  await transitionRuntimeStatus(agent, 'waiting-input', 'idle', { clearQuestion: true })
}
