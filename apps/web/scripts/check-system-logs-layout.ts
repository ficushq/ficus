/** DB-free Settings → Logs regression: the real section and stylesheet, a copy of the shell layout and a fake log socket.
 * From apps/web: CHROMIUM_PATH=/path/to/chromium bun scripts/check-system-logs-layout.ts
 * Checks that the pane fills the page height and the content width, that wrapping and the no-wrap horizontal
 * scroll work, that following pauses on scroll-up and Jump to latest resumes it, that search keeps the active
 * match in view, and that full screen covers the window and Escape returns, at desktop and phone widths.
 * A second pass fills the 10,000-line buffer, whose off-screen 200-line blocks the browser skips drawing,
 * and checks that following, Jump to latest, search jumps across the whole buffer and wrap toggling still
 * land where they should.
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

/** Two frames, so blocks the browser was skipping and that came into view have been laid out. */
const settle = (page: Page) =>
  page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))))

const emit = (page: Page, text: string) =>
  page.evaluate((value) => (window as unknown as { emitSystemLog: (text: string) => void }).emitSystemLog(value), text)

/** True, or where the active match and the pane are, for the failure message. */
const activeMatchInView = (page: Page) =>
  page.evaluate(() => {
    const pane = document.querySelector('[role="log"]')!.getBoundingClientRect()
    const mark = document.querySelector('[data-active-match]')?.getBoundingClientRect()
    if (
      mark &&
      mark.top >= pane.top &&
      mark.bottom <= pane.bottom &&
      mark.left >= pane.left &&
      mark.right <= pane.right
    )
      return true
    const edges = (rect?: DOMRect) => (rect ? [rect.top, rect.bottom, rect.left, rect.right].map(Math.round) : null)
    return JSON.stringify({ mark: edges(mark), pane: edges(pane) })
  })

/** A full buffer: the same checks that matter for long sessions, where most rows are never drawn. */
async function checkFullBuffer(browser: Browser, viewport: (typeof VIEWPORTS)[number]) {
  const label = `full-buffer-${viewport.name}`
  const page = await browser.newPage({ viewport })
  page.setDefaultTimeout(60000)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname
    if (!path.startsWith('/api/')) return route.continue()
    if (path === '/api/auth/ws-ticket') return route.fulfill({ json: { ticket: 'fixture-ticket' } })
    errors.push(`Unexpected API request: ${path}`)
    return route.abort()
  })
  // 7,600 sample entries are about 10,100 lines, so the buffer is full and already trimming.
  await page.goto(`${server.resolvedUrls!.local[0]!}system-logs-fixture?lines=7600`)
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('.ficus-log-line').length === 10000)
  await settle(page)
  const log = page.getByRole('log', { name: 'System log output' })
  const jump = page.getByRole('button', { name: /Jump to latest/ })

  // Rows live in 200-line blocks the browser may skip while they are off screen (the oldest block is
  // partly trimmed, so 10,000 lines can span 51 blocks).
  const blocks = await log.locator('.ficus-log-block').evaluateAll((all) => ({
    count: all.length,
    visibility: [...new Set(all.map((block) => getComputedStyle(block).contentVisibility))],
  }))
  assert.ok(blocks.count === 50 || blocks.count === 51, `${label}: 200-line blocks (${blocks.count})`)
  assert.deepEqual(blocks.visibility, ['auto'], `${label}: blocks are drawn only near the pane`)
  assert.ok((await geometry(page)).distanceFromBottom <= 2, `${label}: following starts pinned to the newest line`)

  // Following through a burst that fills a new block and trims the oldest lines.
  await emit(page, '[worker] 2026-11-20T09:09:00.500Z [queue]                  burst line\n'.repeat(299))
  await emit(page, '[worker] end of burst\n')
  await log.getByText('end of burst').waitFor()
  await settle(page)
  assert.equal(await log.locator('.ficus-log-line').count(), 10000, `${label}: the buffer stays at 10,000 lines`)
  assert.ok((await geometry(page)).distanceFromBottom <= 2, `${label}: still pinned after a 300-line burst`)

  // Paused in the middle of the buffer, the line at the top of the pane stays put while lines arrive.
  await log.hover()
  await page.mouse.wheel(0, -600)
  await jump.waitFor()
  await log.evaluate((box) => {
    box.scrollTop = box.scrollHeight / 2
  })
  await settle(page)
  const topRow = () =>
    log.evaluate((box) => {
      const rect = box.getBoundingClientRect()
      const row = document.elementFromPoint(rect.left + 40, rect.top + 20)?.closest('.ficus-log-line')
      return row ? { text: row.textContent, top: Math.round(row.getBoundingClientRect().top) } : null
    })
  const before = await topRow()
  assert.ok(before, `${label}: a row at the top of the pane`)
  await emit(page, '[api] 2026-11-20T09:09:01.500Z [http]                   --> GET /api/health 200 1ms\n'.repeat(5))
  await jump.getByText('5 new').waitFor()
  await settle(page)
  assert.deepEqual(await topRow(), before, `${label}: a paused view does not move while the buffer trims`)
  await jump.click()
  await jump.waitFor({ state: 'detached' })
  await settle(page)
  assert.ok((await geometry(page)).distanceFromBottom <= 2, `${label}: Jump to latest lands on the newest line`)
  await emit(page, '[worker] after resume\n')
  await log.getByText('after resume').waitFor()
  await settle(page)
  assert.ok((await geometry(page)).distanceFromBottom <= 2, `${label}: following again after resuming`)

  // Search: sample entries 1,000 to 6,000 (every 1,000th) are the only lines with a .000Z timestamp, so
  // each step jumps about 1,300 lines into blocks that have not been drawn yet, and Next from the newest
  // wraps to the oldest.
  const search = page.getByLabel('Search logs')
  await search.fill('.000Z')
  const counter = page.getByText(/^(–|\d+) \/ \d+$/)
  const total = Number((await counter.innerText()).split(' / ')[1])
  assert.equal(total, 6, `${label}: matches spread through the buffer`)
  await search.press('Enter')
  const steps = ['enter', 'Next', ...Array<string>(total).fill('Previous')]
  const seen: number[] = []
  for (const step of steps) {
    if (step !== 'enter') await page.getByRole('button', { name: step, exact: true }).click()
    await settle(page)
    assert.equal(
      await activeMatchInView(page),
      true,
      `${label}: active match is visible after ${step} (${seen.length + 1})`
    )
    seen.push(Number((await counter.innerText()).split(' / ')[0]))
  }
  assert.deepEqual(
    seen,
    [total, 1, total, ...Array.from({ length: total - 1 }, (_, index) => total - 1 - index)],
    `${label}: Enter, Next and Previous visit every match in order`
  )
  // Switching wrap re-centers the active match, near the top of the buffer.
  await page.getByLabel('Wrap lines').uncheck()
  await settle(page)
  assert.equal(await activeMatchInView(page), true, `${label}: active match is visible without wrapping`)
  const box = await geometry(page)
  assert.ok(box.scrollWidth > box.clientWidth + 40, `${label}: long lines scroll sideways when not wrapped`)
  await page.getByLabel('Wrap lines').check()
  await settle(page)
  assert.equal(await activeMatchInView(page), true, `${label}: active match is visible with wrapping again`)
  await search.fill('')
  await jump.click()
  await jump.waitFor({ state: 'detached' })
  await settle(page)
  assert.ok((await geometry(page)).distanceFromBottom <= 2, `${label}: Jump to latest after searching`)

  assert.deepEqual(errors, [], `${label}: no browser errors or unexpected API requests`)
  console.log(`PASS ${label}: 10,000 lines, following, paused view, Jump to latest, search across the buffer, wrap`)
  await page.close()
}

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
  for (const viewport of VIEWPORTS) await checkFullBuffer(browser, viewport)
} finally {
  await browser?.close()
  await server.close()
}
