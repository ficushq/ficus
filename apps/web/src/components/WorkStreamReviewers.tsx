import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { workflowGateHasNoActiveAssignedReviewer, type WorkStream } from '@ficus/shared'
import { client } from '../api/clientInstance'
import { queries } from '../queryOptions'
import { queryKeys } from '../queryKeys'
import { usePermissions } from '../hooks/usePermissions'

/**
 * On an open stream whose assigned reviewers are all inactive: the owner and admins now decide its
 * assigned-reviewers approvals, and someone should assign an active reviewer. Clears once one is.
 */
export function NoActiveReviewerNotice({ stream }: { stream: WorkStream }) {
  if (stream.status === 'done' || stream.status === 'canceled') return null
  if (!workflowGateHasNoActiveAssignedReviewer(stream.assignedReviewerIds, stream.inactiveAssignedReviewerIds))
    return null
  return (
    <p
      role="status"
      aria-label="No active assigned reviewer"
      className="rounded border border-th-border p-3 text-xs text-status-warning-700 dark:text-status-warning-400"
    >
      No assigned reviewer of this work stream is still active, so its owner and admins decide the approvals meant for
      assigned reviewers. Assign an active reviewer under Workflow, then Manage workflow.
    </p>
  )
}

export function WorkStreamReviewers({ stream }: { stream: WorkStream }) {
  if (stream.status === 'done' || stream.status === 'canceled') return null
  return <ActiveWorkStreamReviewers stream={stream} />
}

function ActiveWorkStreamReviewers({ stream }: { stream: WorkStream }) {
  const { can } = usePermissions(stream.squadId)
  const cache = useQueryClient()
  const { data: people = [], isLoading, error } = useQuery(queries.workflows.reviewers(stream.squadId))
  const update = useMutation({
    mutationFn: (ids: string[]) => client.workflows.assignReviewers(stream.id, ids),
    onSuccess: async () => {
      await cache.invalidateQueries({ queryKey: queryKeys.squads.all })
      await cache.invalidateQueries({ queryKey: queryKeys.workflows.all })
    },
  })
  const ids = stream.assignedReviewerIds ?? []
  const inactive = stream.inactiveAssignedReviewerIds ?? []
  const noneActive = workflowGateHasNoActiveAssignedReviewer(ids, inactive)
  return (
    <div className="space-y-2 text-sm" aria-label="Assigned reviewers">
      <div className="font-medium">Assigned reviewers</div>
      <p className="text-xs text-muted">
        Any one assigned reviewer can decide when an approval step uses “Assigned reviewers.” Review permission is also
        required.
      </p>
      {ids.map((id) => (
        <div key={id} className="flex items-center justify-between gap-2">
          <span>
            {people.find((person) => person.id === id)?.name ?? 'Unavailable reviewer'}
            {inactive.includes(id) && <span className="text-muted"> · no longer active</span>}
          </span>
          {can('workstreams:update') && (
            <button
              type="button"
              className="ficus-button ficus-button-danger px-2 py-1 text-xs"
              disabled={update.isPending}
              onClick={() => update.mutate(ids.filter((value) => value !== id))}
            >
              Remove<span className="sr-only"> reviewer {id}</span>
            </button>
          )}
        </div>
      ))}
      {noneActive && (
        <p role="alert" className="text-xs text-status-warning-700 dark:text-status-warning-400">
          No assigned reviewer is still active, so the owner and admins decide approvals meant for assigned reviewers.
          Assign an active reviewer.
        </p>
      )}
      {!ids.length && (
        <p className="text-xs text-muted">No reviewers assigned — anyone with review permission can decide.</p>
      )}
      {can('workstreams:update') && (
        <select
          aria-label="Assign reviewer"
          className="ficus-field w-full rounded-md border border-th-border px-3 py-2"
          value=""
          disabled={isLoading || !!error || update.isPending || ids.length >= 64}
          onChange={(event) => {
            if (event.target.value) update.mutate([...ids, event.target.value])
          }}
        >
          <option value="">{isLoading ? 'Loading reviewers…' : 'Assign a reviewer…'}</option>
          {people
            .filter((person) => !ids.includes(person.id))
            .map((person) => (
              <option key={person.id} value={person.id}>
                {person.name}
              </option>
            ))}
        </select>
      )}
      {!isLoading && !error && !people.length && (
        <p className="text-xs text-muted">No users have review permission in this squad yet.</p>
      )}
      {(update.error || error) && (
        <p role="alert" className="text-xs text-status-danger-600 dark:text-status-danger-400">
          {update.error ? update.error.message : 'Could not load reviewers.'}
        </p>
      )}
    </div>
  )
}
