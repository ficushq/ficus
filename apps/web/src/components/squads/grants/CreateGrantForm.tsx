import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { GrantPolicy } from '@ficus/shared'
import { createGrant } from '../../../api/grants'
import { queries } from '../../../queryOptions'
import { queryKeys } from '../../../queryKeys'
import { GrantPolicyEditor } from './GrantPolicyEditor'

interface Props {
  sourceSquadId: string
  onClose: () => void
}

export function CreateGrantForm({ sourceSquadId, onClose }: Props) {
  const queryClient = useQueryClient()
  const [granteeSquadId, setGranteeSquadId] = useState('')
  const [expiresAt, setExpiresAt] = useState('')
  const [policy, setPolicy] = useState<GrantPolicy>({ read: { sourceTypes: ['memory_file'], paths: [] } })

  const { data: allSquads = [] } = useQuery(queries.squads.list('active'))
  const availableSquads = allSquads.filter((s) => s.id !== sourceSquadId && !s.isAnonymous)

  const createMutation = useMutation({
    mutationFn: () =>
      createGrant(sourceSquadId, {
        granteeSquadId,
        policy,
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.squads.grants.outbound(sourceSquadId) })
      queryClient.invalidateQueries({ queryKey: queryKeys.squads.grants.inbound(granteeSquadId) })
      onClose()
    },
  })

  return (
    <div className="border border-th-border rounded-lg p-4 bg-surface-secondary space-y-4">
      <div>
        <label className="block text-xs font-medium text-secondary mb-1">Grantee squad</label>
        <select
          value={granteeSquadId}
          onChange={(event) => setGranteeSquadId(event.target.value)}
          className="ficus-field w-full px-2 py-1 text-sm border border-th-border bg-surface text-primary rounded"
        >
          <option value="">Select squad...</option>
          {availableSquads.map((squad) => (
            <option key={squad.id} value={squad.id}>
              {squad.name}
            </option>
          ))}
        </select>
      </div>

      <GrantPolicyEditor policy={policy} onChange={setPolicy} />

      <div>
        <label className="block text-xs font-medium text-secondary mb-1">Expires at (optional)</label>
        <input
          type="datetime-local"
          value={expiresAt}
          onChange={(event) => setExpiresAt(event.target.value)}
          className="ficus-field px-2 py-1 text-xs border border-th-border bg-surface text-primary rounded"
        />
      </div>

      {createMutation.isError && (
        <p className="text-sm text-status-danger-600 dark:text-status-danger-400">
          {createMutation.error instanceof Error ? createMutation.error.message : 'Failed to create grant'}
        </p>
      )}

      <div className="flex gap-2">
        <button
          onClick={() => createMutation.mutate()}
          disabled={createMutation.isPending || !granteeSquadId}
          className="ficus-button ficus-button-primary px-4 py-2 text-sm font-medium rounded-md disabled:opacity-50"
        >
          {createMutation.isPending ? 'Creating...' : 'Create grant'}
        </button>
        <button
          onClick={onClose}
          className="ficus-button ficus-button-secondary px-4 py-2 text-sm font-medium rounded-md"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}
