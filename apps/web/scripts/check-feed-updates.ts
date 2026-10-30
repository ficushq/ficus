/** DB-free Chromium check of real Feed components with synthetic API responses.
 * From apps/web: SCREENSHOT_DIR=/path/to/evidence bun scripts/check-feed-updates.ts
 * CHROMIUM_PATH optionally selects a browser. Server/browser always close in finally.
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
const screenshots = process.env.SCREENSHOT_DIR
if (screenshots) await mkdir(screenshots, { recursive: true })
const server = await startFixtureServer({ path: '/feed-fixture', entry: '/scripts/fixtures/feed-updates.tsx' })
let browser: Browser | undefined
try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH })
  for (const width of [320, 390, 768])
    for (const dark of [false, true]) {
      const page = await browser.newPage({ viewport: { width, height: 740 } })
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(message.text())
      })
      page.setDefaultTimeout(10000)
      const at = '2026-10-28T12:00:00.000Z'
      const rows = Array.from({ length: 45 }, (_, i) => ({
        id: `completion-${i}`,
        number: i + 1,
        title: `Completed task ${i + 1} with a long descriptive title`,
        squadId: 'synthetic',
        completedAt: new Date(Date.parse(at) - i * 1000).toISOString(),
      }))
      const saved = new Set<string>()
      let refreshed = false
      let arrived = false
      await page.route('**/api/**', async (route) => {
        const url = new URL(route.request().url())
        if (!url.pathname.startsWith('/api/')) return route.continue()
        if (url.pathname === '/api/workstreams') {
          const offset = Number(url.searchParams.get('cursor') ?? 0)
          const items = arrived
            ? [
                {
                  ...rows[0],
                  id: 'new-completion',
                  title: 'Actually new completion',
                  completedAt: '2026-10-29T12:00:00.000Z',
                },
              ]
            : refreshed
              ? [rows[44]]
              : rows.slice(offset, offset + 20)
          return route.fulfill({
            json: {
              items,
              totalCount: arrived || refreshed ? 1 : 45,
              hasMore: !arrived && !refreshed && offset + 20 < rows.length,
              nextCursor: String(offset + 20),
            },
          })
        }
        if (url.pathname.endsWith('/feed-seen')) {
          const id = url.pathname.split('/')[3]!
          const expected =
            id === 'new-completion' ? '2026-10-29T12:00:00.000Z' : rows.find((row) => row.id === id)?.completedAt
          assert.deepEqual(route.request().postDataJSON(), { completedAt: expected })
          saved.add(id)
          return route.fulfill({ json: { seen: true } })
        }
        if (url.pathname.includes('/inbox')) return route.fulfill({ json: { count: 0 } })
        errors.push(`Unexpected API call: ${url.pathname}`)
        return route.abort()
      })
      await page.goto(`${server.resolvedUrls!.local[0]}feed-fixture${dark ? '?dark' : ''}`)
      await page
        .getByText('45 completed', { exact: false })
        .waitFor()
        .catch(async (error) => {
          console.error(errors, await page.locator('body').innerText())
          throw error
        })
      assert.equal(await page.locator('time[aria-label]').count(), 0)
      assert.ok((await page.locator('time[title] .sr-only').count()) > 0)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      if (screenshots) await page.screenshot({ path: `${screenshots}/feed-${width}-${dark ? 'dark' : 'light'}.png` })
      await page.getByRole('button', { name: 'Show more updates', exact: true }).click()
      await page.locator('[data-completion-id="completion-39"]').waitFor()
      // The first and second page are loaded, but many rows never entered the viewport.
      assert.ok(saved.size < 40)
      await page.locator('[data-testid="app-scroll-container"]').evaluate((element) => {
        element.scrollTop = 0
      })
      await page.getByRole('button', { name: 'Dismiss', exact: true }).click()
      await page.locator('[data-testid="feed-visit-summary"]').waitFor({ state: 'detached' })
      assert.equal(saved.size, 40)
      assert.equal(saved.has('completion-44'), false)
      await page.getByRole('button', { name: 'Review pending action' }).waitFor()
      refreshed = true
      await page.evaluate(() => (window as unknown as { refreshFeed: () => Promise<void> }).refreshFeed())
      assert.equal(await page.locator('[data-testid="feed-visit-summary"]').count(), 0)
      assert.equal(saved.has('completion-44'), false)
      // A real newer completion reopens Updates without jumping the reader.
      await page.locator('[data-testid="app-scroll-container"]').evaluate((element) => {
        element.scrollTop = 500
      })
      const before = await page.locator('[data-testid="app-scroll-container"]').evaluate((element) => element.scrollTop)
      arrived = true
      await page.evaluate(() => (window as unknown as { refreshFeed: () => Promise<void> }).refreshFeed())
      const jump = page.getByRole('button', { name: 'New updates ↑' })
      await jump.waitFor().catch(async (error) => {
        console.error(
          errors,
          await page.evaluate(() => ({
            text: document.body.innerText.slice(0, 800),
            sectionTop: document.querySelector('details')?.getBoundingClientRect().top,
            scroll: document.querySelector('main')?.scrollTop,
          }))
        )
        if (screenshots) await page.screenshot({ path: `${screenshots}/failure.png` })
        throw error
      })
      const after = await page.locator('[data-testid="app-scroll-container"]').evaluate((element) => element.scrollTop)
      assert.ok(after >= before, 'arrival must not scroll the reader to the heading')
      assert.equal(saved.has('new-completion'), false)
      // Real fixed screenshot rejection controls coexist with the sticky jump and mobile dock.
      await page.evaluate(() => {
        const file = new File(['x'], 'too-large.png', { type: 'image/png' })
        Object.defineProperty(file, 'size', { value: 100 * 1024 * 1024 })
        const transfer = new DataTransfer()
        transfer.items.add(file)
        document.body.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: transfer }))
      })
      await page.getByTestId('screenshot-rejected').waitFor()
      const jumpBox = await jump.boundingBox()
      const fixedBox = await page.getByTestId('screenshot-rejected').boundingBox()
      assert.ok(jumpBox && fixedBox)
      assert.ok(
        jumpBox.y + jumpBox.height <= fixedBox.y || fixedBox.y + fixedBox.height <= jumpBox.y,
        'jump overlaps fixed screenshot controls'
      )
      const dock = page.locator('nav').last()
      if (width < 768) {
        const dockBox = await dock.boundingBox()
        assert.ok(dockBox && jumpBox.y + jumpBox.height <= dockBox.y, 'jump overlaps mobile navigation')
      }
      if (screenshots)
        await page.screenshot({ path: `${screenshots}/feed-jump-${width}-${dark ? 'dark' : 'light'}.png` })
      await jump.click()
      await page.getByText('Actually new completion', { exact: false }).waitFor()
      assert.equal(errors.length, 0, errors.join('\n'))
      console.log(
        `PASS ${width}px ${dark ? 'dark' : 'light'}: 40 loaded receipts, unfetched untouched, pending action retained, real narrow controls non-overlapping`
      )
      await page.close()
    }
} finally {
  await browser?.close()
  await server.close()
}
