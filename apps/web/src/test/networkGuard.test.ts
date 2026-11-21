import { afterEach, describe, expect, test } from 'bun:test'
import {
  allowNetworkOrigin,
  describeBlockedRequests,
  guardFetch,
  refuseNetworkRequest,
  takeBlockedRequests,
} from './networkGuard'

// Every test here consumes what it records, so the preload's own check stays clear.
afterEach(() => {
  takeBlockedRequests()
})

const answered = async () => Response.json({ ok: true })

describe('network guard', () => {
  test('the preload guards the process fetch: a request to the network is refused and recorded', async () => {
    await expect(fetch('https://ficus.test/api/auth/permissions')).rejects.toThrow(
      'Unmocked network request refused by the web test preload: fetch GET https://ficus.test/api/auth/permissions'
    )
    expect(takeBlockedRequests()).toEqual([{ kind: 'fetch GET', url: 'https://ficus.test/api/auth/permissions' }])
    expect(takeBlockedRequests()).toEqual([])
  })

  test('the preload guards WebSocket connections', () => {
    expect(() => new WebSocket('ws://localhost/ws')).toThrow('WebSocket ws://localhost/ws')
    expect(takeBlockedRequests()).toEqual([{ kind: 'WebSocket', url: 'ws://localhost/ws' }])
  })

  test('names the method of a refused request', async () => {
    const guarded = guardFetch(answered as typeof fetch)
    await expect(guarded('http://localhost/api/images/1', { method: 'DELETE' })).rejects.toThrow(TypeError)
    await expect(guarded(new Request('http://localhost/api/roles', { method: 'POST' }))).rejects.toThrow(TypeError)
    expect(takeBlockedRequests()).toEqual([
      { kind: 'fetch DELETE', url: 'http://localhost/api/images/1' },
      { kind: 'fetch POST', url: 'http://localhost/api/roles' },
    ])
  })

  test('data: and blob: URLs never reach the network and pass', async () => {
    const guarded = guardFetch(answered as typeof fetch)
    expect((await guarded('data:text/plain,hello')).ok).toBe(true)
    expect((await guarded('blob:http://localhost/1')).ok).toBe(true)
    expect(takeBlockedRequests()).toEqual([])
  })

  test('a test may allow the origin of a server it started, until it revokes it', async () => {
    const guarded = guardFetch(answered as typeof fetch)
    const revoke = allowNetworkOrigin('http://127.0.0.1:61234/')
    try {
      expect((await guarded('http://127.0.0.1:61234/fixture')).ok).toBe(true)
      expect(refuseNetworkRequest('WebSocket', 'ws://127.0.0.1:61234/socket')).toBeUndefined()
      await expect(guarded('http://127.0.0.1:61235/fixture')).rejects.toThrow(TypeError)
    } finally {
      revoke()
      revoke()
    }
    await expect(guarded('http://127.0.0.1:61234/fixture')).rejects.toThrow(TypeError)
    expect(takeBlockedRequests().map(({ url }) => url)).toEqual([
      'http://127.0.0.1:61235/fixture',
      'http://127.0.0.1:61234/fixture',
    ])
  })

  test('the failure message lists each refused request once and says how to mock it', () => {
    const message = describeBlockedRequests([
      { kind: 'fetch GET', url: 'https://ficus.test/api/squads' },
      { kind: 'fetch GET', url: 'https://ficus.test/api/squads' },
    ])
    expect(message).toBe(
      'This test made 2 unmocked network requests:\n' +
        '  fetch GET https://ficus.test/api/squads\n' +
        'Mock it instead: seed the query cache, inject the API, or pass the DOM harness an api route table' +
        ' (src/test/apiMock.ts).\n' +
        'The rules for web tests are in AGENTS.md, under "Writing tests without flakes, contention, or hidden timeouts".'
    )
  })
})
