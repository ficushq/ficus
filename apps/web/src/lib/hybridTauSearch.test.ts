import { expect, mock, test } from 'bun:test'
import type { EntitySearchResult } from '@ficus/shared'
import { hybridTauSearch } from './hybridTauSearch'

const entity: EntitySearchResult = {
  id: 'work-id',
  kind: 'work_stream',
  label: 'Feed cleanup',
  detail: '',
  squadId: 'squad-id',
  squadName: 'Ficus',
  status: 'active',
  updatedAt: '2026-09-06',
  score: 80,
}
test('merges bounded entity results with local navigation and applies one final limit', async () => {
  const search = mock(async () => ({ results: [entity, { ...entity, id: 'second', score: 60 }] }))
  const result = await hybridTauSearch('Feed', 2, new Set(), search)
  expect(search.mock.calls).toEqual([['Feed', 2]])
  expect(result.results.map((row) => row.label)).toEqual(['Feed', 'Feed cleanup'])
  expect(result.results[1]).toMatchObject({
    id: 'work-id',
    squadId: 'squad-id',
    workStreamId: 'work-id',
    path: '/squads/squad-id/work?ws=work-id',
  })
  expect(result.partial).toBe(false)
})
test('uses current settings availability and makes backend failure explicit', async () => {
  const failed = async () => {
    throw new Error('Network error')
  }
  expect((await hybridTauSearch('models', 10, new Set(), failed)).results).toEqual([])
  const result = await hybridTauSearch('models', 10, new Set(['agents']), failed)
  // A forbidden settings section cannot appear even while the backend is down.
  expect(result.results.every((row) => row.kind === 'Page' || row.path.includes('section=agents'))).toBe(true)
  expect(result.partial).toBe(true)
  expect(result.error).toContain('unavailable')
  expect((await hybridTauSearch('Feed', 1, new Set(), failed)).results[0].label).toBe('Feed')
})
test('keeps backend ordering for tied scores and routes consultants into their squad chats', async () => {
  const consultant = { ...entity, id: 'consultant', kind: 'consultant_conversation' as const, label: 'Recent result' }
  const result = await hybridTauSearch('result', 3, new Set(), async () => ({
    results: [consultant, { ...entity, label: 'Older result' }],
  }))
  expect(result.results.map((row) => row.label)).toEqual(['Recent result', 'Older result'])
  expect(result.results[0].path).toBe('/squads/squad-id/agents?agent=consultant')
})
