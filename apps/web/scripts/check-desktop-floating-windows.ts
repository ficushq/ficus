/** DB-free Chromium layout regression for Ficus Desktop's inset title bar, not native macOS verification.
 * Floating agent chat windows, the assistant window and a hand-rolled dialog must keep out of the band
 * where macOS draws the window buttons, while windowed; fullscreen and browsers keep the whole screen.
 * CHROMIUM_PATH=/path/to/chromium bun apps/web/scripts/check-desktop-floating-windows.ts
 * SCREENSHOT_DIR optionally saves the Desktop, fullscreen and browser views.
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { startFixtureServer } from './fixture-server'

const { chromium } = createRequire(resolve(import.meta.dir, '../../core/package.json'))(
  'playwright-core'
) as typeof import('playwright-core')

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
/** --desktop-titlebar-height in index.css, plus the 8px window margin. */
const TITLE_BAR = 56
const BELOW_BAR = TITLE_BAR + 8

const server = await startFixtureServer({ entry: '/scripts/fixtures/desktop-floating-windows.tsx' })
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
  await page.addInitScript(
    ({ a, b }) => {
      if (!sessionStorage.getItem('seeded')) {
        sessionStorage.setItem('seeded', 'true')
        // Saved by an older build: one free window right under the window buttons, one snapped to the
        // top-left quarter, and the assistant snapped to the right half.
        localStorage.setItem(
          'ficus-chat-windows:user:u1',
          JSON.stringify({
            assistantZ: 3,
            windows: [
              { agentId: a, rect: { x: 0, y: 0, w: 420, h: 360 }, z: 1 },
              { agentId: b, rect: { x: 600, y: 100, w: 420, h: 500 }, snap: 'top-left', z: 2 },
            ],
            remembered: {},
          })
        )
        localStorage.setItem('ficus-assistant-window', JSON.stringify({ snap: 'right' }))
      }
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
    },
    { a: A, b: B }
  )
  await page.goto(`${server.resolvedUrls!.local[0]!}?chat=open`)

  const screenshot = async (name: string) => {
    if (!process.env.SCREENSHOT_DIR) return
    await mkdir(process.env.SCREENSHOT_DIR, { recursive: true })
    await page.screenshot({ path: resolve(process.env.SCREENSHOT_DIR, `${name}.png`) })
  }
  const windows = {
    [A]: page.locator(`[data-floating-window="${A}"]`),
    [B]: page.locator(`[data-floating-window="${B}"]`),
    assistant: page.getByRole('dialog', { name: 'Assistant', exact: true }),
  }
  const boxes = async () =>
    Object.fromEntries(
      await Promise.all(
        Object.entries(windows).map(async ([key, locator]) => [key, (await locator.boundingBox())!] as const)
      )
    )
  /** Nothing floating covers the window-button corner: the app header (a drag region) is what is there. */
  const buttonsClear = (current: Page) =>
    current.evaluate(() =>
      [
        [20, 20],
        [60, 30],
        [400, 28],
      ].every(([x, y]) => !!document.elementFromPoint(x!, y!)?.closest('.ficus-app-header'))
    )
  const appRegion = (selector: string) =>
    page.locator(selector).evaluate((el) => getComputedStyle(el).getPropertyValue('-webkit-app-region'))

  await windows[A].waitFor()
  await windows[B].waitFor()
  await windows.assistant.waitFor()
  assert.equal(await page.evaluate(() => document.documentElement.dataset.desktopShell), 'inset')
  // Snapped windows refit with a transition; wait for them to settle.
  await page.waitForTimeout(400)
  const placed = await boxes()
  assert.deepEqual(
    placed[A],
    { x: 8, y: BELOW_BAR, width: 420, height: 360 },
    'A saved window comes back below the bar'
  )
  assert.deepEqual(placed[B], { x: 8, y: BELOW_BAR, width: 628, height: 360 }, 'Top-left quarter starts below the bar')
  assert.deepEqual(placed.assistant, { x: 644, y: BELOW_BAR, width: 628, height: 728 }, 'Assistant right half too')
  assert.equal(await buttonsClear(page), true, 'The title bar stays uncovered')
  assert.equal(await appRegion('.ficus-app-header'), 'drag', 'The title bar still drags the window')
  await screenshot('desktop-floating-windows')

  // Dragging a window (B, the front one) into the title bar previews filling the screen below it; the
  // window itself never rises into the bar.
  const title = windows[B].locator('header').first()
  const grab = (await title.boundingBox())!
  await page.mouse.move(grab.x + 120, grab.y + grab.height / 2)
  await page.mouse.down()
  await page.mouse.move(500, 300, { steps: 4 })
  await page.mouse.move(500, 20, { steps: 4 })
  const picker = (await page.locator('[data-snap-zone-picker]').boundingBox())!
  assert.ok(picker.y >= TITLE_BAR, 'The snap-zone picker opens below the bar')
  assert.equal(await page.locator('[data-snap-preview]').getAttribute('data-snap-preview'), 'full')
  const preview = (await page.locator('[data-snap-preview]').boundingBox())!
  assert.equal(preview.y, BELOW_BAR)
  assert.ok((await windows[B].boundingBox())!.y >= BELOW_BAR, 'A dragged window stays below the bar')
  await screenshot('desktop-floating-window-drag')
  await page.mouse.up()
  await page.waitForTimeout(400)
  assert.deepEqual((await windows[B].boundingBox())!, { x: 8, y: BELOW_BAR, width: 1264, height: 728 })
  assert.equal(await buttonsClear(page), true)
  // Controls in a window's own title bar stay clickable.
  await windows[B].getByRole('button', { name: 'Close window' }).click()
  await windows[B].waitFor({ state: 'detached' })

  // Fullscreen hides the window buttons: the band is released and snaps fill the screen again.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('fixture-fullscreen', { detail: true })))
  await page.waitForTimeout(400)
  assert.equal((await windows[A].boundingBox())!.y, 8, 'Fullscreen gives the band back')
  assert.equal((await windows.assistant.boundingBox())!.y, 8)
  await screenshot('desktop-floating-windows-fullscreen')
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('fixture-fullscreen', { detail: false })))
  await page.waitForTimeout(400)
  assert.equal((await windows[A].boundingBox())!.y, BELOW_BAR, 'Leaving fullscreen reserves it again')

  // A browser never reserves anything.
  await page.evaluate(() => sessionStorage.setItem('browser-only', 'true'))
  await page.reload()
  await windows[A].waitFor()
  await page.waitForTimeout(400)
  assert.equal(await page.evaluate(() => document.documentElement.dataset.desktopShell), undefined)
  assert.equal((await windows[A].boundingBox())!.y, 8)
  assert.equal((await windows.assistant.boundingBox())!.y, 8)
  await screenshot('browser-floating-windows')

  // A dialog that does not use Modal reserves the same band, even in a short window. On a clean Desktop
  // page: floating windows stack above these older z-50 dialogs.
  await page.evaluate(() => {
    sessionStorage.removeItem('browser-only')
    localStorage.removeItem('ficus-chat-windows:user:u1')
    localStorage.removeItem('ficus-assistant-window')
  })
  await page.goto(server.resolvedUrls!.local[0]!)
  await page.setViewportSize({ width: 1280, height: 360 })
  assert.equal(await page.evaluate(() => document.documentElement.dataset.desktopShell), 'inset')
  await page.getByRole('button', { name: 'Open template diff' }).click()
  const dialogPanel = page.locator('.ficus-titlebar-reserve > .ficus-overlay')
  await dialogPanel.waitFor()
  assert.ok((await dialogPanel.boundingBox())!.y >= TITLE_BAR, 'Template diff panel stays below the bar')
  await screenshot('desktop-template-diff-short-window')
  // Its header controls stay clickable.
  await dialogPanel.locator('button').first().click()
  await dialogPanel.waitFor({ state: 'detached' })

  assert.deepEqual(errors, [])
  console.log(
    'PASS Desktop floating windows: saved and snapped windows, the assistant and a hand-rolled dialog stay below the inset title bar; drag preview, picker and drag stay below it; fullscreen and browsers use the whole screen. Native macOS window buttons are not tested.'
  )
} finally {
  await browser?.close()
  await server.close()
}
