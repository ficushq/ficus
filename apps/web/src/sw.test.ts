import { describe, expect, test } from 'bun:test'
import { IMAGE_CACHE_NAME, SW_RUNTIME_CACHE_PREFIXES } from '@ficus/shared/browser-keys'
import {
  RETIRED_SW_CACHE_PREFIXES,
  runtimeServiceWorkerCaches,
  serviceWorkerCacheNames,
  staleServiceWorkerCaches,
} from './swCaches'

describe('service-worker runtime caches', () => {
  test('cache names are the ficus prefixes plus the build version', () => {
    expect(serviceWorkerCacheNames('v7')).toEqual({ static: 'ficus-cache-v7', api: 'ficus-api-cache-v7' })
  })

  test('the runtime prefix list is exactly the two ficus prefixes', () => {
    expect([...SW_RUNTIME_CACHE_PREFIXES]).toEqual(['ficus-cache-', 'ficus-api-cache-'])
  })

  test('activation deletes older ficus caches and keeps the current pair and foreign caches', () => {
    const current = serviceWorkerCacheNames('v2')
    const keys = [
      'ficus-cache-old',
      'ficus-api-cache-old',
      current.static,
      current.api,
      'workbox-precache-v2-https://example.test/',
      'garden-cache-v1',
      IMAGE_CACHE_NAME,
    ]
    expect(staleServiceWorkerCaches(keys, 'v2')).toEqual(['ficus-cache-old', 'ficus-api-cache-old'])
  })

  test('activation deletes the runtime caches written before the rename, so none is stranded', () => {
    expect(RETIRED_SW_CACHE_PREFIXES).toHaveLength(3)
    for (const prefix of RETIRED_SW_CACHE_PREFIXES) expect(prefix.startsWith('ficus')).toBe(false)
    const retired = RETIRED_SW_CACHE_PREFIXES.map((prefix) => `${prefix}old-build`)
    expect(staleServiceWorkerCaches([...retired, serviceWorkerCacheNames('v2').static], 'v2')).toEqual(retired)
  })

  test('clearing runtime caches covers current, older and retired caches but not foreign ones', () => {
    const current = serviceWorkerCacheNames('v2')
    const retired = RETIRED_SW_CACHE_PREFIXES.map((prefix) => `${prefix}old-build`)
    const keys = [
      current.static,
      current.api,
      'ficus-cache-old',
      ...retired,
      'workbox-precache-v2-x',
      'garden-cache-v1',
    ]
    expect(runtimeServiceWorkerCaches(keys)).toEqual([current.static, current.api, 'ficus-cache-old', ...retired])
  })
})
