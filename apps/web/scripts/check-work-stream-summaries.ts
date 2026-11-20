/**
 * Focused, DB-free Chromium check of work stream summaries with the real components and stylesheet
 * and made-up streams: the Feed rows are unchanged by default, hovering a row opens its peek card
 * after about half a second, "Summaries" adds one truncated line under active rows only, board
 * cards clamp the summary to two lines, and the detail modal shows the "Now" line under the title.
 * From apps/web: CHROMIUM_PATH=/path/to/chromium bun scripts/check-work-stream-summaries.ts
 * Optional SCREENSHOT_DIR saves screenshots (peek card, summary lines, board, detail modal; light and dark).
 * Uses Core's declared playwright-core dependency, without loading any Core test setup.
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Browser } from 'playwright-core'
import { startFixtureServer } from './fixture-server'

const root = resolve(import.meta.dir, '..')
const { chromium } = createRequire(resolve(root, '../core/package.json'))(
  'playwright-core'
) as typeof import('playwright-core')
const screenshotDir = process.env.SCREENSHOT_DIR
if (screenshotDir) await mkdir(screenshotDir, { recursive: true })

const server = await startFixtureServer({
  path: '/work-stream-summaries-fixture',
  entry: '/scripts/fixtures/work-stream-summaries.tsx',
})

const SUMMARY = 'Wiring the peek card into Feed, Home and Work rows'

let browser: Browser | undefined
try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] })
  const page = await browser.newPage()
  page.setDefaultTimeout(10000)
  page.setDefaultNavigationTimeout(30000)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.route('**/api/**', (route) =>
    new URL(route.request().url()).pathname.startsWith('/api/')
      ? route.fulfill({ status: 404, json: {} })
      : route.continue()
  )
  const base = `${server.resolvedUrls!.local[0]!}work-stream-summaries-fixture`
  const shot = async (name: string) => {
    if (screenshotDir) await page.screenshot({ path: resolve(screenshotDir, `${name}.png`) })
  }

  for (const appearance of ['light', 'dark'] as const) {
    const theme = appearance === 'dark' ? '&dark' : ''
    await page.setViewportSize({ width: 1100, height: 720 })

    // With "Summaries" off, rows are unchanged; hovering one opens its peek after about half a
    // second. The pointer is parked first: left over a row from the previous page, it would start the
    // delay early.
    await page.mouse.move(0, 0)
    await page.goto(`${base}?view=feed&nosummaries${theme}`)
    const row = page.locator('[data-testid="feed-work-row"]').first()
    await row.waitFor()
    assert.equal(await page.locator('[data-testid="work-stream-summary-line"]').count(), 0, 'rows changed while off')
    await row.hover({ position: { x: 200, y: 12 } })
    await page.waitForTimeout(250)
    assert.equal(await page.locator('[data-testid="work-stream-peek"]').count(), 0, 'the peek opened too early')
    const peek = page.getByRole('dialog', { name: /Work stream one-line summaries at a glance/ })
    await peek.waitFor()
    const text = await peek.textContent()
    for (const part of [SUMMARY, 'Implement · Waiting on you: question', 'PR #996', 'Engineer', 'Reviewer'])
      assert.ok(text?.includes(part), `${appearance}: the peek lacks "${part}"`)
    const [rowBox, peekBox] = [await row.boundingBox(), await peek.boundingBox()]
    assert.ok(rowBox && peekBox && peekBox.y >= rowBox.y + rowBox.height - 1, 'the peek is not below its row')
    await shot(`peek-${appearance}`)

    // "Summaries", on by default: one muted, truncated line under active rows only.
    await page.goto(`${base}?view=feed${theme}`)
    await page.locator('[data-testid="feed-work-row"]').first().waitFor()
    const lines = page.locator('[data-testid="work-stream-summary-line"]')
    assert.equal(await lines.count(), 3, 'expected a line for each active stream with a summary')
    const overflow = await lines.first().evaluate((el) => getComputedStyle(el).textOverflow)
    assert.equal(overflow, 'ellipsis', 'the summary line is not truncated')
    await shot(`feed-summaries-${appearance}`)

    // Work and Home have the switch in the Active header, beside the view controls.
    for (const surface of ['work', 'home'] as const) {
      await page.goto(`${base}?view=${surface}${theme}`)
      const toggle = page.locator(`[data-testid="show-summaries-${surface}"]`)
      await toggle.waitFor()
      assert.equal(await toggle.getAttribute('aria-checked'), 'true', `${surface}: summaries are off by default`)
      assert.equal(await page.locator('[data-testid="work-stream-summary-line"]').count(), 3, `${surface}: no lines`)
      await page.waitForTimeout(300)
      await shot(`${surface}-summaries-${appearance}`)
      await toggle.click()
      assert.equal(await toggle.getAttribute('aria-checked'), 'false', `${surface}: the switch did not turn off`)
      assert.equal(
        await page.locator('[data-testid="work-stream-summary-line"]').count(),
        0,
        `${surface}: lines remain`
      )
    }

    // Board cards show the summary clamped to two lines.
    await page.setViewportSize({ width: 1400, height: 720 })
    await page.goto(`${base}?view=board${theme}`)
    const cardLine = page.locator('[data-testid="work-stream-card-summary"]').first()
    await cardLine.waitFor()
    const clamp = await cardLine.evaluate((el) => getComputedStyle(el).webkitLineClamp)
    assert.equal(clamp, '2', 'board summaries are not clamped to two lines')
    await shot(`board-${appearance}`)

    // The detail modal's "Now" line sits under the title, above the waits.
    await page.setViewportSize({ width: 1100, height: 760 })
    await page.goto(`${base}?view=modal${theme}`)
    const now = page.locator('[data-testid="work-stream-now"]')
    await now.waitFor()
    assert.ok(
      (await now.textContent())?.includes('Generated summary · updated 4 min ago'),
      'the Now line is not marked as generated, or lacks its age'
    )
    await shot(`modal-${appearance}`)
  }
  assert.deepEqual(errors, [], `page errors: ${errors.join('; ')}`)
  console.log('Work stream summary checks passed.')
} finally {
  await browser?.close()
  await server.close()
}
