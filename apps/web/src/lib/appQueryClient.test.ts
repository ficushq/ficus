import { expect, test } from 'bun:test'
import { HttpResponseError, queryRetryDelay, shouldRetryQuery } from '@ficus/client-core'
import { createAppQueryClient } from './appQueryClient'
import { apiFetch, ApiError } from '../api/client'
import { webTransport } from '../api/transport'
import { acquireDomHarness } from '../test/domHarness'

test('the app query client uses the shared retry policy', () => {
  const queries = createAppQueryClient().getDefaultOptions().queries!
  expect(queries.retry).toBe(shouldRetryQuery)
  expect(queries.retryDelay).toBe(queryRetryDelay)
})

test('both API clients carry a 503 Retry-After to the retry policy', async () => {
  const dom = await acquireDomHarness({
    url: 'http://localhost/',
    api: {
      '/api/busy': () =>
        Response.json(
          { code: 'read_deadline_exceeded', error: 'Ficus is busy' },
          { status: 503, headers: { 'Retry-After': '5' } }
        ),
    },
  })
  try {
    const legacy = await apiFetch('/busy').catch((error: unknown) => error)
    expect(legacy).toBeInstanceOf(ApiError)
    expect(legacy).toMatchObject({ status: 503, retryAfterMs: 5_000 })
    const shared = await webTransport.request('/busy').catch((error: unknown) => error)
    expect(shared).toBeInstanceOf(HttpResponseError)
    expect(shared).toMatchObject({ status: 503, retryAfterMs: 5_000 })
  } finally {
    await dom.cleanup()
  }
})

test('a busy read is retried only after its Retry-After', async () => {
  const client = createAppQueryClient()
  const calls: number[] = []
  const data = await client.fetchQuery({
    queryKey: ['busy-read'],
    queryFn: async () => {
      calls.push(performance.now())
      if (calls.length === 1) throw new ApiError(503, 'Ficus is busy', undefined, 1_000)
      return 'answered'
    },
    // fetchQuery turns retries off unless asked; the app's queries (useQuery) inherit the defaults.
    retry: client.getDefaultOptions().queries!.retry,
  })
  expect(data).toBe('answered')
  expect(calls).toHaveLength(2)
  expect(calls[1]! - calls[0]!).toBeGreaterThanOrEqual(990)
  client.clear()
})
