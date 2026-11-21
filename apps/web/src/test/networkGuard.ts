/**
 * Web tests never reach the network. The test preload wraps the process fetch and WebSocket, and
 * every DOM harness window routes its own requests (fetch, XHR and resource loads) through the same
 * check. A request to an origin a test has not allowed is refused at once, recorded, and reported by
 * the preload as a failure of the test that made it, so a leak is caught where it starts rather than
 * through DNS timing in some later file.
 *
 * Mock the request instead: seed the query cache, inject or stub the API, pass the DOM harness an
 * `api` route table (apiMock.ts), or replace globalThis.fetch for the test. A test that starts its
 * own server may allow that server's origin with allowNetworkOrigin.
 */
import type { IFetchInterceptor } from 'happy-dom'

export type BlockedRequest = { kind: string; url: string }

const NETWORK_SCHEMES = new Set(['http:', 'https:', 'ws:', 'wss:'])
const allowedOrigins = new Map<string, number>()
let blocked: BlockedRequest[] = []

/** Resolves `url` the way the installed DOM window's fetch would: relative to its page. */
function resolve(url: string) {
  try {
    return new URL(url, globalThis.window?.location?.href)
  } catch {
    return undefined
  }
}

function requestMethod(input: unknown, init: RequestInit | undefined) {
  const method = init?.method ?? (input instanceof Request ? input.method : undefined) ?? 'GET'
  return method.toUpperCase()
}

function requestUrl(input: unknown) {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  if (input && typeof input === 'object' && 'url' in input && typeof input.url === 'string') return input.url
  return String(input)
}

/**
 * Returns the error to fail the request with when `url` would reach the network, after recording
 * it. data: and blob: URLs, URLs that do not parse, and allowed origins pass.
 */
export function refuseNetworkRequest(kind: string, url: string): Error | undefined {
  const parsed = resolve(url)
  if (!parsed || !NETWORK_SCHEMES.has(parsed.protocol)) return undefined
  if (allowedOrigins.has(parsed.origin.replace(/^ws/, 'http'))) return undefined
  blocked.push({ kind, url: parsed.href })
  return new TypeError(`Unmocked network request refused by the web test preload: ${kind} ${parsed.href}`)
}

/** Lets the current test reach a server it started itself. Call the returned function to revoke. */
export function allowNetworkOrigin(url: string | URL) {
  const origin = new URL(url).origin.replace(/^ws/, 'http')
  allowedOrigins.set(origin, (allowedOrigins.get(origin) ?? 0) + 1)
  let revoked = false
  return () => {
    if (revoked) return
    revoked = true
    const count = (allowedOrigins.get(origin) ?? 1) - 1
    if (count > 0) allowedOrigins.set(origin, count)
    else allowedOrigins.delete(origin)
  }
}

/** Returns and forgets every request refused since the last call. */
export function takeBlockedRequests() {
  const taken = blocked
  blocked = []
  return taken
}

export function describeBlockedRequests(requests: BlockedRequest[]) {
  const unique = [...new Set(requests.map(({ kind, url }) => `${kind} ${url}`))]
  return (
    `This test made ${requests.length === 1 ? 'an unmocked network request' : `${requests.length} unmocked network requests`}:\n` +
    unique.map((line) => `  ${line}`).join('\n') +
    '\nMock it instead: seed the query cache, inject the API, or pass the DOM harness an api route table' +
    ' (src/test/apiMock.ts).'
  )
}

/** Wraps a fetch implementation so requests to the network are refused and recorded. */
export function guardFetch<T extends typeof fetch>(target: T, kind = 'fetch'): T {
  const guarded = function (this: unknown, input: Parameters<typeof fetch>[0], init?: RequestInit) {
    const error = refuseNetworkRequest(`${kind} ${requestMethod(input, init)}`, requestUrl(input))
    if (error) return Promise.reject(error)
    return Reflect.apply(target, this, [input, init])
  }
  return Object.assign(guarded, target) as unknown as T
}

let installed = false

/** Installs the process-wide guards. The test preload calls this once. */
export function installNetworkGuard() {
  if (installed) return
  installed = true
  globalThis.fetch = guardFetch(globalThis.fetch)
  const NativeWebSocket = globalThis.WebSocket
  if (NativeWebSocket) {
    globalThis.WebSocket = new Proxy(NativeWebSocket, {
      construct(target, args, newTarget) {
        const error = refuseNetworkRequest('WebSocket', String(args[0]))
        if (error) throw error
        return Reflect.construct(target, args, newTarget)
      },
    })
  }
}

/**
 * Happy DOM fetch interceptor for harness windows, covering requests the window makes itself (its
 * own fetch, XMLHttpRequest and resource loads). Happy DOM counts the asynchronous hook as a
 * pending task and only ends it when the hook returns, so the hook must not throw: a refused
 * request resolves as a network error response instead.
 */
export const networkGuardInterceptor: IFetchInterceptor = {
  async beforeAsyncRequest({ request, window }) {
    if (refuseNetworkRequest(`DOM window ${request.method}`, request.url)) return window.Response.error()
    return undefined
  },
  beforeSyncRequest({ request, window }) {
    if (!refuseNetworkRequest(`DOM window synchronous ${request.method}`, request.url)) return undefined
    return {
      status: 0,
      statusText: '',
      ok: false,
      url: request.url,
      redirected: false,
      headers: new window.Headers(),
      body: null,
    }
  },
}
