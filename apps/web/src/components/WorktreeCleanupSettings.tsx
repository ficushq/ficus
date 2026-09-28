import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { WorkStream } from '@ficus/shared'
import { client } from '../api/clientInstance'
import { queryKeys } from '../queryKeys'
import { usePermissions } from '../hooks/usePermissions'
import { actionErrorMessage } from '../lib/actionError'

export function WorktreeCleanupSettings({ stream }: { stream: WorkStream }) {
  const { can, isLoading } = usePermissions(stream.squadId)
  const cache = useQueryClient()
  const action = useMutation({
    mutationFn: (enabled: boolean) => client.workStreams.setAutoCleanupWorktree(stream.id, enabled),
    onSuccess: (updated) => {
      cache.setQueryData(queryKeys.squads.workStreamDetail(stream.id), updated)
      cache.invalidateQueries({ queryKey: queryKeys.squads.all })
    },
  })
  const cleanup = stream.worktreeCleanup
  const fenced = cleanup?.status === 'removing' || (cleanup?.status === 'error' && !!cleanup.operationId)
  const reclaimed = cleanup?.status === 'succeeded'
  return (
    <section className="space-y-2 border-t border-panel-border pt-4" aria-label="Worktree cleanup">
      <label className="flex items-center gap-2 text-sm font-medium text-primary">
        <input
          type="checkbox"
          className="accent-accent disabled:cursor-default"
          checked={stream.autoCleanupWorktree ?? false}
          disabled={isLoading || !can('workstreams:update') || action.isPending || fenced || reclaimed}
          onChange={(event) => action.mutate(event.currentTarget.checked)}
        />
        Automatically clean up the worktree
      </label>
      <p className="text-xs text-secondary">
        Enabled by default for new work streams. Cleanup runs after delivery and associated executions finish. Disable
        before finishing to retain the worktree. Dirty or shared worktrees are retained.
      </p>
      {!stream.worktree && <p className="text-xs text-secondary">No worktree is attached; nothing will be removed.</p>}
      {cleanup && (
        <p className="text-xs text-secondary">
          Cleanup: {cleanup.status}. {cleanup.reason}
        </p>
      )}
      {fenced && (
        <p className="text-xs text-secondary">Do not reuse or modify this path while removal awaits terminal proof.</p>
      )}
      {reclaimed && (
        <p className="text-xs text-secondary">
          The branch and delivery history are retained. Provision a new work stream for further work.
        </p>
      )}
      {action.isPending && (
        <p role="status" className="text-xs text-secondary">
          Saving retention setting…
        </p>
      )}
      {action.isError && (
        <p role="alert" className="text-xs text-status-danger-400">
          {actionErrorMessage(action.error)}
        </p>
      )}
    </section>
  )
}
