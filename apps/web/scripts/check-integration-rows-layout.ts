/**
 * DB-free Chromium review of the connection rows on the GitHub, Notion, Cloudflare (deployment) and
 * local BigBrain integration cards, with the real components and stylesheet and synthetic
 * connections and squads (scripts/fixtures/integration-rows.tsx). Each row must show one status
 * badge, at most one inline fix, and a More actions menu whose Remove… asks for confirmation in the
 * row. Asserts that nothing widens the page at 390px and that nothing calls the API. Optional
 * SCREENSHOT_DIR saves each card at 1280 and 390, light and dark, plus its open menu and confirmation.
 * From apps/web: CHROMIUM_PATH=/path/to/chromium SCREENSHOT_DIR=/tmp/shots bun scripts/check-integration-rows-layout.ts
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
  path: '/integration-rows-fixture',
  entry: '/scripts/fixtures/integration-rows.tsx',
})

interface Card {
  /** Row titles with the status badge and the inline fix each one should show. */
  rows: { title: string; status: string; inline?: string }[]
  /** The row whose menu and Remove confirmation are opened. */
  menuRow: string
  /** Every item that row's menu offers. */
  menu: string[]
  /** What the Remove confirmation says. */
  removeText: string
}

const cards: Record<string, Card> = {
  github: {
    rows: [
      { title: 'Ficus Bot', status: 'Healthy' },
      { title: 'Ada Lovelace', status: 'Reconnect required', inline: 'Reconnect' },
      { title: 'Old automation account', status: 'Disabled', inline: 'Enable' },
    ],
    menuRow: 'Ficus Bot',
    menu: ['Reconnect', 'Disable…', 'Remove…'],
    removeText: 'Remove the Ficus Bot connection? 2 squads lose GitHub access.',
  },
  notion: {
    rows: [
      { title: 'Acme Wiki', status: 'Healthy' },
      { title: 'Design Notes', status: 'Reconnect required', inline: 'Reconnect' },
      { title: 'Archive', status: 'Disabled', inline: 'Enable' },
    ],
    menuRow: 'Acme Wiki',
    menu: ['Reconnect', 'Refresh', 'Disable…', 'Remove…'],
    removeText: 'Remove the Acme Wiki connection? 1 squad loses Notion access.',
  },
  cloudflare: {
    rows: [
      { title: 'Production account', status: 'Healthy' },
      { title: 'Staging account', status: 'Invalid credentials' },
      { title: 'Preview account', status: 'Healthy' },
      { title: 'Old marketing account', status: 'Disabled', inline: 'Enable' },
    ],
    menuRow: 'Preview account',
    menu: ['Validate', 'Make global default', 'Replace token', 'Disable…', 'Remove…'],
    removeText: 'Remove the Preview account connection? 1 squad loses Cloudflare access.',
  },
  bigbrain: {
    rows: [
      { title: 'BigBrain · Research and Personal Notes Vault', status: 'Healthy' },
      { title: 'BigBrain · Team Vault', status: 'Invalid credentials' },
      { title: 'BigBrain · Old Vault', status: 'Disabled', inline: 'Enable' },
    ],
    menuRow: 'BigBrain · Research and Personal Notes Vault',
    menu: ['Validate', 'Disable…', 'Remove…'],
    removeText: 'Remove the BigBrain · Research and Personal Notes Vault connection? 1 squad loses BigBrain access.',
  },
}

let browser: Browser | undefined
const errors: string[] = []

async function open(page: Page, provider: string, width: number, appearance: string) {
  await page.setViewportSize({ width, height: 900 })
  await page.goto(
    `${server.resolvedUrls!.local[0]!}integration-rows-fixture?provider=${provider}&appearance=${appearance}`,
    { timeout: 120_000 }
  )
  await page.locator(`#integration-card-${provider}`).waitFor()
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
    await page.setViewportSize({ width, height: Math.max(600, Math.min(result.height + 48, 3200)) })
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
      for (const [provider, card] of Object.entries(cards)) {
        await open(page, provider, width, appearance)
        for (const { title, status, inline } of card.rows) {
          const row = page.getByRole('listitem', { name: title, exact: true })
          const text = await row.innerText()
          assert.ok(text.includes(status), `${provider} ${title}: expected the status "${status}"`)
          // A row shows only the fix for its status; everything else sits in its menu.
          const buttons = await row
            .locator(':scope > div:first-child button')
            .evaluateAll((items) => items.map((item) => item.getAttribute('aria-label') ?? item.textContent))
          assert.deepEqual(
            buttons,
            [...(inline ? [inline] : []), `More actions for ${title}`],
            `${provider} ${title}: row buttons`
          )
        }
        await capture(page, provider, width, appearance)
        const row = page.getByRole('listitem', { name: card.menuRow, exact: true })
        await row.getByRole('button', { name: `More actions for ${card.menuRow}` }).click()
        await page.getByRole('menuitem', { name: 'Remove…' }).waitFor()
        const items = await page.getByRole('menuitem').allInnerTexts()
        assert.deepEqual(items, card.menu, `${provider}: menu items`)
        // Let the menu finish its entrance animation before the screenshot.
        await page.waitForTimeout(400)
        await capture(page, `${provider}-menu`, width, appearance)
        await page.getByRole('menuitem', { name: 'Remove…' }).click()
        await row.getByText(card.removeText).waitFor()
        // Let the closing menu finish its exit animation too.
        await page.waitForTimeout(400)
        await capture(page, `${provider}-remove`, width, appearance)
      }
    }
  }
  assert.deepEqual(errors, [])
  console.log('Integration rows layout: every card fits at 1280 and 390, light and dark, without API requests.')
} finally {
  await browser?.close()
  await server.close()
}
