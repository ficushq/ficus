/**
 * Sibling apps served on the same origin under the service worker's scope.
 * They own their own HTML routes and assets, so the web app's worker never
 * answers for them: no app-shell navigation fallback and no runtime caching.
 */
export const SIBLING_APP_PATHS = ['/docs', '/garden'] as const

/** True when `pathname` is a sibling app's root or anything below it, relative to the worker's scope. */
export function bypassesServiceWorker(pathname: string, basePath: string): boolean {
  const base = basePath.replace(/\/$/, '')
  return SIBLING_APP_PATHS.some((path) => pathname === base + path || pathname.startsWith(`${base}${path}/`))
}
