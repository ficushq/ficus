/**
 * Focused, DB-free Chromium check of the phone touch-target rule with the real stylesheet, the real chat
 * header status rows and made-up data. At 375px and 1280px:
 * - in a text row with an icon pinned to the first line (items-start + mt-0.5), the icon stays centred on
 *   that line even when the line holds a link or a link-style button;
 * - those inline text controls keep the line's height;
 * - standalone design-system buttons are at least 24px tall on phones, and the chat thinking/tool rows keep
 *   their 24px phone height;
 * - a fixed-size custom control (a toggle switch) keeps its designed size.
 * From apps/web: CHROMIUM_PATH=/path/to/chromium bun scripts/check-mobile-touch-targets.ts
 * Optional SCREENSHOT_DIR saves screenshots (phone and desktop, light and dark).
 * Uses Core's declared playwright-core dependency, without loading any Core test setup.
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createServer } from 'vite'
import type { Browser } from 'playwright-core'
import type { Monitor } from '@ficus/shared'

const root = resolve(import.meta.dir, '..')
const { chromium } = createRequire(resolve(root, '../core/package.json'))(
  'playwright-core'
) as typeof import('playwright-core')
const screenshotDir = process.env.SCREENSHOT_DIR
if (screenshotDir) await mkdir(screenshotDir, { recursive: true })

const now = Date.now()
const monitor = (id: string, label: string): Monitor => ({
  id,
  agentId: 'agent-1',
  sandboxId: 'sandbox-1',
  label,
  description: null,
  command: 'tail -F build.log | grep --line-buffered ERROR',
  cwd: null,
  status: 'running',
  processId: `process-${id}`,
  timeoutMs: 1_800_000,
  maxBatchLines: 20,
  maxBatchBytes: 4096,
  batchDebounceMs: 750,
  exitCode: null,
  failureReason: null,
  failureKind: null,
  linesEmitted: 0,
  bytesEmitted: 0,
  createdAt: new Date(now - 60_000).toISOString(),
  startedAt: new Date(now - 60_000).toISOString(),
  endedAt: null,
  lastBatchAt: null,
  restartPolicy: 'never',
  restartLimit: 5,
  restartCount: 0,
  rapidRestartCount: 0,
  launchedAt: new Date(now - 60_000).toISOString(),
  deadlineAt: null,
  nextRestartAt: null,
  lastRestartAt: null,
  lastRestartReason: null,
})
const api: Record<string, unknown> = {
  '/api/agents/agent-1/slot-holds': [
    { poolKey: 'shared-box-intensive', expiresAt: new Date(now + 3_600_000).toISOString() },
  ],
  '/api/agents/agent-1/slot-waits': [
    { waiterId: 'waiter-1', poolKey: 'production-change', queuedAt: new Date(now).toISOString() },
  ],
  '/api/monitors': [monitor('m1', 'Garden planner build errors'), monitor('m2', 'Nightly export')],
}

const server = await createServer({
  configFile: false,
  root,
  server: { host: '127.0.0.1', port: 0 },
  esbuild: { jsx: 'automatic' },
  logLevel: 'warn',
  plugins: [
    {
      name: 'mobile-touch-targets-fixture',
      configureServer(server) {
        server.middlewares.use('/touch-targets-fixture', (_req, res) => {
          res.setHeader('Content-Type', 'text/html')
          res.end(
            '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/scripts/fixtures/mobile-touch-targets.tsx"></script></body></html>'
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
  page.setDefaultTimeout(10000)
  page.setDefaultNavigationTimeout(30000)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const errors: string[] = []
  await page.route('**/api/**', (route) => {
    const url = new URL(route.request().url())
    if (!url.pathname.startsWith('/api/')) return route.continue()
    if (url.pathname in api) return route.fulfill({ json: api[url.pathname] })
    errors.push(`Unexpected API request: ${url.pathname}`)
    return route.abort()
  })
  page.on('pageerror', (error) => errors.push(error.message))

  const measurements: unknown[] = []
  for (const width of [375, 1280]) {
    for (const appearance of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 700 })
      await page.goto(`${server.resolvedUrls!.local[0]!}touch-targets-fixture?appearance=${appearance}`)
      await page.getByText('Monitoring:').waitFor()
      await page.getByText('Holding slot:').waitFor()
      const result = await page.evaluate(() => {
        const round = (value: number) => Math.round(value * 10) / 10
        const header = document.querySelector('[data-fixture="chat-header"]')!
        // Rows whose icon is pinned to the first text line: the icon's centre against that line's centre.
        const rows = [...header.querySelectorAll<HTMLElement>('.items-start')].map((row) => {
          const icon = row.querySelector('svg')!.getBoundingClientRect()
          const text = row.querySelector<HTMLElement>('span')!
          // The row's leading text ("Monitoring: ") is on the first line, whatever else wraps.
          const walker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT)
          const range = document.createRange()
          range.selectNodeContents(walker.nextNode()!)
          const glyphs = range.getClientRects()[0]!
          return {
            text: text.textContent!.slice(0, 40),
            offset: round(icon.top + icon.height / 2 - (glyphs.top + glyphs.height / 2)),
          }
        })
        const inline = [...header.querySelectorAll<HTMLElement>('.items-start span button, .items-start span a')].map(
          (el) => ({ text: el.textContent!, height: round(el.getBoundingClientRect().height) })
        )
        const standalone = document.querySelector('[data-fixture="standalone"]')!
        const controls = [...standalone.querySelectorAll<HTMLElement>('button')].map((el) => ({
          name: el.getAttribute('aria-label') ?? el.textContent!.trim().slice(0, 30),
          role: el.getAttribute('role'),
          height: round(el.getBoundingClientRect().height),
          width: round(el.getBoundingClientRect().width),
        }))
        return { rows, inline, controls }
      })
      measurements.push({ width, appearance, ...result })
      const phone = width < 768
      assert.equal(result.rows.length, 4, 'hold, wait, monitor and link rows render')
      for (const row of result.rows) {
        assert.ok(Math.abs(row.offset) <= 1, `${width}px: icon off the first line by ${row.offset}px in "${row.text}"`)
      }
      for (const control of result.inline)
        assert.ok(control.height <= 17, `${width}px: inline "${control.text}" grew to ${control.height}px`)
      for (const control of result.controls) {
        if (control.role === 'switch')
          assert.deepEqual([control.height, control.width], [20, 36], `${width}px: the toggle changed size`)
        else if (phone)
          assert.ok(control.height >= 24, `${width}px: "${control.name}" is only ${control.height}px tall`)
      }
      if (screenshotDir)
        await page.screenshot({
          path: resolve(screenshotDir, `touch-targets-${width}-${appearance}.png`),
          fullPage: true,
        })
    }
  }

  assert.deepEqual(errors, [], 'No browser runtime errors')
  console.log(JSON.stringify(measurements, null, 2))
  console.log('Passed: inline rows stay aligned and standalone touch targets hold at 375 and 1280px, light and dark.')
} finally {
  await browser?.close()
  await server.close()
}
