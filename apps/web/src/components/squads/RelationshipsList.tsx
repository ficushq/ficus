import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { queries } from '../../queryOptions'
import { queryKeys } from '../../queryKeys'
import { useSquadSlugs } from '../../hooks/useSquadSlugs'
import { createSquadRelationship } from '../../api/squads'
import { usePermissions } from '../../hooks/usePermissions'
import type { SquadRelationshipSummary, SquadRelationshipType, SquadRelationships } from '@ficus/shared'

interface Props {
  squadId: string
  relationships: SquadRelationships
}

const RELATIONSHIP_SECTIONS: {
  key: keyof SquadRelationships
  label: string
  description: string
}[] = [
  { key: 'reportsTo', label: 'Reports To', description: 'Parent squads' },
  { key: 'reportedBy', label: 'Reported By', description: 'Child squads' },
  { key: 'collaborates', label: 'Collaborates With', description: 'Peer squads' },
  { key: 'dependsOn', label: 'Depends On', description: 'Upstream dependencies' },
  { key: 'dependedOnBy', label: 'Depended On By', description: 'Downstream dependents' },
]

export function RelationshipsList({ squadId, relationships }: Props) {
  const queryClient = useQueryClient()
  const [showAddForm, setShowAddForm] = useState(false)
  const [targetSquadId, setTargetSquadId] = useState('')
  const [relationType, setRelationType] = useState<SquadRelationshipType>('collaborates')
  const { can, isLoading: permissionsLoading } = usePermissions(squadId)
  const canWriteRelationships = !permissionsLoading && can('squad-relationships:write')

  const { data: allSquads = [] } = useQuery({
    ...queries.squads.list('active'),
    enabled: showAddForm,
  })

  const availableSquads = allSquads.filter((s) => s.id !== squadId && !s.isAnonymous)

  const createMutation = useMutation({
    mutationFn: () =>
      createSquadRelationship({
        sourceSquadId: squadId,
        targetSquadId,
        relationshipType: relationType,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.squads.detail(squadId) })
      setShowAddForm(false)
      setTargetSquadId('')
    },
  })

  return (
    <div aria-label="Squad relationships">
      {canWriteRelationships && (
        <div className="flex justify-end mb-4">
          <button
            onClick={() => setShowAddForm(true)}
            className="ficus-button ficus-button-primary px-3 py-1.5 text-sm font-medium rounded"
          >
            Add Relationship
          </button>
        </div>
      )}

      {canWriteRelationships && showAddForm && (
        <div className="border-b border-panel-border last:border-b-0 mb-4 py-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <select
              value={targetSquadId}
              onChange={(e) => setTargetSquadId(e.target.value)}
              className="ficus-field px-3 py-2 border border-th-border bg-surface text-primary rounded-md"
            >
              <option value="">Select squad...</option>
              {availableSquads.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <select
              value={relationType}
              onChange={(e) => setRelationType(e.target.value as SquadRelationshipType)}
              className="ficus-field px-3 py-2 border border-th-border bg-surface text-primary rounded-md"
            >
              <option value="reports_to">Reports To</option>
              <option value="collaborates">Collaborates With</option>
              <option value="depends_on">Depends On</option>
            </select>
            <div className="flex gap-2">
              <button
                onClick={() => createMutation.mutate()}
                disabled={createMutation.isPending || !targetSquadId}
                className="ficus-button ficus-button-primary flex-1 px-4 py-2 text-sm font-medium rounded-md disabled:opacity-50"
              >
                {createMutation.isPending ? 'Adding...' : 'Add'}
              </button>
              <button
                onClick={() => setShowAddForm(false)}
                className="ficus-button ficus-button-secondary px-4 py-2 text-sm font-medium rounded-md"
              >
                Cancel
              </button>
            </div>
          </div>
          {createMutation.isError && (
            <p className="mt-2 text-sm text-status-danger-600 dark:text-status-danger-400">
              {createMutation.error instanceof Error ? createMutation.error.message : 'Failed to create relationship'}
            </p>
          )}
        </div>
      )}

      <div className="grid items-start gap-6 md:grid-cols-2">
        {RELATIONSHIP_SECTIONS.map(({ key, label, description }) => (
          <RelationshipSection key={key} title={label} description={description} squads={relationships[key]} />
        ))}
      </div>
    </div>
  )
}

function RelationshipSection({
  title,
  description,
  squads,
}: {
  title: string
  description: string
  squads: SquadRelationshipSummary[]
}) {
  const { slugFor } = useSquadSlugs()
  return (
    <div className="border-b border-panel-border last:border-b-0 pb-4">
      <h4 className="font-medium text-sm text-muted mb-1">{title}</h4>
      <p className="text-xs text-muted mb-3">{description}</p>
      {squads.length === 0 ? (
        <p className="text-sm text-muted">None</p>
      ) : (
        <ul className="space-y-2">
          {squads.map((s) => (
            <li key={s.id} className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <Link
                  to={`/squads/${slugFor(s.id)}`}
                  className="block rounded-lg px-2 py-2 -mx-2 text-sm font-medium text-secondary hover:bg-surface-hover hover:text-primary"
                >
                  {s.name}
                </Link>
                <p className="text-xs text-muted truncate">{s.purpose}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
