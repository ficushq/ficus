/**
 * DB-free Chromium review of Settings → Administration → Server address and its "Reach this server from a
 * phone" guide, with the real components and stylesheet and a made-up machine (scripts/fixtures/phone-reach.tsx).
 * Asserts that no state widens the page at 390px, that nothing calls the API, that each state says what to do
 * next, and that "Use this address" opens the form with that address. Optional SCREENSHOT_DIR saves every state
 * at 1280 and 390, light and dark.
 * From apps/web: CHROMIUM_PATH=/path/to/chromium SCREENSHOT_DIR=/tmp/shots bun scripts/check-phone-reach-guide.ts
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
const server = await startFixtureServer({ path: '/phone-reach-fixture', entry: '/scripts/fixtures/phone-reach.tsx' })

/** What each machine must say, so a screenshot is never the only evidence. */
const expected: Record<string, string[]> = {
  local: [
    'Reach this server from a mobile device',
    'The current address only works on this computer.',
    'http://studio-mac.local:3000',
    'HOST=0.0.0.0',
    'Tailscale was not found on this machine.',
    'reverse_proxy 127.0.0.1:3000',
  ],
  tailscale: ['tailscale serve --bg http://127.0.0.1:3000', 'https://studio-mac.tail1234.ts.net'],
  home: [
    'The current address works for mobile devices on the same network as this server.',
    'Tailscale is installed but not connected.',
  ],
}

let browser: Browser | undefined
const errors: string[] = []

async function open(page: Page, state: string, width: number, appearance: string) {
  await page.setViewportSize({ width, height: 900 })
  await page.goto(`${server.resolvedUrls!.local[0]!}phone-reach-fixture?state=${state}&appearance=${appearance}`, {
    timeout: 120_000,
  })
  await page.getByRole('heading', { name: 'Reach this server from a mobile device' }).waitFor()
  // Every option open, so the whole guide is measured and captured.
  await page.evaluate(() => document.querySelectorAll('details').forEach((details) => (details.open = true)))
}

async function capture(page: Page, name: string, width: number, appearance: string) {
  const result = await page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>('[data-fixture-scroller]')!
    return {
      document: document.documentElement.scrollWidth,
      client: scroller.clientWidth,
      scroll: scroller.scrollWidth,
      height: scroller.scrollHeight,
    }
  })
  assert.ok(result.document <= width, `${name} ${width}px ${appearance}: the document is wider than the viewport`)
  assert.ok(result.scroll <= result.client, `${name} ${width}px ${appearance}: the page scrolls sideways`)
  if (screenshotDir) {
    await page.setViewportSize({ width, height: Math.max(600, Math.min(result.height + 48, 2400)) })
    await page.screenshot({ path: resolve(screenshotDir, `${name}-${width}-${appearance}.png`) })
    await page.setViewportSize({ width, height: 900 })
  }
}

try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] })
  const page = await browser.newPage()
  page.setDefaultTimeout(10_000)
  page.on('pageerror', (error) => {
    errors.push(error.message)
    console.error(error.message)
  })
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname
    // Vite serves source modules under /src/api/; only real API calls are refused.
    if (!path.startsWith('/api/')) return route.continue()
    errors.push(`Unexpected API request: ${route.request().method()} ${path}`)
    return route.fulfill({ status: 404, json: { error: 'not in fixture' } })
  })
  for (const appearance of ['dark', 'light']) {
    for (const width of [1280, 390]) {
      for (const [state, texts] of Object.entries(expected)) {
        await open(page, state, width, appearance)
        const text = await page.locator('[data-fixture-scroller]').innerText()
        for (const wanted of texts) assert.ok(text.includes(wanted), `${state}: expected "${wanted}"`)
        assert.ok(!/relay/i.test(text.replace(/Mobile & Pro/g, '')), `${state}: a relay is not offered here`)
        await capture(page, state, width, appearance)
      }
      // Choosing an address opens the form above with it; nothing is saved until it is reviewed.
      await open(page, 'tailscale', width, appearance)
      await page.getByRole('button', { name: 'Use this address' }).last().click()
      const field = page.getByRole('textbox', { name: 'New public address' })
      await field.waitFor()
      assert.equal(await field.inputValue(), 'https://studio-mac.tail1234.ts.net')
      await capture(page, 'tailscale-chosen', width, appearance)
    }
  }
  assert.deepEqual(errors, [])
  console.log('Phone reach guide: every state fits at 1280 and 390, light and dark, without API requests.')
} finally {
  await browser?.close()
  await server.close()
}
