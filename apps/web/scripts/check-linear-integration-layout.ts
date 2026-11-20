/**
 * DB-free Chromium review of Settings → Integrations → Linear, with the real components and
 * stylesheet and synthetic workspaces, keys and squads (scripts/fixtures/linear-integration.tsx).
 * Asserts that no state widens the page at 390px, that nothing calls the API, and that each state
 * says what to do next. Optional SCREENSHOT_DIR saves every state at 1280 and 390, light and dark.
 * From apps/web: CHROMIUM_PATH=/path/to/chromium SCREENSHOT_DIR=/tmp/shots bun scripts/check-linear-integration-layout.ts
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
const server = await startFixtureServer({
  path: '/linear-integration-fixture',
  entry: '/scripts/fixtures/linear-integration.tsx',
})

/** What each state must say, so a screenshot is never the only evidence. */
const expected: Record<string, string[]> = {
  before: ['Connect Linear', 'Install Ficus in Linear', 'Use a personal API key instead'],
  installed: [
    'Ficus',
    'linear.app/ficushq',
    'Healthy',
    'No squad can use this workspace yet.',
    'Install in another workspace',
  ],
  attached: ['Used by', 'Platform', 'choose the Linear teams whose issues it handles'],
  several: ['Beta Labs', 'Needs permissions', 'Operations key', 'Disabled', 'Research and Insights'],
  'api-key': ['Personal API key', 'Install Ficus in Linear'],
  'self-hosted': ['Callback URL', 'Save Linear application'],
}

let browser: Browser | undefined
const errors: string[] = []

async function open(page: Page, state: string, width: number, appearance: string) {
  await page.setViewportSize({ width, height: 900 })
  await page.goto(
    `${server.resolvedUrls!.local[0]!}linear-integration-fixture?state=${state}&appearance=${appearance}`,
    { timeout: 120_000 }
  )
  await page.locator('#integration-card-linear').waitFor()
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
        const text = await page.locator('#integration-card-linear').innerText()
        for (const wanted of texts) assert.ok(text.includes(wanted), `${state}: expected "${wanted}"`)
        await capture(page, state, width, appearance)
      }
      // The API-key form opens only when asked for.
      await open(page, 'before', width, appearance)
      await page.getByRole('button', { name: 'Use a personal API key instead' }).click()
      await page.getByRole('button', { name: 'Create and validate' }).waitFor()
      await capture(page, 'before-api-key', width, appearance)
      // Secondary and destructive actions live in one menu per connection.
      await open(page, 'installed', width, appearance)
      await page.getByRole('button', { name: 'More actions for Ficus' }).click()
      await page.getByRole('menuitem', { name: 'Remove…' }).waitFor()
      // Let the menu finish its entrance animation before the screenshot.
      await page.waitForTimeout(400)
      await capture(page, 'installed-menu', width, appearance)
      await page.getByRole('menuitem', { name: 'Remove…' }).click()
      await page.getByText('Remove the Ficus connection?').waitFor()
      await capture(page, 'installed-remove', width, appearance)
    }
  }
  assert.deepEqual(errors, [])
  console.log('Linear integration layout: every state fits at 1280 and 390, light and dark, without API requests.')
} finally {
  await browser?.close()
  await server.close()
}
