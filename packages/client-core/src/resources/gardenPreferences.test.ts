import { expect, test } from 'bun:test'
import { createClient } from '../client'
import type { Transport, RequestOptions } from '../transport'

test('garden preferences are self-service over the shared transport, with the session identity precondition', async () => {
  const calls: Array<{ path: string; options?: RequestOptions }> = []
  const result = { userId: 'A', style: 'blueprint' as const }
  const transport: Transport = {
    request: async <T>(path: string, options?: RequestOptions) => {
      calls.push({ path, options })
      return result as T
    },
    openStream: async () => {
      throw new Error('unused')
    },
    wsUrl: (p) => p,
    url: (p) => p,
  }
  const resource = createClient(transport).gardenPreferences
  const signal = new AbortController().signal
  expect(await resource.getMine(signal)).toEqual(result)
  expect(await resource.updateMine({ expectedUserId: 'A', style: 'blueprint' }, signal)).toEqual(result)
  expect(calls).toEqual([
    { path: '/garden-preferences/me', options: { signal } },
    {
      path: '/garden-preferences/me',
      options: { method: 'PUT', body: { expectedUserId: 'A', style: 'blueprint' }, signal },
    },
  ])
})
