import type { Command } from 'commander'
import type { WorktreeCleanupInspection } from '@ficus/shared'
import { apiGet, apiPatch, apiPost } from '../client'
import { isJsonMode, output, outputError } from '../output'

/** Point-of-use guidance for worktree cleanup diagnosis; the static agent prompt keeps only the retain command. */
export const CLEANUP_HELP = `
New streams default to automatic cleanup (create/update --auto-cleanup-worktree).
After delivered done, the platform removes a worktree it provisioned once the
stream's executions settle and no dependent or bound stream still uses it. Do not
reuse, recreate or remove a cleanup-owned path, even when it appears missing.

retain works before or after delivery while no removal is in flight; it stops
automatic cleanup without deleting files or rewriting ownership.

Duplicate folders or binding mismatches:
  1. Run inspect --json and compare owned (the original server-observed creation
     receipt) with current (metadata.git). A null cleanup means no cleanup job
     exists, not that no worktree is owned.
  2. Do not fix a mismatch by rewriting bindings, ownership or database rows.
     Retain first.
  3. After retention, an authorized operator may remove only trees confirmed
     unused by fresh live-use, uncommitted-change and unpushed-commit checks.
     Keep open-PR trees and recoverable branches; disabling cleanup does not
     prove a folder is disposable.

An uncertain removal blocks reuse; reconcile collects non-destructive proof and
never clears operation markers by age. After a completed removal, provision a new
stream for further work; the branch and delivery history remain. Historical or
manually created trees without platform ownership are retained, not swept.
`

export function registerWorkstreamCleanupCommands(ws: Command): void {
  const cleanup = ws
    .command('cleanup')
    .description('Inspect ownership, reconcile fenced operations and stop automatic cleanup')
    .addHelpText('after', CLEANUP_HELP)
  cleanup
    .command('inspect <id>')
    .description('Read original ownership, current bindings and recovery state')
    .action(async (id: string) => {
      try {
        const result = await apiGet<WorktreeCleanupInspection>(
          `/api/workstreams/${encodeURIComponent(id)}/worktree-cleanup`
        )
        if (isJsonMode()) {
          output(result)
          return
        }
        console.log(`Owned worktree: ${result.owned?.worktree ?? '(none — not platform-created)'}`)
        console.log(`Owned branch:   ${result.owned?.branch ?? '(none)'}`)
        console.log(`Owned repository: ${result.owned?.repository ?? '(none)'}`)
        console.log(`Current worktree: ${result.current.worktree ?? '(none)'}`)
        console.log(`Current branch: ${result.current.branch ?? '(none)'}`)
        console.log(`Current repository: ${result.current.repository ?? '(none)'}`)
        console.log(
          `Bindings match: ${result.bindingsMatch === null ? 'not applicable' : result.bindingsMatch ? 'yes' : 'NO'}`
        )
        console.log(
          `Cleanup: ${result.cleanup?.status ?? 'not queued'}${result.cleanup?.reason ? ` — ${result.cleanup.reason}` : ''}`
        )
        console.log(`Recovery: ${result.recovery}`)
        console.log(
          result.recovery === 'retain'
            ? `Run ficus workstream cleanup retain ${result.workStreamId} to stop automatic cleanup without deleting files or rewriting ownership.`
            : result.recovery === 'retained'
              ? 'Automatic removal is stopped. Before manual removal, disable automatic cleanup and verify exact paths, live users, Git state and recoverable commits. Keep active worktrees and branches.'
              : 'Do not remove or reuse this path. For an in-flight operation, cleanup reconcile can collect non-destructive proof; it never clears uncertainty by age. Retention cannot clear an unverified removal or undo a completed removal.'
        )
      } catch (error) {
        outputError(error as Error)
      }
    })
  cleanup
    .command('reconcile <id>')
    .description('Reconcile an existing removal without dispatching deletion; uncertainty stays fenced')
    .action(async (id: string) => {
      try {
        const result = await apiPost<WorktreeCleanupInspection>(
          `/api/workstreams/${encodeURIComponent(id)}/worktree-cleanup/reconcile`
        )
        output(result)
      } catch (error) {
        outputError(error as Error)
      }
    })
  cleanup
    .command('retain <id>')
    .description('Disable automatic cleanup, even after delivery; never deletes files or clears in-flight removal')
    .action(async (id: string) => {
      try {
        // The existing lifecycle mutation atomically invalidates unclaimed jobs and
        // refuses an in-flight removal. An inspection snapshot is not authorization.
        const result = await apiPatch(`/api/workstreams/${encodeURIComponent(id)}`, { autoCleanupWorktree: false })
        output(
          result,
          'Automatic cleanup disabled. No files deleted or ownership rewritten. Inspect ownership and verify live use, Git state and recovery before any manual removal.'
        )
      } catch (error) {
        outputError(error as Error)
      }
    })
}
