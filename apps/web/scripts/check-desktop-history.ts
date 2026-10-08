/** DB-free real Chromium/Router regression. Run from apps/web:
 * CHROMIUM_PATH=/path/to/chromium bun scripts/check-desktop-history.ts
 * SCREENSHOT_DIR optionally saves the real header in windowed/fullscreen chrome.
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
const server = await createServer({
  configFile: false,
  root,
  resolve: { dedupe: ['react', 'react-dom'] },
  server: { host: '127.0.0.1', port: 0 },
  esbuild: { jsx: 'automatic' },
  plugins: [
    {
      name: 'desktop-history-fixture',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (!req.headers.accept?.includes('text/html')) return next()
          res.setHeader('Content-Type', 'text/html')
          res.end(
            '<html><head></head><body><div id="root"></div><script type="module" src="/scripts/fixtures/desktop-history.tsx"></script></body></html>'
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
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  page.setDefaultTimeout(5000)
  page.setDefaultNavigationTimeout(30000)
  const errors: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text())
  })
  page.on('pageerror', (error) => {
    errors.push(error.message)
    console.error(error.message)
  })
  await page.route('**/api/**', (route) =>
    new URL(route.request().url()).pathname.startsWith('/api/')
      ? route.fulfill({
          json: route.request().url().includes('count')
            ? { count: 0 }
            : route.request().url().includes('permissions')
              ? { permissions: [] }
              : [],
        })
      : route.continue()
  )
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('fixture-bootstrapped')) {
      history.replaceState({}, '', '/unrelated')
      history.pushState({}, '', '/')
      sessionStorage.setItem('fixture-bootstrapped', 'true')
    }
    if (sessionStorage.getItem('browser-only')) return
    window.ficusDesktopApp = {
      version: 1,
      notificationsEnabled: async () => false,
      deliverNotifications: async () => {},
      shell: {
        platform: 'darwin',
        insetTitleBar: true,
        fullscreen: async () => false,
        onFullscreenChange: (listener) => {
          window.addEventListener('fixture-fullscreen', () => listener(true))
          return () => {}
        },
      },
    }
  })
  await page.goto(server.resolvedUrls!.local[0]!)
  const back = page.getByRole('button', { name: 'Go back', exact: true })
  const forward = page.getByRole('button', { name: 'Go forward', exact: true })
  await page.locator('output').waitFor()
  assert.equal(await back.count(), 1, 'Desktop header has a back arrow')
  assert.equal(await back.isDisabled(), true)
  assert.notEqual(
    await back.evaluate((el) => getComputedStyle(el).pointerEvents),
    'none',
    'Disabled arrows retain tooltip and no-drag hit area'
  )
  assert.equal(await forward.isDisabled(), true)
  const at = async (path: string) => {
    await page.waitForFunction((path) => document.querySelector('output')?.textContent === path, path)
  }
  await page.getByRole('button', { name: 'Chat one', exact: true }).click()
  await page.getByRole('button', { name: 'Work stream', exact: true }).click()
  await at('/squads/team?ws=42#activity')
  assert.equal(await forward.isDisabled(), true)
  await back.click()
  await at('/chat?session=one')
  assert.equal(await forward.isEnabled(), true)
  await page.reload()
  await at('/chat?session=one')
  assert.equal(await forward.isEnabled(), true, 'Reload retains forward availability')
  await forward.click()
  await at('/squads/team?ws=42#activity')
  await page.keyboard.press('Meta+[')
  await at('/chat?session=one')
  await page.keyboard.press('Meta+[')
  await at('/')
  assert.equal(await back.isDisabled(), true)
  await page.keyboard.press('Meta+[')
  await at('/')
  await page.keyboard.press('Meta+]')
  await at('/chat?session=one')
  await page.getByRole('button', { name: 'Replace chat', exact: true }).click()
  await at('/chat?session=two')
  await forward.click()
  await at('/squads/team?ws=42#activity')
  await back.click()
  await at('/chat?session=two')
  await page.getByRole('button', { name: 'Branch', exact: true }).click()
  await at('/settings')
  assert.equal(await forward.isDisabled(), true, 'Push truncates forward branch')
  await page.evaluate(() => {
    location.hash = 'native-hash'
  })
  await at('/settings#native-hash')
  await back.click()
  await at('/settings')
  await forward.click()
  await at('/settings#native-hash')
  await back.click()
  await at('/settings')
  await page.getByRole('textbox', { name: 'Editor' }).focus()
  await page.keyboard.press('Meta+[')
  await at('/settings')
  await back.focus()
  await page.keyboard.press('Enter')
  await at('/chat?session=two')
  assert.equal(await back.evaluate((el) => getComputedStyle(el).getPropertyValue('-webkit-app-region')), 'no-drag')
  assert.ok((await back.boundingBox())!.x >= 96, 'Arrows clear traffic lights')
  assert.equal(await page.locator('header').evaluate((el) => el.getBoundingClientRect().height), 56)
  if (process.env.SCREENSHOT_DIR) {
    await mkdir(process.env.SCREENSHOT_DIR, { recursive: true })
    await page.screenshot({ path: resolve(process.env.SCREENSHOT_DIR, 'desktop-history-windowed.png') })
  }
  await page.evaluate(() => window.dispatchEvent(new Event('fixture-fullscreen')))
  assert.equal(await page.locator('html').getAttribute('data-desktop-shell'), null)
  assert.equal(await back.isVisible(), true, 'Fullscreen still has desktop history')
  await page.keyboard.press('Meta+]')
  await at('/settings')
  if (process.env.SCREENSHOT_DIR)
    await page.screenshot({ path: resolve(process.env.SCREENSHOT_DIR, 'desktop-history-fullscreen.png') })
  await page.evaluate(() => sessionStorage.setItem('browser-only', 'true'))
  await page.reload()
  await at('/settings')
  assert.equal(await back.count(), 0, 'Ordinary browsers have no desktop controls')
  assert.equal(
    await page.evaluate(() => {
      const event = new KeyboardEvent('keydown', { key: '[', metaKey: true, bubbles: true, cancelable: true })
      document.body.dispatchEvent(event)
      return event.defaultPrevented
    }),
    false,
    'Browser-native shortcuts are not intercepted'
  )
  assert.deepEqual(errors, [])
  console.log(
    'PASS desktop history: real Router push/replace/pop/reload, branching, shortcuts, editor, fullscreen, browser gating, header layout/no-drag'
  )
} finally {
  await browser?.close()
  await server.close()
}
