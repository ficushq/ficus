import { workStreamRef, workStreamTitle } from '@ficus/shared'
import type { Squad, WorkStream } from '@ficus/shared'
import { visibleNavItems } from '../components/navModel'
import { ALL_SECTIONS } from '../components/settings/settingsSections'
import {
  matchesSetting,
  settingMatchRank,
  SETTINGS_PAGE_KEYWORDS,
  SETTINGS_SEARCH_ENTRIES,
} from '../components/settings/settingsSearch'

export interface AssistantSearchResult {
  id: string
  label: string
  detail: string
  path: string
  kind: 'Page' | 'Squad' | 'Work stream' | 'Setting'
  keywords: string
}

/** Only pass authorized API results. Search is local; asking the assistant is a separate action. */
export function assistantSearch(
  query: string,
  squads: readonly Pick<Squad, 'id' | 'name' | 'purpose'>[],
  streams: readonly Pick<WorkStream, 'id' | 'squadId' | 'title' | 'status'>[],
  allowedSettings: ReadonlySet<string>
): AssistantSearchResult[] {
  if (!query.trim()) return []
  const settings = ALL_SECTIONS.filter((section) => allowedSettings.has(section.id))
  const entries: AssistantSearchResult[] = [
    ...visibleNavItems.map((item) => ({
      id: `page:${item.to}`,
      label: item.label,
      path: item.to,
      detail: 'Page',
      kind: 'Page' as const,
      keywords: '',
    })),
    ...squads.map((squad) => ({
      id: `squad:${squad.id}`,
      label: squad.name,
      path: `/squads/${encodeURIComponent(squad.id)}`,
      detail: squad.purpose || 'Squad',
      kind: 'Squad' as const,
      keywords: squad.id,
    })),
    ...streams
      .filter((stream) => stream.status === 'active' || stream.status === 'queued')
      .map((stream) => ({
        id: `work:${stream.id}`,
        label: workStreamTitle(stream),
        path: `/squads/${encodeURIComponent(stream.squadId)}/work?ws=${encodeURIComponent(workStreamRef(stream))}`,
        detail: `${squads.find((squad) => squad.id === stream.squadId)?.name ?? 'Work stream'} · ${stream.status === 'queued' ? 'Queued' : 'Active'}`,
        kind: 'Work stream' as const,
        keywords: stream.id,
      })),
    ...settings.map((section) => ({
      id: `settings:${section.id}`,
      label: section.label,
      path: `/settings?section=${encodeURIComponent(section.id)}`,
      detail: 'Settings',
      kind: 'Setting' as const,
      keywords: `${section.description} ${SETTINGS_PAGE_KEYWORDS[section.id] ?? ''}`,
    })),
    ...SETTINGS_SEARCH_ENTRIES.filter((entry) => allowedSettings.has(entry.section)).map((entry) => ({
      id: `settings:${entry.section}:${entry.id}`,
      label: entry.label,
      path: `/settings?${new URLSearchParams({ section: entry.section, setting: entry.id })}`,
      detail: `Settings → ${settings.find((section) => section.id === entry.section)?.label ?? entry.section}`,
      kind: 'Setting' as const,
      keywords: entry.keywords,
    })),
  ]
  return entries
    .filter((item) => matchesSetting(query, item.label, item.detail, item.kind, item.keywords))
    .sort(
      (a, b) => settingMatchRank(query, a.label) - settingMatchRank(query, b.label) || a.label.localeCompare(b.label)
    )
}
