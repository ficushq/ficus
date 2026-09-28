import type { EntitySearchResult } from '@ficus/shared'
import { searchEntities } from '../api/search'
import { assistantSearch } from './assistantSearch'
import { settingMatchRank } from '../components/settings/settingsSearch'

/** Web destinations stay with the frontend; the API and CLI return entity references only. */
function entityDestination(row: EntitySearchResult) {
  const id = encodeURIComponent(row.id)
  const squad = encodeURIComponent(row.squadId ?? '')
  switch (row.kind) {
    case 'squad':
      return { kind: 'Squad', path: `/squads/${id}` }
    case 'work_stream':
      return {
        kind: 'Work stream',
        workStreamId: String(row.number ?? row.id),
        path: `/squads/${squad}/work?ws=${row.number ?? id}`,
      }
    case 'consultant_conversation':
      return { kind: 'Conversation', agentId: row.id, path: `/squads/${squad}/agents?agent=${id}` }
    case 'assistant_conversation':
      return { kind: 'Assistant conversation', conversationId: row.id, path: `/?chat=open&assistantConversation=${id}` }
  }
}

export async function hybridFicusSearch(
  query: string,
  limit: number,
  allowedSettings: ReadonlySet<string>,
  search = searchEntities
) {
  const navigation = assistantSearch(query, [], [], allowedSettings).map((row) => ({
    ...row,
    score: 100 - settingMatchRank(query, row.label) * 20,
  }))
  try {
    const entities = await search(query, limit)
    const results = [
      ...entities.results.map((row) => ({
        ...row,
        label: row.kind === 'work_stream' && row.number ? `#${row.number} · ${row.label}` : row.label,
        entityKind: row.kind,
        ...entityDestination(row),
      })),
      ...navigation,
    ]
    return { results: results.sort((a, b) => b.score - a.score).slice(0, limit), partial: false }
  } catch {
    // Navigation remains useful when entity search fails; never disguise the missing source as no matches.
    return {
      results: navigation.slice(0, limit),
      partial: true,
      error: 'Entity search is unavailable. Only navigation results are shown.',
    }
  }
}
