import { expect, test } from 'bun:test'
import type { Transport } from '../transport'
import { actionsResource } from './actions'

function recordingTransport(paths: string[]): Transport {
  return {
    request: async <T>(path: string) => {
      paths.push(path)
      return [] as T
    },
  } as unknown as Transport
}

test('pending actions list every type unless a client passes a types filter', async () => {
  const paths: string[] = []
  const actions = actionsResource(recordingTransport(paths))
  await actions.listPendingActions()
  await actions.listPendingActions({ types: [] })
  await actions.listPendingActions({ types: ['workstream-delivery'] })
  await actions.listPendingActions({ types: ['agent-error', 'workstream-review'] })
  expect(paths).toEqual([
    '/actions/pending',
    '/actions/pending',
    '/actions/pending?types=workstream-delivery',
    '/actions/pending?types=agent-error,workstream-review',
  ])
})
