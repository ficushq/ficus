import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { SquadMemoryGrantDTO } from '@ficus/shared'
import { deleteGrant } from '../../../api/grants'
import { queries } from '../../../queryOptions'
import { queryKeys } from '../../../queryKeys'
import { useSquadSlugs } from '../../../hooks/useSquadSlugs'
import { useLoadingShapeCount } from '../../../hooks/useLoadingShapeCount'
import { CollectionSkeleton } from '../../loading/Skeleton'
import { GrantPolicySummary } from './GrantPolicySummary'
import { GrantRiskBadge } from './GrantRiskBadge'
import { evaluateGrantRisks } from './grantRisks'

interface Props {
  sourceSquadId: string
}

export function OutboundGrantsList({ sourceSquadId }: Props) {
  const { data: grants = [], isLoading, isSuccess } = useQuery(queries.squads.grants.outbound(sourceSquadId))
  const { data: allSquads = [] } = useQuery(queries.squads.list('active'))
  const squadsById = useMemo(() => new Map(allSquads.map((squad) => [squad.id, squad])), [allSquads])
  const { slugFor } = useSquadSlugs()
  const queryClient = useQueryClient()
  const grantSkeletonCount = useLoadingShapeCount(
    `squads:${sourceSquadId}:outbound-memory-grants`,
    isSuccess ? grants.length : undefined,
    { fallbackCount: 2, maxCount: 8 }
  )

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteGrant(id),
    onSuccess: (_, id) => {
      const removed = grants.find((grant) => grant.id === id)
      queryClient.invalidateQueries({ queryKey: queryKeys.squads.grants.outbound(sourceSquadId) })
      if (removed) queryClient.invalidateQueries({ queryKey: queryKeys.squads.grants.inbound(removed.granteeSquadId) })
    },
  })

  if (isLoading) return <CollectionSkeleton label="Loading outbound memory grants" count={grantSkeletonCount} />
  if (grants.length === 0) {
    return <p className="text-sm text-muted italic">This squad does not share memory with any other squad.</p>
  }

  return (
    <ul className="space-y-3">
      {grants.map((grant: SquadMemoryGrantDTO) => {
        const grantee = squadsById.get(grant.granteeSquadId)
        const risks = evaluateGrantRisks(grant.policy)
        return (
          <li key={grant.id} className="border border-th-border rounded-lg p-4 bg-surface">
            <div className="flex items-start justify-between gap-3 mb-3">
              <div className="min-w-0">
                <div className="text-sm">
                  <span className="text-muted">Shared with </span>
                  {grantee ? (
                    <Link
                      to={`/squads/${slugFor(grantee.id)}`}
                      className="font-medium text-accent-light hover:underline"
                    >
                      {grantee.name}
                    </Link>
                  ) : (
                    <span className="font-mono text-xs">{grant.granteeSquadId.slice(0, 8)}</span>
                  )}
                </div>
                {grant.expiresAt && (
                  <div className="text-xs text-muted mt-0.5">expires {new Date(grant.expiresAt).toLocaleString()}</div>
                )}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <GrantRiskBadge risks={risks} />
                <button
                  onClick={() => {
                    if (confirm('Revoke this grant?')) deleteMutation.mutate(grant.id)
                  }}
                  className="ficus-button text-xs text-status-danger-600 dark:text-status-danger-400 hover:underline"
                >
                  Revoke
                </button>
              </div>
            </div>
            <GrantPolicySummary policy={grant.policy} />
          </li>
        )
      })}
    </ul>
  )
}
