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
const caseFilter = process.env.REVIEW_CASE_FILTER ? new RegExp(process.env.REVIEW_CASE_FILTER) : undefined
let passed = 0
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
  for (const surface of ['web', 'farm'])
    for (const width of [390, 1280])
      for (const dark of surface === 'web' ? [false, true] : [false])
        for (const mode of [
          'first',
          'repeat',
          'blocked',
          'carried',
          'none',
          'legacy',
          'return',
          'restarted',
          'mixed-agent-first',
          'mixed-human-first',
          'decision-brief',
          'decision-none',
          'legacy-queued',
          'human-return',
          'decision-restarted',
          'transitive-files',
          'transitive-legacy',
        ]) {
          const caseName = `${surface} ${mode} ${width} ${dark ? 'dark' : 'light'}`
          if (caseFilter && !caseFilter.test(caseName)) continue
          await page.setViewportSize({ width, height: 900 })
          await page.emulateMedia({ colorScheme: dark ? 'dark' : 'light' })
          await page.goto(
            `${server.resolvedUrls!.local[0]}review-fixture?surface=${surface}&mode=${mode}${dark ? '&dark' : ''}`,
            { waitUntil: 'domcontentloaded', timeout: 30000 }
          )
          const review = surface === 'web' ? page.getByRole('dialog') : page.locator('.g-decision')
          await review.waitFor()
          assert.equal(
            await review.evaluate((el) => getComputedStyle(el).paddingTop),
            surface === 'farm' ? '12px' : '0px',
            'Real review styles must be present'
          )
          if (surface === 'web') assert.equal(await review.evaluate((el) => getComputedStyle(el).position), 'fixed')
          const legacy = ['legacy', 'legacy-queued', 'transitive-legacy'].includes(mode)
          const article = review.getByRole('article', { name: 'Decision brief', exact: true })
          const primary = review.getByRole('tab', { name: legacy ? 'Handoff' : 'Decision brief', exact: true })
          await primary.waitFor()
          assert.equal(await primary.getAttribute('aria-selected'), 'true')
          const attachment = review.getByRole('tab', { name: 'staging-design.md', exact: true })
          assert.equal(
            await attachment.evaluate((el) => !!el.closest('details')),
            false,
            'Attachment tabs remain visible peers'
          )
          if (legacy) assert.equal(await article.count(), 0)
          else {
            await article.waitFor()
            if (['none', 'restarted', 'decision-none', 'decision-restarted', 'transitive-files'].includes(mode))
              await article.getByText('No decision brief for this gate', { exact: true }).waitFor()
            else {
              await article.getByRole('heading', { name: 'Decision', exact: true }).first().waitFor()
              if (['repeat', 'blocked', 'return'].includes(mode))
                await article.getByText('What changed since your last review', { exact: true }).waitFor()
              if (
                mode === 'carried' ||
                mode === 'human-return' ||
                mode === 'decision-brief' ||
                mode.startsWith('mixed-')
              )
                await article.getByText('Carried forward from an earlier step', { exact: true }).waitFor()
            }
            if (mode.startsWith('mixed-')) {
              await article.getByText('Approve the joined staging design.', { exact: true }).waitFor()
              assert.equal(await article.getByText('Carried forward from an earlier step', { exact: true }).count(), 1)
              assert.equal(await article.getByRole('heading', { name: 'Decision', exact: true }).count(), 2)
            }
            if (mode === 'restarted') {
              await review
                .getByText(
                  'Review only the replacement staging scope. The previous review session does not authorize this scope.',
                  { exact: true }
                )
                .first()
                .waitFor()
              assert.equal(await article.getByRole('heading', { name: 'Decision', exact: true }).count(), 0)
            }
            if (mode.startsWith('decision-') && mode !== 'decision-restarted')
              await review
                .getByText('Choose the staging option; production remains forbidden.', { exact: true })
                .first()
                .waitFor()
            if (mode === 'decision-restarted') {
              await review.getByText('Choose only the replacement staging scope.', { exact: true }).first().waitFor()
              assert.equal(await article.getByRole('heading', { name: 'Decision', exact: true }).count(), 0)
              assert.equal(await article.getByText('Carried forward from an earlier step', { exact: true }).count(), 0)
            }
            const disclosure = review
              .locator('details')
              .filter({ has: page.locator('summary', { hasText: 'Internal handoff' }) })
            assert.equal(await disclosure.getAttribute('open'), null)
            assert.equal(
              await article.evaluate(
                (el) =>
                  !!(
                    el.compareDocumentPosition(
                      [...document.querySelectorAll('summary')].find((node) => node.textContent === 'Internal handoff')!
                    ) & Node.DOCUMENT_POSITION_FOLLOWING
                  )
              ),
              true
            )
            assert.equal(
              await article.evaluate((el) => el.scrollWidth > el.clientWidth + 1),
              false,
              'Literal resource IDs wrap'
            )
            if (mode === 'first' || mode === 'transitive-files') {
              await attachment.click()
              const panel = review.getByRole('tabpanel')
              await panel.getByText('Staging design attachment', { exact: false }).waitFor()
              assert.equal(await article.count(), 0, 'The selected attachment occupies the document panel')
              await primary.click()
              await article.waitFor()
              assert.equal(await disclosure.getAttribute('open'), null)
              await disclosure.locator('summary').click()
              await review.getByText('Detailed audit handoff.', { exact: false }).waitFor()
              await disclosure.locator('summary').click()
            }
          }
          if (mode === 'transitive-legacy') {
            await attachment.click()
            await review.getByRole('tabpanel').getByText('Staging design attachment', { exact: false }).waitFor()
            await primary.click()
            assert.equal(await primary.getAttribute('aria-selected'), 'true')
            assert.equal(await article.count(), 0)
          }
          if (mode === 'return')
            await review
              .getByRole('button', { name: /^Approved/ })
              .getByText('Continues to execute', { exact: true })
              .waitFor()
          await review.evaluate((el) => {
            el.querySelector('[data-review-document]')?.scrollTo(0, 0)
            el.closest('main')?.scrollTo(0, 0)
          })
          const path = (name: string) =>
            resolve(screenshotDir!, `${surface}-${name}-${width}-${dark ? 'dark' : 'light'}.png`)
          if (screenshotDir) await page.screenshot({ path: path(mode) })
          if (mode === 'blocked') {
            const approve = review.getByRole('button', { name: /^Approved/ })
            assert.equal(await approve.isDisabled(), true)
            await review.getByText('Wait for staging prerequisite 1.', { exact: false }).waitFor()
            await review.getByText('Wait for staging prerequisite 2.', { exact: false }).waitFor()
            await review.getByText('Review queued', { exact: true }).waitFor()
            if (surface === 'farm') await review.getByLabel('Decision notes').fill('Read the synthetic staging design.')
            assert.equal(await approve.isDisabled(), true)
            await page.evaluate(() => (window as unknown as { clearReviewBlockers: () => void }).clearReviewBlockers())
            await page.waitForFunction(
              () =>
                ![...document.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
                  button.textContent?.startsWith('Approved')
                )?.disabled
            )
            assert.equal(await approve.isDisabled(), false)
            await review.getByText('Your review', { exact: true }).waitFor()
            if (screenshotDir) await page.screenshot({ path: path('cleared') })
          }
          assert.deepEqual(errors, [], 'No console errors or unexpected backend calls')
          passed++
          console.log(`PASS ${caseName}`)
        }
  assert.ok(passed > 0, 'The filter must select at least one browser case')
  assert.deepEqual(errors, [], 'No console errors or unexpected backend calls')
  console.log(`Completed ${passed} browser cases`)
} catch (error) {
  console.error(errors)
  throw error
} finally {
  await browser?.close()
  await server.close()
}
