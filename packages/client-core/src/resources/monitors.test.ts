import { expect, test } from 'bun:test'
import { createClient } from '../client'
import type { Transport, RequestOptions } from '../transport'

function fakeTransport(calls: Array<{ path: string; options?: RequestOptions }>): Transport {
  return {
    request: async <T>(path: string, options?: RequestOptions) => {
      calls.push({ path, options })
      return [] as T
    },
    openStream: async () => {
      throw new Error('unused')
    },
    wsUrl: (p) => p,
    url: (p) => p,
  }
}

test('list sends only the given filters, comma-joining statuses', async () => {
  const calls: Array<{ path: string; options?: RequestOptions }> = []
  const monitors = createClient(fakeTransport(calls)).monitors
  const signal = new AbortController().signal
  await monitors.list()
  await monitors.list({ agentId: 'agent-1', status: ['starting', 'running', 'canceling'] }, signal)
  await monitors.list({ squadId: 'squad 1', status: [] })
  expect(calls).toEqual([
    { path: '/monitors', options: { signal: undefined } },
    { path: '/monitors?agentId=agent-1&status=starting%2Crunning%2Ccanceling', options: { signal } },
    { path: '/monitors?squadId=squad+1', options: { signal: undefined } },
  ])
})

test('get, logs and cancel address one encoded monitor', async () => {
  const calls: Array<{ path: string; options?: RequestOptions }> = []
  const monitors = createClient(fakeTransport(calls)).monitors
  const signal = new AbortController().signal
  await monitors.get('m/1', signal)
  await monitors.logs('m1')
  await monitors.logs('m1', 500, signal)
  await monitors.cancel('m1')
  expect(calls).toEqual([
    { path: '/monitors/m%2F1', options: { signal } },
    { path: '/monitors/m1/logs?tail=100', options: { signal: undefined } },
    { path: '/monitors/m1/logs?tail=500', options: { signal } },
    { path: '/monitors/m1/cancel', options: { method: 'POST' } },
  ])
})
