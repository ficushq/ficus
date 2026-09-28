/**
 * Transport seam shared by web and mobile.
 *
 * Endpoint functions (see ./resources) are written against this interface so the
 * same API layer works over either host's transport:
 * - web: cookie + CSRF header (`CSRF_HEADER` from `@ficus/shared/http-headers`) + hiretau.ai host resolution (apps/web/src/api/transport.ts)
 * - mobile: `Authorization: Bearer` + paired base URL + expo-secure-store token (the native companion)
 */
export interface RequestOptions {
  method?: string
  /** JSON-serialized unless it is a FormData (then sent as-is). */
  body?: unknown
  headers?: Record<string, string>
  signal?: AbortSignal
}

export interface Transport {
  /** Typed JSON request. Resolves `path` (e.g. '/users/123') against the host's API base; throws on !ok. */
  request<T>(path: string, options?: RequestOptions): Promise<T>
  /** Open an SSE/byte stream (e.g. POST /chat); returns a reader over the response body. */
  openStream(path: string, options?: RequestOptions): Promise<ReadableStreamDefaultReader<Uint8Array>>
  /** Build a ws(s):// URL for a path (e.g. '/ws'), applying host + auth query params. */
  wsUrl(path: string, params?: Record<string, string>): string
  /** Build an absolute API URL for a path (e.g. for an <img src>); same base as request(). */
  url(path: string): string
}
