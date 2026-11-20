/** DB-free Chromium layout regression for Ficus Desktop's inset title bar, not native macOS verification.
 * Floating agent chat windows, the assistant window and dialogs must keep out of the band where macOS
 * draws the window buttons, while windowed; fullscreen and browsers keep the whole screen. Dialogs and the
 * header dropdowns (the inbox and the Action Center) must draw over open floating windows and the Assistant,
 * in browsers and in Desktop.
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
  await page.route('**/api/**', (route) => {
    const { pathname } = new URL(route.request().url())
    if (!pathname.startsWith('/api/')) return route.continue()
    if (pathname.includes('permissions')) return route.fulfill({ json: { permissions: [] } })
    // The inbox dropdown loads pages and counts: every inbox is empty.
    if (pathname.startsWith('/api/inbox/'))
      return route.fulfill({ json: { items: [], hasMore: false, nextCursor: null, totalCount: 0, count: 0 } })
    return route.fulfill({ json: [] })
  })
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

  // Dialogs open over the floating windows and the Assistant: nothing they draw covers any part of a
  // dialog, its buttons included. Checked in this browser view, then in Desktop.
  const DIALOGS = [
    {
      name: 'Template differences',
      open: () => page.getByRole('button', { name: 'Open template diff' }).evaluate((el: HTMLElement) => el.click()),
      shot: 'template-diff',
    },
    {
      name: 'Template Diff — model',
      open: () => page.getByRole('button', { name: 'Diff', exact: true }).evaluate((el: HTMLElement) => el.click()),
      shot: 'template-field-diff',
    },
    {
      name: 'Files already exist',
      open: () =>
        page
          .locator('input[type="file"]')
          .first()
          .setInputFiles({ name: 'notes.md', mimeType: 'text/markdown', buffer: Buffer.from('# Notes') }),
      shot: 'upload-conflict',
    },
  ]
  const dialogsOnTop = async (view: string) => {
    for (const { name, open, shot } of DIALOGS) {
      await open()
      const dialog = page.getByRole('dialog', { name, exact: true })
      await dialog.waitFor()
      const panel = dialog.locator('.ficus-overlay').first()
      const hits = await panel.evaluate((surface) => {
        const box = surface.getBoundingClientRect()
        const covered: string[] = []
        for (let fx = 0.02; fx < 1; fx += 0.08)
          for (let fy = 0.02; fy < 1; fy += 0.08) {
            const [x, y] = [box.left + box.width * fx, box.top + box.height * fy]
            const hit = document.elementFromPoint(x, y)
            if (!hit || !surface.contains(hit))
              covered.push(
                `${Math.round(x)},${Math.round(y)} ${hit?.closest('[data-floating-window]')?.outerHTML.slice(0, 60)}`
              )
          }
        const buttons = [...surface.querySelectorAll('button')]
          .filter((button) => {
            const r = button.getBoundingClientRect()
            return !button.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2))
          })
          .map((button) => button.textContent || button.getAttribute('aria-label'))
        const under = [...document.querySelectorAll<HTMLElement>('[data-floating-window]')]
          .filter((w) => {
            const r = w.getBoundingClientRect()
            return r.right > box.left && r.left < box.right && r.bottom > box.top && r.top < box.bottom
          })
          .map((w) => w.dataset.floatingWindow)
        return { covered, buttons, under, top: box.top }
      })
      assert.deepEqual(hits.under.sort(), [A, 'assistant'].sort(), `${name} opens over a window and the Assistant`)
      assert.deepEqual(hits.covered, [], `${view}: nothing covers ${name}`)
      assert.deepEqual(hits.buttons, [], `${view}: every button of ${name} is uncovered`)
      if (view === 'desktop') assert.ok(hits.top >= TITLE_BAR, `${name} stays below the title bar`)
      await screenshot(`${view}-${shot}-over-windows`)
      // Its own close button works, above the windows.
      await dialog.getByRole('button', { name: 'Close', exact: true }).first().click()
      await dialog.waitFor({ state: 'detached' })
    }
  }
  await dialogsOnTop('browser')

  // The header dropdowns open over the Assistant (snapped to the right half, over the top-right corner) and
  // a chat window moved there: nothing covers them or their buttons, and a press on the Assistant closes them.
  const DROPDOWNS = [
    {
      name: 'Inbox',
      event: 'open-inbox-popup',
      panel: () => page.locator('#inbox-popup[data-state="open"]'),
      shot: 'inbox',
    },
    {
      name: 'Action Center',
      event: 'open-action-center',
      panel: () => page.locator('[role="dialog"][aria-label="Action Center"][data-state="open"]'),
      shot: 'action-center',
    },
  ]
  const dropdownsOnTop = async (view: string) => {
    for (const { name, event, panel, shot } of DROPDOWNS) {
      await page.evaluate((type) => window.dispatchEvent(new CustomEvent(type)), event)
      await panel().waitFor()
      await page.waitForTimeout(200)
      await screenshot(`${view}-${shot}-over-windows`)
      const hits = await panel().evaluate((surface) => {
        const box = surface.getBoundingClientRect()
        const covered: string[] = []
        for (let fx = 0.02; fx < 1; fx += 0.08)
          for (let fy = 0.02; fy < 1; fy += 0.08) {
            const [x, y] = [box.left + box.width * fx, box.top + box.height * fy]
            const hit = document.elementFromPoint(x, y)
            if (!hit || !surface.contains(hit)) covered.push(`${Math.round(x)},${Math.round(y)}`)
          }
        const buttons = [...surface.querySelectorAll('button')]
          .filter((button) => {
            const r = button.getBoundingClientRect()
            return !button.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2))
          })
          .map((button) => button.textContent || button.getAttribute('aria-label'))
        const under = [...document.querySelectorAll<HTMLElement>('[data-floating-window]')]
          .filter((w) => {
            const r = w.getBoundingClientRect()
            return r.right > box.left && r.left < box.right && r.bottom > box.top && r.top < box.bottom
          })
          .map((w) => w.dataset.floatingWindow)
        return { covered, buttons, under, right: innerWidth - box.right, top: box.top }
      })
      assert.deepEqual(hits.under.sort(), [A, 'assistant'].sort(), `${name} opens over a window and the Assistant`)
      assert.deepEqual(hits.covered, [], `${view}: nothing covers the ${name} dropdown`)
      assert.deepEqual(hits.buttons, [], `${view}: every button of the ${name} dropdown is uncovered`)
      assert.equal(hits.top, 56, `${name} opens under the header`)
      assert.equal(hits.right, 12, `${name} keeps 12px from the right edge`)
      // A press on the Assistant beside it is outside the dropdown: it closes it.
      const assistant = (await windows.assistant.boundingBox())!
      await page.mouse.click(assistant.x + 40, assistant.y + assistant.height - 40)
      await panel().waitFor({ state: 'detached' })
    }
  }
  // Drags chat window A by its title bar so its top-left corner lands at x, y (clear of the snap zones).
  const dragWindowA = async (x: number, y: number) => {
    const box = (await windows[A].boundingBox())!
    const grab = { x: box.x + 120, y: box.y + 16 }
    await page.mouse.move(grab.x, grab.y)
    await page.mouse.down()
    await page.mouse.move(grab.x + 40, grab.y + 40, { steps: 4 })
    await page.mouse.move(grab.x + x - box.x, grab.y + y - box.y, { steps: 4 })
    await page.mouse.up()
    await page.waitForTimeout(400)
  }
  // Window A goes under the top-right corner too, above the Assistant, for the dropdowns; then back.
  await dragWindowA(860, 120)
  await dropdownsOnTop('browser')
  await dragWindowA(8, 120)

  // In Desktop, with the same window and Assistant open behind them.
  await page.evaluate(() => sessionStorage.removeItem('browser-only'))
  await page.reload()
  await windows[A].waitFor()
  await page.waitForTimeout(400)
  assert.equal(await page.evaluate(() => document.documentElement.dataset.desktopShell), 'inset')
  await dialogsOnTop('desktop')
  await dragWindowA(860, 120)
  await dropdownsOnTop('desktop')

  // A dialog keeps below the band even in a short window.
  await page.setViewportSize({ width: 1280, height: 360 })
  await DIALOGS[0]!.open()
  const dialogPanel = page.getByRole('dialog', { name: DIALOGS[0]!.name }).locator('.ficus-overlay').first()
  await dialogPanel.waitFor()
  assert.ok((await dialogPanel.boundingBox())!.y >= TITLE_BAR, 'Template diff panel stays below the bar')
  await screenshot('desktop-template-diff-short-window')

  assert.deepEqual(errors, [])
  console.log(
    'PASS Desktop floating windows: saved and snapped windows, the assistant and dialogs stay below the inset title bar; drag preview, picker and drag stay below it; fullscreen and browsers use the whole screen; the template diff, field diff and upload conflict dialogs and the inbox and Action Center dropdowns draw over open windows and the Assistant in browsers and Desktop, and a press on the Assistant closes the dropdowns. Native macOS window buttons are not tested.'
  )
} finally {
  await browser?.close()
  await server.close()
}
