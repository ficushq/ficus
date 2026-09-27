import { SW_API_CACHE_PREFIX, SW_CACHE_PREFIX, SW_RUNTIME_CACHE_PREFIXES } from '@ficus/shared/browser-keys'

/**
 * Cache prefixes written by builds before the Ficus rename (the service
 * worker's runtime caches and the page-side image cache). Nothing reads them
 * any more; activation and CLEAR_CACHE delete them so an installed PWA does not
 * keep an old API-response or image cache forever.
 */
// retired-cache cleanup: remove in Wave 3
export const RETIRED_SW_CACHE_PREFIXES = ['tau-cache-', 'tau-api-cache-', 'tau-images-'] as const

/** This build's runtime cache names. */
export function serviceWorkerCacheNames(version: string): { static: string; api: string } {
  return { static: `${SW_CACHE_PREFIX}${version}`, api: `${SW_API_CACHE_PREFIX}${version}` }
}

const hasPrefix = (key: string, prefixes: readonly string[]) => prefixes.some((prefix) => key.startsWith(prefix))

/** Every runtime cache this app owns, in any version (current, older or retired). Foreign caches are left alone. */
export function runtimeServiceWorkerCaches(keys: readonly string[]): string[] {
  return keys.filter((key) => hasPrefix(key, SW_RUNTIME_CACHE_PREFIXES) || hasPrefix(key, RETIRED_SW_CACHE_PREFIXES))
}

/** Runtime caches to delete on activation: every owned cache except this build's two. */
export function staleServiceWorkerCaches(keys: readonly string[], version: string): string[] {
  const current = serviceWorkerCacheNames(version)
  return runtimeServiceWorkerCaches(keys).filter((key) => key !== current.static && key !== current.api)
}
