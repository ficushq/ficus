import { describe, expect, test } from 'bun:test'
import { useEffect } from 'react'
import { QueryClient } from '@tanstack/react-query'
import { acquireDomHarness, DOM_GLOBAL_NAMES, installDomHarness, withDomOwnership } from './domHarness'

function descriptorSnapshot() {
  return new Map(DOM_GLOBAL_NAMES.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]))
}

describe('DOM harness', () => {
  test('waits for ownership before installing and restoring a non-writable sentinel', async () => {
    const first = await acquireDomHarness({ url: 'http://localhost/first' })
    const firstDocument = first.window.document
    let sentinelSetupStarted = false
    const sentinelRun = withDomOwnership(async () => {
      sentinelSetupStarted = true
      const original = Object.getOwnPropertyDescriptor(globalThis, 'document')
      try {
        const sentinel = { sentinel: true }
        Object.defineProperty(globalThis, 'document', {
          value: sentinel,
          configurable: true,
          enumerable: true,
          writable: false,
        })
        const before = Object.getOwnPropertyDescriptor(globalThis, 'document')
        const dom = installDomHarness({ url: 'http://localhost/sentinel' })
        try {
          expect(() => {
            throw new Error('fixture failure')
          }).toThrow('fixture failure')
        } finally {
          await dom.cleanup()
        }
        expect(Object.getOwnPropertyDescriptor(globalThis, 'document')).toEqual(before)
      } finally {
        if (original) Object.defineProperty(globalThis, 'document', original)
        else Reflect.deleteProperty(globalThis, 'document')
      }
    })

    await Promise.resolve()
    expect(sentinelSetupStarted).toBe(false)
    expect(globalThis.document).toBe(firstDocument)
    await first.cleanup()
    await sentinelRun
  })

  test('serializes concurrent owners without restoring globals underneath the active owner', async () => {
    const first = await acquireDomHarness({ url: 'http://localhost/first' })
    let secondAcquired = false
    const secondPromise = acquireDomHarness({ url: 'http://localhost/second' }).then((value) => {
      secondAcquired = true
      return value
    })
    await Promise.resolve()
    expect(secondAcquired).toBe(false)
    expect(globalThis.window).toBe(first.window)
    await first.cleanup()
    const second = await secondPromise
    expect(globalThis.window).toBe(second.window)
    expect(second.window.location.pathname).toBe('/second')
    await second.cleanup()
  })

  test('configures the Window before installing mirrored globals', async () => {
    const matchMedia = () => ({ matches: false })
    const dom = await acquireDomHarness({
      url: 'http://localhost/mobile',
      windowOptions: { innerWidth: 375, innerHeight: 800 },
      configureWindow(window) {
        Object.defineProperty(window, 'matchMedia', { configurable: true, value: matchMedia })
      },
    })
    try {
      expect(globalThis.window).toBe(dom.window)
      expect(dom.window.innerWidth).toBe(375)
      expect(dom.window.innerHeight).toBe(800)
      expect(dom.window.matchMedia).toBe(matchMedia)
    } finally {
      await dom.cleanup()
    }
  })

  test('mirrors additional DOM constructors and restores their exact descriptors', async () => {
    const names = [
      'DOMException',
      'EventTarget',
      'HTMLSelectElement',
      'HTMLTextAreaElement',
      'InputEvent',
      'ResizeObserver',
      'TouchEvent',
    ] as const
    const before = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]))
    const dom = await acquireDomHarness({ url: 'http://localhost/' })
    try {
      for (const name of names) expect(globalThis[name]).toBe(dom.window[name])
    } finally {
      await dom.cleanup()
    }
    for (const name of names) expect(Object.getOwnPropertyDescriptor(globalThis, name)).toEqual(before.get(name))
  })

  test('restores partial installation and releases ownership when installation throws', async () => {
    const before = descriptorSnapshot()
    await expect(
      acquireDomHarness({ url: 'http://localhost/failure', failAfterInstalling: 'document' })
    ).rejects.toThrow('injected DOM installation failure after document')
    for (const name of DOM_GLOBAL_NAMES) {
      expect(Object.getOwnPropertyDescriptor(globalThis, name)).toEqual(before.get(name))
    }
    const next = await acquireDomHarness({ url: 'http://localhost/next' })
    expect(next.window.location.pathname).toBe('/next')
    await next.cleanup()
  })

  test('restores the window prototype and closes it when configuration throws', () => {
    const before = descriptorSnapshot()
    let configuredWindow: Window | undefined
    let patchedAddEventListener: typeof EventTarget.prototype.addEventListener | undefined
    let closed = false
    expect(() =>
      installDomHarness({
        url: 'http://localhost/failure',
        configureWindow(window) {
          configuredWindow = window
          patchedAddEventListener = window.EventTarget.prototype.addEventListener
          const close = window.close.bind(window)
          window.close = () => {
            closed = true
            close()
          }
          throw new Error('configuration failed')
        },
      })
    ).toThrow('configuration failed')
    expect(closed).toBe(true)
    expect(configuredWindow).toBeDefined()
    const prototype = configuredWindow!.EventTarget.prototype
    expect(prototype.addEventListener).not.toBe(patchedAddEventListener)
    for (const name of DOM_GLOBAL_NAMES)
      expect(Object.getOwnPropertyDescriptor(globalThis, name)).toEqual(before.get(name))
  })

  test('restores exact descriptors and deletes globals that were initially absent', async () => {
    const before = descriptorSnapshot()
    const dom = await acquireDomHarness({ url: 'http://localhost/chat' })
    expect(globalThis.document).toBe(dom.window.document)
    await dom.cleanup()
    for (const name of DOM_GLOBAL_NAMES) {
      expect(Object.getOwnPropertyDescriptor(globalThis, name)).toEqual(before.get(name))
    }
  })

  test('runs async client cancellation after unmount while the owned window is still installed', async () => {
    const events: string[] = []
    const dom = await acquireDomHarness({
      url: 'http://localhost/',
      beforeUnmount: async () => {
        await Promise.resolve()
        events.push(globalThis.window === dom.window ? 'cancel-before-unmount' : 'cancel-without-window')
      },
      afterUnmount: async () => {
        await Promise.resolve()
        events.push(globalThis.window === dom.window ? 'cancel-with-window' : 'cancel-without-window')
      },
    })
    const close = dom.window.close.bind(dom.window)
    dom.window.close = () => {
      events.push('close')
      close()
    }
    function Fixture() {
      useEffect(() => () => void events.push('unmount'), [])
      return null
    }
    const rendered = dom.createRoot()
    await dom.act(async () => rendered.root.render(<Fixture />))
    await dom.cleanup()
    expect(events).toEqual(['cancel-before-unmount', 'unmount', 'cancel-with-window', 'close'])
  })

  test('still unmounts roots when pre-unmount cancellation fails', async () => {
    const events: string[] = []
    const dom = await acquireDomHarness({
      url: 'http://localhost/',
      beforeUnmount: () => {
        events.push('before-unmount')
        throw new Error('cancellation failed')
      },
    })
    function Fixture() {
      useEffect(() => () => void events.push('unmount'), [])
      return null
    }
    const rendered = dom.createRoot()
    await dom.act(async () => rendered.root.render(<Fixture />))
    await expect(dom.cleanup()).rejects.toThrow('cancellation failed')
    expect(events).toEqual(['before-unmount', 'unmount'])
    const next = await acquireDomHarness({ url: 'http://localhost/next' })
    await next.cleanup()
  })

  test('does not release ownership until concurrent cleanup callers share completed teardown', async () => {
    let finishUnmount!: () => void
    const unmountBlocked = new Promise<void>((resolve) => {
      finishUnmount = resolve
    })
    const first = await acquireDomHarness({
      url: 'http://localhost/first',
      beforeUnmount: () => unmountBlocked,
    })
    const firstCleanup = first.cleanup()
    const secondCleanup = first.cleanup()
    let nextAcquired = false
    const nextPromise = acquireDomHarness({ url: 'http://localhost/next' }).then((dom) => {
      nextAcquired = true
      return dom
    })
    await Bun.sleep(0)
    expect(nextAcquired).toBe(false)
    finishUnmount()
    await Promise.all([firstCleanup, secondCleanup])
    const next = await nextPromise
    expect(nextAcquired).toBe(true)
    await next.cleanup()
  })

  test('unmounts every root before closing the window and cleanup is idempotent', async () => {
    const events: string[] = []
    const dom = await acquireDomHarness({ url: 'http://localhost/' })
    const close = dom.window.close.bind(dom.window)
    dom.window.close = () => {
      events.push('close')
      close()
    }
    function Fixture() {
      useEffect(() => () => void events.push('unmount'), [])
      return <div />
    }
    const first = dom.createRoot()
    const second = dom.createRoot()
    await dom.act(async () => {
      first.root.render(<Fixture />)
      second.root.render(<Fixture />)
    })
    await dom.cleanup()
    await dom.cleanup()
    expect(events).toEqual(['unmount', 'unmount', 'close'])
  })

  test('restores previous-window location state changed during the lease', async () => {
    const previousWindow = globalThis.window
    const before = {
      hash: previousWindow.location.hash,
      pathname: previousWindow.location.pathname,
      search: previousWindow.location.search,
    }
    const dom = await acquireDomHarness({ url: 'http://localhost/owned' })
    try {
      previousWindow.location.hash = '#leak'
      previousWindow.location.pathname = '/leaked'
      previousWindow.location.search = '?owner=bad'
    } finally {
      await dom.cleanup()
    }
    expect({
      hash: previousWindow.location.hash,
      pathname: previousWindow.location.pathname,
      search: previousWindow.location.search,
    }).toEqual(before)
  })

  test('removes listeners left on retained owned targets', async () => {
    let calls = 0
    const dom = await acquireDomHarness({ url: 'http://localhost/' })
    const target = new dom.window.EventTarget()
    target.addEventListener('leaked', () => calls++)
    await dom.cleanup()
    target.dispatchEvent(new dom.window.Event('leaked'))
    expect(calls).toBe(0)
  })

  test('runs effect cleanup and cancels window tasks before the next test', async () => {
    let listenerCalls = 0
    let taskCalls = 0
    let intervalCalls = 0
    const dom = await acquireDomHarness({ url: 'http://localhost/' })
    function Fixture() {
      useEffect(() => {
        const listener = () => listenerCalls++
        document.addEventListener('fixture', listener)
        setTimeout(() => taskCalls++, 100)
        setInterval(() => intervalCalls++, 100)
        return () => document.removeEventListener('fixture', listener)
      }, [])
      return null
    }
    const rendered = dom.createRoot()
    await dom.act(async () => rendered.root.render(<Fixture />))
    await dom.cleanup()
    dom.window.document.dispatchEvent(new dom.window.Event('fixture'))
    await Bun.sleep(120)
    expect(listenerCalls).toBe(0)
    expect(taskCalls).toBe(0)
    expect(intervalCalls).toBe(0)
  })

  test('aborts in-flight fetches at cleanup so a late query settlement cannot stall the next owner', async () => {
    // A request that outlives its owner settles under whichever window is installed then.
    // TanStack Query reacts by scheduling its five-minute garbage-collection timer through
    // the global setTimeout, so the next owner's waitUntilComplete() would wait on it.
    let release!: () => void
    const released = new Promise<void>((resolve) => (release = resolve))
    const server = Bun.serve({
      port: 0,
      fetch: async () => {
        await released
        return Response.json({ ok: true })
      },
    })
    const queryClient = new QueryClient()
    try {
      const first = await acquireDomHarness({ url: server.url.href })
      const settled = queryClient
        .fetchQuery({
          queryKey: ['late-response'],
          queryFn: async () => (await fetch(new URL('/late', server.url))).json(),
          retry: false,
        })
        .then(
          () => 'resolved',
          () => 'rejected'
        )
      await Bun.sleep(20)
      await first.cleanup()
      const next = await acquireDomHarness({ url: server.url.href })
      try {
        release()
        await Bun.sleep(50)
        const outcome = await Promise.race([
          next.window.happyDOM.waitUntilComplete().then(() => 'complete'),
          Bun.sleep(1_000).then(() => 'stalled'),
        ])
        expect(outcome).toBe('complete')
        expect(await settled).toBe('rejected')
      } finally {
        await next.cleanup()
      }
    } finally {
      release()
      queryClient.clear()
      await server.stop(true)
    }
  })
})
