/** DB-free Chromium check of the in-app Needs-you notices in every built-in theme and appearance:
 * the cards render from theme tokens with readable text, sit at the top right, take no motion under
 * reduced motion, and are reachable and dismissible by keyboard.
 * CHROMIUM_PATH=/path/to/chromium bun apps/web/scripts/check-needs-you-notifications.ts
 * SCREENSHOT_DIR optionally saves one view per theme and appearance.
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Browser } from 'playwright-core'
import { startFixtureServer } from './fixture-server'
import { BUILT_IN_THEMES } from '../src/theme/registry'

const { chromium } = createRequire(resolve(import.meta.dir, '../../core/package.json'))(
  'playwright-core'
) as typeof import('playwright-core')

function luminance([r, g, b]: number[]): number {
  const [lr, lg, lb] = [r!, g!, b!].map((channel) => {
    const c = channel / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * lr! + 0.7152 * lg! + 0.0722 * lb!
}
function contrast(a: number[], b: number[]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi! + 0.05) / (lo! + 0.05)
}

const server = await startFixtureServer({
  path: '/needs-you-fixture',
  entry: '/scripts/fixtures/needs-you-notifications.tsx',
})
let browser: Browser | undefined
try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] })
  const screenshotDir = process.env.SCREENSHOT_DIR
  if (screenshotDir) await mkdir(screenshotDir, { recursive: true })
  const views = BUILT_IN_THEMES.flatMap((theme) =>
    theme.kind === 'dual'
      ? (['light', 'dark'] as const).map((appearance) => ({ theme: theme.id, appearance }))
      : [{ theme: theme.id, appearance: 'constant' as const }]
  )
  for (const view of views) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 640 }, reducedMotion: 'reduce' })
    page.setDefaultTimeout(5000)
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.on(
      'console',
      (message) =>
        message.type() === 'error' &&
        !message.text().startsWith('Failed to load resource') &&
        errors.push(message.text())
    )
    // The fixture page has no favicon; any other missing resource is a failure.
    page.on('response', (response) => {
      if (response.status() === 404 && !new URL(response.url()).pathname.endsWith('/favicon.ico'))
        errors.push(`404 ${response.url()}`)
    })
    await page.goto(
      `${server.resolvedUrls!.local[0]!}needs-you-fixture?theme=${view.theme}&appearance=${view.appearance}`
    )
    const cards = page.getByTestId('needs-you-notice')
    await cards.nth(1).waitFor()
    const label = `${view.theme}/${view.appearance}`

    const facts = await cards.evaluateAll((elements) =>
      elements.map((element) => {
        const rgb = (value: string) => (value.match(/[\d.]+/g) ?? []).slice(0, 4).map(Number)
        const style = getComputedStyle(element)
        const box = element.getBoundingClientRect()
        const text = (selector: string) => {
          const node = element.querySelector(selector)
          return node ? rgb(getComputedStyle(node).color) : null
        }
        return {
          background: rgb(style.backgroundColor),
          animation: style.animationName,
          right: window.innerWidth - box.right,
          top: box.top,
          headline: element.querySelector('.font-medium')?.textContent,
          headlineColor: text('.font-medium'),
          detailColor: text('.text-secondary'),
          mutedColor: text('.text-muted'),
        }
      })
    )
    assert.deepEqual(
      facts.map((fact) => fact.headline),
      ['Payments Engineer has a question', 'Payments Engineer requests review'],
      `${label}: newest first`
    )
    assert.ok(facts[0]!.top < 120, `${label}: newest card at the top`)
    for (const fact of facts) {
      assert.ok(fact.background.length >= 3 && (fact.background[3] ?? 1) > 0.9, `${label}: opaque card surface`)
      assert.equal(fact.animation, 'none', `${label}: no entrance motion under reduced motion`)
      assert.ok(fact.right >= 8 && fact.right <= 16, `${label}: right edge`)
      assert.ok(contrast(fact.headlineColor!, fact.background) >= 4.5, `${label}: headline contrast`)
      assert.ok(contrast(fact.mutedColor!, fact.background) >= 4.5, `${label}: muted text contrast`)
      if (fact.detailColor) assert.ok(contrast(fact.detailColor, fact.background) >= 4.5, `${label}: detail contrast`)
    }
    if (screenshotDir)
      await page.screenshot({ path: resolve(screenshotDir, `needs-you-${view.theme}-${view.appearance}.png`) })

    // Keyboard: Tab reaches the first card's open button, then its close button; Escape dismisses.
    await page.keyboard.press('Tab')
    assert.equal(
      await page.evaluate(() => document.activeElement?.closest('[data-testid="needs-you-notice"]') !== null),
      true,
      `${label}: Tab reaches a notice`
    )
    await page.keyboard.press('Escape')
    await assert.doesNotReject(async () => {
      await page.waitForFunction(() => document.querySelectorAll('[data-testid="needs-you-notice"]').length === 1)
    }, `${label}: Escape dismisses the focused notice`)
    assert.deepEqual(errors, [], `${label}: no page errors`)
    await page.close()
    console.log(`ok ${label}`)
  }
} finally {
  await browser?.close()
  await server.close()
}
