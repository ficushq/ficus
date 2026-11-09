/**
 * Focused, DB-free Chromium check of where an agent chat's history search button sits, with the real
 * components and stylesheet and made-up messages, embedded under a parent's own title bar the way
 * squad agent threads embed it (enableFullscreen={false}):
 * - with a composer, ChatView draws no header row, and the button sits with the composer controls on
 *   desktop and in the options sheet on phones, showing the accent style while the panel is open;
 * - closing the panel returns focus to the button (on phones, to the options sheet trigger);
 * - without a composer, the button falls back to ChatView's header so search stays reachable.
 * From apps/web: CHROMIUM_PATH=/path/to/chromium bun scripts/check-history-search-placement.ts
 * Optional SCREENSHOT_DIR saves screenshots (desktop and phone, light and dark, closed and open).
 * Uses Core's declared playwright-core dependency, without loading any Core test setup.
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { startFixtureServer } from './fixture-server'

const root = resolve(import.meta.dir, '..')
const { chromium } = createRequire(resolve(root, '../core/package.json'))(
  'playwright-core'
) as typeof import('playwright-core')
const screenshotDir = process.env.SCREENSHOT_DIR
if (screenshotDir) await mkdir(screenshotDir, { recursive: true })

const server = await startFixtureServer({
  path: '/history-search-placement-fixture',
  entry: '/scripts/fixtures/history-search-placement.tsx',
})

const searchButton = 'button[aria-label="Search this conversation"]'
const panel = '[data-testid="chat-history-search"]'

/** Where the visible search button is, and what sits between the parent's title bar and the transcript. */
function measure(page: Page) {
  return page.evaluate((selector) => {
    const visible = (el: Element) => (el as HTMLElement).offsetParent !== null
    const button = [...document.querySelectorAll<HTMLButtonElement>(selector)].find(visible) ?? null
    const titleBar = document.querySelector('[data-testid="parent-title-bar"]')!.getBoundingClientRect()
    const transcript = document.querySelector('[data-testid="chat-messages"]')!.getBoundingClientRect()
    return {
      header: !!document.querySelector('[data-testid="chat-header"]'),
      // Vertical space between the parent's title bar and the transcript (the search panel aside).
      gapAboveTranscript: transcript.top - titleBar.bottom,
      button: button && {
        inComposer: !!button.closest('.chat-composer-controls'),
        inHeader: !!button.closest('[data-testid="chat-header"]'),
        pressed: button.getAttribute('aria-pressed'),
        title: button.title,
        background: getComputedStyle(button).backgroundColor,
        focused: document.activeElement === button,
      },
    }
  }, searchButton)
}

const transparent = (color: string | undefined) => !color || color === 'rgba(0, 0, 0, 0)' || color === 'transparent'

let browser: Browser | undefined
try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] })
  const page = await browser.newPage({ hasTouch: true })
  page.setDefaultTimeout(10000)
  page.setDefaultNavigationTimeout(30000)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  // The chat needs no server: search finds nothing, and any other API request gets a 404
  // (source modules under /src/api pass).
  await page.route('**/api/**', (route) => {
    const { pathname } = new URL(route.request().url())
    if (!pathname.startsWith('/api/')) return route.continue()
    if (pathname.endsWith('/messages/search')) return route.fulfill({ json: { results: [], nextCursor: null } })
    return route.fulfill({ status: 404, json: {} })
  })
  const url = (appearance: string, composer = 'shown') =>
    `${server.resolvedUrls!.local[0]!}history-search-placement-fixture?appearance=${appearance}&composer=${composer}`
  const shot = async (name: string) => {
    if (screenshotDir) await page.screenshot({ path: resolve(screenshotDir, `${name}.png`) })
  }

  for (const appearance of ['light', 'dark']) {
    // Desktop: with the composer controls, no header row of its own.
    await page.setViewportSize({ width: 1280, height: 620 })
    await page.goto(url(appearance))
    await page.locator('textarea').waitFor()
    await page.waitForTimeout(200)
    const closed = await measure(page)
    assert.equal(closed.header, false, `desktop ${appearance}: ChatView drew a header row for the search button`)
    assert.ok(closed.gapAboveTranscript <= 1, `desktop ${appearance}: an extra row sits above the transcript`)
    assert.equal(closed.button?.inComposer, true, `desktop ${appearance}: the button is not in the composer controls`)
    assert.equal(closed.button?.pressed, 'false')
    assert.match(closed.button!.title, /\+Shift\+F\)$/)
    await shot(`desktop-${appearance}-closed`)

    await page.locator(searchButton).filter({ visible: true }).click()
    await page.locator(panel).waitFor()
    await page.waitForTimeout(100)
    const open = await measure(page)
    assert.equal(open.button?.pressed, 'true', `desktop ${appearance}: the button is not pressed while open`)
    assert.ok(!transparent(open.button?.background), `desktop ${appearance}: no accent while the panel is open`)
    await page.mouse.move(0, 0)
    await shot(`desktop-${appearance}-open`)

    await page.keyboard.press('Escape')
    await page.locator(panel).waitFor({ state: 'detached' })
    await page.waitForTimeout(100)
    const reclosed = await measure(page)
    assert.equal(reclosed.button?.focused, true, `desktop ${appearance}: closing did not return focus to the button`)
    assert.equal(reclosed.button?.pressed, 'false')

    // Phone: the composer controls fold into the options sheet, and search goes with them.
    await page.setViewportSize({ width: 390, height: 700 })
    await page.goto(url(appearance))
    await page.locator('textarea').waitFor()
    await page.waitForTimeout(200)
    const phone = await measure(page)
    assert.equal(phone.header, false, `phone ${appearance}: ChatView drew a header row for the search button`)
    assert.ok(phone.gapAboveTranscript <= 1, `phone ${appearance}: an extra row sits above the transcript`)
    assert.equal(phone.button, null, `phone ${appearance}: the desktop search button shows on a phone`)
    await shot(`phone-${appearance}-closed`)

    const trigger = page.locator('button[aria-label="Attach or change controls"]')
    await trigger.click()
    const sheetSearch = page.getByRole('dialog').getByRole('button', { name: 'Search this conversation' })
    await sheetSearch.waitFor()
    await page.waitForTimeout(300)
    await shot(`phone-${appearance}-sheet`)
    await sheetSearch.click()
    await page.locator(panel).waitFor()
    await page.waitForTimeout(300)
    assert.equal(
      await page.evaluate(() => document.activeElement?.getAttribute('aria-label')),
      'Search this conversation',
      `phone ${appearance}: the search input does not have focus after opening from the sheet`
    )
    await shot(`phone-${appearance}-open`)

    await trigger.click()
    const sheetClose = page.getByRole('dialog').getByRole('button', { name: 'Close search' })
    await sheetClose.waitFor()
    await page.waitForTimeout(300)
    await shot(`phone-${appearance}-sheet-open`)
    await sheetClose.click()
    await page.locator(panel).waitFor({ state: 'detached' })
    await page.waitForTimeout(100)
    assert.equal(
      await page.evaluate(() => document.activeElement?.getAttribute('aria-label')),
      'Attach or change controls',
      `phone ${appearance}: closing did not return focus to the options sheet trigger`
    )

    // No composer: the button falls back to ChatView's header.
    await page.setViewportSize({ width: 1280, height: 620 })
    await page.goto(url(appearance, 'hidden'))
    await page.locator('[data-testid="chat-messages"]').waitFor()
    await page.waitForTimeout(200)
    const readOnly = await measure(page)
    assert.equal(readOnly.header, true, `read-only ${appearance}: no header row for the search button`)
    assert.equal(readOnly.button?.inHeader, true, `read-only ${appearance}: the button is not in the header`)
    await shot(`desktop-${appearance}-no-composer`)
  }
  assert.deepEqual(errors, [])
  console.log('Passed: history search sits with the composer controls (or the header without one), light and dark.')
} finally {
  await browser?.close()
  await server.close()
}
