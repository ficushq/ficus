import { afterEach, beforeEach, expect, test } from 'bun:test'
import { acquireDomHarness } from '../test/domHarness'
import type { DesktopShell } from '../lib/desktop'
import { useDesktopShellChrome } from './useDesktopShellChrome'

let harness: Awaited<ReturnType<typeof acquireDomHarness>>
beforeEach(async () => {
  harness = await acquireDomHarness({ url: 'http://localhost/' })
})
afterEach(async () => {
  await harness.cleanup()
  delete window.ficusDesktopApp
})

function Probe() {
  useDesktopShellChrome()
  return null
}

function installShell(shell: Partial<DesktopShell> & { insetTitleBar: boolean }, initiallyFullscreen = false) {
  const listeners = new Set<(fullscreen: boolean) => void>()
  let unsubscribed = 0
  window.ficusDesktopApp = {
    version: 1,
    notificationsEnabled: async () => false,
    deliverNotifications: async () => {},
    shell: {
      platform: 'darwin',
      fullscreen: async () => initiallyFullscreen,
      onFullscreenChange(listener) {
        listeners.add(listener)
        return () => {
          unsubscribed++
          listeners.delete(listener)
        }
      },
      ...shell,
    },
  }
  return {
    emit: (fullscreen: boolean) => listeners.forEach((listener) => listener(fullscreen)),
    unsubscribed: () => unsubscribed,
  }
}

async function mount() {
  const { root } = harness.createRoot()
  await harness.act(async () => root.render(<Probe />))
  return root
}

test('marks the document inset while windowed and clears it in fullscreen', async () => {
  const shell = installShell({ insetTitleBar: true })
  const root = await mount()
  expect(document.documentElement.dataset.desktopShell).toBe('inset')

  await harness.act(async () => shell.emit(true))
  expect(document.documentElement.dataset.desktopShell).toBeUndefined()

  await harness.act(async () => shell.emit(false))
  expect(document.documentElement.dataset.desktopShell).toBe('inset')

  await harness.act(async () => root.unmount())
  expect(document.documentElement.dataset.desktopShell).toBeUndefined()
  expect(shell.unsubscribed()).toBe(1)
})

test('a window that opens in fullscreen is not marked inset', async () => {
  installShell({ insetTitleBar: true }, true)
  await mount()
  expect(document.documentElement.dataset.desktopShell).toBeUndefined()
})

test('browsers and desktop windows with a standard title bar are unchanged', async () => {
  installShell({ insetTitleBar: false })
  await mount()
  expect(document.documentElement.hasAttribute('data-desktop-shell')).toBe(false)

  delete window.ficusDesktopApp
  await mount()
  expect(document.documentElement.hasAttribute('data-desktop-shell')).toBe(false)
})
