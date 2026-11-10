import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { acquireDomHarness } from '../test/domHarness'

const serviceWorker = await import('./serviceWorker')

type Listener = () => void

interface FakeWorker extends Omit<ServiceWorker, 'state'> {
  state: string
  listeners: Map<string, Set<Listener>>
}

function createFakeWorker(opts: { version?: string; state?: string; activateOnSkipWaiting?: boolean } = {}) {
  const listeners = new Map<string, Set<Listener>>()
  const worker = {
    state: opts.state ?? 'installed',
    listeners,
    addEventListener: (event: string, cb: Listener) => {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event)!.add(cb)
    },
    removeEventListener: (event: string, cb: Listener) => listeners.get(event)?.delete(cb),
    postMessage: mock((message: { type?: string }, ports?: MessagePort[]) => {
      if (message?.type === 'GET_VERSION' && opts.version) {
        ports?.[0]?.postMessage({ version: opts.version })
      }
      if (message?.type === 'SKIP_WAITING' && opts.activateOnSkipWaiting) {
        queueMicrotask(() => {
          worker.state = 'activated'
          listeners.get('statechange')?.forEach((cb) => cb())
        })
      }
    }),
  }
  return worker as unknown as FakeWorker
}

function createFakeRegistration(waiting: FakeWorker | null = null) {
  return {
    scope: '/',
    waiting,
    installing: null,
    update: mock(async () => {}),
    addEventListener: mock(() => {}),
  } as unknown as ServiceWorkerRegistration & { waiting: FakeWorker | null }
}

function installNavigator(registration: ServiceWorkerRegistration) {
  Object.defineProperty(globalThis.navigator, 'serviceWorker', {
    value: {
      register: mock(async () => registration),
      addEventListener: mock(() => {}),
      removeEventListener: mock(() => {}),
      controller: {},
    },
    configurable: true,
  })
}

async function flushVersionChecks(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

describe('service worker update availability', () => {
  let dom: Awaited<ReturnType<typeof acquireDomHarness>>
  let reloadMock: ReturnType<typeof mock>

  beforeEach(async () => {
    dom = await acquireDomHarness({ url: 'http://localhost/' })
    Object.defineProperty(dom.window.document, 'visibilityState', {
      value: 'hidden',
      configurable: true,
    })
    serviceWorker.__resetServiceWorkerForTests()
    reloadMock = mock(() => {})
    serviceWorker.__setReloadPageForTests(reloadMock)
    serviceWorker.__setSkipWaitingTimeoutForTests(30)
  })

  afterEach(async () => {
    serviceWorker.__resetServiceWorkerForTests()
    await dom.cleanup()
  })

  test('initializes install prompt listeners once when the window supports events', () => {
    const addEventListener = mock(() => {})
    const initializeInstallPromptListeners = (
      serviceWorker as typeof serviceWorker & { initializeInstallPromptListeners(): void }
    ).initializeInstallPromptListeners
    const previousWindow = globalThis.window
    globalThis.window = { addEventListener } as unknown as typeof globalThis.window

    try {
      initializeInstallPromptListeners()
      initializeInstallPromptListeners()
    } finally {
      globalThis.window = previousWindow
    }

    expect(addEventListener).toHaveBeenCalledTimes(2)
    expect(addEventListener.mock.calls.map(([event]) => event)).toEqual(['beforeinstallprompt', 'appinstalled'])
  })

  test('install prompt initialization tolerates a window without event capability', () => {
    const initializeInstallPromptListeners = (
      serviceWorker as typeof serviceWorker & { initializeInstallPromptListeners(): void }
    ).initializeInstallPromptListeners
    const previousWindow = globalThis.window
    globalThis.window = {} as typeof globalThis.window

    try {
      expect(() => initializeInstallPromptListeners()).not.toThrow()
    } finally {
      globalThis.window = previousWindow
    }
  })

  test('exposes a non-empty app version', () => {
    expect(serviceWorker.APP_VERSION.length).toBeGreaterThan(0)
  })

  test('no waiting worker means no banner', async () => {
    const registration = createFakeRegistration(null)
    installNavigator(registration)

    await serviceWorker.registerServiceWorker()
    await flushVersionChecks()

    expect(serviceWorker.getServiceWorkerState().updateAvailable).toBe(false)
  })

  test('waiting worker with a different version shows the banner', async () => {
    const registration = createFakeRegistration(createFakeWorker({ version: 'v2' }))
    installNavigator(registration)

    await serviceWorker.registerServiceWorker()
    await flushVersionChecks()

    expect(serviceWorker.getServiceWorkerState().updateAvailable).toBe(true)
  })

  test('waiting worker reporting the page version is suppressed (iOS phantom)', async () => {
    const registration = createFakeRegistration(createFakeWorker({ version: serviceWorker.APP_VERSION }))
    installNavigator(registration)

    await serviceWorker.registerServiceWorker()
    await flushVersionChecks()

    expect(serviceWorker.getServiceWorkerState().updateAvailable).toBe(false)
  })

  test('waiting worker that never answers GET_VERSION shows no banner', async () => {
    const registration = createFakeRegistration(createFakeWorker({}))
    installNavigator(registration)

    await serviceWorker.registerServiceWorker()
    await flushVersionChecks()

    expect(serviceWorker.getServiceWorkerState().updateAvailable).toBe(false)
  })

  test('a version becoming readable later shows the banner on the next check', async () => {
    const waiting = createFakeWorker({})
    const registration = createFakeRegistration(waiting)
    installNavigator(registration)

    await serviceWorker.registerServiceWorker()
    await flushVersionChecks()
    expect(serviceWorker.getServiceWorkerState().updateAvailable).toBe(false)

    // The worker wakes up and starts answering GET_VERSION.
    registration.waiting = createFakeWorker({ version: 'v2' })
    serviceWorker.requestUpdateCheck()
    await flushVersionChecks()

    expect(serviceWorker.getServiceWorkerState().updateAvailable).toBe(true)
  })

  test('applyUpdate posts SKIP_WAITING and reloads once activation is confirmed', async () => {
    const waiting = createFakeWorker({ version: 'v2', activateOnSkipWaiting: true })
    const registration = createFakeRegistration(waiting)
    installNavigator(registration)

    await serviceWorker.registerServiceWorker()
    await flushVersionChecks()
    await serviceWorker.applyUpdate()

    expect(waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' })
    expect(reloadMock).toHaveBeenCalledTimes(1)
  })

  test('applyUpdate retries, rejects, and re-shows the banner when activation never confirms', async () => {
    const waiting = createFakeWorker({ version: 'v2' })
    const registration = createFakeRegistration(waiting)
    installNavigator(registration)

    await serviceWorker.registerServiceWorker()
    await flushVersionChecks()
    expect(serviceWorker.getServiceWorkerState().updateAvailable).toBe(true)

    await expect(serviceWorker.applyUpdate()).rejects.toThrow('activation timed out')
    await flushVersionChecks()

    const skipWaitingCalls = (waiting.postMessage as ReturnType<typeof mock>).mock.calls.filter(
      (call: unknown[]) => (call[0] as { type?: string })?.type === 'SKIP_WAITING'
    )
    expect(skipWaitingCalls.length).toBe(2)
    expect(reloadMock).not.toHaveBeenCalled()
    expect(serviceWorker.getServiceWorkerState().updateAvailable).toBe(true)
  })

  test('applyUpdate without a waiting worker is a no-op', async () => {
    const registration = createFakeRegistration(null)
    installNavigator(registration)

    await serviceWorker.registerServiceWorker()
    await serviceWorker.applyUpdate()

    expect(reloadMock).not.toHaveBeenCalled()
  })

  test('auto-applies silently on a fresh visible launch without flashing the banner', async () => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    const waiting = createFakeWorker({ version: 'v2', activateOnSkipWaiting: true })
    const registration = createFakeRegistration(waiting)
    installNavigator(registration)

    const seen: boolean[] = []
    serviceWorker.onUpdateAvailable((available) => seen.push(available))

    await serviceWorker.registerServiceWorker()
    await flushVersionChecks()

    expect(reloadMock).toHaveBeenCalledTimes(1)
    expect(seen).not.toContain(true)
  })

  test('a failed auto-apply falls back to the banner and is not retried automatically', async () => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    const waiting = createFakeWorker({ version: 'v2' })
    const registration = createFakeRegistration(waiting)
    installNavigator(registration)

    await serviceWorker.registerServiceWorker()
    // Wait out both SKIP_WAITING confirmation windows (2 × 30ms) plus slack.
    await new Promise((resolve) => setTimeout(resolve, 150))
    await flushVersionChecks()

    expect(serviceWorker.getServiceWorkerState().updateAvailable).toBe(true)
    const callsAfterFailure = (waiting.postMessage as ReturnType<typeof mock>).mock.calls.length

    serviceWorker.requestUpdateCheck()
    await flushVersionChecks()

    const skipWaitingCalls = (waiting.postMessage as ReturnType<typeof mock>).mock.calls
      .slice(callsAfterFailure)
      .filter((call: unknown[]) => (call[0] as { type?: string })?.type === 'SKIP_WAITING')
    expect(skipWaitingCalls.length).toBe(0)
    expect(serviceWorker.getServiceWorkerState().updateAvailable).toBe(true)
  })

  test('does not auto-apply the same version transition twice across reloads (CDN flip-flop guard)', async () => {
    // A misbehaving CDN can serve a stale sw.js while index.html is fresh:
    // the page auto-applies the "different" worker and reloads, then finds the
    // same stale worker waiting again. The second occurrence must NOT reload —
    // it falls back to the banner instead of looping.
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    const waiting = createFakeWorker({ version: 'v-stale', activateOnSkipWaiting: true })
    const registration = createFakeRegistration(waiting)
    installNavigator(registration)

    await serviceWorker.registerServiceWorker()
    await flushVersionChecks()
    expect(reloadMock).toHaveBeenCalledTimes(1)

    // Simulate the post-reload page: module state resets, sessionStorage
    // survives, the page version is unchanged, and the same stale worker is
    // waiting again.
    serviceWorker.__resetServiceWorkerForTests()
    reloadMock = mock(() => {})
    serviceWorker.__setReloadPageForTests(reloadMock)
    serviceWorker.__setSkipWaitingTimeoutForTests(30)
    const secondWaiting = createFakeWorker({ version: 'v-stale', activateOnSkipWaiting: true })
    installNavigator(createFakeRegistration(secondWaiting))

    await serviceWorker.registerServiceWorker()
    await flushVersionChecks()

    expect(reloadMock).not.toHaveBeenCalled()
    expect(serviceWorker.getServiceWorkerState().updateAvailable).toBe(true)
  })

  test('a fresh page version clears the auto-apply transition guard', async () => {
    // Legit updates change the page version after reload, so a *new* target
    // version seen by a *new* page version must still auto-apply. The guard is
    // keyed on the (page → target) pair; same page + same target is the only
    // blocked combination. Here the second target differs → applies.
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    const waiting = createFakeWorker({ version: 'v2', activateOnSkipWaiting: true })
    installNavigator(createFakeRegistration(waiting))

    await serviceWorker.registerServiceWorker()
    await flushVersionChecks()
    expect(reloadMock).toHaveBeenCalledTimes(1)

    serviceWorker.__resetServiceWorkerForTests()
    reloadMock = mock(() => {})
    serviceWorker.__setReloadPageForTests(reloadMock)
    serviceWorker.__setSkipWaitingTimeoutForTests(30)
    const newerWaiting = createFakeWorker({ version: 'v3', activateOnSkipWaiting: true })
    installNavigator(createFakeRegistration(newerWaiting))

    await serviceWorker.registerServiceWorker()
    await flushVersionChecks()

    expect(reloadMock).toHaveBeenCalledTimes(1)
  })

  test('a worker installing after registration is detected through statechange', async () => {
    const registration = createFakeRegistration(null)
    let updateFound: Listener | undefined
    ;(registration.addEventListener as ReturnType<typeof mock>).mockImplementation((event: string, cb: Listener) => {
      if (event === 'updatefound') updateFound = cb
    })
    installNavigator(registration)

    await serviceWorker.registerServiceWorker()
    await flushVersionChecks()
    expect(serviceWorker.getServiceWorkerState().updateAvailable).toBe(false)

    const installing = createFakeWorker({ version: 'v2', state: 'installing' })
    ;(registration as unknown as { installing: FakeWorker | null }).installing = installing
    updateFound?.()
    installing.state = 'installed'
    registration.waiting = installing
    installing.listeners.get('statechange')?.forEach((cb) => cb())
    await flushVersionChecks()

    expect(serviceWorker.getServiceWorkerState().updateAvailable).toBe(true)
  })
})

describe('service worker registration under a base path', () => {
  test('registers sw.js under the runtime base path Core rendered', async () => {
    const dom = await acquireDomHarness({
      url: 'http://localhost/ficus/',
      configureWindow: (w) =>
        w.document.head.insertAdjacentHTML('beforeend', '<meta name="ficus-base-path" content="/ficus/">'),
    })
    serviceWorker.__resetServiceWorkerForTests()
    try {
      installNavigator(createFakeRegistration(null))
      await serviceWorker.registerServiceWorker()
      const register = globalThis.navigator.serviceWorker.register as unknown as ReturnType<typeof mock>
      expect(register.mock.calls[0]?.[0]).toBe('/ficus/sw.js')
    } finally {
      serviceWorker.__resetServiceWorkerForTests()
      await dom.cleanup()
    }
  })
})
