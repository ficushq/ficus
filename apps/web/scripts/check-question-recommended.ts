/** DB-free rendered check of a recommended option on the agent question card, using the real component and stylesheet.
 * From apps/web: CHROMIUM_PATH=/path/to/chromium bun scripts/check-question-recommended.ts
 * Every built-in theme (light and dark for dual themes) at 1280 and 390 pixels: the recommended option
 * carries a visible "Recommended" tag with its reason, nothing is preselected, and the card fits.
 * Optional SCREENSHOT_DIR saves one screenshot of the card per theme, appearance and width; optional
 * THEMES (comma-separated theme ids, for example `ficus,iris`) runs only those themes.
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Browser } from 'playwright-core'
import { BUILT_IN_THEMES } from '../src/theme/registry'
import { startFixtureServer } from './fixture-server'

const root = resolve(import.meta.dir, '..')
const { chromium } = createRequire(resolve(root, '../core/package.json'))(
  'playwright-core'
) as typeof import('playwright-core')
const screenshotDir = process.env.SCREENSHOT_DIR
if (screenshotDir) await mkdir(screenshotDir, { recursive: true })
const server = await startFixtureServer({
  path: '/question-recommended-fixture',
  entry: '/scripts/fixtures/question-recommended.tsx',
})

const onlyThemes = process.env.THEMES?.split(',').map((id) => id.trim())
const variants = BUILT_IN_THEMES.filter((theme) => !onlyThemes || onlyThemes.includes(theme.id)).flatMap((theme) =>
  theme.kind === 'dual' ? [`${theme.id}:light`, `${theme.id}:dark`] : [`${theme.id}:constant`]
)

let browser: Browser | undefined
try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] })
  const errors: string[] = []
  for (const width of [1280, 390]) {
    for (const variant of variants) {
      const page = await browser.newPage({ deviceScaleFactor: 2 })
      page.setDefaultTimeout(10000)
      page.setDefaultNavigationTimeout(30000)
      page.on('pageerror', (error) => errors.push(error.message))
      // The card needs no server: answer any API request with a 404 (source modules under /src/api pass).
      await page.route('**/api/**', (route) =>
        new URL(route.request().url()).pathname.startsWith('/api/')
          ? route.fulfill({ status: 404, json: {} })
          : route.continue()
      )
      const [theme, appearance] = variant.split(':')
      const label = `${theme}-${appearance}-${width}`
      await page.setViewportSize({ width, height: 900 })
      await page.goto(
        `${server.resolvedUrls!.local[0]!}question-recommended-fixture?theme=${theme}&appearance=${appearance}`
      )
      await page.locator('input[type="radio"]').first().waitFor()

      // One tag on the select option and one on the text suggestion, each with its reason.
      const tags = page.getByText('Recommended', { exact: true })
      assert.equal(await tags.count(), 2, `${label}: two Recommended tags`)
      const option = page.locator('label', { has: page.locator('input[type="radio"]') }).nth(1)
      assert.equal(
        await option.textContent(),
        'Move 10% of teams this week, the rest next weekRecommendedIt limits the impact if a large account finds a problem.',
        `${label}: recommended option text`
      )
      assert.equal(await page.getByText('They run the exports.', { exact: true }).isVisible(), true)

      // Nothing is preselected: no radio is checked and the answer text is empty.
      assert.equal(await page.locator('input[type="radio"]:checked').count(), 0, `${label}: no preselected option`)
      assert.equal(await page.locator('textarea').inputValue(), '', `${label}: empty text answer`)

      // Theme tokens only: the tag resolves to an opaque fill, distinct from its text.
      for (const style of await tags.evaluateAll((elements) =>
        elements.map((element) => {
          const computed = getComputedStyle(element)
          return { background: computed.backgroundColor, color: computed.color }
        })
      )) {
        assert.notEqual(style.background, 'rgba(0, 0, 0, 0)', `${label}: tag fill`)
        assert.notEqual(style.background, style.color, `${label}: tag text differs from its fill`)
      }

      // The tag wraps under a long label rather than widening the card.
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth),
        width,
        `${label}: no sideways scroll`
      )
      const card = (await page.locator('#shot').boundingBox())!
      const tagBox = (await tags.first().boundingBox())!
      assert.ok(tagBox.x + tagBox.width <= card.x + card.width, `${label}: tag fits the card`)

      if (screenshotDir) await page.locator('#shot').screenshot({ path: resolve(screenshotDir, `${label}.png`) })
      await page.close()
    }
  }
  assert.deepEqual(errors, [], 'no page errors')
  console.log(`question recommended check passed: ${variants.length} variants at 1280 and 390 pixels`)
} finally {
  await browser?.close()
  await server.close()
}
