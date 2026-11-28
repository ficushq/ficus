/** DB-free Chromium layout regression. The fixture varies visualViewport, not the layout viewport.
 * From apps/web: CHROMIUM_PATH=/path/to/chromium bun scripts/check-mobile-keyboard.ts
 * Optional SCREENSHOT_DIR writes keyboard-open/closed pairs, cropped to the simulated visible area.
 */
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import type { Browser, Locator } from 'playwright-core'
import { startFixtureServer } from './fixture-server'

const { chromium } = createRequire(resolve(import.meta.dir, '../../core/package.json'))(
  'playwright-core'
) as typeof import('playwright-core')
const screenshotDir = process.env.SCREENSHOT_DIR
if (screenshotDir) await mkdir(screenshotDir, { recursive: true })
const server = await startFixtureServer({ path: '/keyboard', entry: '/scripts/fixtures/mobile-keyboard.tsx' })
let browser: Browser | undefined
try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] })
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  page.setDefaultTimeout(5000)
  page.setDefaultNavigationTimeout(30000)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const errors: string[] = []
  page.on('pageerror', (error) => {
    errors.push(error.message)
    console.error(error)
  })
  await page.route('**/api/**', (route) =>
    new URL(route.request().url()).pathname.startsWith('/api/')
      ? route.fulfill({ json: route.request().url().includes('ticket') ? { ticket: 'fixture-ticket' } : [] })
      : route.continue()
  )
  await page.addInitScript(() => {
    // Keep the real viewport's other properties and its event target in place.
    const viewport = window.visualViewport!
    let keyboardHeight: number | null = null
    Object.defineProperty(viewport, 'height', { get: () => keyboardHeight ?? innerHeight })
    window.addEventListener('fixture-keyboard', (event) => {
      keyboardHeight = (event as CustomEvent<number | null>).detail
      performance.mark('fixture-keyboard-resize')
      viewport.dispatchEvent(new Event('resize'))
    })
  })
  const open = async (view: string) => page.goto(`${server.resolvedUrls!.local[0]!}keyboard?view=${view}`)
  const shell = page.getByTestId('app-shell')
  const keyboard = async (height: number | null) => {
    await page.evaluate((detail) => window.dispatchEvent(new CustomEvent('fixture-keyboard', { detail })), height)
    assert.equal(await shell.evaluate((node) => node.clientHeight), height ?? page.viewportSize()!.height)
  }
  const shot = async (name: string) => {
    if (!screenshotDir) return
    const { width } = page.viewportSize()!
    const height = await shell.evaluate((node) => node.clientHeight)
    await page.screenshot({ path: resolve(screenshotDir, `${name}.png`), clip: { x: 0, y: 0, width, height } })
  }
  const focused = (node: Locator) => node.evaluate((el) => el === document.activeElement)
  const box = async (node: Locator) => (await node.boundingBox())!
  const cdp = await page.context().newCDPSession(page)
  const swipe = async (x: number, y: number, distance: number) => {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
    for (const portion of [0.2, 0.44, 0.68, 1]) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + distance * portion }] })
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  }
  for (const view of ['settings', 'squad', 'activity']) {
    await open(view)
    const trigger = page.getByRole('button', {
      name: view === 'activity' ? /^Active work,/ : 'Choose settings section',
    })
    const panel = page.getByRole(view === 'activity' ? 'dialog' : 'region', {
      name: view === 'activity' ? 'Active work streams' : 'Settings sections',
    })
    const search = panel.getByLabel(view === 'activity' ? 'Search active work' : 'Search settings')
    await trigger.tap()
    assert.ok(await focused(search), `${view}: search did not autofocus`)
    const anchored = await box(panel)
    assert.ok(anchored.y > 20, `${view}: picker is not anchored with the keyboard closed`)
    await shot(`${view}-picker-closed`)
    const query = view === 'activity' ? 'Release' : view === 'squad' ? 'squad' : 'a'
    await search.fill(query)
    const input = (await search.elementHandle())!
    await keyboard(360)
    await page
      .waitForFunction((el) => el.closest('[data-popover]')!.getBoundingClientRect().top <= 12, input)
      .catch(() => assert.fail(`${view}: picker did not detach to the visible top edge`))
    const expanded = await box(panel)
    assert.ok(expanded.width >= 366 && expanded.height >= 336, `${view}: picker does not fill the visible area`)
    assert.ok(
      expanded.x >= 7 && expanded.y >= 7 && expanded.x + expanded.width <= 383 && expanded.y + expanded.height <= 353,
      `${view}: picker exceeds the visible area margins`
    )
    assert.ok(await input.evaluate((el) => el === document.activeElement && el.isConnected))
    assert.equal(await search.inputValue(), query)
    const list = panel.getByRole('listbox')
    assert.ok(
      await list.evaluate((el) => el.scrollHeight > el.clientHeight),
      `${view}: results do not have an independent scroll range`
    )
    const listBox = await box(list)
    await swipe(listBox.x + listBox.width / 2, listBox.y + listBox.height - 16, -100)
    await page.waitForFunction((el) => el.scrollTop > 0, await list.elementHandle())
    assert.ok(await focused(search), `${view}: scrolling moved focus`)
    assert.ok((await box(search)).y > 0 && (await box(search)).y < 140, `${view}: search scrolled away`)
    await shot(`${view}-picker-open`)
    await keyboard(230)
    const fieldBox = await box(search)
    assert.ok(fieldBox.y >= 8 && fieldBox.y + fieldBox.height < 230, `${view}: a short viewport clips search`)
    const shortList = await box(list)
    assert.ok(shortList.height > 24 && shortList.y + shortList.height < 230, `${view}: a short viewport clips results`)
    await keyboard(null)
    await page.waitForFunction((el) => el.closest('[data-popover]')!.getBoundingClientRect().top > 20, input)
    assert.ok(await input.evaluate((el) => el === document.activeElement && el.isConnected))
    assert.equal(await search.inputValue(), query)
    await keyboard(360)
    await panel.getByRole('button', { name: 'Close picker' }).tap()
    assert.ok(await focused(trigger))
    await panel.waitFor({ state: 'hidden' })
    await keyboard(null)
    await trigger.tap()
    assert.ok(await focused(search))
    await keyboard(360)
    // Commit a result through the existing search handler while detached.
    await search.fill(view === 'activity' ? '119' : view === 'squad' ? 'instructions' : 'paired devices')
    if (view === 'activity') await panel.getByRole('option', { name: /^#119 / }).tap()
    else await search.press('Enter')
    if (view !== 'activity')
      await trigger.getByText(view === 'squad' ? 'Instructions' : 'Paired Devices', { exact: true }).waitFor()
    if (view === 'activity') assert.match((await trigger.getAttribute('aria-label')) ?? '', /showing #119/)
    await panel.waitFor({ state: 'hidden' })
    await keyboard(null)
    await trigger.tap()
    await search.press('Escape')
    await panel.waitFor({ state: 'hidden' })
    assert.ok(await focused(trigger))
  }

  await open('squad')
  const name = page.getByRole('textbox', { name: 'Name', exact: true })
  const description = page.getByRole('textbox', { name: 'Description' })
  const identity = page.getByTestId('mobile-squad-header-title-row')
  const chooser = page.getByRole('button', { name: 'Choose settings section' })
  const tabs = page.getByRole('tablist', { name: 'Squad sections' })
  await name.waitFor()
  await shot('squad-form-closed')
  const before = await Promise.all([identity, tabs, chooser].map(box))
  await name.tap()
  await name.fill('Product Design')
  await keyboard(335)
  const isAboveKeyboard = async (field: Locator) => {
    const rect = await box(field)
    return rect.y >= 0 && rect.y + rect.height <= 335
  }
  assert.ok(await isAboveKeyboard(name), 'Squad name is still clipped by the keyboard')
  await name.press('Tab')
  assert.ok(await focused(description), 'Squad form did not advance to Description')
  assert.ok(await isAboveKeyboard(description), 'Description is still clipped by the keyboard')
  await description.fill('Updated purpose')
  const during = await Promise.all([identity, tabs, chooser].map(box))
  assert.ok(before[2]!.y - during[2]!.y > 60, 'Squad chooser stays pinned above the form')
  for (let i = 1; i < during.length; i++) {
    assert.ok(
      Math.abs(during[i]!.y - during[0]!.y - (before[i]!.y - before[0]!.y)) < 2,
      'Squad chrome does not scroll as one unit'
    )
  }
  await shot('squad-form-open')
  await keyboard(null)
  assert.ok(Math.abs((await box(chooser)).y - before[2]!.y) < 2, 'Squad chooser did not return to its closed layout')
  assert.ok(await focused(description))
  assert.equal(await name.inputValue(), 'Product Design')
  assert.equal(await description.inputValue(), 'Updated purpose')

  // At a shorter phone height the closed form still has a scroll range. Keep the same
  // point in the form when the whole-page scroller hands it back to the inner scroller.
  await page.setViewportSize({ width: 390, height: 630 })
  await open('squad')
  await description.tap()
  await keyboard(315)
  const form = page.locator('.squad-settings-form')
  const squadPage = page.locator('.squad-detail-page')
  const contentOffset = await squadPage.evaluate((el) => {
    const form = el.querySelector('.squad-settings-form')!
    const chrome = form.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop
    el.scrollTop = chrome + 75
    return el.scrollTop - chrome
  })
  assert.ok(contentOffset > 30, 'Test fixture is not scrolled into the form')
  const pageOffset = await squadPage.evaluate((el) => el.scrollTop)
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))
  await keyboard(null)
  const innerOffset = await form.evaluate((el) => el.scrollTop)
  assert.ok(Math.abs(innerOffset - contentOffset) <= 1, 'Keyboard dismissal lost the form reading position')
  await keyboard(315)
  assert.ok(
    (await squadPage.evaluate((el) => el.scrollTop)) > pageOffset - 100,
    'Keyboard reopen reset to the top of the squad page'
  )
  await keyboard(null)
  await page.setViewportSize({ width: 390, height: 844 })

  // Real xterm and TerminalTabs, with a loopback-only, synthetic WebSocket peer.
  const sessions: string[] = []
  const resizes: number[] = []
  let inputText = ''
  const output = Array.from({ length: 100 }, (_, index) => `Fixture scrollback line ${index + 1}`).join('\r\n')
  await page.routeWebSocket('**/ws/terminal?**', (socket) => {
    const id = new URL(socket.url()).searchParams.get('sessionId') ?? 'new-shell'
    sessions.push(id)
    socket.send(JSON.stringify({ type: 'session', sessionId: id }))
    socket.send(`${output}\r\n${id} $ `)
    socket.onMessage((message) => {
      if (typeof message !== 'string') inputText += message.toString()
      else resizes.push(JSON.parse(message).rows)
    })
  })
  await open('workspace')
  const terminalPane = page.getByText('Terminal', { exact: true })
  await terminalPane.tap()
  const terminal = page.locator('.xterm:visible')
  const textarea = terminal.locator('textarea')
  const terminalScreen = terminal.locator('.xterm-screen')
  await terminalScreen.waitFor()
  await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent?.includes('shell-one $'))
  const appHeader = page.locator('.ficus-app-header')
  const terminalHandle = (await terminal.elementHandle())!
  const initialFit = await terminalHandle.evaluate((el) => ({
    height: el.getBoundingClientRect().height,
    rows: el.querySelector('.xterm-rows')?.childElementCount,
  }))
  await shot('workspace-closed')
  await terminalScreen.tap({ position: { x: 100, y: 70 } })
  assert.ok(await focused(textarea), 'Tapping xterm did not focus its keyboard input')
  await page.keyboard.type('hello')
  await keyboard(360)
  await appHeader.waitFor({ state: 'hidden' })
  const expandedTerminal = await box(terminal)
  assert.ok(expandedTerminal.y < 80 && expandedTerminal.height > 250, 'Terminal did not reclaim page chrome space')
  assert.ok(await focused(textarea))
  await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent?.includes('shell-one $'))
  await swipe(180, 110, 125)
  await page.waitForFunction(() => !document.querySelector('.xterm-rows')?.textContent?.includes('shell-one $'))
  assert.ok(await focused(textarea), 'Scrolling terminal history lost the keyboard')
  assert.equal(await page.getByTestId('app-scroll-container').evaluate((el) => el.scrollTop), 0)
  await shot('workspace-open')
  await keyboard(null)
  // The header returns on the shell resize; xterm paints its restored rows after the
  // ResizeObserver refit. Measure from the simulated viewport event, not Playwright's wait.
  const refit = await page.waitForFunction(
    ({ el, height, rows }) => {
      if (Math.abs(el.getBoundingClientRect().height - height) >= 2) return false
      if (el.querySelector('.xterm-rows')?.childElementCount !== rows) return false
      const mark = performance.getEntriesByName('fixture-keyboard-resize', 'mark').at(-1)!
      return { elapsed: Math.round(performance.now() - mark.startTime) }
    },
    { el: terminalHandle, ...initialFit }
  )
  const restored = await refit.jsonValue()
  assert.ok(restored)
  const { elapsed } = restored
  console.log(
    `Terminal restored ${Math.round(initialFit.height)}px and ${initialFit.rows} rows from ${Math.round(expandedTerminal.height)}px in ${elapsed}ms after keyboard dismissal.`
  )
  assert.ok(elapsed <= 300, `Terminal refit took ${elapsed}ms; expected at most 300ms`)
  await appHeader.waitFor()
  assert.ok(await focused(textarea))
  await page.keyboard.type(' world')
  assert.equal(inputText, 'hello world')
  assert.deepEqual(sessions, ['shell-one'])
  assert.ok(new Set(resizes).size > 1, 'No PTY resize was sent')
  await keyboard(360)
  await textarea.blur()
  assert.ok(!(await appHeader.isVisible()), 'Terminal chrome jumped back before the keyboard finished closing')
  await page.locator('.workspace-mobile-terminal').getByText('Shell 2', { exact: true }).tap()
  await keyboard(null)
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.xterm-rows')].some((el) => el.textContent?.includes('shell-two $'))
  )
  await page.locator('.workspace-mobile-terminal').getByText('Shell 1', { exact: true }).tap()
  assert.deepEqual(sessions, ['shell-one', 'shell-two'], 'Switching tabs reconnected the original shell')

  await page.setViewportSize({ width: 1200, height: 844 })
  await open('activity')
  await page.getByRole('button', { name: /^Active work,/ }).click()
  await keyboard(360)
  assert.ok(
    (await box(page.getByRole('dialog', { name: 'Active work streams' }))).width < 500,
    'Desktop picker detached'
  )
  assert.deepEqual(errors, [], `Page errors: ${errors.join('; ')}`)
  console.log('Mobile keyboard layout checks passed.')
} finally {
  await browser?.close()
  await server.close()
}
