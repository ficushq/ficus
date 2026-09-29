import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { Command } from 'commander'
import { apiGet } from '../client'
import { outputTable, outputError } from '../output'
import { registerSearchCommands } from './search'

const get = apiGet as ReturnType<typeof mock>
beforeEach(() => {
  get.mockReset().mockResolvedValue({ results: [{ id: 'found', kind: 'work_stream', label: 'Deploy' }] })
  ;(outputTable as ReturnType<typeof mock>).mockClear()
  ;(outputError as ReturnType<typeof mock>).mockClear()
})
afterEach(() => get.mockReset().mockResolvedValue({}))
async function run(args: string[]) {
  const program = new Command().exitOverride()
  registerSearchCommands(program)
  await program.parseAsync(['search', ...args], { from: 'user' })
}
test('sends encoded queries and validated filters, preserving returned IDs in output', async () => {
  const squad = '477b5724-41ce-4760-b54b-50e11f7a0758'
  await run(['deploy & release', '--limit', '5', '--kind', 'work_stream', '--squad', squad])
  const path = get.mock.calls[0][0]
  const parsed = new URL(path, 'http://localhost')
  expect(parsed.pathname).toBe('/api/search')
  expect(Object.fromEntries(parsed.searchParams)).toEqual({
    q: 'deploy & release',
    limit: '5',
    kind: 'work_stream',
    squadId: squad,
  })
  expect(outputTable).toHaveBeenCalledWith(
    [{ id: 'found', kind: 'work_stream', label: 'Deploy' }],
    ['kind', 'id', 'label', 'squadName', 'status']
  )
})
test('rejects invalid limits and kinds without requesting an inventory', async () => {
  for (const args of [
    ['q', '--limit', '0'],
    ['q', '--limit', '51'],
    ['q', '--limit', '1.5'],
    ['q', '--kind', 'agent'],
    ['q', '--squad', 'bad'],
  ])
    await run(args)
  expect(get).not.toHaveBeenCalled()
  expect(outputError).toHaveBeenCalledTimes(5)
})
test('reports backend errors without silently replacing them with empty search results', async () => {
  const failure = new Error('Forbidden')
  get.mockRejectedValue(failure)
  await run(['deploy'])
  expect(outputError).toHaveBeenCalledWith(failure)
  expect(outputTable).not.toHaveBeenCalled()
})
test('assistant conversation results add the agent id column', async () => {
  const rows = [{ id: 'conversation-1', kind: 'assistant_conversation', label: 'Access', agentId: 'agent-1' }]
  get.mockResolvedValue({ results: rows })
  await run(['access', '--kind', 'assistant_conversation'])
  expect(outputTable).toHaveBeenCalledWith(rows, ['kind', 'id', 'label', 'squadName', 'status', 'agentId'])
})
