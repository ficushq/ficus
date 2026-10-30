/**
 * DB-free regression for dependency row alignment, wrapping and keyboard navigation in the real modal.
 * From apps/web: CHROMIUM_PATH=/path/to/chromium bun scripts/check-work-stream-dependencies-layout.ts
 * Optional SCREENSHOT_DIR saves the light/dark, narrow/desktop cases (with and without a message).
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
  path: '/dependency-fixture',
  entry: '/scripts/fixtures/work-stream-detail.tsx',
})
let browser: Browser | undefined
try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] })
  const page = await browser.newPage()
  page.setDefaultTimeout(5000)
  page.setDefaultNavigationTimeout(30000)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname
    if (!path.startsWith('/api/')) return route.continue()
    errors.push(`Unexpected API request: ${path}`)
    return route.abort()
  })
  const failures: string[] = []
  for (const width of [320, 390, 1280])
    for (const dark of [false, true])
      for (const message of [false, true]) {
        const name = `dependencies-${width}-${dark ? 'dark' : 'light'}${message ? '-message' : ''}`
        await page.setViewportSize({ width, height: 900 })
        await page.goto(
          server.resolvedUrls!.local[0]! +
            `dependency-fixture?dependencies${dark ? '&dark' : ''}${message ? '&message' : ''}`
        )
        const section = page.getByRole('region', { name: 'Dependencies' })
        await section.waitFor()
        if (screenshotDir) await page.screenshot({ path: resolve(screenshotDir, `${name}.png`) })
        const issues = await section.evaluate((section) => {
          const issues: string[] = []
          const near = (a: number, b: number) => Math.abs(a - b) <= 1
          const rows = [...section.querySelectorAll('li')].filter((el) => el.parentElement?.tagName === 'UL')
          if (rows.length !== 3) issues.push('Expected blocking, ready and done rows')
          for (const [index, row] of rows.entries()) {
            const button = row.querySelector('button')!
            const title = button.lastElementChild!
            const titleRect = title.getBoundingClientRect()
            const condition = row.querySelector('[data-condition]')!
            if (!near(condition.getBoundingClientRect().left, titleRect.left))
              issues.push(`Row ${index}: condition is not aligned with title`)
            const status = [...row.querySelectorAll('span')].find((el) =>
              ['Waiting on Dependency', 'Active', 'Done'].includes(el.textContent ?? '')
            )!
            const statusRect = status.getBoundingClientRect()
            if (!near(statusRect.left, titleRect.left)) issues.push(`Row ${index}: status is not aligned with title`)
            if (statusRect.top < titleRect.bottom - 1) issues.push(`Row ${index}: status must follow the full title`)
            const marker = button.firstElementChild!.getBoundingClientRect()
            if (!near(marker.top + marker.height / 2, titleRect.top + 10))
              issues.push(`Row ${index}: marker must align with first title line`)
            const time = row.querySelector('time')
            if (time) {
              const blocking = time.parentElement!
              if (blocking.getBoundingClientRect().left < titleRect.left - 1)
                issues.push(`Row ${index}: blocking label starts in marker gutter`)
              if (blocking.getBoundingClientRect().top < titleRect.bottom - 1)
                issues.push(`Row ${index}: metadata must follow the full title`)
            }
            const prose = row.querySelector('.prose')
            if (prose && !near(prose.getBoundingClientRect().left, titleRect.left))
              issues.push(`Row ${index}: message misaligned`)
            if (row.scrollWidth > row.clientWidth + 1) issues.push(`Row ${index}: horizontal overflow`)
            const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT)
            while (walker.nextNode()) {
              if (!walker.currentNode.textContent?.trim()) continue
              const range = document.createRange()
              range.selectNodeContents(walker.currentNode)
              for (const rect of range.getClientRects()) {
                if (rect.right > row.getBoundingClientRect().right + 1) issues.push(`Row ${index}: text overflows`)
              }
            }
            if (index > 0) {
              const gap = row.getBoundingClientRect().top - rows[index - 1]!.getBoundingClientRect().bottom
              if (gap < 8 || gap > 12) issues.push(`Row ${index}: inconsistent row spacing (${gap}px)`)
            }
          }
          if (document.documentElement.scrollWidth > innerWidth) issues.push('Document overflow')
          return issues
        })
        failures.push(...issues.map((issue) => `${name}: ${issue}`))
        assert.equal(await section.locator('[data-blocking]').count(), 1)
        assert.equal(await section.locator('[data-satisfied="true"]').count(), 2)
        assert.equal(await section.getByLabel('Done status').count(), 1)
        const dependency = section.getByRole('button', {
          name: 'Open dependency Deploy provider plugins and unassigned credential migration',
        })
        await dependency.focus()
        await page.keyboard.press('Enter')
        await page
          .getByRole('heading', { name: /881 · Deploy provider plugins and unassigned credential migration/ })
          .waitFor()
      }
  assert.deepEqual(errors, [], 'No browser errors or backend requests')
  assert.deepEqual(failures, [], 'Dependency layout regressions')
  console.log(
    'Passed 12 dependency layout cases: 320/390/1280px, light/dark, optional markdown message; keyboard navigation.'
  )
} finally {
  await browser?.close()
  await server.close()
}
