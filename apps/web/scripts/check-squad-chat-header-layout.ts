/**
 * Focused, DB-free Chromium check of the squad Chats tab header with the real components and stylesheet
 * and made-up data (an agent with a long name and a running subagent, so the Subagents view is offered).
 * Each width shows exactly one variant of the view tabs: the "..." menu on phones, the dropdown from md
 * and the segmented control from lg. The header stays one row with the agent name readable and the
 * fullscreen button on screen, the fullscreen view's header follows the same rule, and the squad tab
 * bar never shows a sliver of a clipped tab beside More.
 * From apps/web: CHROMIUM_PATH=/path/to/chromium bun scripts/check-squad-chat-header-layout.ts
 * Optional SCREENSHOT_DIR saves a screenshot per width and appearance.
 * Uses Core's declared playwright-core dependency, without loading any Core test setup.
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

type Variant = 'menu' | 'dropdown' | 'segmented'
const WIDTHS: Array<{ width: number; variant: Variant }> = [
  { width: 390, variant: 'menu' },
  { width: 800, variant: 'dropdown' },
  { width: 1280, variant: 'segmented' },
]

/** Which view-tab variants are displayed inside `scope`, and the geometry of the header row. */
function measure(page: Page, scope: 'inline' | 'fullscreen') {
  return page.evaluate((scope) => {
    const shown = (el: Element | null) => !!el && (el as HTMLElement).getClientRects().length > 0
    const container =
      scope === 'inline'
        ? document.querySelector<HTMLElement>('[aria-label="Fullscreen"]')!.parentElement!.parentElement!
        : document.querySelector<HTMLElement>('[role="dialog"]')!
    const variants = {
      menu: shown(container.querySelector('[aria-label^="Conversation options"]')),
      dropdown: shown(container.querySelector('button[aria-label="Agent view"]')),
      segmented: shown(container.querySelector('[role="radiogroup"][aria-label="Agent view"]')),
    }
    const rect = (el: Element | null) => {
      const box = el?.getBoundingClientRect()
      return box && { left: Math.round(box.left), right: Math.round(box.right), width: Math.round(box.width) }
    }
    // The agent's title ("Manager", then its name) as displayed: one line on wide screens, two on phones.
    const title = [...container.querySelectorAll<HTMLElement>('span, h2')].find(
      (el) =>
        el.firstChild?.nodeType === Node.TEXT_NODE && el.firstChild.textContent?.startsWith('Manager') && shown(el)
    )
    return {
      variants,
      header: { height: Math.round(container.getBoundingClientRect().height), ...rect(container)! },
      title: rect(title ?? null),
      fullscreen: rect(container.querySelector('[aria-label="Fullscreen"]')),
      document: document.documentElement.scrollWidth,
    }
  }, scope)
}

/**
 * The squad tab bar's trailing edge, at the start of the row and scrolled to its end: whether the tabs
 * continue past the edge, whether the edge fades out, and which tab labels sit under the fade.
 */
function squadTabsEdge(page: Page) {
  return page.evaluate(() => {
    const nav = document.querySelector<HTMLElement>('[role="tablist"][aria-label="Squad sections"]')!
    const style = getComputedStyle(nav)
    const fade =
      parseFloat(style.getPropertyValue('--squad-tabs-fade')) *
      parseFloat(getComputedStyle(document.documentElement).fontSize)
    const underFade = () => {
      const fadeStart = nav.getBoundingClientRect().right - fade
      return [...nav.querySelectorAll<HTMLElement>('[role="tab"]')]
        .filter((tab) => {
          const range = document.createRange()
          range.selectNodeContents(tab)
          return range.getBoundingClientRect().right > fadeStart + 0.5
        })
        .map((tab) => tab.textContent)
    }
    nav.scrollLeft = 0
    const atStart = underFade()
    nav.scrollLeft = nav.scrollWidth
    const atEnd = underFade()
    nav.scrollLeft = 0
    return {
      overflows: nav.scrollWidth > nav.clientWidth + 1,
      mask: style.maskImage || style.getPropertyValue('-webkit-mask-image'),
      fade,
      atStart,
      atEnd,
    }
  })
}

const server = await startFixtureServer({ entry: '/scripts/fixtures/squad-chat-header.tsx' })
let browser: Browser | undefined
try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] })
  const page = await browser.newPage({ hasTouch: true })
  page.setDefaultTimeout(10000)
  page.setDefaultNavigationTimeout(30000)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const errors: string[] = []
  // Lists the panel reads (agent types, work streams, questions, slugs) are empty.
  await page.route('**/api/**', (route) => {
    const url = new URL(route.request().url())
    if (!url.pathname.startsWith('/api/')) return route.continue()
    return route.fulfill({ json: [] })
  })
  page.on('pageerror', (error) => errors.push(error.message))

  const measurements: unknown[] = []
  for (const { width, variant } of WIDTHS) {
    for (const appearance of ['light', 'dark']) {
      for (const scope of ['inline', 'fullscreen'] as const) {
        await page.setViewportSize({ width, height: 844 })
        const query = new URLSearchParams()
        if (appearance === 'dark') query.set('dark', '1')
        if (scope === 'fullscreen') query.set('fullscreen', '1')
        await page.goto(`${server.resolvedUrls!.local[0]!}squads/squad-1/agents?${query}`)
        if (scope === 'inline') await page.getByLabel('Fullscreen').waitFor()
        else await page.getByRole('dialog').waitFor()
        await page.getByText('Transcript line 1:').first().waitFor()
        const result = await measure(page, scope)
        const tabsEdge = scope === 'inline' ? await squadTabsEdge(page) : undefined
        measurements.push({ width, appearance, scope, ...result, tabsEdge })
        const label = `${width}px ${appearance} ${scope}`
        // Before the assertions, so a failing layout is captured too.
        if (screenshotDir)
          await page.screenshot({ path: resolve(screenshotDir, `squad-chat-${scope}-${width}-${appearance}.png`) })

        // Exactly one variant of the view tabs, the one meant for this width.
        assert.deepEqual(
          result.variants,
          { menu: variant === 'menu', dropdown: variant === 'dropdown', segmented: variant === 'segmented' },
          `${label}: view tabs variants`
        )
        assert.ok(result.document <= width, `${label}: the page is wider than the viewport`)
        assert.ok(result.title && result.title.width >= 80, `${label}: the agent name is squeezed`)
        if (scope === 'inline') {
          // One row: the two-line phone title (name over role) and the controls, nothing stacked.
          assert.ok(result.header.height <= 64, `${label}: the header is ${result.header.height}px tall`)
          assert.ok(result.fullscreen && result.fullscreen.right <= result.header.right, `${label}: fullscreen`)
          // A squad tab cut off beside More fades out instead of leaving a hard-edged sliver, every
          // label clears the fade once scrolled into view, and nothing fades when the tabs all fit.
          assert.ok(tabsEdge!.fade >= 16 && tabsEdge!.mask.includes('gradient'), `${label}: squad tabs edge fade`)
          assert.deepEqual(tabsEdge!.atEnd, [], `${label}: the last squad tab stays under the fade`)
          if (!tabsEdge!.overflows) assert.deepEqual(tabsEdge!.atStart, [], `${label}: squad tabs fade though all fit`)
        }
      }
    }
  }

  assert.deepEqual(errors, [], 'No browser runtime errors')
  console.log(JSON.stringify(measurements, null, 2))
  console.log('Passed: one view-tabs variant per width and a one-row header at 390, 800 and 1280px, light and dark.')
} finally {
  await browser?.close()
  await server.close()
}
