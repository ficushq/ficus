import { eq } from 'drizzle-orm'
import type { WorktreeCleanupInspection } from '@ficus/shared'
import { db, workStreams, workStreamWorktrees, worktreeCleanupJobs } from '../../db'

/** A single read snapshot; never starts a sandbox or changes cleanup ownership. */
export async function inspectWorktreeCleanup(id: string): Promise<WorktreeCleanupInspection | null> {
  const [row] = await db
    .select({ stream: workStreams, registration: workStreamWorktrees, job: worktreeCleanupJobs })
    .from(workStreams)
    .leftJoin(workStreamWorktrees, eq(workStreamWorktrees.workStreamId, workStreams.id))
    .leftJoin(worktreeCleanupJobs, eq(worktreeCleanupJobs.workStreamId, workStreams.id))
    .where(eq(workStreams.id, id))
  if (!row) return null
  const { stream, registration, job } = row
  const git = (stream.metadata as Record<string, unknown>)?.git as Record<string, unknown> | undefined
  const keys = ['repository', 'worktree', 'branch'] as const
  const current = Object.fromEntries(
    keys.filter((key) => typeof git?.[key] === 'string').map((key) => [key, git![key]])
  )
  return {
    workStreamId: id,
    autoCleanupWorktree: stream.autoCleanupWorktree,
    owned: registration?.ownership ?? null,
    current,
    bindingsMatch: registration ? keys.every((key) => current[key] === registration.ownership[key]) : null,
    cleanup: job
      ? {
          status: job.status,
          reason: job.reason,
          attempts: job.attempts,
          operationId: job.operationId,
          nextAttemptAt: job.nextAttemptAt.toISOString(),
          updatedAt: job.updatedAt.toISOString(),
        }
      : null,
    recovery:
      job?.status === 'succeeded'
        ? 'reclaimed'
        : job?.operationId || job?.status === 'removing'
          ? 'in-flight'
          : stream.autoCleanupWorktree
            ? 'retain'
            : 'retained',
  }
}
