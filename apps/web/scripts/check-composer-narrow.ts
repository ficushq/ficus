/**
 * Focused, DB-free Chromium check that a chat composer follows its own width, not the viewport's, with
 * the real components and stylesheet and made-up messages, in a wide (1440px) viewport:
 * - a floating agent window or side panel narrower than COMPOSER_COLLAPSE_WIDTH folds the action
 *   buttons behind one options trigger, as phones do; wider composers keep them inline;
 * - at every width, Send, Stop, the Interrupt / Follow up split button and the context indicator sit
 *   fully inside the composer and never under another control (a busy turn wraps them to a new line);
 * - the trigger opens the shared menu (arrow keys, Escape and focus return) with every action as a
 *   labelled row, including the window's own "Open full page";
 * - the window title bar truncates a long agent name in a narrow window, keeps its four buttons whole, and links the
 *   squad name to the squad's Home;
 * - on a phone-sized viewport the trigger still opens the bottom sheet.
 * From apps/web: CHROMIUM_PATH=/path/to/chromium bun scripts/check-composer-narrow.ts
 * Optional SCREENSHOT_DIR saves screenshots of each width, idle and busy, light and dark, and the menu.
 * Uses Core's declared playwright-core dependency, without loading any Core test setup.
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { startFixtureServer } from './fixture-server'

/** The composer width below which its actions fold away; ResponsiveChat.css says 30rem. */
const COMPOSER_COLLAPSE_WIDTH = 480

const root = resolve(import.meta.dir, '..')
const { chromium } = createRequire(resolve(root, '../core/package.json'))(
  'playwright-core'
) as typeof import('playwright-core')
const screenshotDir = process.env.SCREENSHOT_DIR
if (screenshotDir) await mkdir(screenshotDir, { recursive: true })

const server = await startFixtureServer({
  path: '/composer-narrow-fixture',
  entry: '/scripts/fixtures/composer-narrow.tsx',
})

type Box = { left: number; right: number; top: number; bottom: number; width: number }

/** The composer's geometry: which controls show, and whether any of them overlap or spill out. */
function measure(page: Page, scope: string) {
  return page.evaluate((scope) => {
    const container = document.querySelector(scope)!
    const form = container.querySelector<HTMLFormElement>('form.chat-composer')!
    const box = (el: Element): Box => {
      const r = el.getBoundingClientRect()
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width }
    }
    const shown = (el: Element | null): el is HTMLElement =>
      !!el && (el as HTMLElement).offsetParent !== null && el.getBoundingClientRect().width > 0
    const actions = form.querySelector('.chat-composer-actions')!
    const trigger = form.querySelector('.chat-composer-attach')!
    const send = form.querySelector('.chat-composer-send')!
    const context = form.querySelector('[aria-label^="Context "]')
    // Every control a person can press in the row, each as its own box.
    const controls = [
      ...(shown(trigger) ? [trigger] : []),
      ...(shown(actions) ? [...actions.querySelectorAll('button')] : []),
      ...(shown(context) ? [context] : []),
      ...send.querySelectorAll('button'),
    ].filter(shown)
    const boxes = controls.map((el) => ({ name: el.getAttribute('aria-label') ?? el.textContent ?? '', ...box(el) }))
    const overlaps: string[] = []
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]!
        const b = boxes[j]!
        if (send.contains(controls[i]!) && send.contains(controls[j]!)) continue
        const x = Math.min(a.right, b.right) - Math.max(a.left, b.left)
        const y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
        if (x > 0.5 && y > 0.5) overlaps.push(`${a.name} / ${b.name}`)
      }
    const formBox = box(form)
    const outside = boxes.filter((b) => b.left < formBox.left - 0.5 || b.right > formBox.right + 0.5).map((b) => b.name)
    return {
      composerWidth: formBox.width,
      collapsed: shown(trigger),
      actionsShown: shown(actions),
      contextShown: shown(context),
      sendShown: shown(send),
      overlaps,
      outside,
      rows: new Set(boxes.filter((b) => send.contains(controls[boxes.indexOf(b)]!)).map((b) => Math.round(b.top))).size,
      sendTop: box(send).top,
      // The row's leading group (the trigger or actions, and the status); Send below it has wrapped.
      leadBottom: box(send.previousElementSibling!).bottom,
    }
  }, scope)
}

/** The floating window's title bar: truncation, the window buttons, and the squad link. */
function measureHeader(page: Page) {
  return page.evaluate(() => {
    const header = document.querySelector('[data-floating-window] header')!
    const headerBox = header.getBoundingClientRect()
    const title = header.querySelector<HTMLElement>('span.truncate.text-sm')!
    const buttons = [...header.querySelectorAll<HTMLElement>('button')].map((el) => {
      const r = el.getBoundingClientRect()
      return { label: el.getAttribute('aria-label'), width: r.width, inside: r.right <= headerBox.right + 0.5 }
    })
    const link = header.querySelector<HTMLAnchorElement>('a')
    const firstButton = header.querySelector('button')!.getBoundingClientRect()
    return {
      titleTruncated: title.scrollWidth > title.clientWidth,
      titleClear: title.getBoundingClientRect().right <= firstButton.left + 0.5,
      buttons,
      link: link && {
        text: link.textContent,
        href: link.getAttribute('href'),
        width: link.getBoundingClientRect().width,
      },
    }
  })
}

let browser: Browser | undefined
try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] })
  const page = await browser.newPage()
  page.setDefaultTimeout(10000)
  page.setDefaultNavigationTimeout(30000)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  // The chat needs no server: any API request gets a 404 (source modules under /src/api pass).
  await page.route('**/api/**', (route) => {
    const { pathname } = new URL(route.request().url())
    if (!pathname.startsWith('/api/')) return route.continue()
    return route.fulfill({ status: 404, json: {} })
  })
  const url = (query: string) => `${server.resolvedUrls!.local[0]!}composer-narrow-fixture?${query}`
  const shot = async (name: string) => {
    if (screenshotDir) await page.screenshot({ path: resolve(screenshotDir, `${name}.png`) })
  }
  const open = async (query: string) => {
    await page.goto(url(query))
    await page.locator('textarea').first().waitFor()
    await page.waitForTimeout(250)
  }
  const report: string[] = []

  await page.setViewportSize({ width: 1440, height: 720 })
  for (const appearance of ['dark', 'light']) {
    for (const [layout, widths] of [
      ['window', [340, 420, 520, 720]],
      ['panel', [400, 560]],
    ] as const) {
      for (const width of widths) {
        for (const busy of [false, true]) {
          const label = `${layout}-${width}${busy ? '-busy' : ''}-${appearance}`
          await open(`layout=${layout}&w=${width}&appearance=${appearance}${busy ? '&busy=1' : ''}`)
          const scope = layout === 'window' ? '[data-floating-window]' : '[data-testid="side-panel"]'
          const m = await measure(page, scope)
          report.push(
            `${label}: composer ${m.composerWidth.toFixed(0)}px, ${m.collapsed ? 'folded' : 'inline'}, send rows ${m.rows}, ${m.sendTop >= m.leadBottom ? 'send wrapped' : 'one line'}`
          )
          const narrow = m.composerWidth < COMPOSER_COLLAPSE_WIDTH
          assert.equal(m.collapsed, narrow, `${label}: folded=${m.collapsed} at ${m.composerWidth}px`)
          assert.equal(m.actionsShown, !narrow, `${label}: inline actions shown=${m.actionsShown}`)
          assert.ok(m.contextShown, `${label}: the context indicator is hidden`)
          assert.ok(m.sendShown, `${label}: the send controls are hidden`)
          assert.deepEqual(m.overlaps, [], `${label}: controls overlap`)
          assert.deepEqual(m.outside, [], `${label}: controls spill outside the composer`)
          if (layout === 'window') {
            const header = await measureHeader(page)
            // The long agent name truncates in narrow windows, and never runs under the buttons.
            if (width <= 420) assert.ok(header.titleTruncated, `${label}: the long agent name is not truncated`)
            assert.ok(header.titleClear, `${label}: the agent name runs under the title bar buttons`)
            assert.equal(header.buttons.length, 4, `${label}: expected four title bar buttons`)
            for (const button of header.buttons) {
              assert.equal(button.width, 32, `${label}: ${button.label} is squeezed`)
              assert.ok(button.inside, `${label}: ${button.label} spills out of the title bar`)
            }
            assert.deepEqual(
              { text: header.link?.text, href: header.link?.href },
              { text: 'Ficus', href: '/squads/ficus' },
              `${label}: the squad name is not a link to its Home`
            )
          }
          await page.mouse.move(1400, 700)
          await shot(label)
        }
      }
    }

    // A wide page composer keeps every action inline, as before.
    await open(`layout=page&appearance=${appearance}`)
    const wide = await measure(page, 'body')
    assert.equal(wide.collapsed, false, `page ${appearance}: a wide composer folded its actions`)
    assert.deepEqual(wide.overlaps, [], `page ${appearance}: controls overlap`)
    report.push(`page-1440-${appearance}: composer ${wide.composerWidth.toFixed(0)}px, inline`)
    await shot(`page-1440-${appearance}`)
  }

  // The options menu in a narrow window: every action as a row, arrows, Escape and focus return.
  await open('layout=window&w=340&appearance=dark')
  const trigger = page.locator('[data-floating-window] button.chat-composer-attach')
  assert.equal(await trigger.getAttribute('aria-haspopup'), 'menu')
  await trigger.click()
  const menu = page.getByRole('menu', { name: 'Chat options' })
  await menu.waitFor()
  await page.waitForTimeout(250)
  const rows = await menu.getByRole('menuitem').allInnerTexts()
  assert.deepEqual(rows, [
    'Attach image',
    'Attach file',
    'Voice message',
    'Auto-scroll on',
    'Show raw text',
    'Search this conversation',
    'Open full page',
  ])
  const menuBox = (await menu.boundingBox())!
  assert.ok(menuBox.y >= 0 && menuBox.y + menuBox.height <= 720, 'the menu leaves the viewport')
  const focused = () => page.evaluate(() => document.activeElement?.textContent ?? '')
  assert.equal(await focused(), 'Attach image')
  await page.keyboard.press('ArrowDown')
  assert.equal(await focused(), 'Attach file')
  await shot('window-340-menu-dark')
  await page.keyboard.press('Escape')
  await menu.waitFor({ state: 'hidden' })
  assert.equal(
    await page.evaluate(() => document.activeElement?.classList.contains('chat-composer-attach')),
    true,
    'Escape did not return focus to the options trigger'
  )
  // Search from the menu opens the panel with its input focused.
  await trigger.click()
  await menu.getByRole('menuitem', { name: 'Search this conversation' }).click()
  await page.locator('[data-testid="chat-history-search"]').waitFor()
  await page.waitForTimeout(150)
  assert.equal(
    await page.evaluate(() => document.activeElement?.getAttribute('aria-label')),
    'Search this conversation',
    'the search input does not have focus after opening from the menu'
  )
  await page.keyboard.press('Escape')
  await page.locator('[data-testid="chat-history-search"]').waitFor({ state: 'detached' })
  await page.waitForTimeout(150)
  assert.equal(
    await page.evaluate(() => document.activeElement?.classList.contains('chat-composer-attach')),
    true,
    'closing search did not return focus to the options trigger'
  )

  // The squad link takes the app to the squad's Home; the window stays open.
  await page.locator('[data-floating-window] header a').click()
  await page.waitForTimeout(100)
  assert.equal(await page.locator('[data-floating-window]').count(), 1, 'following the squad link closed the window')

  // Phones keep the bottom sheet.
  await page.setViewportSize({ width: 390, height: 720 })
  await open('layout=page&appearance=dark')
  const phone = await measure(page, 'body')
  assert.equal(phone.collapsed, true, 'phone: the actions did not fold')
  const phoneTrigger = page.locator('button.chat-composer-attach')
  assert.equal(await phoneTrigger.getAttribute('aria-haspopup'), 'dialog')
  await phoneTrigger.click()
  await page.getByRole('dialog', { name: 'More controls' }).waitFor()
  assert.equal(await page.getByRole('menu', { name: 'Chat options' }).count(), 0, 'phone: the menu opened')
  await page.waitForTimeout(300)
  await shot('phone-390-sheet-dark')

  assert.deepEqual(errors, [], 'page errors')
  console.log(report.join('\n'))
  console.log('composer narrow-container check passed')
} finally {
  await browser?.close()
  await server.close()
}
