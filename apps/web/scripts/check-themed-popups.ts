// Focused real-Chromium regression gate. Uses the repository's playwright-core
// installation; set PLAYWRIGHT_BROWSERS_PATH to your installed browser cache.
// Everything (Vite and Chromium included) is closed in finally, without a DB/API.
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import type { Page } from 'playwright-core'

const require = createRequire(resolve(import.meta.dir, '../../core/package.json'))
const { chromium } = require('playwright-core') as typeof import('playwright-core')
const root = resolve(import.meta.dir, '..')
process.chdir(root)
const screenshots = process.env.POPUP_SCREENSHOTS
const server = await createServer({
  root,
  configFile: false,
  plugins: [react()],
  server: { host: '127.0.0.1', port: 0 },
})
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
let cases = 0
try {
  await server.listen()
  const address = server.httpServer!.address()
  assert(address && typeof address !== 'string')
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  const base = `http://127.0.0.1:${address.port}/src/test/fixtures/themed-popups.html`
  const load = async (surface: string, edge = 'bottom-right', width = 390, height = 300) => {
    await page.setViewportSize({ width, height })
    await page.goto(`${base}?surface=${surface}&edge=${edge}`)
    await page.locator('[data-anchor]').waitFor()
  }
  const popup = () => page.locator('[role="listbox"], [role="menu"]')
  const state = async () => JSON.parse((await page.locator('[data-result]').textContent())!)
  const focused = async (text: string) =>
    page.waitForFunction((text) => document.activeElement?.textContent?.includes(text), text)
  const trigger = (label: string) => page.locator(`button[aria-label="${label}"]`)

  await load('delivery')
  await page.getByRole('textbox', { name: 'Message agent' }).fill('Must not send on mode selection')
  await trigger('Message delivery').focus()
  await page.keyboard.press('Enter')
  await focused('Interrupt')
  const listboxId = await popup().getAttribute('id')
  assert.equal(await trigger('Message delivery').getAttribute('aria-controls'), listboxId)
  const selected = page.getByRole('option', { name: 'Interrupt', exact: true })
  assert.equal(await selected.getAttribute('aria-selected'), 'true')
  const description = await selected.getAttribute('aria-describedby')
  assert(description)
  assert.match((await page.locator(`[id="${description}"]`).textContent())!, /next delivery point/)
  await page.keyboard.press('ArrowDown')
  await focused('Follow up')
  assert.equal((await state()).mode, 'steer')
  await page.keyboard.press('Enter')
  await popup().waitFor({ state: 'detached' })
  assert.deepEqual(await state(), { mode: 'follow-up', sends: 0, changes: 1, tab: 'settings' })
  assert.equal(
    await trigger('Message delivery').evaluate((node) => node === document.activeElement),
    true,
    'focus should return to delivery trigger'
  )
  await page.keyboard.press('Space')
  await focused('Follow up')
  await page.keyboard.press('Escape')
  await popup().waitFor({ state: 'detached' })
  assert.equal(
    await trigger('Message delivery').evaluate((node) => node === document.activeElement),
    true,
    'focus should return to delivery trigger'
  )
  cases++

  // Nonmodal Tab/Shift+Tab preserve logical order despite the portal.
  await trigger('Message delivery').click()
  await focused('Follow up')
  await page.keyboard.press('Tab')
  await popup().waitFor({ state: 'detached' })
  assert.equal(
    await page.locator('[data-after]').evaluate((node) => node === document.activeElement),
    true,
    'focus should exit to After trigger'
  )
  await trigger('Message delivery').click()
  await focused('Follow up')
  await page.keyboard.press('Shift+Tab')
  await popup().waitFor({ state: 'detached' })
  assert.equal(
    await trigger('Message delivery').evaluate((node) => node === document.activeElement),
    true,
    'focus should return to delivery trigger'
  )
  await trigger('Message delivery').click()
  await page.locator('[data-after]').click()
  await popup().waitFor({ state: 'detached' })
  assert.equal(
    await page.locator('[data-after]').evaluate((node) => node === document.activeElement),
    true,
    'focus should exit to After trigger'
  )
  cases++

  await trigger('Message delivery').click()
  await page.locator('[data-disable]').evaluate((node) => (node as HTMLButtonElement).click())
  await popup().waitFor({ state: 'detached' })
  assert.equal(await trigger('Message delivery').isDisabled(), true)
  cases++

  await load('disabled')
  await trigger('Disabled options').click()
  await focused('Selected')
  await page.keyboard.press('End')
  await focused('Enabled last')
  await page.keyboard.press('ArrowDown')
  await focused('Selected')
  await page.keyboard.press('Home')
  await focused('Selected')
  assert.equal((await state()).tab, 'settings')
  await page.keyboard.press('Escape')
  cases++

  for (const width of [390, 800, 1200]) {
    await load('views', 'top-right', width, 500)
    if (width < 1024) {
      await trigger(width < 768 ? 'Conversation options, settings view' : 'Agent view').click()
      await focused('settings')
      await page.keyboard.press('End')
      await focused('subagents')
      assert.equal(await page.locator(':focus').getAttribute('aria-label'), 'subagents, 2 active subagents')
      assert.equal((await state()).tab, 'settings')
      await page.keyboard.press('Enter')
      assert.equal((await state()).tab, 'subagents')
    } else {
      assert.equal(await trigger('Agent view').isVisible(), false)
      await trigger('subagents, 2 active subagents').click()
      assert.equal((await state()).tab, 'subagents')
    }
    assert.equal(await page.locator('select').count(), 0)
    cases++
  }

  // A hidden breakpoint trigger must not leave a portaled menu behind.
  await load('views', 'top-right', 390, 500)
  await trigger('Conversation options, settings view').click()
  await page.setViewportSize({ width: 1200, height: 500 })
  await popup().waitFor({ state: 'detached' })
  cases++

  await load('actions')
  await trigger('Chat options').click()
  await focused('Manage chats')
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await page.getByRole('dialog', { name: 'Spawn agent', exact: true }).waitFor()
  assert.equal(
    await page
      .getByRole('dialog', { name: 'Spawn agent', exact: true })
      .evaluate((node) => node === document.activeElement),
    true
  )
  cases++

  // Actual clipping, flip/shift, scroll-height and layout assertions at every corner.
  for (const surface of ['delivery', 'tools', 'views', 'actions']) {
    for (const edge of ['top-left', 'top-right', 'bottom-left', 'bottom-right']) {
      await load(surface, edge, 320, 260)
      const label = {
        delivery: 'Message delivery',
        tools: 'More squad tools',
        views: 'Conversation options, settings view',
        actions: 'Chat options',
      }[surface]!
      await trigger(label).click()
      await assertInsideViewport(page)
      assert.equal(await popup().evaluate((node) => !!node.closest('[data-clipping]')), false)
      if (surface === 'tools') {
        await focused('settings')
        await page.keyboard.press('End')
        await focused('Tool 13')
        assert.equal(
          await page.locator(':focus').evaluate((node) => {
            const row = node.getBoundingClientRect()
            const menu = node.closest('[role="menu"]')!.getBoundingClientRect()
            return row.top >= menu.top && row.bottom <= menu.bottom
          }),
          true
        )
      }
      await page.setViewportSize({ width: 375, height: 340 })
      await assertInsideViewport(page)
      // Move the anchor in a scrolling/clipping parent while keeping it visible.
      await page.locator('[data-scroller]').evaluate((node) => {
        node.scrollTop = 12
      })
      await assertInsideViewport(page)
      await page.locator('[data-clipping]').evaluate((node) => {
        ;(node as HTMLElement).style.right = '30px'
        ;(node as HTMLElement).style.left = 'auto'
      })
      await assertInsideViewport(page)
      await page.waitForFunction((label) => {
        const anchor = document.querySelector(`button[aria-label="${label}"]`)!.getBoundingClientRect()
        const element = document.querySelector('[role="listbox"], [role="menu"]')!
        const menu = element.getBoundingClientRect()
        const desiredLeft = element.getAttribute('data-placement')?.endsWith('start')
          ? anchor.left
          : anchor.right - menu.width
        const safeLeft = Math.max(8, Math.min(desiredLeft, innerWidth - menu.width - 8))
        return Math.abs(menu.left - safeLeft) < 1
      }, label)
      cases++
    }
  }

  for (const edge of ['top-right', 'bottom-right']) {
    await load('delivery', edge, 1200, 700)
    await trigger('Message delivery').click()
    await assertInsideViewport(page)
    assert.equal(
      await popup().evaluate((node, edge) => {
        const anchor = document.querySelector('button[aria-label="Message delivery"]')!.getBoundingClientRect()
        const menu = node.getBoundingClientRect()
        return edge.startsWith('top') ? menu.top >= anchor.bottom : menu.bottom <= anchor.top
      }, edge),
      true,
      `Popup should open ${edge.startsWith('top') ? 'below' : 'above'} its trigger`
    )
    cases++
  }

  await load('delivery', 'bottom-right', 390, 500)
  // Simulate visual viewport keyboard/pan events without claiming a physical iOS keyboard test.
  await page.evaluate(() => {
    const viewport = Object.assign(new EventTarget(), {
      width: 300,
      height: 200,
      offsetTop: 80,
      offsetLeft: 20,
      scale: 1,
    })
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport })
  })
  await trigger('Message delivery').click()
  await assertInsideViewport(page)
  await page.evaluate(() => {
    Object.assign(window.visualViewport!, { height: 160, offsetTop: 100 })
    window.visualViewport!.dispatchEvent(new Event('resize'))
    window.visualViewport!.dispatchEvent(new Event('scroll'))
  })
  await assertInsideViewport(page)
  cases++

  await load('delivery', 'bottom-right', 390, 500)
  await page.locator('[data-modal]').evaluate((node) => (node as HTMLButtonElement).click())
  await trigger('Message delivery').click()
  await assertInsideViewport(page)
  await page.keyboard.press('Escape')
  assert.equal(await page.getByRole('dialog', { name: 'Containing dialog', exact: true }).isVisible(), true)
  assert.equal(
    await trigger('Message delivery').evaluate((node) => node === document.activeElement),
    true,
    'focus should return to delivery trigger'
  )
  cases++

  if (screenshots) {
    await mkdir(screenshots, { recursive: true })
    for (const [name, width, height, theme] of [
      ['narrow-light', 390, 500, 'light'],
      ['short-dark', 320, 260, 'dark'],
      ['wide-light', 1200, 700, 'light'],
    ] as const) {
      await load('delivery', 'bottom-right', width, height)
      await page.evaluate((theme) => {
        document.documentElement.dataset.appearance = theme
        document.documentElement.classList.toggle('dark', theme === 'dark')
      }, theme)
      await trigger('Message delivery').click()
      await assertInsideViewport(page)
      await popup().evaluate(async (node) => {
        await Promise.all(node.getAnimations().map((animation) => animation.finished))
      })
      await page.screenshot({ path: resolve(screenshots, `${name}.png`) })
    }
  }
  assert.deepEqual(errors, [], 'Browser console/page errors')
  console.log(`PASS: ${cases} browser popup scenarios; no browser errors`)
} finally {
  await browser?.close()
  await server.close()
}

async function assertInsideViewport(page: Page) {
  await page.waitForFunction(() => {
    const popup = document.querySelector('[role="listbox"], [role="menu"]')
    if (!popup) return false
    const rect = popup.getBoundingClientRect()
    const viewport = window.visualViewport
    const x = viewport?.offsetLeft ?? 0,
      y = viewport?.offsetTop ?? 0
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      rect.left >= x + 7 &&
      rect.top >= y + 7 &&
      rect.right <= x + (viewport?.width ?? innerWidth) - 7 &&
      rect.bottom <= y + (viewport?.height ?? innerHeight) - 7
    )
  })
}
