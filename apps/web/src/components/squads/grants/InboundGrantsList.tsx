import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import type { SquadMemoryGrantDTO } from '@ficus/shared'
import { queries } from '../../../queryOptions'
import { useSquadSlugs } from '../../../hooks/useSquadSlugs'
import { useLoadingShapeCount } from '../../../hooks/useLoadingShapeCount'
import { CollectionSkeleton } from '../../loading/Skeleton'
import { GrantPolicySummary } from './GrantPolicySummary'

interface Props {
  granteeSquadId: string
}

export function InboundGrantsList({ granteeSquadId }: Props) {
  const { data: grants = [], isLoading, isSuccess } = useQuery(queries.squads.grants.inbound(granteeSquadId))
  const { data: allSquads = [] } = useQuery(queries.squads.list('active'))
  const squadsById = useMemo(() => new Map(allSquads.map((squad) => [squad.id, squad])), [allSquads])
  const { slugFor } = useSquadSlugs()
  const grantSkeletonCount = useLoadingShapeCount(
    `squads:${granteeSquadId}:inbound-memory-grants`,
    isSuccess ? grants.length : undefined,
    { fallbackCount: 2, maxCount: 8 }
  )

  if (isLoading) return <CollectionSkeleton label="Loading inbound memory grants" count={grantSkeletonCount} />
  if (grants.length === 0) {
    return <p className="text-sm text-muted italic">No other squad has shared memory with this one.</p>
  }

  return (
    <ul className="space-y-3">
      {grants.map((grant: SquadMemoryGrantDTO) => {
        const source = squadsById.get(grant.sourceSquadId)
        return (
          <li key={grant.id} className="border border-th-border rounded-lg p-4 bg-surface">
            <div className="mb-3 text-sm">
              <span className="text-muted">Received from </span>
              {source ? (
                <Link to={`/squads/${slugFor(source.id)}`} className="font-medium text-accent-light hover:underline">
                  {source.name}
                </Link>
              ) : (
                <span className="font-mono text-xs">{grant.sourceSquadId.slice(0, 8)}</span>
              )}
              {grant.expiresAt && (
                <span className="text-xs text-muted ml-2">expires {new Date(grant.expiresAt).toLocaleString()}</span>
              )}
            </div>
            <GrantPolicySummary policy={grant.policy} />
          </li>
        )
      })}
    </ul>
  )
}
