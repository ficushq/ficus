import { describe, expect, test } from 'bun:test'
import { assistantSearch } from './assistantSearch'
import { isSectionAllowed } from '../components/settings/settingsSections'

const squads = [{ id: 'squad-uuid', name: 'Ficus', purpose: 'Agent orchestration platform' }]
const streams = [
  { id: 'stream-uuid', squadId: 'squad-uuid', title: 'Fix OAuth recovery', status: 'active' as const },
  { id: 'done-uuid', squadId: 'squad-uuid', title: 'Old OAuth work', status: 'done' as const },
]

describe('assistant destination search', () => {
  test('exact settings titles beat keyword matches and fields link to their anchors', () => {
    const allowed = new Set(['agent-types', 'system', 'secrets'])
    const results = assistantSearch('Agent Types', squads, streams, allowed)
    expect(results[0]?.label).toBe('Agent Types')
    expect(results[0]?.path).toBe('/settings?section=agent-types')
    expect(assistantSearch('max concurrent agents', squads, streams, allowed)[0]?.path).toBe(
      '/settings?section=system&setting=max-concurrent-agents'
    )
  })
  test('finds all visible navigation pages, squads by purpose, and active work with canonical links', () => {
    expect(assistantSearch('inbox', [], [], new Set())[0]?.path).toBe('/inbox')
    expect(assistantSearch('orchestration', squads, streams, new Set())[0]?.path).toBe('/squads/squad-uuid')
    expect(assistantSearch('OAuth', squads, streams, new Set()).map((item) => item.path)).toEqual([
      '/squads/squad-uuid/work?ws=stream-uuid',
    ])
  })
  test('omits disallowed settings pages and their fields', () => {
    expect(assistantSearch('author email', [], [], new Set())).toEqual([])
    expect(assistantSearch('Agent Types', [], [], new Set())).toEqual([])
    expect(isSectionAllowed('agent-types', () => false, false)).toBe(false)
    expect(isSectionAllowed('agent-types', () => true, true)).toBe(false)
    expect(isSectionAllowed('integrations', () => true, false, false)).toBe(false)
  })
  test('does not show a redundant navigation list before typing', () => {
    expect(assistantSearch(' ', squads, streams, new Set(['general']))).toEqual([])
  })
})
