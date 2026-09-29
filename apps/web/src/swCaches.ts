import { SW_API_CACHE_PREFIX, SW_CACHE_PREFIX, SW_RUNTIME_CACHE_PREFIXES } from '@ficus/shared/browser-keys'

/** This build's runtime cache names. */
export function serviceWorkerCacheNames(version: string): { static: string; api: string } {
  return { static: `${SW_CACHE_PREFIX}${version}`, api: `${SW_API_CACHE_PREFIX}${version}` }
}

const hasPrefix = (key: string, prefixes: readonly string[]) => prefixes.some((prefix) => key.startsWith(prefix))

/** Every runtime cache this app owns, in any version (current or older). Foreign caches are left alone. */
export function runtimeServiceWorkerCaches(keys: readonly string[]): string[] {
  return keys.filter((key) => hasPrefix(key, SW_RUNTIME_CACHE_PREFIXES))
}

/** Runtime caches to delete on activation: every owned cache except this build's two. */
export function staleServiceWorkerCaches(keys: readonly string[], version: string): string[] {
  const current = serviceWorkerCacheNames(version)
  return runtimeServiceWorkerCaches(keys).filter((key) => key !== current.static && key !== current.api)
}
