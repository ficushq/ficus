import type { Command } from 'commander'
import type { WorktreeCleanupInspection } from '@ficus/shared'
import { apiGet, apiPatch } from '../client'
import { isJsonMode, output, outputError } from '../output'

export function registerWorkstreamCleanupCommands(ws: Command): void {
  const cleanup = ws.command('cleanup').description('Inspect original worktree ownership and stop automatic cleanup')
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
              ? 'Automatic cleanup is disabled. Before manual removal, verify exact paths, live users, Git state and recoverable commits. Keep active worktrees and branches.'
              : 'Do not remove or reuse this path. Retention cannot clear an in-flight operation or undo a completed removal.'
        )
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
