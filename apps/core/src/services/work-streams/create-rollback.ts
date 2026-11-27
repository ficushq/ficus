/**
 * Undo the repository provisioning of a work stream create that never
 * committed (its transaction failed, or it lost its idempotency claim).
 *
 * Only a worktree at the stream-unique default path (`worktrees/<streamId>`) is
 * removed. A caller-chosen `--worktree` path is kept with its branch: a repeat
 * with the same key may have taken the claim over and adopted that very path
 * (repository-setup.ts reuses an existing worktree on the requested branch),
 * and a retry adopts it the same way. Nothing is removed while any stream in
 * the squad references the worktree path, or the repository and branch.
 *
 * Within those limits, only what that create's ownership receipt names is touched:
 * - the worktree, through the native cleanup runner (worktree-cleanup-runtime.ts),
 *   which checks the directory identity and registration and refuses
 *   uncommitted or unpublished work;
 * - the branch, only when the receipt says this create made it (`baseCommit`),
 *   nothing has it checked out, and it still points at the commit it was made
 *   from. A pre-existing branch is never deleted.
 *
 * Anything that cannot be proven safe is left in place and logged; rollback
 * never replaces the create's own error.
 */
import { posix as path } from 'node:path'
import { and, eq, or, sql } from 'drizzle-orm'
import { db, workStreams } from '../../db'
import { createLogger } from '../../lib/infra/logger'
import type { RepositoryExec, WorktreeOwnership } from './repository-setup'
import { removeOwnedWorktree } from './worktree-cleanup-runtime'

const log = createLogger('work-stream-create')

export interface ProvisioningRollback {
  worktree: 'removed' | 'retained' | 'failed'
  /** `pre-existing`: the create reused a branch it did not make, which is never deleted. */
  branch: 'deleted' | 'retained' | 'pre-existing'
  reason: string
}

export async function removeProvisionedWorktree(
  exec: RepositoryExec,
  ownership: WorktreeOwnership
): Promise<ProvisioningRollback> {
  const createdFrom = ownership.baseCommit
  const untouchedBranch = createdFrom ? 'retained' : 'pre-existing'
  // A created branch must still be at its starting commit; the runner refuses a moved HEAD.
  const head = createdFrom ?? (await exec(['git', '-C', ownership.worktree, 'rev-parse', 'HEAD'])).trim()
  const receipt = await removeOwnedWorktree(exec, { ownership, head, operationId: crypto.randomUUID() })
  if (receipt.status !== 'succeeded')
    return { worktree: receipt.status, branch: untouchedBranch, reason: receipt.reason }
  if (!createdFrom) return { worktree: 'removed', branch: 'pre-existing', reason: receipt.reason }

  const ref = `refs/heads/${ownership.branch}`
  const git = (...args: string[]) => exec(['git', '-C', ownership.repository, ...args])
  const checkedOut = (await git('worktree', 'list', '--porcelain')).split('\n').includes(`branch ${ref}`)
  if (checkedOut)
    return { worktree: 'removed', branch: 'retained', reason: 'Branch is checked out in another worktree' }
  try {
    // The old-value argument makes this a compare-and-delete: a moved branch is kept.
    await git('update-ref', '-d', ref, createdFrom)
  } catch {
    return { worktree: 'removed', branch: 'retained', reason: 'Branch moved since this create made it' }
  }
  return { worktree: 'removed', branch: 'deleted', reason: 'Owned worktree and the branch this create made removed' }
}

async function squadRepositoryExec(squadId: string): Promise<RepositoryExec> {
  const factory = await import('../sandbox/factory')
  const { Squad } = await import('../../entities/Squad')
  const manager = factory.getSandboxManager()
  const sandboxId = Squad.getSandboxId(squadId)
  return async (args, options) => (await manager.exec(sandboxId, args, options)).toString()
}

/** Why this create's provisioning must stay, or undefined when it may be removed. */
async function keepReason(
  squadId: string,
  workStreamId: string,
  ownership: WorktreeOwnership
): Promise<string | undefined> {
  // A commit whose outcome was unknown (the connection dropped at COMMIT) may still have landed.
  const [landed] = await db.select({ id: workStreams.id }).from(workStreams).where(eq(workStreams.id, workStreamId))
  if (landed) return 'The work stream committed; its worktree is kept'
  if (ownership.worktree !== path.join(ownership.workspace, 'worktrees', workStreamId))
    return 'A caller-chosen worktree path is kept with its branch; another create with the same key may have adopted it, and a retry adopts it'
  const git = sql`${workStreams.metadata}->'git'`
  const [referenced] = await db
    .select({ id: workStreams.id })
    .from(workStreams)
    .where(
      and(
        eq(workStreams.squadId, squadId),
        or(
          sql`${git}->>'worktree' = ${ownership.worktree}`,
          sql`${git}->>'repository' = ${ownership.repository} AND ${git}->>'branch' = ${ownership.branch}`
        )
      )
    )
    .limit(1)
  if (referenced) return `Work stream ${referenced.id} references this worktree or branch; both are kept`
  return undefined
}

/**
 * Best effort: logs and returns the outcome, never throws. Removes nothing that
 * another work stream (or this one, if it did commit) may use; see the module comment.
 */
export async function rollbackCreateProvisioning(
  squadId: string,
  workStreamId: string,
  ownership: WorktreeOwnership,
  options: { exec?: RepositoryExec } = {}
): Promise<ProvisioningRollback> {
  let result: ProvisioningRollback
  try {
    const reason = await keepReason(squadId, workStreamId, ownership)
    if (reason) {
      result = { worktree: 'retained', branch: ownership.baseCommit ? 'retained' : 'pre-existing', reason }
      log.warn(`Kept provisioning of work stream ${workStreamId}: ${reason}`)
      return result
    }
    result = await removeProvisionedWorktree(options.exec ?? (await squadRepositoryExec(squadId)), ownership)
  } catch (error) {
    // A runner rejection is an unknown outcome: report it, and never retry deletion here.
    result = {
      worktree: 'failed',
      branch: ownership.baseCommit ? 'retained' : 'pre-existing',
      reason: error instanceof Error ? error.message : String(error),
    }
  }
  const line = `Rolled back provisioning of uncommitted work stream ${workStreamId}: worktree ${result.worktree}, branch ${result.branch} (${result.reason})`
  if (result.worktree === 'removed' && result.branch !== 'retained') log.info(line)
  else log.warn(line)
  return result
}
