/** DB-free rendered check of the squad header chips and work stream times, using the real squad page.
 * From apps/web: CHROMIUM_PATH=/path/to/chromium bun scripts/check-squad-home-clarity.ts
 * Every built-in theme (light and dark for dual themes): the workspace chip names its subject and an
 * unprovisioned workspace reads as neutral rather than a warning, the bell chip reads as a
 * notification setting, streams waiting on a person show how long instead of time worked, and the
 * detail modal shows both. Optional SCREENSHOT_DIR saves the page and the modal per theme and
 * appearance; optional THEMES (comma-separated theme ids, for example `ficus,iris`) runs only those.
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
  path: '/squad-home-clarity-fixture',
  entry: '/scripts/fixtures/squad-home-clarity.tsx',
})

const onlyThemes = process.env.THEMES?.split(',').map((id) => id.trim())
const variants = BUILT_IN_THEMES.filter((theme) => !onlyThemes || onlyThemes.includes(theme.id)).flatMap((theme) =>
  theme.kind === 'dual' ? [`${theme.id}:light`, `${theme.id}:dark`] : [`${theme.id}:constant`]
)

/** The text of one stream row's time, by stream title, including its screen reader prefix. */
async function rowTime(page: Page, title: string) {
  const row = page.locator('li', { hasText: title }).first()
  return ((await row.getByTestId('work-stream-time').first().textContent()) ?? '').trim()
}

let browser: Browser | undefined
try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] })
  const errors: string[] = []
  for (const variant of variants) {
    const [theme, appearance] = variant.split(':')
    const label = `${theme}-${appearance}`
    const base = `${server.resolvedUrls!.local[0]!}squad-home-clarity-fixture?theme=${theme}&appearance=${appearance}`
    const page = await browser.newPage()
    page.setDefaultTimeout(10000)
    page.on('pageerror', (error) => errors.push(`${label}: ${error.message}`))
    await page.setViewportSize({ width: 1280, height: 760 })

    await page.goto(base)
    const chip = page.getByText('Workspace not started', { exact: true })
    await chip.waitFor()
    // Neutral, not the attention (warning) treatment it had when an unstarted workspace read as an error.
    const pill = chip.locator('xpath=..')
    const pillClass = (await pill.getAttribute('class')) ?? ''
    assert.ok(!pillClass.includes('attention'), `${label}: workspace chip still uses the attention treatment`)
    assert.equal(await pill.locator('.bg-status-neutral-solid').count(), 1, `${label}: neutral marker missing`)
    const colors = await pill.evaluate((element) => {
      const style = getComputedStyle(element)
      return { text: style.color, background: style.backgroundColor }
    })
    assert.notEqual(colors.text, colors.background, `${label}: workspace chip text matches its background`)

    const bell = page.locator('.attention-menu summary').first()
    assert.equal((await bell.innerText()).trim(), 'Notifications: Show', `${label}: bell chip label`)

    assert.equal(await rowTime(page, 'Make every payment retry safe'), 'Waiting on you 7d', `${label}: review row`)
    assert.equal(
      await rowTime(page, 'Make the first five minutes effortless'),
      'Waiting on you 1d',
      `${label}: question row`
    )
    const working = await rowTime(page, 'Bring instant search to every workspace')
    assert.match(working, /^Time worked 3h [56]m$/, `${label}: working row`)
    if (screenshotDir) await page.screenshot({ path: resolve(screenshotDir, `home-${label}.png`) })

    await page.goto(`${base}&ws=ws-2`)
    const dialog = page.getByRole('dialog')
    await dialog.getByText('Time worked', { exact: true }).waitFor()
    assert.equal(await dialog.getByText('Waiting on you', { exact: true }).count(), 1, `${label}: modal waiting field`)
    assert.equal(await dialog.getByText('Runtime', { exact: true }).count(), 0, `${label}: modal still says Runtime`)
    if (screenshotDir) await page.screenshot({ path: resolve(screenshotDir, `modal-${label}.png`) })
    await page.close()
  }
  assert.deepEqual(errors, [])
  console.log(`squad home clarity: ${variants.length} theme variants passed`)
} finally {
  await browser?.close()
  await server.close()
}
