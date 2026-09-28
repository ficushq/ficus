import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { squadSlugMap, type SquadSlugMap } from '@ficus/shared'
import { queries } from '../queryOptions'

/**
 * Derive id<->slug maps for all (active) squads from the cached squad list.
 * `slugFor(id)` returns the pretty slug, falling back to the raw id when the
 * list isn't loaded yet or the squad isn't present (e.g. archived/anonymous) —
 * a UUID URL still resolves and self-upgrades to the slug on arrival.
 */
export function useSquadSlugs(): SquadSlugMap & { slugFor: (id: string) => string; isPending: boolean } {
  const { data: squads, isPending } = useQuery(queries.squads.list())
  const map = useMemo(() => squadSlugMap(squads ?? []), [squads])
  return useMemo(() => ({ ...map, isPending, slugFor: (id: string) => map.idToSlug[id] ?? id }), [map, isPending])
}
