/** DB-free rendered check of the Squads page cards, using the real component and stylesheet.
 * From apps/web: CHROMIUM_PATH=/path/to/chromium bun scripts/check-squad-cards.ts
 * Every built-in theme (light and dark for dual themes) at 1280 and 390 pixels: a work row opens its
 * stream, "+N more" opens the squad's Work tab, the rest of the card opens the squad, and the drag
 * handle stays on top. While the viewer's actions load, each card's placeholders take the same height
 * as its rows ("+N more" included) and an idle squad shows only the footer counts below its description. Optional SCREENSHOT_DIR saves one screenshot per theme, appearance and width;
 * optional THEMES (comma-separated theme ids, for example `ficus,iris`) runs only those themes.
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
const server = await startFixtureServer({ path: '/squad-cards-fixture', entry: '/scripts/fixtures/squad-cards.tsx' })

const onlyThemes = process.env.THEMES?.split(',').map((id) => id.trim())
const variants = BUILT_IN_THEMES.filter((theme) => !onlyThemes || onlyThemes.includes(theme.id)).flatMap((theme) =>
  theme.kind === 'dual' ? [`${theme.id}:light`, `${theme.id}:dark`] : [`${theme.id}:constant`]
)

/** Clicks a point and returns where the app went: the new location, or `/squads` when nothing navigated. */
async function clickAt(page: Page, x: number, y: number) {
  await page.mouse.click(x, y)
  await page
    .waitForFunction(() => document.querySelector('[data-testid="location"]')?.textContent !== '/squads', null, {
      timeout: 1000,
    })
    .catch(() => {})
  return page.getByTestId('location').textContent()
}

/** Each card's work section (rows or placeholders below the description) height. */
function workSectionHeights(page: Page) {
  return page
    .locator('.ficus-panel p.line-clamp-2 + .mb-3')
    .evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().height))
}

let browser: Browser | undefined
try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] })
  const errors: string[] = []
  for (const width of [1280, 390]) {
    for (const variant of variants) {
      // A fresh page per variant keeps the browser's memory flat across the 26 runs.
      const page = await browser.newPage()
      page.setDefaultTimeout(10000)
      page.on('pageerror', (error) => errors.push(error.message))
      const [theme, appearance] = variant.split(':')
      const label = `${theme}-${appearance}-${width}`
      await page.setViewportSize({ width, height: 900 })
      const url = `${server.resolvedUrls!.local[0]!}squad-cards-fixture?theme=${theme}&appearance=${appearance}`
      const load = async () => {
        await page.goto(url)
        await page.getByTestId('squad-card-work-row').first().waitFor()
      }
      await load()

      const product = page.locator('.ficus-panel', { hasText: 'Product Engineering' })
      const rows = product.getByTestId('squad-card-work-row')
      // The viewer's question (#12) and review (#8) lead, then the rest by recent activity, four at most.
      assert.deepEqual(
        await rows.locator('span.truncate').allTextContents(),
        [
          '#8 · Make every payment retry safe',
          '#12 · Retire the old billing export',
          '#1 · Make the first five minutes effortless',
          '#3 · Bring instant search to every workspace',
        ],
        `${label}: row order`
      )
      const research = page.locator('.ficus-panel', { hasText: 'Research' })
      assert.equal(
        await research.locator('p.line-clamp-2 + div').getByText('0 active work streams', { exact: true }).count(),
        1
      )
      assert.equal(await research.getByTestId('squad-card-work-row').count(), 0)

      // Cards stay inside the viewport (long titles truncate rather than widen the card), and rows inside their card.
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth),
        width,
        `${label}: no sideways scroll`
      )
      for (const box of await page
        .locator('.ficus-panel')
        .evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().toJSON()))) {
        assert.ok(box.left >= 0 && box.right <= width, `${label}: card fits the viewport`)
      }
      const card = (await product.boundingBox())!
      for (const box of await rows.evaluateAll((elements) =>
        elements.map((element) => element.getBoundingClientRect().toJSON())
      )) {
        assert.ok(box.left >= card.x && box.right <= card.x + card.width + 0.5, `${label}: row fits the card`)
      }
      if (screenshotDir) await page.screenshot({ path: resolve(screenshotDir, `${label}.png`), fullPage: true })
      const workHeights = await workSectionHeights(page)

      // Theme tokens only: the row marker and badge resolve to colors, and hover fills the row.
      const firstRow = rows.first()
      await firstRow.hover()
      await page.waitForTimeout(200)
      const hover = await firstRow.evaluate((element) => getComputedStyle(element).backgroundColor)
      assert.notEqual(hover, 'rgba(0, 0, 0, 0)', `${label}: row hover fill`)

      // Clicks: a row opens its stream, "+N more" the Work tab, the description and the
      // blank card space the squad; the drag handle navigates nowhere.
      const rowBox = (await rows.nth(1).boundingBox())!
      assert.equal(
        await clickAt(page, rowBox.x + 40, rowBox.y + rowBox.height / 2),
        '/squads/product-engineering/work?ws=12'
      )
      await load()
      const more = product.getByRole('link', { name: '2 more active work streams in Product Engineering' })
      assert.equal(await more.textContent(), '+2 more')
      const moreBox = (await more.boundingBox())!
      assert.equal(
        await clickAt(page, moreBox.x + 4, moreBox.y + moreBox.height / 2),
        '/squads/product-engineering/work'
      )
      await load()
      const description = (await product.getByText('Build a product customers love', { exact: false }).boundingBox())!
      assert.equal(await clickAt(page, description.x + 20, description.y + 5), '/squads/product-engineering')
      await load()
      const footer = (await product.getByText('6 active work streams').boundingBox())!
      assert.equal(await clickAt(page, footer.x + footer.width + 40, footer.y + 4), '/squads/product-engineering')
      await load()
      const handle = (await product.getByRole('button', { name: 'Drag to reorder Product Engineering' }).boundingBox())!
      assert.equal(await clickAt(page, handle.x + handle.width / 2, handle.y + handle.height / 2), '/squads')
      await load()

      // Keyboard: the squad link, then each row, then "+N more", then the drag handle.
      await product.getByRole('link', { name: 'Product Engineering', exact: true }).focus()
      const order: string[] = []
      for (let i = 0; i < 6; i++) {
        await page.keyboard.press('Tab')
        order.push(
          await page.evaluate(() => {
            const element = document.activeElement as HTMLElement
            return element.getAttribute('aria-label') ?? element.getAttribute('href') ?? ''
          })
        )
      }
      assert.deepEqual(order, [
        '/squads/product-engineering/work?ws=8',
        '/squads/product-engineering/work?ws=12',
        '/squads/product-engineering/work?ws=1',
        '/squads/product-engineering/work?ws=3',
        '2 more active work streams in Product Engineering',
        'Drag to reorder Product Engineering',
      ])

      // While the viewer's actions load: placeholders as tall as the rows they stand for, and
      // the idle squad still has no work section.
      await page.goto(`${url}&actions=pending`)
      await product.getByTestId('squad-card-work-placeholder').first().waitFor()
      assert.equal(await product.getByTestId('squad-card-work-placeholder').count(), 4, `${label}: placeholders`)
      assert.equal(
        await research.locator('p.line-clamp-2 + div').getByText('0 active work streams', { exact: true }).count(),
        1
      )
      assert.equal(await research.getByTestId('squad-card-work-placeholder').count(), 0)
      if (screenshotDir) {
        await page.screenshot({ path: resolve(screenshotDir, `${label}-loading.png`), fullPage: true })
      }
      assert.deepEqual(await workSectionHeights(page), workHeights, `${label}: work heights while loading`)

      console.log(`PASS ${label}: order, idle card footer, row fit, hover, clicks, keyboard order and loading heights`)
      await page.close()
    }
  }
  assert.deepEqual(errors, [], 'No browser runtime errors')
} finally {
  await browser?.close()
  await server.close()
}
