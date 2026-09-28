import { expect, test, spyOn } from 'bun:test'
import type { RenderItem } from '@ficus/client-core'
import { assistantSummaryUpdateIds } from './assistantSummarySources'
import { assistantQueries } from '../queryOptions'
import { assistantApi } from '../api/assistant'

test('summary source IDs include the last grouped row and remove duplicate references', () => {
  const first = { id: 'first', role: 'assistant', metadata: { assistantUpdateIds: ['one'] } }
  const last = { id: 'last', role: 'assistant', metadata: { assistantUpdateIds: ['one', 'two'] } }
  expect(
    assistantSummaryUpdateIds({ kind: 'persisted', message: first, mergedFrom: [first, last] } as Extract<
      RenderItem,
      { kind: 'persisted' }
    >)
  ).toEqual(['one', 'two'])
})
test('source retrieval loads every referenced update in bounded requests', async () => {
  const ids = Array.from({ length: 123 }, (_, index) => `update-${index}`)
  const read = spyOn(assistantApi, 'readUpdates').mockImplementation(
    async (_id, ids) => ids.map((messageId) => ({ messageId })) as never
  )
  try {
    const options = assistantQueries.updates('owner', 'conversation', ids)
    const rows = await options.queryFn!({} as never)
    expect(rows!.map((row) => row.messageId)).toEqual(ids)
    expect(read.mock.calls.map((call) => call[1].length)).toEqual([50, 50, 23])
    expect(read.mock.calls.every((call) => call[0] === 'conversation')).toBe(true)
  } finally {
    read.mockRestore()
  }
})
