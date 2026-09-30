/**
 * Sibling apps served on the same origin under the service worker's scope.
 * They own their own HTML routes and assets, so the web app's worker never
 * answers for them: no app-shell navigation fallback and no runtime caching.
 */
export const SIBLING_APP_PATHS = ['/docs', '/farm'] as const

/**
 * Squads' deployed apps, proxied at /api/app/<id>/. Not the web app's API:
 * another app's pages and assets, each behind its own token. Caching them as
 * API responses would keep a private app in this origin's Cache Storage, and
 * a failure (say, a body that won't decode) came back as the worker's
 * "Offline and no cached data available" 503 instead of the real error.
 */
export const DEPLOYED_APP_PREFIX = '/api/app/'

/**
 * APIs the worker never caches: a sibling app's private data (the farm's chat,
 * DMs included, and its settings), which a page it controls could otherwise
 * leave in Cache Storage on a shared browser.
 */
export const UNCACHED_API_PATHS = ['/api/farm-chat/', '/api/farm-preferences/'] as const

/** True when `pathname` is an API the worker must pass straight to the network, relative to its scope. */
export function isUncachedApi(pathname: string, basePath: string): boolean {
  const base = basePath.replace(/\/$/, '')
  return UNCACHED_API_PATHS.some((path) => pathname.startsWith(base + path))
}

/**
 * True when `pathname` is a sibling app's root or anything below it, or a
 * deployed app's, relative to the worker's scope.
 */
export function bypassesServiceWorker(pathname: string, basePath: string): boolean {
  const base = basePath.replace(/\/$/, '')
  if (pathname.startsWith(base + DEPLOYED_APP_PREFIX)) return true
  return SIBLING_APP_PATHS.some((path) => pathname === base + path || pathname.startsWith(`${base}${path}/`))
}
