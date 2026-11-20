/**
 * Focused, DB-free Chromium check of Activity's Active work pill with the real components and
 * stylesheet and made-up streams: the streams stay hidden behind an "Active work" pill in the presence
 * line; it opens a searchable list (marker, number and one-line title, with the state marker centred on
 * the title line) that the arrow keys move through and that still searches the summary; choosing a stream
 * filters the feed and opens its details card (title, chips for state, step, working agent and PR, the full
 * summary, actions) without horizontal overflow; filtered rows drop the repeated stream line; and a clipped
 * row expands in place. Desktop and narrow.
 * From apps/web: CHROMIUM_PATH=/path/to/chromium bun scripts/check-activity-work.ts
 * Optional SCREENSHOT_DIR saves screenshots (feed, open list, details panel, expanded row).
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
  const trigger = page.locator('[data-testid="activity-work-trigger"]')
  const options = page.locator('[role="listbox"] [role="option"]')

  for (const [width, label] of [
    [1280, 'desktop'],
    [400, 'narrow'],
  ] as const) {
    for (const appearance of ['dark', 'light'] as const) {
      const theme = appearance === 'dark' ? '&dark' : ''
      await page.setViewportSize({ width, height: 900 })

      // Hidden by default: the presence line holds the counts and the pill, nothing else.
      await page.goto(`${base}?view=feed${theme}`)
      await trigger.waitFor()
      assert.equal(await options.count(), 0, `${label}: the stream list shows before the pill is opened`)
      assert.ok(((await trigger.textContent()) ?? '').includes('7'), `${label}: the pill lacks the stream count`)
      await shot(`activity-feed-${label}-${appearance}`)

      // The list: marker, number and title on one line; search and arrows.
      await trigger.click()
      await options.first().waitFor()
      assert.equal(await options.count(), 8, `${label}: expected "All activity" and seven streams`)
      const first = (await options.nth(1).textContent()) ?? ''
      assert.ok(first.startsWith('#1394 Deliver human PR comments'), `${label}: the first stream lacks its title`)
      for (const part of ['Working', 'Implement', 'author filter.'])
        assert.ok(!first.includes(part), `${label}: the row still shows "${part}"`)
      for (let index = 1; index < 8; index++) {
        const geometry = await options.nth(index).evaluate((row) => {
          const marker = row.querySelector('[data-activity-work-state]')!.getBoundingClientRect()
          const title = row.querySelector('.truncate')!
          const line = title.getBoundingClientRect()
          return {
            offset: Math.abs(marker.top + marker.height / 2 - (line.top + line.height / 2)),
            lineHeight: line.height,
            clipped: title.scrollWidth > title.clientWidth,
            hover: row.getAttribute('title'),
            label: row.getAttribute('aria-label'),
          }
        })
        assert.ok(geometry.offset <= 1, `${label}: row ${index}'s marker is ${geometry.offset}px off its title line`)
        assert.ok(geometry.lineHeight <= 21, `${label}: row ${index}'s title wraps`)
        assert.equal(geometry.hover, geometry.label, `${label}: row ${index} lacks its full title on hover`)
        if (index === 1 && label === 'narrow') assert.ok(geometry.clipped, `${label}: the long title is not clipped`)
      }
      const search = page.getByRole('searchbox', { name: 'Search active work' })
      assert.ok(await search.evaluate((el) => el === document.activeElement), `${label}: search is not focused`)
      await shot(`activity-list-${label}-${appearance}`)
      await search.fill('paused while')
      assert.equal(await options.count(), 1, `${label}: searching the summary did not filter`)
      await search.fill('')
      await search.press('ArrowDown')
      await page.keyboard.press('ArrowDown')
      await page.keyboard.press('Enter')
      const panel = page.locator('[data-testid="activity-work-stream-filter"]')
      await panel.waitFor()
      assert.ok(((await panel.textContent()) ?? '').includes('#1394'), `${label}: Enter did not select the stream`)

      // The details panel has everything in full, and rows stop repeating the stream.
      const text = (await panel.textContent()) ?? ''
      for (const part of [
        'and record skipped deliveries',
        'author filter.',
        'Generated summary',
        'Step Implement',
        'Working Engineer',
        'PR #1031',
        'Open work stream',
        'Open chat · Engineer',
        'Last event',
        'Clear',
      ])
        assert.ok(text.includes(part), `${label}: the details panel lacks "${part}"`)
      assert.ok(
        await panel.evaluate((el) => el.scrollWidth <= el.clientWidth),
        `${label}: the details card overflows horizontally`
      )
      assert.equal(await page.locator('[data-activity-context="work-stream"]').count(), 0, 'rows repeat the stream')
      await shot(`activity-selected-${label}-${appearance}`)

      // A clipped chat row expands in place.
      await page.locator('[data-activity-row-expand]').first().click()
      await page.locator('[data-activity-row-full]').waitFor()
      assert.ok(
        ((await page.locator('[data-activity-row-full]').textContent()) ?? '').includes('focused test file again'),
        `${label}: the full message did not render`
      )
      await shot(`activity-row-expanded-${label}-${appearance}`)
    }
  }
  assert.deepEqual(errors, [], `page errors: ${errors.join('; ')}`)
  console.log('Activity work checks passed.')
} finally {
  await browser?.close()
  await server.close()
}
