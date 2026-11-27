/** DB-free rendered check that the Feed, a squad's Work list and the Assistant draw one work stream row
 * and use one wait vocabulary, with the real components and stylesheet.
 * From apps/web: CHROMIUM_PATH=/path/to/chromium bun scripts/check-work-stream-rows.ts
 * Every built-in theme (light and dark for dual themes): each row leads with a visible status marker, then
 * "#number · title" with the status badge at the right and one context line beneath; a routine approval
 * reads "review needed", never "blocked"; agents are named by type, never by name alone. Optional
 * SCREENSHOT_DIR saves one screenshot per surface, theme and appearance; optional THEMES (comma-separated
 * theme ids, for example `ficus,iris`) runs only those themes.
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { BUILT_IN_THEMES } from '../src/theme/registry'
import { startFixtureServer } from './fixture-server'

const root = resolve(import.meta.dir, '..')
const { chromium } = createRequire(resolve(root, '../core/package.json'))(
  'playwright-core'
) as typeof import('playwright-core')
const screenshotDir = process.env.SCREENSHOT_DIR
if (screenshotDir) await mkdir(screenshotDir, { recursive: true })
const server = await startFixtureServer({
  path: '/work-stream-rows-fixture',
  entry: '/scripts/fixtures/work-stream-rows.tsx',
})

const onlyThemes = process.env.THEMES?.split(',').map((id) => id.trim())
const variants = BUILT_IN_THEMES.filter((theme) => !onlyThemes || onlyThemes.includes(theme.id)).flatMap((theme) =>
  theme.kind === 'dual' ? [`${theme.id}:light`, `${theme.id}:dark`] : [`${theme.id}:constant`]
)
// The agents' names in the fixture; none may be shown on its own.
const AGENT_NAMES = ['Quartz', 'Flint', 'Wren', 'Moss', 'Pyrite']

/** The row's parts, as boxes, for the Feed and squad list rows. */
async function listRows(page: Page) {
  return page.locator('[data-testid="work-stream-row"]').evaluateAll((rows) =>
    rows.map((row) => {
      const box = (element: Element | null) => {
        if (!element) return null
        const rect = element.getBoundingClientRect()
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }
      }
      const button = row.querySelector('button')!
      const marker = button.querySelector('[data-testid="work-stream-status-marker"]')
      const badges = button.lastElementChild
      return {
        title: button.textContent ?? '',
        markerFirst: button.firstElementChild === marker,
        markerColor: marker ? getComputedStyle(marker).backgroundColor : null,
        marker: box(marker),
        badges: box(badges),
        row: box(row),
        context: box(row.querySelector('[data-testid="work-stream-row-context"]')),
        titleLine: box(button),
      }
    })
  )
}

function assertRows(label: string, rows: Awaited<ReturnType<typeof listRows>>, count: number) {
  assert.equal(rows.length, count, `${label}: row count`)
  for (const row of rows) {
    assert.ok(row.markerFirst, `${label}: the status marker leads "${row.title}"`)
    assert.ok(
      row.markerColor && row.markerColor !== 'rgba(0, 0, 0, 0)',
      `${label}: marker has a theme color for "${row.title}"`
    )
    assert.match(row.title, /^#\d+ · /, `${label}: "#number · title" for "${row.title}"`)
    assert.ok(row.badges!.right >= row.titleLine!.right - 2, `${label}: badge at the right of "${row.title}"`)
    assert.ok(row.context, `${label}: one context line under "${row.title}"`)
    assert.ok(row.context!.top >= row.titleLine!.bottom - 1, `${label}: context below the title of "${row.title}"`)
  }
}

function assertWords(label: string, text: string) {
  assert.ok(!/workstream blocked/i.test(text), `${label}: no raw action type`)
  assert.ok(text.includes('review needed'), `${label}: a pending approval reads "review needed"`)
  for (const name of AGENT_NAMES) assert.ok(!text.includes(name), `${label}: agent name "${name}" shown`)
}

let browser: Browser | undefined
try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] })
  const errors: string[] = []
  for (const variant of variants) {
    const page = await browser.newPage()
    page.setDefaultTimeout(10000)
    page.on('pageerror', (error) => errors.push(error.message))
    await page.setViewportSize({ width: 1280, height: 900 })
    const [theme, appearance] = variant.split(':')
    const url = (section: string) =>
      `${server.resolvedUrls!.local[0]!}work-stream-rows-fixture?section=${section}&theme=${theme}&appearance=${appearance}`

    await page.goto(url('feed'))
    await page.locator('[data-testid="work-stream-row"]').first().waitFor()
    assertRows(`${variant} feed`, await listRows(page), 5)
    const feedText = (await page.getByTestId('feed-surface').textContent()) ?? ''
    assertWords(`${variant} feed`, feedText)
    assert.ok(feedText.includes('Engineer (#1)'), `${variant} feed: the question names its agent by type`)
    if (screenshotDir) await page.screenshot({ path: resolve(screenshotDir, `feed-${theme}-${appearance}.png`) })

    await page.goto(url('squad'))
    await page.locator('[data-testid="work-stream-row"]').first().waitFor()
    assertRows(`${variant} squad`, await listRows(page), 3)
    if (screenshotDir) await page.screenshot({ path: resolve(screenshotDir, `squad-${theme}-${appearance}.png`) })

    await page.goto(url('assistant'))
    const results = page.locator('#command-center-results [role="option"]')
    await results.first().waitFor()
    const workResults = await results.evaluateAll((options) =>
      options
        .filter((option) => option.querySelector('[data-testid="work-stream-status-marker"]'))
        .map((option) => ({
          text: option.textContent ?? '',
          markerFirst: option.firstElementChild?.matches('[data-testid="work-stream-status-marker"]'),
        }))
    )
    assert.ok(workResults.length >= 3, `${variant} assistant: work stream rows use the status marker`)
    for (const result of workResults) {
      assert.ok(result.markerFirst, `${variant} assistant: marker leads "${result.text}"`)
      assert.match(result.text, /^Work stream #\d+ · /, `${variant} assistant: "#number · title" for "${result.text}"`)
    }
    assertWords(`${variant} assistant`, (await page.locator('#command-center-results').textContent()) ?? '')
    if (screenshotDir) await page.screenshot({ path: resolve(screenshotDir, `assistant-${theme}-${appearance}.png`) })
    await page.close()
  }
  assert.deepEqual(errors, [], 'no page errors')
  console.log(`work stream rows: ${variants.length} theme variants passed`)
} finally {
  await browser?.close()
  await server.close()
}
