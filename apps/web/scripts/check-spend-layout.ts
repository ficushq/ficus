/**
 * Focused, DB-free Chromium check of Settings → Spend with the real components and stylesheet and made-up
 * data: at phone widths nothing may make the page wider than the viewport; wide tables scroll inside their
 * own container, and an approximate amount ("≈ $x") never wraps.
 * From apps/web: CHROMIUM_PATH=/path/to/chromium bun scripts/check-spend-layout.ts
 * Optional SCREENSHOT_DIR saves full-page screenshots (phone and desktop, light and dark).
 * Uses Core's declared playwright-core dependency, without loading any Core test setup.
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Browser } from 'playwright-core'
import type { SpendBreakdown, SpendBreakdownRow, SpendDimension, SpendSummary } from '@ficus/shared'
import { startFixtureServer } from './fixture-server'

const root = resolve(import.meta.dir, '..')
const { chromium } = createRequire(resolve(root, '../core/package.json'))(
  'playwright-core'
) as typeof import('playwright-core')
const screenshotDir = process.env.SCREENSHOT_DIR
if (screenshotDir) await mkdir(screenshotDir, { recursive: true })

const DAY_MS = 24 * 60 * 60 * 1000
const today = Math.floor(Date.now() / DAY_MS) * DAY_MS
const series = Array.from({ length: 30 }, (_, index) => {
  const billed = index % 7 === 3 ? 0 : 2 + ((index * 37) % 23) / 2
  return {
    day: new Date(today - (29 - index) * DAY_MS).toISOString().slice(0, 10),
    billedUsd: billed,
    listUsd: billed * 4 + 30,
    calls: 200 + index * 11,
    tokens: 4_000_000 + index * 90_000,
  }
})
const summary: SpendSummary = {
  from: new Date(today - 29 * DAY_MS).toISOString(),
  to: new Date(today + DAY_MS).toISOString(),
  totals: {
    calls: 48_210,
    inputTokens: 912_000_000,
    outputTokens: 7_400_000,
    cacheReadTokens: 2_100_000_000,
    cacheWriteTokens: 12_000_000,
    billedUsd: 214.37,
    subscriptionFeesUsd: 400,
    totalUsd: 614.37,
    listUsd: 3_640.12,
    approximate: true,
  },
  series,
  subscriptions: [
    {
      provider: 'openai-codex',
      accountId: 'work',
      label: 'OpenAI Codex · Work ChatGPT',
      plan: 'pro',
      planLabel: 'ChatGPT Pro',
      planSource: 'detected',
      detectedPlan: 'pro',
      monthlyPriceUsd: 200,
      priceSource: 'default',
      needsChoice: false,
      feeUsd: 200,
      calls: 21_400,
      listUsd: 1_912.4,
    },
    {
      provider: 'anthropic',
      accountId: 'claude-code',
      label: 'Anthropic · Claude Code',
      plan: 'max-20x',
      planLabel: 'Claude Max 20x',
      planSource: 'manual',
      detectedPlan: 'max',
      monthlyPriceUsd: 200,
      priceSource: 'default',
      needsChoice: false,
      feeUsd: 200,
      calls: 9_830,
      listUsd: 1_204.8,
    },
  ],
  projection: { monthUsd: 640.5 },
  meta: { retentionDays: 180, detailFrom: null, feesIncluded: true },
}

const row = (key: string | null, label: string, calls: number, billedUsd: number, approximate = false) =>
  ({
    key,
    label,
    calls,
    tokens: calls * 41_000,
    billedUsd,
    listUsd: billedUsd * 3 + calls * 0.02,
    approximate,
  }) satisfies SpendBreakdownRow
const breakdowns: Partial<Record<SpendDimension, SpendBreakdownRow[]>> = {
  workStream: [
    row('ws-1', '#612 Rework the importer so large CSV files stream instead of loading whole', 4_120, 61.2),
    row('ws-2', '#598 Spend page: subscription fee line items', 2_310, 32.75, true),
    row(null, 'No work stream', 9_870, 12.4, true),
    row('ws-3', '#604 Faster sandbox start', 880, 9.1),
    row('ws-4', '#577 Docs pass', 145, 1_244.03, true),
  ],
  agent: [
    row('a-1', 'Engineer · Fix Spend page mobile and billing', 6_400, 88.6),
    row('a-2', 'Reviewer · Review importer streaming', 1_900, 21.04, true),
    row('a-3', 'Manager', 12_030, 4.5, true),
    row('a-4', 'Deleted (8f2c1d0e)', 300, 1.2),
  ],
  feature: [
    row('agent-turn', 'Agent turns', 40_120, 180.22, true),
    row('decision:triage', 'Decision: triage', 6_210, 21.9),
    row('compaction', 'Compaction', 1_200, 9.44),
    row('transcription', 'Transcription', 680, 2.81),
  ],
  billing: [
    row('api', 'API key', 12_400, 214.37),
    row('subscription', 'Subscription', 31_230, 0),
    row('unknown', 'Before tracking: billing unknown', 4_580, 0, true),
  ],
}

const server = await startFixtureServer({ path: '/spend-fixture', entry: '/scripts/fixtures/spend.tsx' })
let browser: Browser | undefined
try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] })
  const page = await browser.newPage({ hasTouch: true })
  page.setDefaultTimeout(10000)
  page.setDefaultNavigationTimeout(30000)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const errors: string[] = []
  await page.route('**/api/**', (route) => {
    const url = new URL(route.request().url())
    if (!url.pathname.startsWith('/api/')) return route.continue()
    if (url.pathname === '/api/spend/summary') return route.fulfill({ json: summary })
    if (url.pathname === '/api/spend/breakdown') {
      const by = url.searchParams.get('by') as SpendDimension
      const limit = Number(url.searchParams.get('limit') ?? 50)
      const rows = breakdowns[by] ?? breakdowns.feature!
      return route.fulfill({
        json: { by, rows: rows.slice(0, limit), truncated: rows.length > limit } satisfies SpendBreakdown,
      })
    }
    errors.push(`Unexpected API request: ${url.pathname}`)
    return route.abort()
  })
  page.on('pageerror', (error) => errors.push(error.message))

  const measurements: unknown[] = []
  for (const width of [375, 390, 430, 1280]) {
    for (const appearance of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 900 })
      await page.goto(`${server.resolvedUrls!.local[0]!}spend-fixture?appearance=${appearance}`)
      await page.getByText('Total for 30 days').waitFor()
      await page.getByRole('table').nth(2).waitFor()
      const result = await page.evaluate(() => {
        const scroller = document.querySelector<HTMLElement>('[data-fixture-scroller]')!
        const section = document.querySelector<HTMLElement>('[aria-labelledby="spend-heading"]')!
        const bounds = section.getBoundingClientRect()
        // Everything sits inside the section, except what scrolls inside its own container.
        const outside = [...section.querySelectorAll<HTMLElement>('*')]
          .filter((el) => !el.closest('.overflow-x-auto') || el.matches('.overflow-x-auto'))
          .filter((el) => {
            const rect = el.getBoundingClientRect()
            return rect.width > 0 && (rect.right > bounds.right + 1 || rect.left < bounds.left - 1)
          })
          .map((el) => `${el.tagName.toLowerCase()}.${el.className}`.slice(0, 120))
        // An approximate amount is on one line.
        const wrappedAmounts = [...section.querySelectorAll<HTMLElement>('td, p, span')]
          .filter((el) => el.childElementCount === 0 && el.textContent?.startsWith('≈ $'))
          .filter((el) => {
            const range = document.createRange()
            range.selectNodeContents(el)
            return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size > 1
          })
          .map((el) => el.textContent)
        const pills = document.querySelector('[aria-label="Period"]')!.getBoundingClientRect()
        return {
          viewport: innerWidth,
          document: document.documentElement.scrollWidth,
          // The settings column is what scrolls on a phone: it must not scroll sideways.
          page: { client: scroller.clientWidth, scroll: scroller.scrollWidth, height: scroller.scrollHeight },
          section: { client: section.clientWidth, scroll: section.scrollWidth },
          pills: { left: Math.round(pills.left), right: Math.round(pills.right) },
          outside,
          wrappedAmounts,
        }
      })
      measurements.push({ width, appearance, ...result })
      assert.ok(result.document <= width, `${width}px ${appearance}: the document is wider than the viewport`)
      assert.ok(
        result.page.scroll <= result.page.client,
        `${width}px ${appearance}: the page scrolls sideways (${result.page.scroll}px in ${result.page.client}px)`
      )
      assert.ok(result.section.scroll <= result.section.client + 1, `${width}px: the Spend section overflows`)
      assert.ok(result.pills.left >= 0 && result.pills.right <= width, `${width}px: the period pills overflow`)
      assert.deepEqual(result.outside, [], `${width}px: elements outside the section`)
      assert.deepEqual(result.wrappedAmounts, [], `${width}px: an approximate amount wrapped`)
      if (screenshotDir) {
        // The whole page in one shot: as tall as the settings column's content.
        await page.setViewportSize({ width, height: result.page.height })
        await page.screenshot({ path: resolve(screenshotDir, `spend-${width}-${appearance}.png`) })
      }
    }
  }

  // The billing breakdown names usage from before tracking.
  await page.setViewportSize({ width: 390, height: 900 })
  await page.goto(`${server.resolvedUrls!.local[0]!}spend-fixture?appearance=light`)
  await page.getByText('Total for 30 days').waitFor()
  await page.getByRole('combobox', { name: 'Group by' }).click()
  await page.getByRole('option', { name: 'Billing' }).click()
  await page.getByText('Before tracking: billing unknown').waitFor()
  const breakdown = page.locator('[data-setting-target="spend-breakdown"]')
  if (screenshotDir) await breakdown.screenshot({ path: resolve(screenshotDir, 'spend-390-billing-breakdown.png') })

  assert.deepEqual(errors, [], 'No browser runtime errors')
  console.log(JSON.stringify(measurements, null, 2))
  console.log('Passed: no horizontal page overflow at 375, 390, 430 and 1280px, light and dark.')
} finally {
  await browser?.close()
  await server.close()
}
