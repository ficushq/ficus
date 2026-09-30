import { expect, test } from 'bun:test'
import type { Transport } from '../transport'
import { actionsResource } from './actions'

test('pending actions keep the legacy path unless a client opts into delivery gates', async () => {
  const paths: string[] = []
  const transport = {
    request: async <T>(path: string) => {
      paths.push(path)
      return [] as T
    },
  } as unknown as Transport
  await actionsResource(transport).listPendingActions()
  await actionsResource(transport).listPendingActions({ include: ['workstream-delivery'] })
  expect(paths).toEqual(['/actions/pending', '/actions/pending?include=workstream-delivery'])
})
