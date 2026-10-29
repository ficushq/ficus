/** DB-free rendered regression check of Feed Dismiss using the real component and stylesheet.
 * From apps/web: CHROMIUM_PATH=/path/to/chromium bun scripts/check-feed-dismiss-layout.ts
 * Optional SCREENSHOT_DIR saves normal, hover, keyboard-focus and pending screenshots.
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir } from 'node:fs/promises'
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
      configureServer(server) {
        server.middlewares.use('/feed-dismiss-fixture', (_req, res) => {
          res.setHeader('Content-Type', 'text/html')
          res.end(
            '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/scripts/fixtures/feed-dismiss.tsx"></script></body></html>'
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
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  for (const width of [1024, 320]) {
    for (const theme of ['ficus', 'iris']) {
      for (const appearance of ['light', 'dark']) {
        const label = `${theme}-${appearance}-${width}`
        await page.setViewportSize({ width, height: 360 })
        await page.goto(`${server.resolvedUrls!.local[0]!}feed-dismiss-fixture?theme=${theme}&appearance=${appearance}`)
        const button = page.getByRole('button', { name: 'Dismiss', exact: true })
        await button.waitFor()
        const style = () =>
          button.evaluate((element) => {
            const css = getComputedStyle(element)
            const rect = element.getBoundingClientRect()
            return {
              color: css.color,
              background: css.backgroundColor,
              decoration: css.textDecorationLine,
              outline: css.outlineStyle,
              outlineWidth: css.outlineWidth,
              focusVisible: element.matches(':focus-visible'),
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
        await page.mouse.move(0, 0)
        await page.waitForTimeout(200)
        const normal = await style()
        assert.equal(normal.background, 'rgba(0, 0, 0, 0)', `${label}: transparent at rest`)
        assert.equal(normal.color, await token('--color-text-secondary'))
        assert.equal(normal.decoration, 'none')
        assert.ok(normal.left >= 0 && normal.right <= width && normal.height >= 24, `${label}: usable compact target`)
        await shot('normal')
        await button.hover()
        await page.waitForTimeout(200)
        const hover = await style()
        assert.equal(hover.background, await token('--color-bg-surface-hover'))
        assert.equal(hover.color, await token('--color-text-primary'))
        assert.equal(hover.decoration, 'none')
        await shot('hover')
        await page.mouse.move(0, 0)
        await page.keyboard.press('Tab') // summary
        await page.keyboard.press('Tab') // Dismiss
        assert.equal(await button.evaluate((element) => element === document.activeElement), true)
        await page.waitForTimeout(200)
        const focused = await style()
        assert.equal(focused.focusVisible, true)
        assert.notEqual(focused.outline, 'none')
        assert.ok(parseFloat(focused.outlineWidth) > 0)
        await shot('focus')
        if (width === 320) await button.tap()
        else await page.keyboard.press('Enter')
        const pending = page.getByRole('button', { name: 'Dismissing…', exact: true })
        assert.equal(await pending.isDisabled(), true)
        assert.equal(await page.locator('details').evaluate((element) => (element as HTMLDetailsElement).open), true)
        await pending.hover({ force: true })
        await page.waitForTimeout(200)
        const disabled = await pending.evaluate((element) => {
          const css = getComputedStyle(element)
          const rect = element.getBoundingClientRect()
          return {
            background: css.backgroundColor,
            decoration: css.textDecorationLine,
            left: rect.left,
            right: rect.right,
          }
        })
        assert.equal(disabled.background, 'rgba(0, 0, 0, 0)')
        assert.equal(disabled.decoration, 'none')
        assert.ok(disabled.left >= 0 && disabled.right <= width, `${label}: pending label fits`)
        await shot('disabled')
        console.log(`PASS ${label}: normal, hover, focus, disabled, layout and activation`)
      }
    }
  }
  assert.deepEqual(errors, [], 'No browser runtime errors')
} finally {
  await browser?.close()
  await server.close()
}
