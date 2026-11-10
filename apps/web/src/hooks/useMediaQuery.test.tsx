import { afterEach, expect, test } from 'bun:test'
import { useEffect } from 'react'
import { acquireDomHarness } from '../test/domHarness'
import { useMediaQuery } from './useMediaQuery'

let dom: Awaited<ReturnType<typeof acquireDomHarness>> | undefined
afterEach(async () => {
  await dom?.cleanup()
  dom = undefined
})

/** A matchMedia whose answer the test changes, notifying through modern or legacy listeners. */
function controllableMedia(legacyOnly: boolean) {
  let matches = false
  let created = 0
  const listeners = new Set<() => void>()
  const media = () => ({
    _created: ++created,
    get matches() {
      return matches
    },
    media: '(min-width: 768px)',
    ...(legacyOnly
      ? {}
      : {
          addEventListener: (_: string, listener: () => void) => listeners.add(listener),
          removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
        }),
    addListener: (listener: () => void) => listeners.add(listener),
    removeListener: (listener: () => void) => listeners.delete(listener),
  })
  return {
    media,
    listeners,
    created: () => created,
    set(next: boolean) {
      matches = next
      for (const listener of listeners) listener()
    },
  }
}

for (const legacyOnly of [false, true]) {
  test(`follows changes and unsubscribes on unmount (${legacyOnly ? 'legacy listeners' : 'change events'})`, async () => {
    const control = controllableMedia(legacyOnly)
    dom = await acquireDomHarness({
      url: 'http://localhost/',
      configureWindow(window) {
        ;(window as unknown as { matchMedia: unknown }).matchMedia = control.media
      },
    })
    const seen: boolean[] = []
    function Probe() {
      const wide = useMediaQuery('(min-width: 768px)')
      useEffect(() => {
        seen.push(wide)
      }, [wide])
      return null
    }
    const { root } = dom.createRoot()
    await dom.act(async () => root.render(<Probe />))
    expect(seen).toEqual([false])
    await dom.act(async () => control.set(true))
    expect(seen).toEqual([false, true])
    // Re-rendering reads the cached list instead of creating a new one.
    await dom.act(async () => root.render(<Probe />))
    expect(control.created()).toBe(1)
    await dom.act(async () => root.unmount())
    expect(control.listeners.size).toBe(0)
  })
}

test('uses the fallback without matchMedia', async () => {
  dom = await acquireDomHarness({
    url: 'http://localhost/',
    configureWindow(window) {
      ;(window as unknown as { matchMedia: unknown }).matchMedia = undefined
    },
  })
  let value: boolean | undefined
  function Probe() {
    const result = useMediaQuery('(min-width: 768px)', false)
    useEffect(() => {
      value = result
    })
    return null
  }
  const { root } = dom.createRoot()
  await dom.act(async () => root.render(<Probe />))
  expect(value).toBe(false)
  await dom.act(async () => root.unmount())
})
