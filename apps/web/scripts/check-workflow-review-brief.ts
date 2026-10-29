/** DB-free, foreground synthetic browser proof. Owns and closes its exact browser and Vite server. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createServer } from 'vite'
import type { Browser } from 'playwright-core'
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
      name: 'review-brief-fixture',
      configureServer(server) {
        server.middlewares.use('/review-fixture', (_req, res) => {
          res.setHeader('Content-Type', 'text/html')
          res.end(
            '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/scripts/fixtures/workflow-review-brief.tsx"></script></body></html>'
          )
        })
      },
    },
  ],
})
let browser: Browser | undefined
const errors: string[] = []
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
    if (!new URL(route.request().url()).pathname.startsWith('/api/')) return route.continue()
    if (
      route.request().method() === 'GET' &&
      new URL(route.request().url()).pathname === '/api/workflows/runs/brief-fixture/attachments/synthetic-design'
    )
      return route.fulfill({
        contentType: 'text/markdown',
        body: '# Staging design attachment\n\nKeep the existing reader during rollback.',
      })
    errors.push(`Unexpected backend request: ${route.request().method()} ${new URL(route.request().url()).pathname}`)
    return route.abort()
  })
  for (const width of [390, 1280])
    for (const dark of [false, true])
      for (const mode of ['first', 'repeat', 'blocked', 'carried', 'none', 'legacy']) {
        await page.setViewportSize({ width, height: 900 })
        await page.goto(`${server.resolvedUrls!.local[0]}review-fixture?mode=${mode}${dark ? '&dark' : ''}`)
        const dialog = page.getByRole('dialog')
        await dialog.waitFor()
        assert.equal(
          await dialog.evaluate((el) => getComputedStyle(el).position),
          'fixed',
          'Production Tailwind utilities must be present'
        )
        const article = dialog.getByRole('article', { name: 'Decision brief', exact: true })
        if (mode === 'legacy') {
          assert.equal(await article.count(), 0)
          await dialog.getByRole('tab', { name: 'Handoff', exact: true }).waitFor()
        } else {
          await article.waitFor()
          if (mode === 'none') await article.getByText('No decision brief for this gate', { exact: true }).waitFor()
          else {
            await article.getByRole('heading', { name: 'Decision', exact: true }).waitFor()
            if (mode === 'repeat' || mode === 'blocked')
              await article.getByText('What changed since your last review', { exact: true }).waitFor()
            if (mode === 'carried')
              await article.getByText('Carried forward from an earlier step', { exact: true }).waitFor()
          }
          const disclosure = dialog
            .locator('details')
            .filter({ has: page.locator('summary', { hasText: 'Evidence and attachments' }) })
          assert.equal(await disclosure.getAttribute('open'), null)
          assert.equal(
            await article.evaluate(
              (el) =>
                !!(
                  el.compareDocumentPosition(
                    [...document.querySelectorAll('summary')].find((s) => s.textContent === 'Evidence and attachments')!
                  ) & Node.DOCUMENT_POSITION_FOLLOWING
                )
            ),
            true
          )
          const overflow = await article.evaluate((el) => el.scrollWidth > el.clientWidth + 1)
          assert.equal(overflow, false, 'Long literal resource IDs wrap within the reading column')
          if (screenshotDir)
            await page.screenshot({ path: resolve(screenshotDir, `${mode}-${width}-${dark ? 'dark' : 'light'}.png`) })
          if (mode === 'first') {
            await disclosure.locator('summary').click()
            await dialog.getByRole('tab', { name: 'staging-design.md', exact: true }).click()
            await dialog.getByRole('heading', { name: 'Staging design attachment', exact: true }).waitFor()
            assert.equal(await article.isVisible(), true, 'Attachment selection must not replace the decision brief')
          }
        }
        if (mode === 'legacy' && screenshotDir)
          await page.screenshot({ path: resolve(screenshotDir, `${mode}-${width}-${dark ? 'dark' : 'light'}.png`) })
        if (mode === 'blocked') {
          const approve = dialog.getByRole('button', { name: /^Approved/ })
          assert.equal(await approve.isDisabled(), true)
          await dialog.getByText('Wait for staging prerequisite 1.', { exact: false }).waitFor()
          await dialog.getByText('Wait for staging prerequisite 2.', { exact: false }).waitFor()
          await page.evaluate(() => (window as unknown as { clearReviewBlockers: () => void }).clearReviewBlockers())
          await page.waitForFunction(
            () =>
              ![...document.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
                b.textContent?.startsWith('Approved')
              )?.disabled
          )
          assert.equal(await approve.isDisabled(), false)
          if (screenshotDir)
            await page.screenshot({ path: resolve(screenshotDir, `cleared-${width}-${dark ? 'dark' : 'light'}.png`) })
        }
        console.log(`PASS ${mode} ${width} ${dark ? 'dark' : 'light'}`)
      }
  assert.deepEqual(errors, [], 'No console errors or unexpected backend calls')
} catch (error) {
  console.error(errors)
  throw error
} finally {
  await browser?.close()
  await server.close()
}
