/**
 * Focused, DB-free Chromium check of the one-tap reply suggestions in an agent chat, with the real
 * components and stylesheet and made-up messages: the chips float over the end of the transcript with
 * no strip of their own, the latest message is never hidden behind them, the transcript stays at the
 * bottom when they appear, and scrolled up the messages show (and take clicks) around them.
 * From apps/web: CHROMIUM_PATH=/path/to/chromium bun scripts/check-reply-suggestions-layout.ts
 * Optional SCREENSHOT_DIR saves screenshots (phone and desktop, light and dark, at the bottom and scrolled up).
 * Uses Core's declared playwright-core dependency, without loading any Core test setup.
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createServer } from 'vite'
import type { Browser, Page } from 'playwright-core'

const root = resolve(import.meta.dir, '..')
const { chromium } = createRequire(resolve(root, '../core/package.json'))(
  'playwright-core'
) as typeof import('playwright-core')
const screenshotDir = process.env.SCREENSHOT_DIR
if (screenshotDir) await mkdir(screenshotDir, { recursive: true })

const server = await createServer({
  configFile: false,
  root,
  server: { host: '127.0.0.1', port: 0 },
  esbuild: { jsx: 'automatic' },
  plugins: [
    {
      configureServer(server) {
        server.middlewares.use('/reply-suggestions-fixture', (_req, res) => {
          res.setHeader('Content-Type', 'text/html')
          res.end(
            '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/scripts/fixtures/reply-suggestions.tsx"></script></body></html>'
          )
        })
      },
    },
  ],
})

/** Layout of the chat's transcript, the latest message, the replies and the composer. */
function measure(page: Page) {
  return page.evaluate(() => {
    const rect = (el: Element | null) => {
      if (!el) return null
      const { top, bottom, left, right } = el.getBoundingClientRect()
      return { top, bottom, left, right }
    }
    const transcript = document.querySelector<HTMLElement>('[data-testid="chat-messages"]')!
    const group = document.querySelector<HTMLElement>('[role="group"][aria-label="Suggested replies"]')
    const chips = [...(group?.querySelectorAll('button') ?? [])]
    const messages = [...transcript.querySelectorAll('[data-message-id]')]
    const slot = document.querySelector('[data-testid="chat-sticky-after-messages"]')
    return {
      distanceFromBottom: transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight,
      overflows: transcript.scrollHeight > transcript.clientHeight + 40,
      transcript: rect(transcript)!,
      composer: rect(document.querySelector('textarea')!.closest('.border-t'))!,
      lastMessage: rect(messages.at(-1)!)!,
      messages: messages.map((message) => rect(message)!),
      chips: chips.map(rect),
      group: group && { ...rect(group)!, scrollWidth: group.scrollWidth, clientWidth: group.clientWidth },
      strip: Boolean(document.querySelector('[data-testid="chat-before-composer"]')),
      backgrounds: [slot, group].map((el) => (el ? getComputedStyle(el).backgroundColor : null)),
      chipStyle: chips[0] && {
        background: getComputedStyle(chips[0]).backgroundColor,
        shadow: getComputedStyle(chips[0]).boxShadow,
      },
    }
  })
}

const transparent = (color: string | null) => color === null || color === 'rgba(0, 0, 0, 0)' || color === 'transparent'

let browser: Browser | undefined
try {
  await server.listen()
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] })
  const page = await browser.newPage({ hasTouch: true })
  page.setDefaultTimeout(10000)
  page.setDefaultNavigationTimeout(30000)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  // The chat needs no server: answer any API request with a 404 (source modules under /src/api pass).
  await page.route('**/api/**', (route) =>
    new URL(route.request().url()).pathname.startsWith('/api/')
      ? route.fulfill({ status: 404, json: {} })
      : route.continue()
  )

  const results: unknown[] = []
  for (const [width, height] of [
    [1280, 620],
    [390, 700],
  ] as const) {
    for (const appearance of ['light', 'dark']) {
      const label = `${width}px ${appearance}`
      await page.setViewportSize({ width, height })
      await page.goto(`${server.resolvedUrls!.local[0]!}reply-suggestions-fixture?appearance=${appearance}`)
      await page.getByRole('group', { name: 'Suggested replies' }).waitFor()
      await page.waitForTimeout(300)

      // At the bottom: the chips end the transcript, under the latest message and above the composer.
      const bottom = await measure(page)
      results.push({ label, bottom: { ...bottom, messages: undefined } })
      assert.ok(bottom.overflows, `${label}: the fixture transcript must scroll`)
      assert.ok(bottom.distanceFromBottom <= 1, `${label}: the transcript is not at the bottom`)
      assert.equal(bottom.strip, false, `${label}: the replies sit in a strip above the composer`)
      for (const color of bottom.backgrounds) assert.ok(transparent(color), `${label}: the replies have a backdrop`)
      assert.ok(!transparent(bottom.chipStyle!.background), `${label}: a chip has no surface of its own`)
      assert.notEqual(bottom.chipStyle!.shadow, 'none', `${label}: a chip has no shadow`)
      const firstChip = bottom.chips[0]!
      assert.ok(bottom.lastMessage.bottom <= firstChip.top, `${label}: the latest message runs under the replies`)
      const lastChip = bottom.chips.at(-1)!
      // Flush with the messages' right edge, inside the transcript's padding (12px, 16px from md).
      const inset = bottom.transcript.right - lastChip.right
      assert.ok(inset === (width >= 768 ? 16 : 12), `${label}: the replies are ${inset}px from the right edge`)
      // About 8px above the composer, as in the old strip: not touching it, not floating high above it.
      const gap = bottom.composer.top - lastChip.bottom
      assert.ok(gap >= 6 && gap <= 10, `${label}: the replies are ${gap}px above the composer, not about 8px`)
      if (screenshotDir) await page.screenshot({ path: resolve(screenshotDir, `replies-${width}-${appearance}.png`) })

      // Scrolled up: the chips stay pinned over the messages, which show (and take clicks) around them.
      await page.locator('[data-testid="chat-messages"]').evaluate((el) => {
        el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight - 120)
      })
      await page.waitForTimeout(200)
      const scrolled = await measure(page)
      results.push({ label, scrolled: { ...scrolled, messages: undefined } })
      const pinned = scrolled.chips[0]!
      assert.ok(Math.abs(pinned.bottom - firstChip.bottom) <= 1, `${label}: the replies did not stay pinned`)
      assert.ok(
        scrolled.messages.some((message) => message.top < pinned.bottom && message.bottom > pinned.top),
        `${label}: nothing scrolls under the replies`
      )
      const beside = await page.evaluate(
        ({ x, y }) => document.elementFromPoint(x, y)?.closest('[data-message-id]') != null,
        { x: scrolled.transcript.left + 24, y: (pinned.top + pinned.bottom) / 2 }
      )
      assert.ok(beside, `${label}: the messages beside the replies are covered`)
      const onChip = await page.evaluate(
        ({ x, y }) => document.elementFromPoint(x, y)?.closest('button')?.textContent,
        { x: (pinned.left + pinned.right) / 2, y: (pinned.top + pinned.bottom) / 2 }
      )
      assert.equal(onChip, 'Yes, start it', `${label}: a reply does not take clicks`)
      if (screenshotDir) {
        await page.screenshot({ path: resolve(screenshotDir, `replies-${width}-${appearance}-scrolled.png`) })
      }

      // Replies appearing while following the bottom keep the latest message in view above them.
      await page.locator('[data-testid="chat-messages"]').evaluate((el) => {
        el.scrollTop = el.scrollHeight
      })
      await page.evaluate(() => window.setReplies([]))
      await page.waitForTimeout(200)
      await page.evaluate(() => window.setReplies(['Yes, start it', 'Not now', 'Explain the replay first']))
      await page.waitForTimeout(300)
      const reappeared = await measure(page)
      assert.ok(reappeared.distanceFromBottom <= 1, `${label}: new replies pushed the transcript off the bottom`)
      assert.ok(reappeared.lastMessage.bottom <= reappeared.chips[0]!.top, `${label}: new replies hide the message`)
    }
  }

  // On a phone, more replies than fit scroll sideways from the first one.
  await page.setViewportSize({ width: 360, height: 700 })
  await page.goto(`${server.resolvedUrls!.local[0]!}reply-suggestions-fixture?appearance=light`)
  await page.getByRole('group', { name: 'Suggested replies' }).waitFor()
  await page.evaluate(() =>
    window.setReplies(['Yes, start it now', 'Not now, maybe tomorrow', 'Explain the replay first', 'Something else'])
  )
  await page.waitForTimeout(300)
  const narrow = await measure(page)
  results.push({ label: '360px overflowing replies', narrow })
  assert.ok(narrow.group!.scrollWidth > narrow.group!.clientWidth, '360px: the replies should overflow')
  assert.ok(narrow.chips[0]!.left >= narrow.group!.left, '360px: the first reply is out of reach')
  if (screenshotDir) await page.screenshot({ path: resolve(screenshotDir, 'replies-360-overflow.png') })
  // The group passes clicks through, yet sideways scrolling over a chip still scrolls the replies.
  const chip = narrow.chips[0]!
  await page.mouse.move((chip.left + chip.right) / 2, (chip.top + chip.bottom) / 2)
  await page.mouse.wheel(200, 0)
  await page.waitForTimeout(300)
  const scrolledLeft = await page.getByRole('group', { name: 'Suggested replies' }).evaluate((el) => el.scrollLeft)
  assert.ok(scrolledLeft > 0, '360px: the replies do not scroll sideways under the pointer')

  assert.deepEqual(errors, [], 'No browser runtime errors')
  console.log(JSON.stringify(results, null, 2))
  console.log('Passed: the replies float over the transcript without hiding it, at 1280 and 390px, light and dark.')
} finally {
  await browser?.close()
  await server.close()
}
