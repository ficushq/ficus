import { describe, expect, test } from 'bun:test'
import { IMAGE_CACHE_NAME, SW_RUNTIME_CACHE_PREFIXES } from '@ficus/shared/browser-keys'
import { bypassesServiceWorker, isUncachedApi } from './swRoutes'
import { runtimeServiceWorkerCaches, serviceWorkerCacheNames, staleServiceWorkerCaches } from './swCaches'

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
      'farm-cache-v1',
      IMAGE_CACHE_NAME,
    ]
    expect(staleServiceWorkerCaches(keys, 'v2')).toEqual(['ficus-cache-old', 'ficus-api-cache-old'])
  })

  test('clearing runtime caches covers current and older caches but not foreign ones', () => {
    const current = serviceWorkerCacheNames('v2')
    const keys = [current.static, current.api, 'ficus-cache-old', 'workbox-precache-v2-x', 'farm-cache-v1']
    expect(runtimeServiceWorkerCaches(keys)).toEqual([current.static, current.api, 'ficus-cache-old'])
  })
})

describe('service-worker routes', () => {
  test('sibling apps on the origin (docs, farm) bypass the service worker', () => {
    for (const base of ['/', '/ficus/']) {
      const at = (path: string) => base.replace(/\/$/, '') + path
      for (const path of ['/docs', '/docs/', '/docs/start/cloud/', '/farm', '/farm/', '/farm/beds/1']) {
        expect(bypassesServiceWorker(at(path), base)).toBe(true)
      }
      for (const path of ['/', '/farming', '/docsearch', '/settings', '/api/farm']) {
        expect(bypassesServiceWorker(at(path), base)).toBe(false)
      }
    }
  })

  test("squads' deployed apps bypass the service worker: their pages, assets and failures are their own", () => {
    for (const base of ['/', '/ficus/']) {
      const at = (path: string) => base.replace(/\/$/, '') + path
      for (const path of ['/api/app/e691/', '/api/app/e691/_next/static/chunks/app.js', '/api/app/e691/sign-in']) {
        expect(bypassesServiceWorker(at(path), base)).toBe(true)
      }
      for (const path of ['/api/apps', '/api/application', '/api/squads/1/apps']) {
        expect(bypassesServiceWorker(at(path), base)).toBe(false)
      }
    }
  })

  test("never caches the farm's chat or settings APIs", () => {
    for (const base of ['/', '/ficus/']) {
      const at = (path: string) => base.replace(/\/$/, '') + path
      expect(isUncachedApi(at('/api/farm-chat/rooms/1/messages'), base)).toBe(true)
      expect(isUncachedApi(at('/api/farm-chat/people'), base)).toBe(true)
      expect(isUncachedApi(at('/api/farm-preferences/me'), base)).toBe(true)
      expect(isUncachedApi(at('/api/squads'), base)).toBe(false)
    }
  })

  test('a sibling path outside the registration scope is not matched', () => {
    expect(bypassesServiceWorker('/farm/x', '/ficus/')).toBe(false)
  })
})
