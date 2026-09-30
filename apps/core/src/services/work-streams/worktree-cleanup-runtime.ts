import { createHash } from 'node:crypto'
import runner from './worktree-cleanup-runner.sh' with { type: 'text' }
import type { RepositoryExec, WorktreeOwnership } from './repository-setup'

export interface WorktreeRemovalInput {
  ownership: WorktreeOwnership
  head: string
  operationId: string
}
export interface WorktreeRemovalReceipt {
  status: 'succeeded' | 'retained' | 'failed'
  reason: string
  /** Shared refs (refs/ficus-archive/<scope>/<oid>) preserving reflog-only history removed with the worktree. */
  archivedRefs?: string[]
  operationId: string
  digest: string
}

/** Caller must durably fence reuse before dispatch. Rejections mean unknown outcome,
 * not permission to release the fence. Replays never repeat a completed removal. */
export async function removeOwnedWorktree(
  exec: RepositoryExec,
  input: WorktreeRemovalInput
): Promise<WorktreeRemovalReceipt> {
  return invoke(exec, input, 'remove')
}

/** Recovery is read-only: a missing receipt never dispatches another deletion. */
export async function readWorktreeRemovalReceipt(
  exec: RepositoryExec,
  input: WorktreeRemovalInput
): Promise<WorktreeRemovalReceipt> {
  return invoke(exec, input, 'probe')
}

async function invoke(
  exec: RepositoryExec,
  input: WorktreeRemovalInput,
  mode: 'remove' | 'probe'
): Promise<WorktreeRemovalReceipt> {
  // PostgreSQL jsonb may reorder both outer and nested keys on recovery.
  const serialized = JSON.stringify({
    head: input.head,
    operationId: input.operationId,
    ownership: Object.fromEntries(Object.entries(input.ownership).sort(([a], [b]) => a.localeCompare(b))),
  })
  const raw = await exec(['sh', '-c', runner, 'tau-worktree-cleanup', serialized, mode])
  const receipt = JSON.parse(raw) as WorktreeRemovalReceipt
  if (
    !receipt ||
    receipt.operationId !== input.operationId ||
    receipt.digest !== createHash('sha256').update(serialized).digest('hex') ||
    !['succeeded', 'retained', 'failed'].includes(receipt.status) ||
    typeof receipt.reason !== 'string' ||
    (receipt.archivedRefs !== undefined &&
      (!Array.isArray(receipt.archivedRefs) || receipt.archivedRefs.some((ref) => typeof ref !== 'string')))
  ) {
    throw new Error('Worktree cleanup outcome is unproven; keep the reuse fence')
  }
  return receipt
}
