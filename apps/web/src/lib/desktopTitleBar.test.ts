import { afterEach, beforeEach, expect, test } from 'bun:test'
import { acquireDomHarness } from '../test/domHarness'
import { desktopTitleBarReserve, onDesktopTitleBarChange } from './desktopTitleBar'

let harness: Awaited<ReturnType<typeof acquireDomHarness>>
beforeEach(async () => {
  harness = await acquireDomHarness({ url: 'http://localhost/' })
})
afterEach(async () => {
  const root = document.documentElement
  delete root.dataset.desktopShell
  root.style.removeProperty('--desktop-titlebar-height')
  await harness.cleanup()
})

test('reserves the CSS title-bar height only while Desktop marks the window inset', () => {
  const root = document.documentElement
  // index.css defines the height under the inset attribute; the DOM harness has no stylesheet.
  root.style.setProperty('--desktop-titlebar-height', '56px')
  expect(desktopTitleBarReserve()).toBe(0)
  root.dataset.desktopShell = 'inset'
  expect(desktopTitleBarReserve()).toBe(56)
  // Fullscreen removes the attribute: the window buttons are hidden, nothing is reserved.
  delete root.dataset.desktopShell
  expect(desktopTitleBarReserve()).toBe(0)
})

test('reserves nothing when the height is missing', () => {
  document.documentElement.dataset.desktopShell = 'inset'
  expect(desktopTitleBarReserve()).toBe(0)
})

test('tells listeners when the title bar comes and goes, until unsubscribed', async () => {
  const root = document.documentElement
  let calls = 0
  const unsubscribe = onDesktopTitleBarChange(() => calls++)
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
  root.dataset.desktopShell = 'inset'
  await flush()
  expect(calls).toBe(1)
  root.dataset.theme = 'iris'
  await flush()
  expect(calls).toBe(1)
  delete root.dataset.desktopShell
  await flush()
  expect(calls).toBe(2)
  unsubscribe()
  root.dataset.desktopShell = 'inset'
  await flush()
  expect(calls).toBe(2)
  delete root.dataset.theme
})
