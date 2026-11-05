/**
 * Focused, DB-free Chromium check of teammates' typing bubbles in an agent chat, with the real
 * components and stylesheet and made-up messages: the bubbles end the transcript under the latest
 * message and above the composer, stay in view while following the bottom, fit phone widths with
 * many typers, have a surface of their own in light and dark, and bounce only without reduced motion.
 * From apps/web: CHROMIUM_PATH=/path/to/chromium bun scripts/check-teammates-typing-layout.ts
 * Optional SCREENSHOT_DIR saves screenshots (phone and desktop, light and dark, one and several typers).
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

const server = await startFixtureServer({
  path: '/teammates-typing-fixture',
  entry: '/scripts/fixtures/teammates-typing.tsx',
})

/** Layout of the transcript, the latest message, the typing bubbles and the composer. */
function measure(page: Page) {
  return page.evaluate(() => {
    const rect = (el: Element | null) => {
      if (!el) return null
      const { top, bottom, left, right } = el.getBoundingClientRect()
      return { top, bottom, left, right }
    }
    const transcript = document.querySelector<HTMLElement>('[data-testid="chat-messages"]')!
    const indicator = document.querySelector('[data-testid="teammates-typing"]')
    const bubbles = [...document.querySelectorAll('[data-testid="typing-bubble"]')]
    const dots = [...document.querySelectorAll('[data-testid="typing-dot"]')]
    const surface = bubbles[0]?.lastElementChild
    return {
      distanceFromBottom: transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight,
      horizontalOverflow: transcript.scrollWidth - transcript.clientWidth,
      transcript: rect(transcript)!,
      composer: rect(document.querySelector('textarea')!.closest('.border-t'))!,
      lastMessage: rect([...transcript.querySelectorAll('[data-message-id]')].at(-1)!)!,
      indicator: rect(indicator),
      bubbles: bubbles.map((bubble) => ({ ...rect(bubble)!, text: bubble.textContent })),
      more: document.querySelector('[data-testid="typing-more"]')?.textContent ?? null,
      moreTop: rect(document.querySelector('[data-testid="typing-more"]'))?.top ?? null,
      summary: indicator?.querySelector('.sr-only')?.textContent ?? null,
      surface: surface ? getComputedStyle(surface).backgroundColor : null,
      animations: dots.map((dot) => getComputedStyle(dot).animationName),
    }
  })
}

const transparent = (color: string | null) => color === null || color === 'rgba(0, 0, 0, 0)' || color === 'transparent'

let browser: Browser | undefined
try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] })
  const page = await browser.newPage({ hasTouch: true })
  page.setDefaultTimeout(10000)
  page.setDefaultNavigationTimeout(30000)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  // The chat needs no server: answer any API request with a 404 (source modules under /src/api pass).
  await page.route('**/api/**', (route) =>
    new URL(route.request().url()).pathname.startsWith('/api/')
      ? route.fulfill({ status: 404, json: {} })
      : route.continue()
  )

  const surfaces: Record<string, string | null> = {}
  for (const [width, height] of [
    [1280, 620],
    [390, 700],
  ] as const) {
    for (const appearance of ['light', 'dark']) {
      const label = `${width}px ${appearance}`
      await page.emulateMedia({ reducedMotion: 'no-preference' })
      await page.setViewportSize({ width, height })
      await page.goto(`${server.resolvedUrls!.local[0]!}teammates-typing-fixture?appearance=${appearance}`)
      await page.locator('textarea').waitFor()
      await page.waitForTimeout(200)
      assert.equal((await measure(page)).indicator, null, `${label}: a typing bubble shows with nobody typing`)

      // One typer: a bouncing bubble with their name, under the latest message, above the composer, in view.
      await page.evaluate(() => window.setTypers(['Alice']))
      await page.locator('[data-testid="teammates-typing"]').waitFor()
      await page.waitForTimeout(300)
      const one = await measure(page)
      assert.deepEqual(
        one.bubbles.map((bubble) => bubble.text),
        ['Alice'],
        `${label}: one typer`
      )
      assert.equal(one.summary, 'Alice is typing', `${label}: the status line`)
      assert.ok(one.lastMessage.bottom <= one.indicator!.top, `${label}: the bubble overlaps the latest message`)
      assert.ok(one.indicator!.bottom <= one.composer.top, `${label}: the bubble runs under the composer`)
      assert.ok(one.distanceFromBottom <= 1, `${label}: the bubble pushed the transcript off the bottom`)
      assert.ok(!transparent(one.surface), `${label}: the bubble has no surface of its own`)
      surfaces[appearance] = one.surface
      assert.deepEqual(one.animations, Array(3).fill('ficus-typing-dot'), `${label}: the dots do not bounce`)
      if (screenshotDir)
        await page.screenshot({ path: resolve(screenshotDir, `typing-one-${width}-${appearance}.png`) })

      // Several at once: stacked like separate messages, two bubbles then "+3", within the transcript even on a phone.
      await page.evaluate(() => window.setTypers(['Alice', 'Bob Fitzgerald-Montgomery', 'Carol', 'Dan', 'Eve']))
      await page.waitForTimeout(300)
      const several = await measure(page)
      assert.deepEqual(
        several.bubbles.map((bubble) => bubble.text),
        ['Alice', 'Bob Fitzgerald-Montgomery'],
        `${label}: several typers`
      )
      assert.equal(several.more, '+3', `${label}: the bubble for everyone else`)
      for (let index = 1; index < several.bubbles.length; index++)
        assert.ok(
          several.bubbles[index]!.top >= several.bubbles[index - 1]!.bottom,
          `${label}: the bubbles are not stacked one under another`
        )
      assert.ok(several.moreTop! >= several.bubbles.at(-1)!.bottom, `${label}: "+3" is not under the other bubbles`)
      assert.equal(
        several.summary,
        'Alice, Bob Fitzgerald-Montgomery and 3 others are typing',
        `${label}: the status line`
      )
      assert.ok(several.horizontalOverflow <= 0, `${label}: the bubbles overflow the transcript sideways`)
      for (const bubble of several.bubbles)
        assert.ok(
          bubble.left >= several.transcript.left && bubble.right <= several.transcript.right,
          `${label}: a bubble sticks out of the transcript`
        )
      assert.ok(several.indicator!.bottom <= several.composer.top, `${label}: the bubbles run under the composer`)
      assert.ok(several.distanceFromBottom <= 1, `${label}: the bubbles pushed the transcript off the bottom`)
      if (screenshotDir)
        await page.screenshot({ path: resolve(screenshotDir, `typing-several-${width}-${appearance}.png`) })

      // Reduced motion: the dots stay still.
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await page.waitForTimeout(100)
      const still = await measure(page)
      assert.ok(
        still.animations.length > 0 && still.animations.every((name) => name === 'none'),
        `${label}: the dots bounce with reduced motion`
      )

      // Everyone stopped: the bubbles go.
      await page.evaluate(() => window.setTypers([]))
      await page.waitForTimeout(100)
      assert.equal((await measure(page)).indicator, null, `${label}: the bubbles stay after everyone stopped`)
    }
  }
  assert.notEqual(surfaces.light, surfaces.dark, 'the bubble looks the same in light and dark')
  assert.deepEqual(errors, [])
  console.log('Passed: teammates typing ends the transcript above the composer, at 1280 and 390px, light and dark.')
} finally {
  await browser?.close()
  await server.close()
}
