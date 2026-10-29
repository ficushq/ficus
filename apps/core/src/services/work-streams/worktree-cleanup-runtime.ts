import { createHash } from 'node:crypto'
import runner from './worktree-cleanup-runner.sh' with { type: 'text' }
import type { RepositoryExec, WorktreeOwnership } from './repository-setup'

/** Ordered, runtime-observed identities; arrays keep receipt serialization stable across jsonb recovery. */
export interface WorktreeEvidence {
  files: string[]
  identities: string[][]
}

export interface WorktreeRemovalInput {
  ownership: WorktreeOwnership
  head: string
  operationId: string
  evidence?: WorktreeEvidence
}
export interface WorktreeRemovalReceipt {
  status: 'succeeded' | 'retained' | 'failed'
  reason: string
  /** Shared refs (refs/ficus-archive/<scope>/<oid>) preserving reflog-only history removed with the worktree. */
  archivedRefs?: string[]
  operationId: string
  digest: string
}

/** Resolve legacy work-stream files in the owning squad sandbox, never on the Core host.
 * Missing, non-file, non-workspace and aliased paths cannot qualify as external.
 * The same observer runs again inside the destructive runner, including its final check. */
export async function resolveWorktreeEvidence(
  exec: RepositoryExec,
  ownership: WorktreeOwnership,
  files: unknown
): Promise<WorktreeEvidence | undefined> {
  if (!Array.isArray(files)) throw new Error('Unrecognized evidence records')
  if (!files.length) return undefined
  const raw = await exec([
    'sh',
    '-c',
    runner,
    'ficus-worktree-cleanup',
    JSON.stringify({ ownership, files }),
    'evidence',
  ])
  const evidence = JSON.parse(raw) as WorktreeEvidence
  if (
    !evidence ||
    JSON.stringify(evidence.files) !== JSON.stringify(files) ||
    !Array.isArray(evidence.identities) ||
    evidence.identities.length !== files.length ||
    evidence.identities.some(
      (entry) => !Array.isArray(entry) || !entry.length || entry.some((value) => typeof value !== 'string')
    )
  )
    throw new Error('Unproven evidence identities')
  return evidence
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
    // Omit for old/no-evidence operations: their immutable receipt digest must not change.
    ...(input.evidence ? { evidence: { files: input.evidence.files, identities: input.evidence.identities } } : {}),
  })
  const raw = await exec(['sh', '-c', runner, 'ficus-worktree-cleanup', serialized, mode])
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
