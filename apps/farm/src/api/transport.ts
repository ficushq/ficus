import { HttpResponseError, readApiErrorMessage, type RequestOptions, type Transport } from '@ficus/client-core'
import { CSRF_HEADER } from '@ficus/shared/http-headers'
import { apiUrl, wsUrl } from './base'

type Fetch = (input: string, init: RequestInit) => Promise<Response>

function toInit(options?: RequestOptions): RequestInit {
  const method = (options?.method ?? 'GET').toUpperCase()
  const headers: Record<string, string> = { ...(options?.headers ?? {}) }
  const init: RequestInit = { method, credentials: 'include', signal: options?.signal }
  if (options?.body !== undefined) {
    if (typeof FormData !== 'undefined' && options.body instanceof FormData) {
      init.body = options.body
    } else {
      headers['Content-Type'] ??= 'application/json'
      init.body = JSON.stringify(options.body)
    }
  }
  // The session cookie rides along; a custom header on mutations is the CSRF proof.
  if (method !== 'GET' && method !== 'HEAD') headers[CSRF_HEADER] = '1'
  init.headers = headers
  return init
}

/** Cookie-session transport for the same-origin farm, mirroring the web app's. */
export function createFarmTransport(fetchImpl: Fetch = (...args) => fetch(...args)): Transport {
  return {
    async request<T>(path: string, options?: RequestOptions): Promise<T> {
      const res = await fetchImpl(apiUrl(path), toInit(options))
      if (!res.ok) throw new HttpResponseError(res.status, await readApiErrorMessage(res))
      if (res.status === 204) return undefined as T
      if (!(res.headers.get('Content-Type') ?? '').includes('application/json')) return undefined as T
      return (await res.json()) as T
    },
    async openStream(path: string, options?: RequestOptions) {
      const res = await fetchImpl(apiUrl(path), toInit(options))
      if (!res.ok) throw new HttpResponseError(res.status, await readApiErrorMessage(res))
      const reader = res.body?.getReader()
      if (!reader) throw new Error('No response body')
      return reader
    },
    wsUrl(path: string, params?: Record<string, string>) {
      return `${wsUrl(path)}${params ? `?${new URLSearchParams(params)}` : ''}`
    },
    url(path: string) {
      return apiUrl(path)
    },
  }
}
