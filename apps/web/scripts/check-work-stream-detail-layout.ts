/**
 * Focused, DB-free Chromium regression using the real modal and stylesheet.
 * From apps/web: CHROMIUM_PATH=/path/to/chromium bun scripts/check-work-stream-detail-layout.ts
 * Optional SCREENSHOT_DIR saves narrow/wide screenshots and layout measurements.
 * Uses Core's declared playwright-core dependency, without loading any Core test setup.
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createServer } from 'vite'
import type { Browser } from 'playwright-core'

const root = resolve(import.meta.dir, '..')
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
      name: 'work-stream-detail-fixture',
      configureServer(server) {
        server.middlewares.use('/detail-fixture', (_req, res) => {
          res.setHeader('Content-Type', 'text/html')
          res.end(
            '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/scripts/fixtures/work-stream-detail.tsx"></script></body></html>'
          )
        })
      },
    },
  ],
})
let browser: Browser | undefined
try {
  await server.listen()
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] })
  const page = await browser.newPage({ hasTouch: true })
  page.setDefaultTimeout(5000)
  page.setDefaultNavigationTimeout(30000)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const errors: string[] = []
  const writes: unknown[] = []
  let subscription = { inherited: true, attention: { decisions: 'notify', progress: 'mute' } }

  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname
    if (!path.startsWith('/api/')) return route.continue()
    if (path === '/api/workstreams/fixture/subscribe') {
      if (route.request().method() === 'DELETE') {
        writes.push('reset')
        subscription = { inherited: true, attention: { decisions: 'notify', progress: 'mute' } }
      } else {
        const { attention } = route.request().postDataJSON()
        writes.push(attention)
        subscription = { inherited: false, attention }
      }
      return route.fulfill({ json: subscription })
    }
    if (path === '/api/workstreams/fixture/subscription') return route.fulfill({ json: subscription })
    errors.push(`Unexpected API request: ${path}`)
    return route.abort()
  })
  page.on('pageerror', (error) => errors.push(error.message))
  const measurements = []
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 900 })
    await page.goto(server.resolvedUrls!.local[0]! + 'detail-fixture')
    const more = page.getByRole('button', { name: 'More actions', exact: true })
    await more.waitFor()
    assert.equal(await page.getByRole('button', { name: 'Pause work…', exact: true }).count(), 0)
    await more.focus()
    await page.keyboard.press('Enter')
    await page.keyboard.press('Tab')
    assert.equal(
      await page
        .getByRole('button', { name: 'Pause work…', exact: true })
        .evaluate((el) => el === document.activeElement),
      true
    )
    if (screenshotDir) await page.screenshot({ path: resolve(screenshotDir, `actions-${width}.png`) })
    await page.keyboard.press('Enter')
    assert.equal(await page.getByLabel('Reason', { exact: true }).evaluate((el) => el === document.activeElement), true)
    assert.equal(await more.getAttribute('aria-expanded'), 'false')
    if (screenshotDir) await page.screenshot({ path: resolve(screenshotDir, `pause-form-${width}.png`) })
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    assert.equal(
      await more.evaluate((el) => el === document.activeElement),
      true,
      'Cancel returns focus to More actions'
    )
    await more.click()
    await page.locator('summary').filter({ hasText: 'Notifications…' }).click()
    await page.getByRole('radio', { name: 'Decisions: Notify', exact: true }).waitFor({ state: 'visible' })
    assert.equal(await page.getByRole('radio', { name: 'Decisions: Notify', exact: true }).isChecked(), true)
    assert.equal(await page.getByText('Inherits from squad', { exact: true }).isVisible(), true)
    const radioBounds = await page.getByRole('radiogroup').last().boundingBox()
    assert.ok(
      radioBounds && radioBounds.x >= 0 && radioBounds.x + radioBounds.width <= width,
      'Notification options remain inside narrow viewport'
    )
    // Activate the visible labels, not the clipped inputs: exercise real pointer/focus defaults.
    const activate = async (locator: ReturnType<typeof page.locator>) =>
      width === 390 ? locator.tap() : locator.click()
    const decisionsShow = page
      .locator('label')
      .filter({ has: page.getByRole('radio', { name: 'Decisions: Show', exact: true }) })
    await activate(decisionsShow)
    assert.equal(
      await more.getAttribute('aria-expanded'),
      'true',
      'Tapping a visible preference label must keep the menu mounted'
    )
    await page.waitForFunction(
      () => document.querySelector<HTMLInputElement>('[aria-label="Decisions: Show"]')?.checked
    )
    assert.equal(await more.getAttribute('aria-expanded'), 'true', 'Preference activation must not dismiss the editor')
    assert.deepEqual(writes.at(-1), { decisions: 'show', progress: 'mute' })
    const progressShow = page
      .locator('label')
      .filter({ has: page.getByRole('radio', { name: 'Progress: Show', exact: true }) })
    await activate(progressShow)
    await page.waitForFunction(() => document.querySelector<HTMLInputElement>('[aria-label="Progress: Show"]')?.checked)
    assert.deepEqual(writes.at(-1), { decisions: 'show', progress: 'show' })
    await activate(page.getByRole('button', { name: 'Reset to squad', exact: true }))
    await page.getByText('Inherits from squad', { exact: true }).waitFor()
    assert.equal(writes.at(-1), 'reset')
    assert.equal(await more.getAttribute('aria-expanded'), 'true')
    assert.equal(await page.locator('summary').filter({ hasText: 'Notifications…' }).textContent(), 'Notifications…')
    // Native radio keyboard activation also preserves the editor for sequential changes.
    await page.getByRole('radio', { name: 'Decisions: Notify', exact: true }).focus()
    await page.keyboard.press('ArrowLeft')
    await page.waitForFunction(
      () => document.querySelector<HTMLInputElement>('[aria-label="Decisions: Show"]')?.checked
    )
    assert.deepEqual(writes.at(-1), { decisions: 'show', progress: 'mute' })
    await page.keyboard.press('Tab')
    assert.equal(
      await page
        .getByRole('radio', { name: 'Progress: Mute', exact: true })
        .evaluate((el) => el === document.activeElement),
      true
    )
    await page.keyboard.press('ArrowRight')
    await page.waitForFunction(() => document.querySelector<HTMLInputElement>('[aria-label="Progress: Show"]')?.checked)
    assert.deepEqual(writes.at(-1), { decisions: 'show', progress: 'show' })
    await page.keyboard.press('Tab')
    assert.equal(
      await page
        .getByRole('button', { name: 'Reset to squad', exact: true })
        .evaluate((el) => el === document.activeElement),
      true
    )
    await page.keyboard.press('Enter')
    await page.getByText('Inherits from squad', { exact: true }).waitFor()
    assert.equal(writes.at(-1), 'reset')
    assert.equal(await more.getAttribute('aria-expanded'), 'true')
    // An actual outside press must still close, even when it focuses the same dialog ancestor.
    await activate(page.getByRole('heading', { name: /Workflow and description verification/ }))
    assert.equal(await more.getAttribute('aria-expanded'), 'false')
    await activate(more)
    await activate(page.locator('summary').filter({ hasText: 'Notifications…' }))
    await page.getByRole('button', { name: 'Copy link', exact: true }).focus()
    await page.keyboard.press('Tab')
    assert.equal(await more.getAttribute('aria-expanded'), 'false', 'Tab outside dismisses the menu')
    await activate(more)
    await activate(page.locator('summary').filter({ hasText: 'Notifications…' }))
    if (screenshotDir) await page.screenshot({ path: resolve(screenshotDir, `notifications-${width}.png`) })
    await page.keyboard.press('Escape')
    assert.equal(await more.getAttribute('aria-expanded'), 'false')
    assert.equal(await more.evaluate((el) => el === document.activeElement), true)
    const toggle = page.getByRole('button', { name: 'Workflow preview:' })
    await toggle.waitFor()
    assert.equal(await toggle.textContent(), 'Workflow · Focused mobile picker visual follow-up')
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false')
    assert.equal(await page.getByRole('link', { name: 'Open execute attempt 1 agent chat' }).count(), 0)
    assert.equal(await page.getByText('Step usage', { exact: true }).count(), 0)
    assert.equal(await page.getByText('Handoff history', { exact: true }).count(), 0)
    await toggle.scrollIntoViewIfNeeded()
    if (screenshotDir) await page.screenshot({ path: resolve(screenshotDir, `workflow-collapsed-${width}.png`) })
    await toggle.focus()
    await page.keyboard.press('Enter')
    await page.getByLabel('Workflow visual preview').waitFor()
    assert.equal(await page.getByRole('region', { name: 'Workflow steps' }).count(), 1)
    for (const label of ['Step usage', 'Handoff history', 'Manage workflow']) {
      const summary = page.locator('summary').filter({ hasText: new RegExp(`^${label}$`) })
      assert.equal(await summary.evaluate((el) => el.parentElement!.hasAttribute('open')), false)
    }
    await toggle.evaluate((el) => {
      const body = el.closest('[data-modal-size]')!.lastElementChild!
      body.scrollTop += el.getBoundingClientRect().top - body.getBoundingClientRect().top - 12
    })
    if (screenshotDir) await page.screenshot({ path: resolve(screenshotDir, `workflow-overview-${width}.png`) })
    await page.getByRole('button', { name: 'execute: Active', exact: true }).click()
    await page.getByRole('link', { name: 'Open execute attempt 1 agent chat' }).first().waitFor()
    if (screenshotDir) await page.screenshot({ path: resolve(screenshotDir, `workflow-expanded-${width}.png`) })
    await toggle.focus()
    await page.keyboard.press('Space')
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false')
    assert.equal(await page.getByLabel('Workflow visual preview').count(), 0)
    const description = page
      .locator('label')
      .filter({ hasText: /^Description$/ })
      .locator('..')
    await description.scrollIntoViewIfNeeded()
    const result = await description.evaluate((element) => {
      const el = element as HTMLElement
      const rect = el.getBoundingClientRect()
      const prose = el.querySelector('.prose')!
      const modal = el.closest('[data-modal-size]')!
      const body = modal.lastElementChild!
      const textBounds = [...prose.querySelectorAll('p')]
        .filter((p) => !p.closest('table'))
        .map((p) => {
          const range = document.createRange()
          range.selectNodeContents(p)
          return [...range.getClientRects()].every((r) => r.right <= rect.right + 1 && r.left >= rect.left - 1)
        })
      const scrollers = [...prose.querySelectorAll('pre, .overflow-x-auto')].map((e) => ({
        client: e.clientWidth,
        scroll: e.scrollWidth,
      }))
      return {
        viewport: innerWidth,
        document: document.documentElement.scrollWidth,
        modal: modal.clientWidth,
        body: { client: body.clientWidth, scroll: body.scrollWidth },
        description: { client: el.clientWidth, scroll: el.scrollWidth },
        textBounds,
        scrollers,
      }
    })
    measurements.push(result)
    assert.ok(result.document <= width, 'Document must not overflow')
    assert.ok(result.body.scroll <= result.body.client + 1, 'Modal body must not overflow')
    assert.ok(result.description.scroll <= result.description.client + 1, 'Description must not overflow')
    assert.equal(result.textBounds.length, 6, 'Path, token, URL, link, inline code, and normal prose were measured')
    assert.ok(result.textBounds.every(Boolean), 'Every prose text fragment must remain in bounds')
    assert.ok(
      result.scrollers.some((s) => s.scroll > s.client),
      'Wide table retains contained horizontal scrolling'
    )
    if (screenshotDir) await page.screenshot({ path: resolve(screenshotDir, `description-${width}.png`) })
    await page.goto(server.resolvedUrls!.local[0]! + 'detail-fixture?paused')
    await page.getByRole('button', { name: 'Resume work', exact: true }).waitFor()
    assert.equal(
      await page
        .getByText('Paused · Holding its slot · Waiting for the maintenance window', { exact: true })
        .isVisible(),
      true
    )
    assert.equal(await page.getByRole('button', { name: 'Park while paused', exact: true }).count(), 0)
    if (screenshotDir) await page.screenshot({ path: resolve(screenshotDir, `paused-${width}.png`) })
    await page.goto(server.resolvedUrls!.local[0]! + 'detail-fixture?delivery')
    const delivery = page.getByRole('region', { name: 'Delivery requirements' })
    await delivery.waitFor()
    assert.equal(await page.getByRole('button', { name: 'Check delivery', exact: true }).count(), 1)
    assert.equal(await page.getByRole('button', { name: 'Workflow preview:' }).getAttribute('aria-expanded'), 'false')
    assert.equal(await page.getByText('Unattributed usage:', { exact: false }).count(), 0)
    if (screenshotDir) await page.screenshot({ path: resolve(screenshotDir, `delivery-collapsed-${width}.png`) })
  }
  assert.deepEqual(errors, [], 'No browser runtime errors')
  console.log(JSON.stringify(measurements, null, 2))
  if (screenshotDir) await writeFile(resolve(screenshotDir, 'measurements.json'), JSON.stringify(measurements, null, 2))
  console.log(
    'Passed notification touch/mouse/keyboard mutations, reset and dismissal; workflow and layout at 390px and 1280px.'
  )
} finally {
  await browser?.close()
  await server.close()
}
