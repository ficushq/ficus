/** DB-free storage banner regression using the real component and stylesheet with synthetic data.
 * From apps/web: CHROMIUM_PATH=/path/to/chromium bun scripts/check-storage-banner-layout.ts
 * Checks that the Dismiss label sits on the warning's first line, single-line (1440) and wrapped (320).
 * Optional SCREENSHOT_DIR saves light/dark, narrow/wide normal, hover and keyboard-focus screenshots.
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
  path: '/storage-banner-fixture',
  entry: '/scripts/fixtures/storage-banner.tsx',
})
let browser: Browser | undefined
try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] })
  const page = await browser.newPage()
  page.setDefaultTimeout(10000)
  const errors: string[] = []
  page.on('pageerror', (error) => {
    errors.push(error.message)
    console.error(error.message)
  })
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname
    if (!path.startsWith('/api/')) return route.continue()
    errors.push(`Unexpected API request: ${path}`)
    return route.abort()
  })
  for (const width of [1440, 1024, 320]) {
    for (const appearance of ['light', 'dark']) {
      const label = `${appearance}-${width}`
      await page.setViewportSize({ width, height: 360 })
      await page.goto(`${server.resolvedUrls!.local[0]!}storage-banner-fixture?appearance=${appearance}`)
      await page.evaluate(() => localStorage.clear())
      await page.reload()
      const button = page.getByRole('button', { name: 'Dismiss', exact: true })
      const link = page.getByRole('link', { name: 'Review storage', exact: true })
      await button.waitFor()
      assert.match(await page.getByRole('status').innerText(), /The 80% warning clears below 77%/)
      assert.equal(await link.getAttribute('href'), '/settings?section=storage')
      const style = () =>
        button.evaluate((element) => {
          const css = getComputedStyle(element)
          const rect = element.getBoundingClientRect()
          return {
            background: css.backgroundColor,
            color: css.color,
            decoration: css.textDecorationLine,
            padding: parseFloat(css.paddingLeft),
            outline: css.outlineStyle,
            outlineWidth: parseFloat(css.outlineWidth),
            focused: element === document.activeElement && element.matches(':focus-visible'),
            left: rect.left,
            right: rect.right,
            height: rect.height,
          }
        })
      const token = (name: string) =>
        page.evaluate((name) => {
          const probe = document.createElement('span')
          probe.style.color = `rgb(var(${name}))`
          document.body.append(probe)
          const color = getComputedStyle(probe).color
          probe.remove()
          return color
        }, name)
      const shot = async (state: string) => {
        if (screenshotDir) await page.screenshot({ path: resolve(screenshotDir, `${label}-${state}.png`) })
      }
      await page.mouse.move(0, 350)
      // Wait only for the stylesheet's 140ms color transition, not for application readiness.
      await page.waitForTimeout(200)
      const normal = await style()
      assert.equal(normal.background, 'rgba(0, 0, 0, 0)')
      assert.equal(normal.color, await token('--color-text-secondary'))
      assert.equal(normal.decoration, 'none')
      assert.ok(normal.padding >= 12 && normal.height >= 28, `${label}: normal button hit area`)
      assert.ok(normal.left >= 0 && normal.right <= width, `${label}: button fits`)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
      // The Dismiss label sits on the warning's first text line, whether the warning fits on one
      // line (wide) or wraps (narrow); the padded button must not push its label below the text.
      const lines = await page.getByRole('status').evaluate((status) => {
        const lineBox = (node: Node) => {
          const range = document.createRange()
          range.selectNodeContents(node)
          const rects = [...range.getClientRects()].filter((rect) => rect.width > 0)
          const first = rects[0]! // The first text fragment in document order.
          rects.sort((a, b) => a.top - b.top)
          // A rect starting below the current row's bottom begins a new line; nested inline boxes
          // (the inline-flex Review storage link) overlap their row and do not count again.
          let lines = 0
          let rowBottom = -Infinity
          for (const rect of rects) {
            if (rect.top >= rowBottom - 1) {
              lines++
              rowBottom = rect.bottom
            } else rowBottom = Math.max(rowBottom, rect.bottom)
          }
          return { top: first.top, bottom: first.bottom, lines }
        }
        return { text: lineBox(status.querySelector('p')!), label: lineBox(status.querySelector('button')!) }
      })
      if (width === 1440) assert.equal(lines.text.lines, 1, `${label}: the wide warning fits on one line`)
      if (width === 320) assert.ok(lines.text.lines > 2, `${label}: the narrow warning wraps`)
      assert.ok(
        Math.abs(lines.text.top - lines.label.top) <= 1 && Math.abs(lines.text.bottom - lines.label.bottom) <= 1,
        `${label}: Dismiss label aligns with the first warning line (${JSON.stringify(lines)})`
      )
      await shot('normal')
      await button.hover()
      await page.waitForTimeout(200)
      const hover = await style()
      assert.equal(hover.background, await token('--color-bg-surface-hover'))
      assert.equal(hover.color, await token('--color-text-primary'))
      assert.equal(hover.decoration, 'none')
      await shot('hover')
      await page.mouse.move(0, 350)
      await page.keyboard.press('Tab')
      assert.equal(await link.evaluate((element) => element === document.activeElement), true)
      await page.keyboard.press('Tab')
      const focus = await style()
      assert.equal(focus.focused, true)
      assert.notEqual(focus.outline, 'none')
      assert.ok(focus.outlineWidth > 0)
      await shot('focus')
      // Native Enter, Space and pointer activation all preserve the dismissal and its saved week.
      for (const activation of ['Enter', 'Space', 'click']) {
        if (activation === 'click') await button.click()
        else await button.press(activation)
        await page.getByRole('status').waitFor({ state: 'detached' })
        const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('ficus.storageBanner.dismissed')!))
        assert.equal(saved.threshold, 80)
        assert.ok(Math.abs(saved.until - Date.now() - 7 * 24 * 60 * 60 * 1000) < 10000)
        await page.reload()
        // Wait for React to mount before asserting that a saved dismissal stays hidden.
        await page.getByRole('main', { name: 'Storage banner preview' }).waitFor({ state: 'attached' })
        assert.equal(await button.count(), 0)
        await page.evaluate(() => localStorage.clear())
        await page.reload()
        await button.waitFor()
      }
      await link.click()
      await page.getByRole('heading', { name: 'Storage settings destination' }).waitFor()
      assert.equal(await button.isVisible(), true, 'Navigation does not dismiss the warning')
      console.log(
        `PASS ${label}: padding, label aligned with the first text line, no underline, hover, focus, keyboard/click dismissal, persistence and navigation`
      )
    }
  }
  assert.deepEqual(errors, [], 'No browser runtime errors or backend requests')
} finally {
  await browser?.close()
  await server.close()
}
