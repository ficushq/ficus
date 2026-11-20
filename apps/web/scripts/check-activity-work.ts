/**
 * Focused, DB-free Chromium check of Activity's Active work list with the real components and
 * stylesheet and made-up streams: compact full-width rows that fit one line each on desktop, five
 * shown with a remembered "Show N more", "Summaries" lines, the selected stream's details panel with
 * the full title and summary, filtered rows without the repeated stream line, and a clipped row
 * expanding in place. Desktop and narrow widths.
 * From apps/web: CHROMIUM_PATH=/path/to/chromium bun scripts/check-activity-work.ts
 * Optional SCREENSHOT_DIR saves screenshots (list, details panel, expanded row; desktop and narrow).
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
  path: '/activity-work-fixture',
  entry: '/scripts/fixtures/activity-work.tsx',
})

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
  const base = `${server.resolvedUrls!.local[0]!}activity-work-fixture`
  const shot = async (name: string) => {
    if (screenshotDir) await page.screenshot({ path: resolve(screenshotDir, `${name}.png`) })
  }
  const rows = page.locator('[data-testid="activity-work-list"] button[data-work-stream-card]')

  for (const [width, label] of [
    [1280, 'desktop'],
    [400, 'narrow'],
  ] as const) {
    for (const appearance of ['dark', 'light'] as const) {
      const theme = appearance === 'dark' ? '&dark' : ''
      await page.setViewportSize({ width, height: 900 })
      await page.goto(`${base}?view=list${theme}`)
      await rows.first().waitFor()
      assert.equal(await rows.count(), 5, `${label}: five rows before "Show N more"`)
      const summaries = page.locator('[data-testid="activity-work-summary"]')
      assert.equal(await summaries.count(), 4, `${label}: a summary line for each visible row that has one`)
      if (label === 'desktop') {
        // One line per row (plus the summary line): the title gets the full width, not a third of it.
        const box = await rows.nth(4).boundingBox()
        assert.ok(box && box.height < 40, `desktop: a row without a summary is not one line (${box?.height})`)
        const title = rows.first().locator('span.truncate').first()
        assert.ok((await title.boundingBox())!.width > 500, 'desktop: the title is not full width')
      }
      await shot(`activity-list-${label}-${appearance}`)

      // "Summaries" off: single-line rows.
      await page.goto(`${base}?view=list&nosummaries${theme}`)
      await rows.first().waitFor()
      assert.equal(await page.locator('[data-testid="activity-work-summary"]').count(), 0, 'lines remain while off')

      // Selecting a stream: the details panel has everything in full, and rows stop repeating it.
      await page.goto(`${base}?select=1394${theme}`)
      const panel = page.locator('[data-testid="activity-work-stream-filter"]')
      await panel.waitFor()
      const text = (await panel.textContent()) ?? ''
      for (const part of [
        'and record skipped deliveries',
        'author filter.',
        'Generated summary',
        'Step: Implement',
        'Working now: Engineer',
        'Open work stream',
        'Open chat · Engineer',
        'Clear',
      ])
        assert.ok(text.includes(part), `${label}: the details panel lacks "${part}"`)
      assert.equal(await page.locator('[data-activity-context="work-stream"]').count(), 0, 'rows repeat the stream')
      await shot(`activity-selected-${label}-${appearance}`)

      // A clipped chat row expands in place.
      const more = page.locator('[data-activity-row-expand]').first()
      await more.click()
      await page.locator('[data-activity-row-full]').waitFor()
      assert.ok(
        ((await page.locator('[data-activity-row-full]').textContent()) ?? '').includes('focused test file again'),
        `${label}: the full message did not render`
      )
      await shot(`activity-row-expanded-${label}-${appearance}`)

      // "Show 2 more" expands and is remembered across a reload.
      await page.goto(`${base}?view=list${theme}`)
      await page.getByRole('button', { name: 'Show 2 more' }).click()
      assert.equal(await rows.count(), 7, `${label}: Show more did not expand`)
      await page.reload()
      await rows.first().waitFor()
      assert.equal(await rows.count(), 7, `${label}: the expanded list was not remembered`)
      await page.getByRole('button', { name: 'Show fewer' }).click()
    }
  }
  assert.deepEqual(errors, [], `page errors: ${errors.join('; ')}`)
  console.log('Activity work list checks passed.')
} finally {
  await browser?.close()
  await server.close()
}
