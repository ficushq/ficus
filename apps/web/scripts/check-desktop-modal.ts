/** DB-free Chromium CSS/hit-testing regression, not native macOS drag verification.
 * CHROMIUM_PATH=/path/to/chromium bun apps/web/scripts/check-desktop-modal.ts
 * SCREENSHOT_DIR optionally saves windowed, nested, narrow Desktop and browser views.
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Browser, Locator } from 'playwright-core'
import { startFixtureServer } from './fixture-server'

const { chromium } = createRequire(resolve(import.meta.dir, '../../core/package.json'))(
  'playwright-core'
) as typeof import('playwright-core')
const server = await startFixtureServer({ entry: '/scripts/fixtures/desktop-modal.tsx' })
let browser: Browser | undefined
try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] })
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' })
  page.setDefaultTimeout(5000)
  page.setDefaultNavigationTimeout(30000)
  const errors: string[] = []
  page.on('pageerror', (error) => {
    errors.push(error.message)
    console.error(error.message)
  })
  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.push(message.text())
      console.error(message.text())
    }
  })
  await page.route('**/api/**', (route) =>
    new URL(route.request().url()).pathname.startsWith('/api/')
      ? route.fulfill({ json: route.request().url().includes('permissions') ? { permissions: [] } : [] })
      : route.continue()
  )
  await page.addInitScript(() => {
    if (sessionStorage.getItem('browser-only')) return
    window.ficusDesktopApp = {
      version: 1,
      notificationsEnabled: async () => false,
      deliverNotifications: async () => {},
      shell: {
        platform: 'darwin',
        insetTitleBar: true,
        fullscreen: async () => false,
        onFullscreenChange(listener) {
          const handler = (event: Event) => listener((event as CustomEvent<boolean>).detail)
          window.addEventListener('fixture-fullscreen', handler)
          return () => window.removeEventListener('fixture-fullscreen', handler)
        },
      },
    }
  })
  await page.goto(server.resolvedUrls!.local[0]!)
  const modal = page.getByRole('dialog', { name: 'Desktop modal', exact: true })
  const panel = modal.locator(':scope > [data-modal-size]')
  const region = (overlay: Locator) => overlay.locator(':scope > .ficus-modal-drag-region')
  const appRegion = (element: Locator) =>
    element.evaluate((el) => getComputedStyle(el).getPropertyValue('-webkit-app-region'))
  const screenshot = async (name: string) => {
    if (!process.env.SCREENSHOT_DIR) return
    await mkdir(process.env.SCREENSHOT_DIR, { recursive: true })
    await page.screenshot({ path: resolve(process.env.SCREENSHOT_DIR, `${name}.png`) })
  }
  const checkDrag = async (overlay: Locator) => {
    assert.equal(await region(overlay).count(), 1, 'Each modal layer owns a title-bar drag region')
    assert.equal(await appRegion(region(overlay)), 'drag')
    const box = (await region(overlay).boundingBox())!
    assert.equal(box.y, 0)
    assert.equal(box.height, 56)
    assert.equal(box.x, 96, 'Drag area stays clear of native window controls')
    assert.equal(await region(overlay).getAttribute('aria-hidden'), 'true')
    assert.equal(await region(overlay).evaluate((el) => (el as HTMLElement).tabIndex), -1)
    assert.equal(
      await overlay.evaluate(
        (el) => document.elementFromPoint(400, 28) === el.querySelector(':scope > .ficus-modal-drag-region')
      ),
      true
    )
    assert.equal(
      await overlay
        .locator('.ficus-overlay')
        .first()
        .evaluate((el) => getComputedStyle(el).getPropertyValue('-webkit-app-region')),
      'no-drag'
    )
    assert.ok(
      (await overlay.locator('.ficus-overlay').first().boundingBox())!.y >= 56,
      'Interactive content clears the drag band'
    )
  }
  assert.equal(await appRegion(page.locator('.ficus-app-header')), 'drag')
  assert.equal(await page.locator('.ficus-desktop-drag-strip').isVisible(), false)
  await page.locator('.ficus-app-header').evaluate((el) => {
    el.addEventListener('click', () => el.setAttribute('data-unexpected-click', 'true'))
  })
  for (const size of ['default', 'viewport', 'workspace', 'editor', 'content']) {
    await page.getByLabel('Modal size').selectOption(size)
    await page.getByRole('button', { name: 'Open modal', exact: true }).click()
    await checkDrag(modal)
    assert.equal(await modal.evaluate((el) => document.activeElement === el), true, 'Opening still focuses the modal')
    await page.getByLabel('Message', { exact: true }).fill(`Editable ${size}`)
    assert.equal(await page.getByLabel('Message', { exact: true }).inputValue(), `Editable ${size}`)
    assert.notEqual(await appRegion(page.getByLabel('Message', { exact: true })), 'drag')
    // Chromium does not move a native window. A click in the reserved band must not
    // dismiss the dialog or reach navigation underneath it even in this CSS-only fixture.
    await page.mouse.click(540, 28)
    assert.equal(await page.locator('.ficus-app-header').getAttribute('data-unexpected-click'), null)
    assert.equal(await modal.count(), 1)
    assert.equal(new URL(page.url()).pathname, '/')
    if (size === 'workspace') await screenshot('desktop-modal-windowed')
    await page.keyboard.press('Escape')
    await modal.waitFor({ state: 'detached' })
  }
  await page.getByRole('button', { name: 'Open modal', exact: true }).click()
  await page.getByRole('button', { name: 'Open nested modal' }).click()
  const nested = page.getByRole('dialog', { name: 'Nested modal', exact: true })
  await checkDrag(nested)
  await page.getByLabel('Nested message').fill('Nested input remains editable')
  await screenshot('desktop-modal-nested')
  await page.keyboard.press('Escape')
  await nested.waitFor({ state: 'detached' })
  await checkDrag(modal)
  await page.mouse.click(8, 100)
  await modal.waitFor({ state: 'detached' })

  // A narrow Desktop window uses the same full-screen chat and options sheet as phones.
  await page.getByLabel('Modal size').selectOption('workspace')
  await page.setViewportSize({ width: 640, height: 600 })
  await page.getByRole('button', { name: 'Open modal', exact: true }).click()
  await checkDrag(modal)
  await page.getByRole('button', { name: 'Open options sheet' }).click()
  const sheet = page.locator('.mobile-chat-options')
  await checkDrag(sheet)
  await screenshot('desktop-modal-options')
  await page.keyboard.press('Tab')
  assert.equal(await sheet.evaluate((el) => el.contains(document.activeElement)), true)
  await page.keyboard.press('Escape')
  await sheet.waitFor({ state: 'detached' })
  assert.equal(
    await page.getByRole('button', { name: 'Open options sheet' }).evaluate((el) => document.activeElement === el),
    true
  )
  await checkDrag(modal)
  await page.getByRole('button', { name: 'Open options sheet' }).click()
  await page.mouse.click(8, 100)
  await sheet.waitFor({ state: 'detached' })
  assert.equal(await modal.count(), 1, 'Options backdrop closes only the sheet')

  await page.evaluate(() => window.dispatchEvent(new CustomEvent('fixture-fullscreen', { detail: true })))
  assert.equal(await region(modal).isVisible(), false)
  assert.ok((await panel.boundingBox())!.y < 56)
  assert.equal(await page.locator('.ficus-desktop-drag-strip').count(), 0)
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('fixture-fullscreen', { detail: false })))
  await checkDrag(modal)
  await page.keyboard.press('Escape')
  await modal.waitFor({ state: 'detached' })
  assert.equal(await appRegion(page.locator('.ficus-app-header')), 'drag')
  await page.locator('.ficus-app-header').evaluate((el) => el.remove())
  assert.equal(await page.locator('.ficus-desktop-drag-strip').isVisible(), true, 'Headerless fallback is preserved')

  await page.evaluate(() => sessionStorage.setItem('browser-only', 'true'))
  await page.reload()
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 800 })
    await page.getByRole('button', { name: 'Open modal', exact: true }).click()
    assert.equal(await region(modal).isVisible(), false, 'Browser/mobile have no native drag band')
    if (width === 390) {
      assert.equal((await panel.boundingBox())!.y, 0, 'Mobile fullscreen still fills the screen')
      await page.getByRole('button', { name: 'Open options sheet' }).click()
      assert.equal(await region(sheet).isVisible(), false, 'Mobile options have no native drag band')
      await page.keyboard.press('Escape')
      await sheet.waitFor({ state: 'detached' })
    }
    await screenshot(`browser-modal-${width}`)
    if (width === 1280) await page.mouse.click(540, 28)
    else await page.keyboard.press('Escape')
    await modal.waitFor({ state: 'detached' })
  }
  assert.deepEqual(errors, [])
  console.log(
    'PASS Desktop modal CSS: five sizes, nested dialogs, narrow Desktop options sheet, focus, inputs, Escape/backdrop dismissal, blocked navigation, fullscreen, headerless fallback, browser/mobile. Native macOS dragging is not tested.'
  )
} finally {
  await browser?.close()
  await server.close()
}
