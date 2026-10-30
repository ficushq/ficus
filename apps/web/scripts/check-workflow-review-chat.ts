/**
 * DB-free, foreground synthetic browser proof of the review screen's inline agent chat: the decision
 * stays reachable beside a long transcript, review messages carry the consultation, phones switch
 * between Brief and Chat, and an amendment shows the revised marker and what changed.
 * From apps/web: CHROMIUM_PATH=/path/to/chromium bun scripts/check-workflow-review-chat.ts
 * Optional SCREENSHOT_DIR saves screenshots. Owns and closes its exact browser and Vite server.
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createServer } from 'vite'
import type { Browser, Locator, Page } from 'playwright-core'

const root = resolve(import.meta.dir, '..')
// PostCSS/Tailwind resolve their content configuration from cwd, even with a Vite root.
process.chdir(root)
const { chromium } = createRequire(resolve(root, '../core/package.json'))(
  'playwright-core'
) as typeof import('playwright-core')
const screenshotDir = process.env.SCREENSHOT_DIR
if (screenshotDir) await mkdir(screenshotDir, { recursive: true })
const server = await createServer({
  configFile: false,
  root,
  server: { host: '127.0.0.1', port: 0 },
  esbuild: { jsx: 'automatic' },
  plugins: [
    {
      name: 'review-chat-fixture',
      configureServer(server) {
        server.middlewares.use('/review-chat-fixture', (_req, res) => {
          res.setHeader('Content-Type', 'text/html')
          res.end(
            '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/scripts/fixtures/workflow-review-chat.tsx"></script></body></html>'
          )
        })
      },
    },
  ],
})

/** Fully inside the viewport, so it can be reached without scrolling the page. */
async function inViewport(page: Page, locator: Locator) {
  const box = await locator.boundingBox()
  const viewport = page.viewportSize()!
  return !!box && box.y >= 0 && box.y + box.height <= viewport.height + 0.5 && box.width > 0
}

let browser: Browser | undefined
const errors: string[] = []
let passed = 0
try {
  await server.listen()
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] })
  const page = await browser.newPage()
  page.setDefaultTimeout(10000)
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  await page.route('**/api/**', (route) => {
    // Source modules under /src/api/ are not backend calls.
    if (!new URL(route.request().url()).pathname.startsWith('/api/')) return route.continue()
    errors.push(`Unexpected backend request: ${route.request().method()} ${new URL(route.request().url()).pathname}`)
    return route.abort()
  })
  for (const width of [390, 1280])
    for (const dark of [false, true]) {
      const name = `${width}-${dark ? 'dark' : 'light'}`
      const shot = async (label: string) => {
        if (screenshotDir) await page.screenshot({ path: resolve(screenshotDir, `review-chat-${label}-${name}.png`) })
      }
      await page.setViewportSize({ width, height: width < 768 ? 844 : 900 })
      await page.emulateMedia({ colorScheme: dark ? 'dark' : 'light' })
      await page.goto(`${server.resolvedUrls!.local[0]}review-chat-fixture${dark ? '?dark' : ''}`, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      })
      const review = page.getByRole('dialog')
      await review.waitFor()
      const layout = review.locator('[data-review-layout]')
      const approve = review.getByRole('button', { name: /^Approved/ })
      const sendBack = review.getByRole('button', { name: /^Changes requested/ })
      const composer = review.locator('[data-review-chat] textarea')
      if (width >= 1024) {
        assert.equal(await layout.getAttribute('data-review-layout'), 'chat-columns')
        // A long transcript scrolls inside the chat; the decision stays on screen below it.
        const transcript = review.locator('[data-testid="chat-messages"]')
        assert.ok(await transcript.evaluate((el) => el.scrollHeight > el.clientHeight + 40), 'The chat scrolls')
        for (const control of [approve, sendBack, review.getByLabel('Decision and evidence'), composer])
          assert.ok(await inViewport(page, control), 'Decision controls and the composer are reachable')
        assert.ok(await review.getByText('Review the staging design before implementation starts.').first().isVisible())
      } else {
        assert.equal(await layout.getAttribute('data-review-layout'), 'chat-tabs')
        const briefTab = review.getByRole('tab', { name: 'Brief', exact: true })
        const chatTab = review.getByRole('tab', { name: 'Chat', exact: true })
        assert.equal(await briefTab.getAttribute('aria-selected'), 'true')
        for (const control of [approve, sendBack, briefTab, chatTab])
          assert.ok(await inViewport(page, control), 'The switch and decision are reachable on a phone')
        for (const control of [briefTab, chatTab, approve])
          assert.ok(((await control.boundingBox())?.height ?? 0) >= 24, 'Touch targets are at least 24px')
        await shot('brief')
        await chatTab.click()
        await composer.waitFor()
        assert.ok(await inViewport(page, composer), 'The composer sits above the decision sheet')
        assert.ok(await inViewport(page, approve))
      }
      await composer.fill('Can you add a rollback note to the risks?')
      await composer.press('Enter')
      assert.deepEqual(await page.evaluate(() => window.lastSendOptions), {
        reviewConsultation: { workStreamId: 'chat-fixture', gateAttemptId: 2 },
      })
      await shot('chat')
      if (width < 1024) await review.getByRole('tab', { name: /^Brief/ }).click()

      // The agent amends while the review is open.
      await page.evaluate(() => window.amend())
      await review.getByText('Revised just now', { exact: true }).waitFor()
      const changes = review.locator('[data-revision-changes]')
      await changes.waitFor()
      await changes.getByText('Revision 1 to revision 2', { exact: true }).waitFor()
      await changes.getByRole('heading', { name: 'Risks and tradeoffs', exact: true }).waitFor()
      await changes.getByText('The internal handoff changed.', { exact: true }).waitFor()
      for (const [title, file] of [
        ['Added', 'rollback.md'],
        ['Removed', 'old-notes.md'],
        ['Changed', 'staging-design.md'],
      ])
        await changes
          .locator('div', { has: page.getByRole('heading', { name: title, exact: true }) })
          .getByText(file, { exact: true })
          .waitFor()
      if (width < 1024)
        assert.ok(
          await review
            .getByRole('tab', { name: /^Brief/ })
            .locator('[aria-label="Revised"]')
            .isVisible()
        )
      await review
        .getByText('This was revised since you opened it. Review the latest revision.', { exact: true })
        .first()
        .waitFor()
      assert.equal(await approve.isDisabled(), true)
      assert.ok(await inViewport(page, approve), 'The disabled decision stays reachable')
      assert.equal(
        await changes.evaluate((el) => el.scrollWidth > el.clientWidth + 1),
        false,
        'The change list fits its column'
      )
      await review.locator('[data-review-document]').evaluate((el) => el.scrollTo(0, 0))
      await shot('revised')
      await review.getByRole('button', { name: 'Mark as reviewed', exact: true }).click()
      await page.waitForFunction(
        () =>
          ![...document.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
            button.textContent?.startsWith('Approved')
          )?.disabled
      )
      assert.equal(await review.locator('[data-revision-changes]').count(), 0)
      assert.deepEqual(errors, [], 'No console errors or unexpected backend calls')
      passed++
      console.log(`PASS review chat ${name}`)
    }
  console.log(`Completed ${passed} browser cases`)
} catch (error) {
  console.error(errors)
  throw error
} finally {
  await browser?.close()
  await server.close()
}
