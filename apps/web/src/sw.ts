/// <reference lib="webworker" />

import { resolveNotificationTarget } from './lib/notificationTarget'

// Tau Service Worker
// Provides offline caching and push notification support.
// PWA updates are prompt-controlled: the app checks on resume/focus/online/pageshow
// (plus hourly while visible) and only auto-applies on open/resume before interaction.
// Foreground updates use the in-app banner instead of an unexpected reload.

import { precacheAndRoute, cleanupOutdatedCaches } from 'workbox-precaching'

declare const self: ServiceWorkerGlobalScope

declare const __TAU_SW_CACHE_VERSION__: string

const CACHE_VERSION = __TAU_SW_CACHE_VERSION__
const CACHE_NAME = `tau-cache-${CACHE_VERSION}`
const API_CACHE_NAME = `tau-api-cache-${CACHE_VERSION}`
const FICUS_RUNTIME_CACHE_PREFIXES = ['tau-cache-', 'tau-api-cache-']

// Workbox injects the precache manifest here at build time
// (replaces your PRECACHE_ASSETS array with content-hashed assets)
precacheAndRoute(self.__WB_MANIFEST)
cleanupOutdatedCaches()

self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      // Take control of open clients so a skip-waited update applies on reload.
      self.clients.claim(),
      caches
        .keys()
        .then((keys) =>
          Promise.all(
            keys
              .filter(
                (key) =>
                  FICUS_RUNTIME_CACHE_PREFIXES.some((prefix) => key.startsWith(prefix)) &&
                  key !== CACHE_NAME &&
                  key !== API_CACHE_NAME
              )
              .map((key) => caches.delete(key))
          )
        ),
    ])
  )
})

// Base path is the SW's registration scope
// e.g. "/tau/" when registered at /tau/
// or "/" when registered at root
const BASE_PATH = new URL(self.registration.scope).pathname
const p = (path: string) => BASE_PATH.replace(/\/$/, '') + path

// Fetch event - handle both static assets and API caching
self.addEventListener('fetch', (event) => {
  const { request } = event
  const url = new URL(request.url)

  if (request.method !== 'GET') return
  if (url.origin !== self.location.origin) return
  if (url.pathname.startsWith(p('/ws'))) return
  // Docs have their own HTML routes; never replace them with the cached app shell.
  if (url.pathname === p('/docs') || url.pathname.startsWith(p('/docs/'))) return

  if (url.pathname.startsWith(p('/api/'))) {
    if (url.pathname.includes('/stream')) return
    event.respondWith(handleCacheableApiRequest(request, url))
    return
  }

  // Let workbox handle precached assets via precacheAndRoute above
  // Only intercept navigation requests for SPA fallback
  if (request.mode === 'navigate') {
    event.respondWith(handleNavigationRequest(request))
  }
})

/**
 * Handle cacheable API requests with stale-while-revalidate strategy
 */
async function handleCacheableApiRequest(request: Request, url: URL): Promise<Response> {
  const cache = await caches.open(API_CACHE_NAME)

  try {
    // Try network first
    const networkResponse = await fetch(request)

    if (networkResponse.ok) {
      // Clone and cache the successful response
      const responseToCache = networkResponse.clone()

      // Add timestamp header for cache freshness tracking
      const headers = new Headers(responseToCache.headers)
      headers.set('X-Ficus-Cached-At', Date.now().toString())

      const cachedResponse = new Response(responseToCache.body, {
        status: responseToCache.status,
        statusText: responseToCache.statusText,
        headers,
      })

      await cache.put(request, cachedResponse)
      console.log('[SW] Cached API response:', url.pathname)
    }

    return networkResponse
  } catch {
    // Network failed, try cache
    console.log('[SW] Network failed, checking cache:', url.pathname)

    const cachedResponse = await cache.match(request)
    if (cachedResponse) {
      console.log('[SW] Serving cached API response:', url.pathname)

      // Add header to indicate this is cached data
      const headers = new Headers(cachedResponse.headers)
      headers.set('X-Ficus-From-Cache', 'true')

      return new Response(cachedResponse.body, {
        status: cachedResponse.status,
        statusText: cachedResponse.statusText,
        headers,
      })
    }

    // No cache available, return error response
    return new Response(JSON.stringify({ error: 'Offline and no cached data available' }), {
      status: 503,
      statusText: 'Service Unavailable',
      headers: { 'Content-Type': 'application/json' },
    })
  }
}

async function handleNavigationRequest(request: Request): Promise<Response> {
  try {
    return await fetch(request)
  } catch {
    const cached = (await caches.match(BASE_PATH)) || (await caches.match(p('/index.html')))
    if (cached) return cached
    return new Response('Offline', { status: 503 })
  }
}

// Push notification event
self.addEventListener('push', (event) => {
  console.log('[SW] Push received:', event.data?.text())

  if (!event.data) return

  let data
  try {
    data = event.data.json()
  } catch (err) {
    console.error('[SW] Failed to parse push data:', err)
    data = { title: 'Tau', body: event.data.text() }
  }

  // Same-origin only: a saved Assistant conversation link keeps its query string and base path.
  const targetUrl = resolveNotificationTarget(data, self.location.origin, BASE_PATH)

  const options = {
    body: data.body || 'You have a notification',
    icon: p('/icons/icon-192x192.png'),
    badge: p('/icons/icon-96x96.png'),
    data: { url: targetUrl },
    vibrate: [100, 50, 100],
    tag: data.tag || 'tau-notification',
    renotify: Boolean(data.renotify),
    requireInteraction: Boolean(data.requireInteraction),
    actions: data.actions || [],
  }

  event.waitUntil(self.registration.showNotification(data.title || 'Tau', options))
})

// Notification click event
self.addEventListener('notificationclick', (event) => {
  console.log('[SW] Notification clicked:', event.notification.tag)

  event.notification.close()

  const url = event.notification.data?.url || '/'
  // const action = event.action

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // Try to focus an existing window
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          return client.focus().then((focusedClient) => {
            if (focusedClient && 'navigate' in focusedClient) {
              return focusedClient.navigate(url)
            }
          })
        }
      }
      // Open a new window
      return self.clients.openWindow(url)
    })
  )
})

// Handle notification close (for analytics)
self.addEventListener('notificationclose', (event) => {
  console.log('[SW] Notification closed:', event.notification.tag)
})

// // Background sync event (for future offline task support)
// self.addEventListener('sync', (event) => {
//   console.log('[SW] Background sync:', event.tag)

//   if (event.tag === 'sync-tasks') {
//     event.waitUntil(
//       // Future: sync offline task changes
//       Promise.resolve()
//     )
//   }
// })

// // Periodic background sync (for future use)
// self.addEventListener('periodicsync', (event) => {
//   console.log('[SW] Periodic sync:', event.tag)

//   if (event.tag === 'check-notifications') {
//     event.waitUntil(
//       // Future: check for pending notifications
//       Promise.resolve()
//     )
//   }
// })

// Message event - for communication with the main app
self.addEventListener('message', (event) => {
  console.log('[SW] Message received:', event.data)

  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting()
  }

  if (event.data?.type === 'GET_VERSION') {
    event.ports[0]?.postMessage({ version: CACHE_VERSION })
  }

  if (event.data?.type === 'CLEAR_CACHE') {
    event.waitUntil(
      caches.keys().then((keys) =>
        Promise.all(
          keys
            .filter((key) => FICUS_RUNTIME_CACHE_PREFIXES.some((prefix) => key.startsWith(prefix)))
            .map((key) => caches.delete(key))
        ).then(() => {
          event.ports[0]?.postMessage({ success: true })
        })
      )
    )
  }

  if (event.data?.type === 'CLEAR_API_CACHE') {
    event.waitUntil(
      caches.delete(API_CACHE_NAME).then(() => {
        event.ports[0]?.postMessage({ success: true })
      })
    )
  }

  if (event.data?.type === 'GET_API_CACHE_STATS') {
    event.waitUntil(
      getApiCacheStats().then((stats) => {
        event.ports[0]?.postMessage(stats)
      })
    )
  }
})

/**
 * Get statistics about the API cache
 */
async function getApiCacheStats() {
  try {
    const cache = await caches.open(API_CACHE_NAME)
    const keys = await cache.keys()

    let totalSize = 0
    let oldestTimestamp = Date.now()
    let newestTimestamp = 0

    for (const request of keys) {
      const response = await cache.match(request)
      if (response) {
        const blob = await response.clone().blob()
        totalSize += blob.size

        const cachedAt = response.headers.get('X-Ficus-Cached-At')
        if (cachedAt) {
          const timestamp = parseInt(cachedAt, 10)
          oldestTimestamp = Math.min(oldestTimestamp, timestamp)
          newestTimestamp = Math.max(newestTimestamp, timestamp)
        }
      }
    }

    return {
      entryCount: keys.length,
      totalSize,
      oldestTimestamp: keys.length > 0 ? oldestTimestamp : null,
      newestTimestamp: keys.length > 0 ? newestTimestamp : null,
    }
  } catch (error) {
    console.error('[SW] Failed to get cache stats:', error)
    return { entryCount: 0, totalSize: 0, oldestTimestamp: null, newestTimestamp: null }
  }
}
