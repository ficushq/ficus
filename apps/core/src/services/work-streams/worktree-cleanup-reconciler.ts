import { resolveWorktreeAttachments } from './worktree-cleanup-attachments'
import { createHash } from 'node:crypto'
import { and, eq, inArray, isNull, lte, sql, asc } from 'drizzle-orm'
import { db, squads, workStreams, workStreamWorktrees, worktreeCleanupJobs } from '../../db'
import { WorkStream } from '../../entities/WorkStream'
import { InboxMessage } from '../../entities/InboxMessage'
import { eventEmitter } from '../../lib/infra/event-emitter'
import { createLogger } from '../../lib/infra/logger'
import { claimWorktreeCleanup } from './worktree-cleanup-store'
import { removeOwnedWorktree, type WorktreeRemovalInput } from './worktree-cleanup-runtime'
import { verifyWorktreeCleanupDelivery, WorktreeDeliveryUnprovenError } from './worktree-cleanup-delivery'
import type { RepositoryExec } from './repository-setup'

const log = createLogger('worktree-cleanup')
type Job = typeof worktreeCleanupJobs.$inferSelect
export interface CleanupDependencies {
  execForSquad(squadId: string): Promise<RepositoryExec>
  verify(input: Parameters<typeof verifyWorktreeCleanupDelivery>[0], exec: RepositoryExec): Promise<string>
  notify(id: string): Promise<void>
}

/** Capped retry delay; no timer or noisy per-job polling process is created. */
export function cleanupRetryDelay(attempts: number): number {
  return Math.min(3_600_000, 15_000 * 2 ** Math.min(8, Math.max(0, attempts)))
}

const defaults: CleanupDependencies = {
  async execForSquad(squadId) {
    const { ensureSquadSandbox } = await import('../sandbox/ensure')
    const { getSandboxManager } = await import('../sandbox/factory')
    const { Squad } = await import('../../entities/Squad')
    await ensureSquadSandbox(squadId)
    const manager = getSandboxManager()
    return async (args) => (await manager.exec(Squad.getSandboxId(squadId), args)).toString()
  },
  async verify(input, exec) {
    const { codeHostingRegistry } = await import('../integrations/code-hosting')
    return verifyWorktreeCleanupDelivery(input, exec, codeHostingRegistry)
  },
  notify: notifyCleanupBlocker,
}

async function reschedule(job: Job, status: Job['status'], reason: string): Promise<void> {
  await db
    .update(worktreeCleanupJobs)
    .set({
      status,
      reason,
      attempts: job.attempts + 1,
      nextAttemptAt: new Date(Date.now() + cleanupRetryDelay(job.attempts)),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(worktreeCleanupJobs.workStreamId, job.workStreamId),
        eq(worktreeCleanupJobs.status, job.status),
        eq(worktreeCleanupJobs.generation, job.generation),
        job.operationId ? eq(worktreeCleanupJobs.operationId, job.operationId) : isNull(worktreeCleanupJobs.operationId)
      )
    )
}

/** Recovery redelivers only the EXACT persisted operation. The runtime's durable
 * exclusive marker refuses takeover; its immutable receipt prevents late duplicate
 * requests from deleting a replacement. Uncertain outcomes never release reuse. */
export async function processWorktreeCleanup(
  id: string,
  dependencies: Partial<CleanupDependencies> = {}
): Promise<void> {
  const deps = { ...defaults, ...dependencies }
  const [job] = await db.select().from(worktreeCleanupJobs).where(eq(worktreeCleanupJobs.workStreamId, id))
  const stream = await WorkStream.find(id)
  if (!job || !stream || ['succeeded', 'skipped'].includes(job.status)) return
  let input: WorktreeRemovalInput | null = job.removalInput
  try {
    if (!job.operationId) {
      if (stream.status !== 'done' || stream.pause || !stream.autoCleanupWorktree) {
        await reschedule(job, 'skipped', 'Cleanup is disabled or this work stream is not delivered')
        return
      }
      const [registered] = await db.select().from(workStreamWorktrees).where(eq(workStreamWorktrees.workStreamId, id))
      if (!registered) {
        await reschedule(
          job,
          'skipped',
          'No platform-created dedicated worktree; nothing is eligible for automatic removal'
        )
        return
      }
      const git = stream.metadata.git as Record<string, unknown> | undefined
      if ((['worktree', 'repository', 'branch'] as const).some((key) => git?.[key] !== registered.ownership[key])) {
        await reschedule(
          job,
          'deferred',
          'Current git bindings do not match the owned worktree. Use ficus workstream cleanup inspect ' +
            id +
            '; cleanup retain can stop retries before any removal starts.'
        )
        return
      }
      if (!job.deliveredHead) {
        await reschedule(job, 'skipped', 'No authoritative delivered head was captured; retain this worktree')
        return
      }
      const exec = await deps.execForSquad(stream.squadId)
      const head = await deps.verify(
        {
          metadata: stream.metadata,
          mode: stream.completionMode,
          deliveredHead: job.deliveredHead,
          repository: registered.ownership.repository,
          squadId: stream.squadId,
        },
        exec
      )
      const others = await db
        .select({ id: workStreams.id, metadata: workStreams.metadata })
        .from(workStreams)
        .where(eq(workStreams.squadId, stream.squadId))
      const attachments = await resolveWorktreeAttachments(
        exec,
        registered.ownership.workspace,
        others.filter((other) => other.id !== id)
      )
      input = await claimWorktreeCleanup(id, {
        generation: job.generation,
        ownership: registered.ownership,
        head,
        metadata: stream.metadata,
        attachments,
      })
      if (!input) return
    } else if (!input || input.operationId !== job.operationId) {
      await reschedule(job, 'error', 'Persisted removal identity is incomplete; do not reuse the worktree')
      return
    }
    const exec = await deps.execForSquad(stream.squadId)
    const receipt = await removeOwnedWorktree(exec, input!)
    await db
      .update(worktreeCleanupJobs)
      .set({
        status: receipt.status === 'succeeded' ? 'succeeded' : receipt.status === 'retained' ? 'deferred' : 'error',
        reason: receipt.reason,
        // New claims already counted this attempt; receipt recovery must also advance backoff.
        attempts: sql`${worktreeCleanupJobs.attempts} + ${job.operationId ? 1 : 0}`,
        ...(receipt.status === 'retained' ? { operationId: null, removalInput: null } : {}),
        nextAttemptAt: new Date(Date.now() + cleanupRetryDelay(job.attempts)),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(worktreeCleanupJobs.workStreamId, id),
          eq(worktreeCleanupJobs.generation, job.generation),
          eq(worktreeCleanupJobs.operationId, input!.operationId)
        )
      )
  } catch (error) {
    // Never expose raw remote output, paths to secrets, or provider credentials. Delivery refusals
    // carry only fixed, sanitized reasons, so those are surfaced; anything else stays generic.
    const [current] = await db.select().from(worktreeCleanupJobs).where(eq(worktreeCleanupJobs.workStreamId, id))
    if (
      current &&
      current.generation === job.generation &&
      current.operationId === (input?.operationId ?? job.operationId) &&
      !['succeeded', 'skipped'].includes(current.status)
    ) {
      const unknown = Boolean(current.operationId)
      await reschedule(
        current,
        unknown ? 'removing' : 'deferred',
        unknown
          ? 'Removal has no proven terminal receipt. The same worktree remains fenced; cleanup will retry the exact operation only.'
          : error instanceof WorktreeDeliveryUnprovenError
            ? `Delivery is not proven: ${error.message}. No removal was dispatched; cleanup will retry.`
            : 'Delivery or runtime verification is unavailable. No removal was dispatched; cleanup will retry.'
      )
    }
    log.debug('Cleanup deferred', { workStreamId: id, errorName: error instanceof Error ? error.name : 'unknown' })
  } finally {
    eventEmitter.emit('workStream.updated', { workStreamId: id, squadId: stream.squadId })
    await deps.notify(id).catch(() => log.warn('Cleanup blocker notification deferred', { workStreamId: id }))
  }
}

/** Startup + periodic outbox reconciliation also covers missed shutdown events. */
export async function reconcileWorktreeCleanup(): Promise<void> {
  const due = await db
    .select({ id: worktreeCleanupJobs.workStreamId })
    .from(worktreeCleanupJobs)
    .where(
      and(
        inArray(worktreeCleanupJobs.status, ['pending', 'deferred', 'removing', 'error']),
        lte(worktreeCleanupJobs.nextAttemptAt, sql`clock_timestamp()`)
      )
    )
    .orderBy(asc(worktreeCleanupJobs.nextAttemptAt))
    .limit(20)
  for (const row of due) {
    try {
      await processWorktreeCleanup(row.id)
    } catch {
      log.warn('Cleanup reconciliation unavailable', { workStreamId: row.id })
    }
  }
}

async function notifyCleanupBlocker(id: string): Promise<void> {
  const [row] = await db
    .select({ stream: workStreams, job: worktreeCleanupJobs, managerId: squads.managerAgentId })
    .from(workStreams)
    .innerJoin(worktreeCleanupJobs, eq(worktreeCleanupJobs.workStreamId, workStreams.id))
    .innerJoin(squads, eq(squads.id, workStreams.squadId))
    .where(eq(workStreams.id, id))
  if (
    !row ||
    !['deferred', 'removing', 'error'].includes(row.job.status) ||
    !row.job.reason ||
    row.job.reason.startsWith('Associated executions') ||
    row.job.reason.startsWith('Removal claimed')
  )
    return
  const recipientId = row.stream.ownerAgentId ?? row.managerId
  if (!recipientId) return
  const digest = createHash('sha256').update(row.job.reason).digest('hex')
  await InboxMessage.sendOnce(
    {
      recipientType: 'agent',
      recipientId,
      senderType: 'system',
      wakeEligible: true,
      subject: `Worktree cleanup retained: ${row.stream.title.slice(0, 80)}`,
      content: `Delivered work stream ${id} remains done.\nCleanup: ${row.job.status}. ${row.job.reason}\nInspect: ficus workstream cleanup inspect ${id}\nRetain (no deletion; rejected while removal is in flight): ficus workstream cleanup retain ${id}`,
      metadata: { source: 'worktree-cleanup', workStreamId: id, squadId: row.stream.squadId },
    },
    `worktree-cleanup:${id}:${digest}`
  )
}
