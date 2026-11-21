import { afterEach, describe, expect, test } from 'bun:test'
import { apiRoutesFetch, apiUnavailable, type ApiRequest } from './apiMock'
import { guardFetch, takeBlockedRequests } from './networkGuard'

afterEach(() => {
  takeBlockedRequests()
})

const network = guardFetch((async () => Response.json('network')) as typeof fetch)

describe('API route table', () => {
  test('answers a pathname with its JSON body, ignoring the query string and any base path', async () => {
    const routed = apiRoutesFetch({ '/api/auth/permissions': { permissions: ['agents:read'] } }, network)
    for (const url of [
      'http://localhost/api/auth/permissions',
      'https://ficus.test/api/auth/permissions?squadId=squad-1',
      'https://self-hosted.example/ficus/api/auth/permissions',
    ])
      expect(await (await routed(url)).json()).toEqual({ permissions: ['agents:read'] })
    expect(takeBlockedRequests()).toEqual([])
  })

  test('matches the method, path parameters and a trailing wildcard', async () => {
    const seen: ApiRequest[] = []
    const routed = apiRoutesFetch(
      {
        'POST /api/workstreams/:id/waits/:waitId/resolve': (request) => {
          seen.push(request)
          return { resolved: request.params.waitId }
        },
        '/api/inbox/*': [],
      },
      network
    )
    const response = await routed('http://localhost/api/workstreams/ws-1/waits/wait%201/resolve', {
      method: 'POST',
      body: '{}',
    })
    expect(await response.json()).toEqual({ resolved: 'wait 1' })
    expect(seen[0]!.params).toEqual({ id: 'ws-1', waitId: 'wait 1' })
    expect(seen[0]!.method).toBe('POST')
    expect(await (await routed('http://localhost/api/inbox/user/me?limit=5')).json()).toEqual([])
    // GET of the POST route is not served, so it goes on to the guarded fetch.
    await expect(routed('http://localhost/api/workstreams/ws-1/waits/wait-1/resolve')).rejects.toThrow(
      'fetch GET http://localhost/api/workstreams/ws-1/waits/wait-1/resolve'
    )
    expect(takeBlockedRequests()).toHaveLength(1)
  })

  test('an unavailable route fails at once like an unreachable server, without reaching the network', async () => {
    const routed = apiRoutesFetch({ '/api/squads': apiUnavailable }, network)
    await expect(routed('http://localhost/api/squads')).rejects.toThrow(
      'Failed to fetch (GET /api/squads is unavailable in this test)'
    )
    expect(takeBlockedRequests()).toEqual([])
  })

  test('a Response answers as is, undefined answers 204, and routes are read at request time', async () => {
    const routes: Record<string, unknown> = {
      '/api/workstreams/:id': () => Response.json({ error: 'Work stream not found' }, { status: 404 }),
      'DELETE /api/images/:id': undefined,
    }
    const routed = apiRoutesFetch(routes, network)
    expect((await routed('http://localhost/api/workstreams/404')).status).toBe(404)
    expect((await routed('http://localhost/api/images/1', { method: 'DELETE' })).status).toBe(204)
    routes['/api/squads'] = [{ id: 'squad-1' }]
    expect(await (await routed('http://localhost/api/squads')).json()).toEqual([{ id: 'squad-1' }])
  })

  test('requests no route matches go on to the fallback, which the network guard refuses', async () => {
    const routed = apiRoutesFetch({ '/api/squads': [] }, network)
    await expect(routed('https://ficus.test/api/voice/status')).rejects.toThrow(TypeError)
    expect(takeBlockedRequests()).toEqual([{ kind: 'fetch GET', url: 'https://ficus.test/api/voice/status' }])
  })

  test('rejects a malformed route key', async () => {
    const routed = apiRoutesFetch({ 'api/squads': [] }, network)
    await expect(routed('http://localhost/api/squads')).rejects.toThrow(
      'API route "api/squads" must be a pathname, optionally after a method'
    )
  })
})
