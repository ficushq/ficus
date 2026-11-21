/**
 * Serves a test's API requests from a route table, so no web test reaches the network (see
 * networkGuard.ts). Pass the table to the DOM harness, which installs it as the window's fetch for
 * its lifetime and needs no restore:
 *
 *   await acquireDomHarness({ url, api: { '/api/auth/permissions': { permissions: ['agents:read'] } } })
 *
 * A key is a pathname, optionally after a method ('POST /api/roles'; GET is the default). `:name`
 * matches one path segment and a trailing `*` matches the rest. Matching ignores the query string and
 * anything before `/api/`, so a harness URL with a base path still matches. A value is the JSON body
 * to answer with, a Response, `apiUnavailable`, or a function of the request returning one of those.
 *
 * `apiUnavailable` fails the request at once the way an unreachable server does (a rejected fetch).
 * Use it for a query the test does not exercise and only renders through. A request no route matches
 * goes on to the guarded fetch, which refuses it and fails the test.
 */

export const apiUnavailable = Symbol('apiUnavailable')

export type ApiRequest = {
  url: URL
  method: string
  params: Record<string, string>
  init: RequestInit | undefined
}
type ApiAnswer = unknown
export type ApiRoutes = Record<string, ApiAnswer | ((request: ApiRequest) => ApiAnswer | Promise<ApiAnswer>)>

type CompiledRoute = { method: string; segments: string[]; rest: boolean; key: string }

function compile(key: string): CompiledRoute {
  const match = /^(?:([A-Z]+)\s+)?(\/\S*)$/.exec(key.trim())
  if (!match) throw new Error(`API route "${key}" must be a pathname, optionally after a method`)
  const [, method = 'GET', path] = match
  const segments = path!.split('/').filter(Boolean)
  const rest = segments.at(-1) === '*'
  if (rest) segments.pop()
  return { method, segments, rest, key }
}

function apiPath(url: URL) {
  const index = url.pathname.indexOf('/api/')
  return index === -1 ? url.pathname : url.pathname.slice(index)
}

function matchRoute(route: CompiledRoute, method: string, path: string) {
  if (route.method !== method) return undefined
  const parts = path.split('/').filter(Boolean)
  if (route.rest ? parts.length < route.segments.length : parts.length !== route.segments.length) return undefined
  const params: Record<string, string> = {}
  for (const [index, segment] of route.segments.entries()) {
    const part = parts[index]!
    if (segment.startsWith(':')) params[segment.slice(1)] = decodeURIComponent(part)
    else if (segment !== part) return undefined
  }
  return params
}

function toResponse(answer: ApiAnswer): Response | typeof apiUnavailable {
  if (answer === apiUnavailable) return apiUnavailable
  if (answer instanceof Response) return answer
  if (answer === undefined) return new Response(null, { status: 204 })
  return Response.json(answer)
}

/**
 * Returns a fetch that answers from `routes` (read at request time, so a test may change them) and
 * passes every other request to `fallback`.
 */
export function apiRoutesFetch(routes: ApiRoutes, fallback: typeof fetch): typeof fetch {
  const compiled = new Map<string, CompiledRoute>()
  const routed = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = input instanceof Request ? input : undefined
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const url = new URL(href, globalThis.window?.location?.href ?? 'http://localhost/')
    const method = (init?.method ?? request?.method ?? 'GET').toUpperCase()
    const path = apiPath(url)
    for (const key of Object.keys(routes)) {
      let route = compiled.get(key)
      if (!route) compiled.set(key, (route = compile(key)))
      const params = matchRoute(route, method, path)
      if (!params) continue
      const value = routes[key]
      const answer = toResponse(typeof value === 'function' ? await value({ url, method, params, init }) : value)
      if (answer === apiUnavailable)
        throw new TypeError(`Failed to fetch (${method} ${path} is unavailable in this test)`)
      return answer
    }
    return fallback(input, init)
  }
  return routed as typeof fetch
}
