import { readApiErrorMessage } from '@ficus/client-core'
import { CSRF_HEADER } from '@ficus/shared/http-headers'
import { AUTH_TOKEN_STORAGE_KEY } from '@ficus/shared/browser-keys'
export { readApiErrorMessage } from '@ficus/client-core'

const BASE_URL = (import.meta.env?.BASE_URL ?? '/').replace(/\/$/, '')

// Optional BUILD-TIME override for split-domain deployments (API on a
// different origin than the page). Unset everywhere we deploy today.
// Development always stays same-origin and lets Vite's authenticated backend
// proxy choose the target. This prevents an ambient VITE_TAU_API_URL from
// bypassing the read-only production guard in local development.
const EXPLICIT_API_ORIGIN = import.meta.env?.DEV
  ? undefined
  : (import.meta.env?.VITE_TAU_API_URL as string | undefined)?.replace(/\/$/, '')

/**
 * Get the API base URL: `VITE_TAU_API_URL` if the bundle was built with one,
 * otherwise the PAGE's own origin (plus APP_BASE_PATH via
 * import.meta.env.BASE_URL).
 *
 * There used to be hostname sniffing here mapping `<name>.ficus.sh` to
 * `https://api-<name>.ficus.sh` — the retired pre-platform deployment's
 * split-domain layout. Hosted-platform tenants live at `<name>.ficus.sh`
 * with the API served SAME-ORIGIN behind caddy, so that mapping sent every
 * tenant's login to a subdomain that doesn't exist (observed live: CORS
 * failure, status null, on the first tenant's first login). Deriving the
 * API location from the hostname is over: explicit env or same-origin.
 */
export function getApiUrl(path: string = ''): string {
  if (typeof window === 'undefined') {
    return (BASE_URL === '/' ? 'http://localhost' : `http://localhost${BASE_URL}`) + path
  }

  const origin = EXPLICIT_API_ORIGIN ?? window.location.origin
  return origin + (BASE_URL === '/' ? '' : BASE_URL) + path
}

export function getApiHost(): string {
  return new URL(getApiUrl()).host
}

export function getWsUrl(): string {
  return getApiUrl('/ws').replace(/^http/, 'ws')
}

/**
 * Resolve an API path (e.g. '/images/123') to the current page's API URL.
 * Resolve lazily: tests and embedded shells can replace the Window after this
 * module is loaded, and retaining an earlier DOM instance would misroute calls.
 */
export function apiUrl(path: string): string {
  return `${getApiUrl('/api')}${path}`
}

export function getStoredToken(): string | null {
  return localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)
}

export function setStoredToken(token: string): void {
  localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, token)
}

// retired-credential cleanup: remove in Wave 3. Browsers that have not opened the app
// since the cookie migration can still hold the pre-rename credential; purge it too.
const RETIRED_AUTH_TOKEN_STORAGE_KEY = 'tau_password'

export function clearStoredToken(): void {
  localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY)
  localStorage.removeItem(RETIRED_AUTH_TOKEN_STORAGE_KEY)
}

// Auth now travels in an HttpOnly session cookie (sent via credentials: 'include');
// the bearer-header path stays for CLI/agents. Mutating requests carry a CSRF header
// — a cross-site caller can't set a custom header without a gated CORS preflight, so
// it can't ride the ambient cookie. Its name is CSRF_HEADER (@ficus/shared/http-headers).
/**
 * Fetch with the session cookie (credentials) + a CSRF header on mutations. Resolves
 * API paths (e.g. '/agents/123') against API_BASE; full URLs pass through.
 */
export function authFetch(path: string, init?: RequestInit): Promise<Response> {
  const url = path.startsWith('http') ? path : apiUrl(path)
  const method = (init?.method ?? 'GET').toUpperCase()
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string> | undefined) }
  if (method !== 'GET' && method !== 'HEAD') headers[CSRF_HEADER] = '1'
  return fetch(url, { ...init, headers, credentials: 'include' })
}

/**
 * Typed API fetch: resolves path, adds auth + JSON headers, parses JSON.
 *
 * @param path - API path without /api prefix, e.g. '/agents/123'
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly payload?: unknown
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  // Don't set Content-Type for FormData - browser sets it with boundary automatically
  const isFormData = options?.body instanceof FormData
  const headers = isFormData ? { ...options?.headers } : { 'Content-Type': 'application/json', ...options?.headers }

  const response = await authFetch(path, {
    ...options,
    headers,
  })

  if (!response.ok) {
    const payload = await response
      .clone()
      .json()
      .catch(() => undefined)
    throw new ApiError(response.status, await readApiErrorMessage(response), payload)
  }

  if (response.status === 204) {
    return undefined as T
  }

  return response.json()
}
