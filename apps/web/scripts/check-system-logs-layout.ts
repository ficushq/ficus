/** DB-free Settings → Logs regression: the real section and stylesheet, a copy of the shell layout and a fake log socket.
 * From apps/web: CHROMIUM_PATH=/path/to/chromium bun scripts/check-system-logs-layout.ts
 * Checks that the pane fills the page height and the content width, that wrapping and the no-wrap horizontal
 * scroll work, that following pauses on scroll-up and Jump to latest resumes it, that search keeps the active
 * match in view, and that full screen covers the window and Escape returns, at desktop and phone widths.
 * Optional SCREENSHOT_DIR saves light/dark, desktop/narrow screenshots of each state.
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { startFixtureServer } from './fixture-server'

const root = resolve(import.meta.dir, '..')
const { chromium } = createRequire(resolve(root, '../core/package.json'))(
  'playwright-core'
) as typeof import('playwright-core')
const screenshotDir = process.env.SCREENSHOT_DIR
if (screenshotDir) await mkdir(screenshotDir, { recursive: true })
const server = await startFixtureServer({ path: '/system-logs-fixture', entry: '/scripts/fixtures/system-logs.tsx' })

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'narrow', width: 390, height: 844 },
] as const

const geometry = (page: Page) =>
  page.getByRole('log', { name: 'System log output' }).evaluate((box) => {
    const rect = box.getBoundingClientRect()
    return {
      top: rect.top,
      bottom: rect.bottom,
      left: rect.left,
      right: rect.right,
      width: rect.width,
      height: rect.height,
      scrollTop: box.scrollTop,
      scrollLeft: box.scrollLeft,
      scrollWidth: box.scrollWidth,
      clientWidth: box.clientWidth,
      distanceFromBottom: box.scrollHeight - box.scrollTop - box.clientHeight,
      wrap: (box as HTMLElement).dataset.wrap,
    }
  })

let browser: Browser | undefined
try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] })
  for (const viewport of VIEWPORTS) {
    for (const appearance of ['light', 'dark']) {
      const label = `${appearance}-${viewport.name}`
      const page = await browser.newPage({ viewport })
      page.setDefaultTimeout(10000)
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      await page.route('**/api/**', (route) => {
        const path = new URL(route.request().url()).pathname
        // Vite serves source modules such as /src/api/client.ts; only real API calls are answered here.
        if (!path.startsWith('/api/')) return route.continue()
        if (path === '/api/auth/ws-ticket') return route.fulfill({ json: { ticket: 'fixture-ticket' } })
        errors.push(`Unexpected API request: ${path}`)
        return route.abort()
      })
      const shot = async (state: string) => {
        if (screenshotDir) await page.screenshot({ path: resolve(screenshotDir, `${label}-${state}.png`) })
      }
      await page.goto(`${server.resolvedUrls!.local[0]!}system-logs-fixture?appearance=${appearance}&lines=160`)
      await page.evaluate(() => localStorage.clear())
      await page.reload()
      await page.getByRole('button', { name: 'Connect', exact: true }).click()
      const log = page.getByRole('log', { name: 'System log output' })
      await log.getByText('Streaming system logs via pm2').waitFor()
      await page.waitForFunction(() => document.querySelectorAll('.ficus-log-line').length > 150)

      // The pane runs to the bottom of the page (minus the shell footer) and uses the content column's width.
      let box = await geometry(page)
      const content = await page.locator('nav[aria-label="Settings"] + div').boundingBox()
      assert.ok(content, `${label}: content column`)
      assert.ok(box.height >= 288, `${label}: pane is at least 18rem tall (${box.height})`)
      assert.ok(
        viewport.height - box.bottom <= 80,
        `${label}: pane reaches the bottom of the page (${viewport.height - box.bottom}px left)`
      )
      assert.ok(
        box.width >= content.width - 40,
        `${label}: pane uses the content width (${box.width} of ${content.width})`
      )
      assert.ok(box.distanceFromBottom <= 2, `${label}: following starts pinned to the newest line`)
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
        `${label}: no page-level horizontal overflow`
      )
      for (const control of await page.locator('select, input, button').all()) {
        const rect = await control.boundingBox()
        if (rect) assert.ok(rect.x >= 0 && rect.x + rect.width <= viewport.width + 1, `${label}: controls fit`)
      }
      const rowStyle = await log
        .locator('.ficus-log-line')
        .nth(5)
        .evaluate((row) => {
          const css = getComputedStyle(row)
          return { font: css.fontFamily, lineHeight: parseFloat(css.lineHeight), fontSize: parseFloat(css.fontSize) }
        })
      assert.match(rowStyle.font, /mono/i, `${label}: monospace`)
      assert.equal(rowStyle.lineHeight / rowStyle.fontSize, 1.5, `${label}: 1.5 line height`)
      // Components and levels are styled apart.
      const colors = await page.evaluate(() => ({
        api: getComputedStyle(document.querySelector('.ficus-log-component-api')!).color,
        worker: getComputedStyle(document.querySelector('.ficus-log-component-worker')!).color,
        error: getComputedStyle(document.querySelector('.ficus-log-line-error')!).borderLeftColor,
        warn: getComputedStyle(document.querySelector('.ficus-log-line-warn')!).borderLeftColor,
        plain: getComputedStyle(document.querySelector('.ficus-log-line:not(.ficus-log-line-error)')!).borderLeftColor,
      }))
      assert.notEqual(colors.api, colors.worker, `${label}: api and worker colors differ`)
      assert.notEqual(colors.error, colors.warn, `${label}: error and warning bars differ`)
      assert.equal(colors.plain, 'rgba(0, 0, 0, 0)', `${label}: ordinary lines have no bar`)
      await shot('1-wrapped')

      // Wrapped: no sideways scrolling. Unwrapped: one row per line and a horizontal scroll.
      assert.equal(box.wrap, 'on')
      assert.ok(box.scrollWidth <= box.clientWidth + 1, `${label}: wrapped lines do not scroll sideways`)
      await page.getByLabel('Wrap lines').uncheck()
      box = await geometry(page)
      assert.equal(box.wrap, 'off')
      assert.ok(box.scrollWidth > box.clientWidth + 40, `${label}: long lines scroll sideways when not wrapped`)
      const rowHeights = await log
        .locator('.ficus-log-line')
        .evaluateAll((rows) => [...new Set(rows.map((row) => Math.round(row.getBoundingClientRect().height)))])
      assert.deepEqual(rowHeights, [18], `${label}: every unwrapped line is one row`)
      assert.ok(box.distanceFromBottom <= 2, `${label}: still pinned after switching wrap`)
      await shot('2-unwrapped')
      await page.reload()
      await page.getByRole('button', { name: 'Connect', exact: true }).click()
      await page.waitForFunction(() => document.querySelectorAll('.ficus-log-line').length > 150)
      assert.equal(await page.getByLabel('Wrap lines').isChecked(), false, `${label}: the wrap choice is remembered`)
      await page.getByLabel('Wrap lines').check()

      // Scrolling up pauses following; new lines wait below and Jump to latest resumes.
      await log.hover()
      await page.mouse.wheel(0, -600)
      await page.waitForFunction(() => {
        const el = document.querySelector('[role="log"]')!
        return el.scrollHeight - el.scrollTop - el.clientHeight > 300
      })
      const pausedTop = (await geometry(page)).scrollTop
      await page.evaluate(() =>
        (window as unknown as { emitSystemLog: (text: string) => void }).emitSystemLog(
          '[api] 2026-11-20T09:09:00.000Z [http]                   --> GET /api/health 200 1ms\n'.repeat(5)
        )
      )
      const jump = page.getByRole('button', { name: /Jump to latest/ })
      await jump.getByText('5 new').waitFor()
      assert.equal((await geometry(page)).scrollTop, pausedTop, `${label}: a paused view does not move`)
      await shot('3-paused')
      await jump.click()
      await jump.waitFor({ state: 'detached' })
      assert.ok((await geometry(page)).distanceFromBottom <= 2, `${label}: Jump to latest returns to the bottom`)
      await page.evaluate(() =>
        (window as unknown as { emitSystemLog: (text: string) => void }).emitSystemLog('[worker] after resume\n')
      )
      await log.getByText('after resume').waitFor()
      assert.ok((await geometry(page)).distanceFromBottom <= 2, `${label}: following again after resuming`)

      // Search: Enter selects the newest match, Next and Previous keep the active match inside the pane.
      await page.getByLabel('Search logs').fill('validateModelSpec')
      await page.getByLabel('Search logs').press('Enter')
      for (const step of ['enter', 'Previous', 'Previous', 'Next']) {
        if (step !== 'enter') await page.getByRole('button', { name: step, exact: true }).click()
        const inView = await page.evaluate(() => {
          const pane = document.querySelector('[role="log"]')!.getBoundingClientRect()
          const mark = document.querySelector('[data-active-match]')!.getBoundingClientRect()
          return (
            mark.top >= pane.top && mark.bottom <= pane.bottom && mark.left >= pane.left && mark.right <= pane.right
          )
        })
        assert.equal(inView, true, `${label}: active match is visible after ${step}`)
      }
      assert.match(
        await page.getByText(/^\d+ \/ \d+$/).innerText(),
        /^\d+ \/ 17$/,
        `${label}: one match per error dump`
      )
      await shot('4-search')
      await page.getByLabel('Search logs').fill('')

      // Full screen uses (nearly) the whole window; Escape and Exit full screen come back to the page.
      for (const exit of ['Escape', 'button']) {
        await page.getByRole('button', { name: 'Full screen' }).click()
        const dialog = page.getByRole('dialog', { name: 'Logs' })
        await dialog.waitFor()
        await page.waitForTimeout(250) // the 160ms overlay entrance
        const full = await geometry(page)
        assert.ok(full.width >= viewport.width - 40, `${label}: full-screen pane is window-wide (${full.width})`)
        // On a phone the toolbar wraps onto several rows above the pane.
        const minShare = viewport.name === 'narrow' ? 0.7 : 0.8
        assert.ok(
          full.height >= viewport.height * minShare,
          `${label}: full-screen pane is window-tall (${full.height} of ${viewport.height})`
        )
        assert.equal(await dialog.getByRole('log').count(), 1)
        if (exit === 'Escape') {
          await shot('5-full-screen')
          await page.keyboard.press('Escape')
        } else await dialog.getByRole('button', { name: 'Exit full screen' }).click()
        await dialog.waitFor({ state: 'detached' })
        assert.equal(await page.getByRole('log').count(), 1)
        assert.ok((await geometry(page)).distanceFromBottom <= 2, `${label}: back on the page, still following`)
      }
      assert.deepEqual(errors, [], `${label}: no browser errors or unexpected API requests`)
      console.log(`PASS ${label}: fill, wrap/no-wrap, follow pause and resume, search in view, full screen`)
      await page.close()
    }
  }
} finally {
  await browser?.close()
  await server.close()
}
