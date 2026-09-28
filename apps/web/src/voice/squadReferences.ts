import { squadSlugMap, type Squad } from '@ficus/shared'

type VoiceSquadReference = Pick<Squad, 'id' | 'name'> & Partial<Pick<Squad, 'createdAt'>>

/** Use the same collision ordering as the URL router, never a name-only first match. */
export function resolveVoiceSquadId(reference: string, squads: readonly VoiceSquadReference[]): string | undefined {
  const id = reference.trim()
  if (squads.some((squad) => squad.id === id)) return id
  const { slugToId } = squadSlugMap(squads.map((squad) => ({ ...squad, createdAt: squad.createdAt ?? 0 })))
  if (slugToId[id]) return slugToId[id]
  const matches = id.length >= 8 ? squads.filter((squad) => squad.id.startsWith(id)) : []
  return matches.length === 1 ? matches[0].id : undefined
}

export function squadReferenceFromPath(path: string): string | undefined {
  const reference = path.match(/^\/squads\/([^/?#]+)/)?.[1]
  if (!reference) return undefined
  try {
    return decodeURIComponent(reference)
  } catch {
    return undefined
  }
}
