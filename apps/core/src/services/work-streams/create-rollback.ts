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
 *   which checks the directory identity and registration, refuses uncommitted
 *   changes, and archives reflog-only commits under `refs/ficus-archive/` before
 *   it removes the tree;
 * - the branch, only when the receipt says this create made it (`baseCommit`)
 *   and it still points at that commit. The delete is one command in the box
 *   that uses `git branch -D`, which refuses a branch any worktree has checked
 *   out, so another create that checked the branch out in the meantime keeps it.
 *   A pre-existing branch is never deleted.
 *
 * Anything that cannot be proven safe is left in place and logged; rollback
 * never replaces the create's own error. It runs under a deadline, so a hung
 * box cannot hold the request (and its idempotency key) indefinitely.
 */
import { posix as path } from 'node:path'
import { and, eq, or, sql } from 'drizzle-orm'
import { db, squads, workStreams } from '../../db'
import { createLogger } from '../../lib/infra/logger'
import type { RepositoryExec, WorktreeOwnership } from './repository-setup'
import { removeOwnedWorktree } from './worktree-cleanup-runtime'

const log = createLogger('work-stream-create')

/** Upper bound on the box commands of one rollback. */
export const CREATE_ROLLBACK_TIMEOUT_MS = 60_000

export interface ProvisioningRollback {
  worktree: 'removed' | 'retained' | 'failed'
  /** `pre-existing`: the create reused a branch it did not make, which is never deleted. */
  branch: 'deleted' | 'retained' | 'pre-existing'
  reason: string
}

/**
 * Delete `refs/heads/<branch>` only if it is still at `base`, in one box command.
 * `git branch -D` refuses a branch checked out in any worktree; plumbing such as
 * `update-ref -d` would not. Prints one word: deleted, moved, missing or in-use.
 */
const DELETE_CREATED_BRANCH = [
  'repo=$1; branch=$2; base=$3',
  'head=$(git -C "$repo" rev-parse --verify --quiet "refs/heads/$branch^{commit}") || { echo missing; exit 0; }',
  '[ "$head" = "$base" ] || { echo moved; exit 0; }',
  'if git -C "$repo" branch -D "$branch" >/dev/null 2>&1; then echo deleted; else echo in-use; fi',
].join('\n')

const BRANCH_KEPT: Record<string, string> = {
  moved: 'Branch moved since this create made it',
  missing: 'Branch is already gone',
  'in-use': 'Branch is checked out in another worktree',
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

  const outcome = (
    await exec([
      'sh',
      '-c',
      DELETE_CREATED_BRANCH,
      'ficus-create-rollback',
      ownership.repository,
      ownership.branch,
      createdFrom,
    ])
  ).trim()
  if (outcome !== 'deleted')
    return { worktree: 'removed', branch: 'retained', reason: BRANCH_KEPT[outcome] ?? 'Branch delete unproven' }
  return { worktree: 'removed', branch: 'deleted', reason: 'Owned worktree and the branch this create made removed' }
}

async function squadRepositoryExec(squadId: string, signal: AbortSignal): Promise<RepositoryExec> {
  const factory = await import('../sandbox/factory')
  const { Squad } = await import('../../entities/Squad')
  const manager = factory.getSandboxManager()
  const sandboxId = Squad.getSandboxId(squadId)
  return async (args, options) => (await manager.exec(sandboxId, args, { ...options, signal })).toString()
}

/** Why this create's provisioning must stay, or undefined when it may be removed. */
async function keepReason(
  squadId: string,
  workStreamId: string,
  ownership: WorktreeOwnership
): Promise<string | undefined> {
  if (ownership.worktree !== path.join(ownership.workspace, 'worktrees', workStreamId))
    return 'A caller-chosen worktree path is kept with its branch; another create with the same key may have adopted it, and a retry adopts it'
  return db.transaction(async (tx) => {
    // A create transaction holds this lock until it commits, so a commit still in
    // flight (its connection dropped at COMMIT) lands before the reads below.
    await tx.select({ id: squads.id }).from(squads).where(eq(squads.id, squadId)).for('update')
    const [landed] = await tx.select({ id: workStreams.id }).from(workStreams).where(eq(workStreams.id, workStreamId))
    if (landed) return 'The work stream committed; its worktree is kept'
    const git = sql`${workStreams.metadata}->'git'`
    const [referenced] = await tx
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
  })
}

/**
 * Best effort: logs and returns the outcome, never throws. Removes nothing that
 * another work stream (or this one, if it did commit) may use; see the module comment.
 */
export async function rollbackCreateProvisioning(
  squadId: string,
  workStreamId: string,
  ownership: WorktreeOwnership,
  options: { exec?: RepositoryExec; timeoutMs?: number } = {}
): Promise<ProvisioningRollback> {
  let result: ProvisioningRollback
  try {
    const reason = await keepReason(squadId, workStreamId, ownership)
    if (reason) {
      result = { worktree: 'retained', branch: ownership.baseCommit ? 'retained' : 'pre-existing', reason }
      log.warn(`Kept provisioning of work stream ${workStreamId}: ${reason}`)
      return result
    }
    const signal = AbortSignal.timeout(options.timeoutMs ?? CREATE_ROLLBACK_TIMEOUT_MS)
    result = await removeProvisionedWorktree(options.exec ?? (await squadRepositoryExec(squadId, signal)), ownership)
  } catch (error) {
    // A runner rejection (or the deadline) is an unknown outcome: report it, and never retry deletion here.
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
