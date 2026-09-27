/**
 * Service Worker Registration and PWA Utilities
 *
 * Version-anchored update flow: the page knows its own build version
 * (__FICUS_SW_CACHE_VERSION__, injected by vite into both this bundle and the
 * service worker), asks any waiting service worker for its version over a
 * MessageChannel, and shows the update banner iff the two differ. Applying an
 * update is confirmed: SKIP_WAITING → await activation/controllerchange →
 * reload. No persisted markers, no worker-object-identity heuristics — after
 * a successful update the reloaded page's own version matches the new worker,
 * so the banner logically cannot re-show.
 */

import { installPwaUpdateChecks, readServiceWorkerVersion, type PwaUpdateController } from './pwaUpdater'
import { PWA_AUTO_APPLY_TRANSITION_STORAGE_KEY, PWA_JUST_APPLIED_STORAGE_KEY } from '@ficus/shared/browser-keys'

/** Build version baked into this page bundle; equals the SW's CACHE_VERSION for the same build. */
export const APP_VERSION =
  typeof __FICUS_SW_CACHE_VERSION__ === 'string' && __FICUS_SW_CACHE_VERSION__.length > 0
    ? __FICUS_SW_CACHE_VERSION__
    : 'dev'

export const SKIP_WAITING_CONFIRM_TIMEOUT_MS = 4_000

export interface ServiceWorkerState {
  isSupported: boolean
  isInstalled: boolean
  isOnline: boolean
  registration: ServiceWorkerRegistration | null
  updateAvailable: boolean
}

let swRegistration: ServiceWorkerRegistration | null = null
let updateAvailable = false
let updateController: PwaUpdateController | null = null
let applyInFlight: Promise<void> | null = null
let evaluateRunId = 0
let reloadPage: () => void = () => window.location.reload()
let skipWaitingTimeoutMs = SKIP_WAITING_CONFIRM_TIMEOUT_MS
const autoApplyAttemptedVersions = new Set<string>()
const workerVersions = new WeakMap<ServiceWorker, string>()
const watchedWorkers = new WeakSet<ServiceWorker>()
const watchedRegistrations = new WeakSet<ServiceWorkerRegistration>()

const updateCallbacks: Set<(available: boolean) => void> = new Set()

function setUpdateAvailable(available: boolean): void {
  if (updateAvailable === available) return
  updateAvailable = available
  if (available) console.log('[PWA] New version available')
  updateCallbacks.forEach((cb) => cb(available))
}

async function getWorkerVersion(worker: ServiceWorker): Promise<string | null> {
  const cached = workerVersions.get(worker)
  if (cached) return cached
  const version = await readServiceWorkerVersion(worker)
  // Only cache successful reads so unresponsive workers are retried on later checks.
  if (version) workerVersions.set(worker, version)
  return version
}

/**
 * Auto-apply transition guard: a successful auto-apply reloads the page, and a
 * healthy reload changes APP_VERSION to the applied version. If the reloaded
 * page has the SAME version and sees the SAME waiting version again, the
 * server is flip-flopping between builds (e.g. a CDN edge-caching a stale
 * sw.js against a fresh index.html). Auto-applying again would reload-loop
 * forever, so the pair is remembered in sessionStorage across reloads.
 */
const AUTO_APPLY_TRANSITION_KEY = PWA_AUTO_APPLY_TRANSITION_STORAGE_KEY

function getSessionStorage(): Storage | null {
  try {
    return globalThis.sessionStorage ?? window.sessionStorage ?? null
  } catch {
    return null
  }
}

function hasAttemptedTransition(targetVersion: string): boolean {
  try {
    return getSessionStorage()?.getItem(AUTO_APPLY_TRANSITION_KEY) === `${APP_VERSION}->${targetVersion}`
  } catch {
    return false
  }
}

function recordTransitionAttempt(targetVersion: string): void {
  try {
    getSessionStorage()?.setItem(AUTO_APPLY_TRANSITION_KEY, `${APP_VERSION}->${targetVersion}`)
  } catch {
    // Without storage the in-memory attempt set still bounds within-page retries.
  }
}

/**
 * Reconcile banner state with the registration: banner iff the waiting worker
 * reports a version different from this page's build. Inside the auto-apply
 * window (fresh open/resume, no interaction yet) a new version is applied
 * silently instead of prompting.
 */
async function evaluateUpdateState(): Promise<void> {
  const runId = ++evaluateRunId
  const waiting = swRegistration?.waiting ?? null
  if (!waiting) {
    setUpdateAvailable(false)
    return
  }

  const version = await getWorkerVersion(waiting)
  if (runId !== evaluateRunId) return

  // No readable version means the worker can't be messaged right now — so it
  // couldn't be activated via SKIP_WAITING either (iOS phantom-waiting after
  // an applied update looks exactly like this). Hide and retry on the next
  // check; a real update becomes messageable as soon as the worker can run.
  if (!version || version === APP_VERSION) {
    setUpdateAvailable(false)
    return
  }

  if (hasAttemptedTransition(version)) {
    console.warn(
      `[PWA] Already auto-applied ${APP_VERSION} -> ${version} this session but the page came back unchanged. ` +
        'The server may be serving inconsistent builds (check CDN/proxy caching of sw.js vs index.html). ' +
        'Falling back to the manual update banner.'
    )
  } else if (!applyInFlight && !autoApplyAttemptedVersions.has(version) && updateController?.isInAutoApplyWindow()) {
    autoApplyAttemptedVersions.add(version)
    recordTransitionAttempt(version)
    try {
      await applyUpdate()
      return
    } catch {
      // Confirmation timed out — fall through to the visible banner.
    }
    if (runId !== evaluateRunId) return
  }

  setUpdateAvailable(true)
}

function watchRegistrationForUpdates(registration: ServiceWorkerRegistration): void {
  const watchWorker = (worker: ServiceWorker | null | undefined) => {
    if (!worker || watchedWorkers.has(worker)) return
    watchedWorkers.add(worker)
    worker.addEventListener?.('statechange', () => {
      void evaluateUpdateState()
    })
  }

  if (!watchedRegistrations.has(registration)) {
    watchedRegistrations.add(registration)
    registration.addEventListener?.('updatefound', () => {
      watchWorker(registration.installing)
    })
  }
  watchWorker(registration.installing)
}

/**
 * Register the service worker and start update checks. Idempotent.
 */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  initializeInstallPromptListeners()
  if (!('serviceWorker' in navigator)) {
    console.log('[PWA] Service workers not supported')
    return null
  }
  if (import.meta.env?.DEV) {
    console.log('[PWA] Service worker disabled in dev')
    return null
  }

  try {
    localStorage.removeItem(PWA_JUST_APPLIED_STORAGE_KEY)
    sessionStorage.removeItem(PWA_JUST_APPLIED_STORAGE_KEY)
  } catch {
    // Storage may be unavailable (private mode); the legacy key is harmless.
  }

  try {
    if (!swRegistration) {
      const base = import.meta.env?.BASE_URL || '/'
      swRegistration = await navigator.serviceWorker.register(`${base.replace(/\/?$/, '/')}sw.js`)
      console.log('[PWA] Service worker registered:', swRegistration.scope)
    }
    const registration = swRegistration
    watchRegistrationForUpdates(registration)
    if (!updateController) {
      updateController = installPwaUpdateChecks(registration, {
        requestEvaluation: () => void evaluateUpdateState(),
      })
    }
    void evaluateUpdateState()
    return registration
  } catch (error) {
    console.error('[PWA] Service worker registration failed:', error)
    return null
  }
}

/**
 * Get current service worker state
 */
export function getServiceWorkerState(): ServiceWorkerState {
  return {
    isSupported: 'serviceWorker' in navigator,
    isInstalled: Boolean(swRegistration),
    isOnline: navigator.onLine,
    registration: swRegistration,
    updateAvailable,
  }
}

/**
 * Subscribe to update availability changes
 */
export function onUpdateAvailable(callback: (available: boolean) => void): () => void {
  updateCallbacks.add(callback)
  if (updateAvailable) {
    callback(true)
  }
  return () => {
    updateCallbacks.delete(callback)
  }
}

/** Trigger an unthrottled update check (e.g. after a WS reconnect hinted at a server restart). */
export function requestUpdateCheck(): void {
  updateController?.checkForUpdate({ isResume: true })
}

function isActivated(worker: ServiceWorker): boolean {
  return worker.state === 'activating' || worker.state === 'activated'
}

function waitForActivation(worker: ServiceWorker, timeoutMs: number): Promise<boolean> {
  if (isActivated(worker)) return Promise.resolve(true)
  return new Promise((resolve) => {
    let done = false
    const finish = (ok: boolean) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try {
        navigator.serviceWorker.removeEventListener?.('controllerchange', onControllerChange)
      } catch {
        // navigator.serviceWorker may be gone in teardown paths.
      }
      worker.removeEventListener?.('statechange', onStateChange)
      resolve(ok)
    }
    const onControllerChange = () => finish(true)
    const onStateChange = () => {
      if (isActivated(worker)) finish(true)
    }
    const timer = setTimeout(() => finish(isActivated(worker)), timeoutMs)
    try {
      navigator.serviceWorker.addEventListener?.('controllerchange', onControllerChange)
    } catch {
      // Listening is best-effort; the statechange listener still confirms.
    }
    worker.addEventListener?.('statechange', onStateChange)
  })
}

/**
 * Apply the waiting update: SKIP_WAITING → confirm activation → reload.
 * Throws if activation cannot be confirmed after a retry; the banner then
 * re-shows because the waiting version still differs from the page's —
 * honest pending state instead of a suppression window.
 */
export async function applyUpdate(): Promise<void> {
  if (applyInFlight) return applyInFlight
  const run = async () => {
    const waiting = swRegistration?.waiting
    if (!waiting) {
      console.log('[PWA] No waiting service worker to apply')
      return
    }
    setUpdateAvailable(false)
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        waiting.postMessage({ type: 'SKIP_WAITING' })
      } catch {
        // A worker that can't be messaged won't confirm; the retry/timeout handles it.
      }
      if (await waitForActivation(waiting, skipWaitingTimeoutMs)) {
        reloadPage()
        return
      }
    }
    throw new Error('[PWA] Service worker activation timed out')
  }
  applyInFlight = run()
    .catch((error) => {
      // Resurface the still-pending update instead of suppressing it.
      void evaluateUpdateState()
      throw error
    })
    .finally(() => {
      applyInFlight = null
    })
  return applyInFlight
}

export function __setReloadPageForTests(fn: (() => void) | null): void {
  reloadPage = fn ?? (() => window.location.reload())
}

export function __setSkipWaitingTimeoutForTests(ms: number | null): void {
  skipWaitingTimeoutMs = ms ?? SKIP_WAITING_CONFIRM_TIMEOUT_MS
}

export function __resetServiceWorkerForTests(): void {
  swRegistration = null
  updateAvailable = false
  applyInFlight = null
  evaluateRunId = 0
  autoApplyAttemptedVersions.clear()
  updateController?.dispose()
  updateController = null
  updateCallbacks.clear()
  reloadPage = () => window.location.reload()
  skipWaitingTimeoutMs = SKIP_WAITING_CONFIRM_TIMEOUT_MS
}

export async function clearCache(): Promise<boolean> {
  if (!('caches' in window)) {
    return false
  }

  try {
    const cacheNames = await caches.keys()
    await Promise.all(cacheNames.map((name) => caches.delete(name)))
    console.log('[PWA] All caches cleared')
    return true
  } catch (error) {
    console.error('[PWA] Failed to clear cache:', error)
    return false
  }
}

/**
 * Install prompt handling (A2HS)
 */
let deferredInstallPrompt: BeforeInstallPromptEvent | null = null

interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[]
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>
  prompt(): Promise<void>
}

const installPromptListenerWindows = new WeakSet<EventTarget>()

/** Initialize install-prompt listeners for the current browser window. Idempotent per window. */
export function initializeInstallPromptListeners(): void {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return
  if (installPromptListenerWindows.has(window)) return
  installPromptListenerWindows.add(window)

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault()
    deferredInstallPrompt = event as BeforeInstallPromptEvent
    console.log('[PWA] Install prompt captured')
  })

  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null
    console.log('[PWA] App installed')
  })
}

export function canInstall(): boolean {
  return deferredInstallPrompt !== null
}

export async function promptInstall(): Promise<boolean> {
  if (!deferredInstallPrompt) {
    console.log('[PWA] No install prompt available')
    return false
  }

  try {
    await deferredInstallPrompt.prompt()
    const result = await deferredInstallPrompt.userChoice

    if (result.outcome === 'accepted') {
      console.log('[PWA] User accepted install')
      deferredInstallPrompt = null
      return true
    } else {
      console.log('[PWA] User dismissed install')
      return false
    }
  } catch (error) {
    console.error('[PWA] Install prompt failed:', error)
    return false
  }
}

export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false

  if (window.matchMedia('(display-mode: standalone)').matches) {
    return true
  }
  if ((navigator as any).standalone === true) {
    return true
  }
  if (document.referrer.includes('android-app://')) {
    return true
  }
  return false
}

export function getPlatform(): 'ios' | 'android' | 'desktop' | 'unknown' {
  if (typeof navigator === 'undefined') return 'unknown'
  const ua = navigator.userAgent.toLowerCase()

  if (/iphone|ipad|ipod/.test(ua)) return 'ios'
  if (/android/.test(ua)) return 'android'
  if (/macintosh|windows|linux/.test(ua) && !/mobile/.test(ua)) return 'desktop'
  return 'unknown'
}

export function getPWASupport(): {
  serviceWorker: boolean
  pushManager: boolean
  notifications: boolean
  manifest: boolean
  standalone: boolean
} {
  return {
    serviceWorker: 'serviceWorker' in navigator,
    pushManager: 'PushManager' in window,
    notifications: 'Notification' in window,
    manifest: 'BeforeInstallPromptEvent' in window || 'onbeforeinstallprompt' in window,
    standalone: isStandalone(),
  }
}

/**
 * API Cache statistics (custom message channel to your SW)
 */
export interface ApiCacheStats {
  entryCount: number
  totalSize: number
  oldestTimestamp: number | null
  newestTimestamp: number | null
}

export async function getApiCacheStats(): Promise<ApiCacheStats | null> {
  const sw = swRegistration?.active ?? navigator.serviceWorker.controller
  if (!sw) return null

  return new Promise((resolve) => {
    const channel = new MessageChannel()
    let resolved = false
    const finish = (val: ApiCacheStats | null) => {
      if (resolved) return
      resolved = true
      resolve(val)
    }

    channel.port1.onmessage = (event) => finish(event.data)
    sw.postMessage({ type: 'GET_API_CACHE_STATS' }, [channel.port2])
    setTimeout(() => finish(null), 3000)
  })
}

export async function clearApiCache(): Promise<boolean> {
  const sw = swRegistration?.active ?? navigator.serviceWorker.controller
  if (!sw) return false

  return new Promise((resolve) => {
    const channel = new MessageChannel()
    let resolved = false
    const finish = (val: boolean) => {
      if (resolved) return
      resolved = true
      resolve(val)
    }

    channel.port1.onmessage = (event) => finish(event.data?.success ?? false)
    sw.postMessage({ type: 'CLEAR_API_CACHE' }, [channel.port2])
    setTimeout(() => finish(false), 3000)
  })
}
