/**
 * Sibling apps served on the same origin under the service worker's scope.
 * They own their own HTML routes and assets, so the web app's worker never
 * answers for them: no app-shell navigation fallback and no runtime caching.
 */
export const SIBLING_APP_PATHS = ['/docs', '/farm'] as const

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

/** True when `pathname` is a sibling app's root or anything below it, relative to the worker's scope. */
export function bypassesServiceWorker(pathname: string, basePath: string): boolean {
  const base = basePath.replace(/\/$/, '')
  return SIBLING_APP_PATHS.some((path) => pathname === base + path || pathname.startsWith(`${base}${path}/`))
}
