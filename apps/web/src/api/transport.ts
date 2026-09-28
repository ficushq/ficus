import type { Transport, RequestOptions } from '@ficus/client-core'
import { HttpResponseError, readApiErrorMessage } from '@ficus/client-core'
import { authFetch, apiUrl, getWsUrl } from './client'

/** Translate a client-core RequestOptions into a browser fetch init (cookie + CSRF added by authFetch). */
function toFetchInit(options?: RequestOptions): RequestInit {
  const init: RequestInit = {}
  if (options?.method) init.method = options.method
  if (options?.signal) init.signal = options.signal

  const isFormData = typeof FormData !== 'undefined' && options?.body instanceof FormData
  const headers: Record<string, string> = { ...(options?.headers ?? {}) }
  if (options?.body !== undefined) {
    if (isFormData) {
      init.body = options.body as FormData // browser sets multipart Content-Type with boundary
    } else {
      if (!('Content-Type' in headers)) headers['Content-Type'] = 'application/json'
      init.body = JSON.stringify(options.body)
    }
  }
  init.headers = headers
  return init
}

/**
 * Web transport: rides the HttpOnly session cookie (credentials) + CSRF header on mutations,
 * resolving paths against the hiretau.ai-aware API base (see ./client).
 */
export const webTransport: Transport = {
  async request<T>(path: string, options?: RequestOptions): Promise<T> {
    const res = await authFetch(path, toFetchInit(options))
    if (!res.ok) throw new HttpResponseError(res.status, await readApiErrorMessage(res))
    if (res.status === 204) return undefined as T
    const contentType = res.headers.get('Content-Type') ?? ''
    if (!contentType.includes('application/json')) return undefined as T
    return (await res.json()) as T
  },

  async openStream(path: string, options?: RequestOptions): Promise<ReadableStreamDefaultReader<Uint8Array>> {
    const res = await authFetch(path, toFetchInit(options))
    if (!res.ok) throw new HttpResponseError(res.status, await readApiErrorMessage(res))
    const reader = res.body?.getReader()
    if (!reader) throw new Error('No response body')
    return reader
  },

  wsUrl(path: string, params?: Record<string, string>): string {
    const base = getWsUrl().replace(/\/ws$/, '')
    const qs = params ? `?${new URLSearchParams(params)}` : ''
    return `${base}${path}${qs}`
  },

  url(path: string): string {
    return apiUrl(path)
  },
}
