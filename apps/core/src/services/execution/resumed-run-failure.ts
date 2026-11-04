import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { activeWorkflowAttempts, SYSTEM_RECIPIENT_ID } from '@ficus/shared'
import { isRestartContext } from '@ficus/shared/restart-context'
import { db, inbox, messages, recoveryEpisodes, slotClaims, slotPools, workStreamFlowRuns, workStreams } from '../../db'
import { createLogger } from '../../lib/infra/logger'
import type { DbHandle } from '../work-streams/waits'

const log = createLogger('resumed-run-failure')

/**
 * A run the platform resumed on the agent's behalf after an interruption: a
 * worker shutdown handed it off, startup recovered it from a dead process, or
 * the lease sweep requeued it. Every one of those paths commits a system
 * message carrying `admissionRecoveryExecutionId` for the execution it
 * requeues (see `recoverExecutions` in startup-recovery.ts), so that marker is
 * the durable proof. A run started from an inbox wake never carries it, which
 * is what keeps the re-wake below from feeding itself.
 */
export interface ResumedRun {
  /** True when a graceful worker stop handed the run off (a verified restart). */
  restart: boolean
}

export interface ResumedRunObligations {
  slotClaims: Array<{ claimId: string; poolKey: string; expiresAt: Date }>
  attempts: Array<{ workStreamId: string; workStreamNumber: number; attemptId: number; stepId: string }>
}

export async function findResumedRun(
  executionId: string,
  agentId: string,
  executor: DbHandle = db
): Promise<ResumedRun | null> {
  const [marker] = await executor
    .select({ metadata: messages.metadata })
    .from(messages)
    .where(
      and(
        eq(messages.agentId, agentId),
        sql`${messages.metadata}->>'admissionRecoveryExecutionId' = ${executionId}`,
        sql`${messages.metadata}->>'isSystem' = 'true'`
      )
    )
    .orderBy(desc(messages.createdAt))
    .limit(1)
  if (!marker) return null
  const metadata = marker.metadata as { restart?: unknown; restartPhase?: unknown } | null
  return { restart: metadata?.restartPhase === 'pause' && isRestartContext(metadata.restart) }
}

/** What the agent still holds that only it can finish or release. */
export async function findResumedRunObligations(
  agentId: string,
  executor: DbHandle = db
): Promise<ResumedRunObligations> {
  const claims = await executor
    .select({ claimId: slotClaims.id, poolKey: slotPools.key, expiresAt: slotClaims.expiresAt })
    .from(slotClaims)
    .innerJoin(slotPools, eq(slotPools.id, slotClaims.poolId))
    .where(
      and(
        eq(slotClaims.ownerAgentId, agentId),
        eq(slotClaims.status, 'active'),
        isNull(slotClaims.endedAt),
        sql`${slotClaims.expiresAt} > clock_timestamp()`
      )
    )
    .orderBy(slotPools.key)
  const runs = await executor
    .select({
      workStreamId: workStreams.id,
      workStreamNumber: workStreams.number,
      state: workStreamFlowRuns.state,
      attemptAgents: workStreamFlowRuns.attemptAgents,
    })
    .from(workStreamFlowRuns)
    .innerJoin(workStreams, eq(workStreams.id, workStreamFlowRuns.workStreamId))
    .where(
      and(
        eq(workStreamFlowRuns.activated, true),
        eq(workStreams.status, 'active'),
        sql`EXISTS (SELECT 1 FROM jsonb_each_text(${workStreamFlowRuns.attemptAgents}) AS owner WHERE owner.value = ${agentId})`
      )
    )
  const attempts = runs.flatMap((run) =>
    activeWorkflowAttempts(run.state)
      .filter((attempt) => run.attemptAgents[String(attempt.id)] === agentId)
      .map((attempt) => ({
        workStreamId: run.workStreamId,
        workStreamNumber: run.workStreamNumber,
        attemptId: attempt.id,
        stepId: attempt.stepId,
      }))
  )
  return { slotClaims: claims, attempts }
}

export function hasResumedRunObligations(obligations: ResumedRunObligations): boolean {
  return obligations.slotClaims.length > 0 || obligations.attempts.length > 0
}

function obligationLines(obligations: ResumedRunObligations): string[] {
  const lines: string[] = []
  for (const claim of obligations.slotClaims)
    lines.push(`- Slot claim ${claim.claimId} on pool ${claim.poolKey}, expiring at ${claim.expiresAt.toISOString()}.`)
  for (const attempt of obligations.attempts)
    lines.push(
      `- Work stream ${attempt.workStreamNumber} (${attempt.workStreamId}), flow attempt ${attempt.attemptId} on step ${attempt.stepId}.`
    )
  return lines
}

/**
 * The woken agent's instructions. It must not assume the interrupted work
 * finished or failed: the outcome is unknown, so it inspects state before
 * repeating anything with an external effect.
 */
export function resumedRunRetryContent(input: {
  executionId: string
  error: string | null
  obligations: ResumedRunObligations
}): string {
  const lines = [
    `Your run was resumed automatically after an interruption (a Ficus restart or a lost execution), and the resumed execution ${input.executionId} then failed: ${input.error ?? 'it stopped without a confirmed result.'}`,
    '',
    'The outcome of what was running when it stopped is unknown, and it may have partial effects. Inspect the current state first, then continue. Do not repeat a command or an external side effect (a push, a merge, a release, a deployment, a message) until you have confirmed it did not already happen.',
    '',
    'The runtime has authorized one bounded automatic retry. Preserve the original scope; every pause, wait, approval, attempt limit and recovery gate still applies.',
  ]
  if (hasResumedRunObligations(input.obligations)) {
    lines.push('', 'You still hold:', ...obligationLines(input.obligations))
    if (input.obligations.slotClaims.length)
      lines.push(
        '',
        'Check them with `ficus slot list`. Renew a claim only while its protected work still needs it, and release it as soon as that work is finished or abandoned.'
      )
    if (input.obligations.attempts.length)
      lines.push('', 'Check each attempt with `ficus workstream flow <id>` before continuing or submitting it.')
  }
  return lines.join('\n')
}

export type StrandedResumedRunReason = 'recovery-held' | 'not-counted' | 'recovery-unrecorded' | 'not-deliverable'

const REASON_TEXT: Record<StrandedResumedRunReason, string> = {
  'recovery-held':
    'its bounded recovery budget is exhausted or held, so it now needs a Continue or Stop decision on the recovery',
  'not-counted':
    'the failure was attributed to a known cause that bounded recovery does not retry automatically (for example an admission or provider refusal)',
  'recovery-unrecorded': 'its failure could not be recorded for bounded recovery, so no automatic retry was issued',
  'not-deliverable':
    'its work stream is paused, its attempt is waiting, or the agent cannot accept a wake right now, and those gates are not bypassed',
}

/**
 * Tell the squad manager (or the owner) that an agent is stranded with live
 * obligations. Routing uses the bounded-recovery audience for the episode's
 * CURRENT state, so an owner-escalated episode reaches the owner exactly like
 * its Continue / Stop decision. Without an eligible recipient it persists a
 * durable system diagnostic instead. Grants no authority.
 */
export async function notifyStrandedResumedRun(input: {
  agentId: string
  executionId: string
  error: string | null
  reason: StrandedResumedRunReason
  obligations: ResumedRunObligations
  recoveryId?: string
}): Promise<void> {
  const { recoveryRecipients } = await import('../recovery/recipients')
  const { initialRecoveryState } = await import('../recovery/policy')
  const [record] = input.recoveryId
    ? await db.select().from(recoveryEpisodes).where(eq(recoveryEpisodes.id, input.recoveryId))
    : []
  const workStreamId = record?.workStreamId ?? input.obligations.attempts[0]?.workStreamId ?? null
  const audience = await recoveryRecipients(
    record ?? {
      id: input.executionId,
      agentId: input.agentId,
      workStreamId,
      state: initialRecoveryState('continue the task'),
    }
  )
  const owner = audience.target === 'owner'
  const recipientIds = owner ? audience.ownerUserIds : audience.managerAgentId ? [audience.managerAgentId] : []
  const content = [
    `Agent ${input.agentId} was resumed automatically after an interruption, and the resumed execution ${input.executionId} failed: ${input.error ?? 'it stopped without a confirmed result.'}`,
    '',
    `It was not re-woken automatically because ${REASON_TEXT[input.reason]}.${input.recoveryId ? ` Recovery: ${input.recoveryId}.` : ''}`,
    '',
    'It still holds:',
    ...obligationLines(input.obligations),
    '',
    'The outcome of its interrupted work is unknown. Decide through the normal routes whether it should continue, and whether its claims should be renewed or released; this notice does not lift any pause, wait, approval or recovery hold.',
  ].join('\n')
  const metadata = {
    source: 'resumed-run-stranded',
    agentId: input.agentId,
    executionId: input.executionId,
    reason: input.reason,
    squadId: audience.squadId,
    slotClaimIds: input.obligations.slotClaims.map((claim) => claim.claimId),
    attempts: input.obligations.attempts.map(({ workStreamId, attemptId }) => ({ workStreamId, attemptId })),
    ...(input.recoveryId ? { recoveryId: input.recoveryId } : {}),
    ...(workStreamId ? { workStreamId } : {}),
  }
  if (!recipientIds.length) {
    // Same durable, idempotent operator surface as an unroutable recovery.
    log.warn('A failed resumed run has live obligations but no manager or owner to notify', {
      agentId: input.agentId,
      executionId: input.executionId,
    })
    await db
      .insert(inbox)
      .values({
        recipientType: 'system',
        recipientId: SYSTEM_RECIPIENT_ID,
        senderType: 'system',
        subject: 'A stranded resumed run has no authorized recipient',
        content: `${content}\n\nNo enabled, authorized manager or owner could be resolved. Restore the authorized routing; do not bypass any gate.`,
        metadata: { ...metadata, source: 'resumed-run-stranded-unroutable' },
        idempotencyKey: `resumed-run-stranded-unroutable:${input.executionId}`,
      })
      .onConflictDoNothing()
    return
  }
  const { InboxMessage } = await import('../../entities/InboxMessage')
  for (const recipientId of recipientIds) {
    await InboxMessage.sendOnce(
      {
        recipientType: owner ? 'user' : 'agent',
        recipientId,
        senderType: 'system',
        ...(owner ? {} : { wakeEligible: true }),
        subject: 'A resumed run failed while holding a slot or flow attempt',
        content,
        metadata,
      },
      `resumed-run-stranded:${input.executionId}:${recipientId}`
    )
  }
}
