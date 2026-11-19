/** Foreground synthetic UI proof; owns and closes its browser and fixture server. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { mkdir } from 'node:fs/promises'
import type { Browser } from 'playwright-core'
import { startFixtureServer } from './fixture-server'
const root = resolve(import.meta.dir, '..')
process.chdir(root)
const { chromium } = createRequire(resolve(root, '../core/package.json'))(
  'playwright-core'
) as typeof import('playwright-core')
const directory = process.env.SCREENSHOT_DIR
if (directory) await mkdir(directory, { recursive: true })
const server = await startFixtureServer({
  path: '/voice-progress-fixture',
  entry: '/scripts/fixtures/voice-progress.tsx',
})
let browser: Browser | undefined
const errors: string[] = []
try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] })
  const page = await browser.newPage()
  page.setDefaultTimeout(10_000)
  page.on('pageerror', (error) => {
    errors.push(error.message)
    console.error(error.message)
  })
  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.push(message.text())
      console.error(message.text())
    }
  })
  await page.route('**/api/**', (route) => {
    if (!new URL(route.request().url()).pathname.startsWith('/api/')) return route.continue()
    errors.push('Unexpected backend request')
    return route.abort()
  })
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 1000 })
    await page.goto(`${server.resolvedUrls!.local[0]}voice-progress-fixture`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    })
    await page.getByRole('button', { name: 'Derive', exact: true }).click()
    await page.evaluate(() => (window as any).voiceFixture.collecting())
    await page.getByText('Activity read from example/private-library.', { exact: true }).waitFor()
    const region = page.getByRole('region', { name: 'Voice derivation progress' })
    await region.scrollIntoViewIfNeeded()
    assert.equal(await page.getByLabel('GitHub login').isDisabled(), true)
    assert.equal(await page.getByRole('button', { name: 'Use this draft', exact: true }).count(), 0)
    assert.equal(await page.getByRole('status').getAttribute('aria-live'), 'polite')
    assert.equal(await page.locator('html').evaluate((el) => el.scrollWidth <= window.innerWidth), true)
    if (directory) await page.screenshot({ path: `${directory}/collecting-${width}.png` })
    await page.evaluate(() => (window as any).voiceFixture.drafting())
    await page.getByText('Drafting style observations. Findings appear after validation.', { exact: true }).waitFor()
    if (directory) await page.screenshot({ path: `${directory}/drafting-${width}.png` })
    await page.evaluate(() => (window as any).voiceFixture.complete())
    const useDraft = page.getByRole('button', { name: 'Use this draft', exact: true })
    await useDraft.waitFor()
    await useDraft.scrollIntoViewIfNeeded()
    assert.equal(await page.getByRole('status').textContent(), 'Draft ready. Nothing was saved.')
    if (directory) await page.screenshot({ path: `${directory}/complete-${width}.png` })
    await page.getByRole('button', { name: 'Derive', exact: true }).click()
    await page.evaluate(() => (window as any).voiceFixture.collecting())
    const cancel = page.getByRole('button', { name: 'Cancel', exact: true })
    await cancel.focus()
    await page.keyboard.press('Enter')
    await page.getByText('Cancelled. Nothing was saved.', { exact: true }).waitFor()
    assert.equal(await page.evaluate(() => (window as any).voiceFixture.aborted()), true)
    assert.equal(await useDraft.count(), 0)
    if (directory) await page.screenshot({ path: `${directory}/cancelled-${width}.png` })
    await page.getByRole('button', { name: 'Derive', exact: true }).click()
    await page.evaluate(() => {
      ;(window as any).voiceFixture.collecting()
      ;(window as any).voiceFixture.fail()
    })
    await page.getByRole('alert').waitFor()
    assert.match((await page.getByRole('alert').textContent()) ?? '', /answer was not JSON/)
    assert.equal(await useDraft.count(), 0)
    await page.getByRole('alert').scrollIntoViewIfNeeded()
    if (directory) await page.screenshot({ path: `${directory}/error-${width}.png` })
  }
  await page.emulateMedia({ forcedColors: 'active' })
  await page.getByRole('button', { name: 'Derive', exact: true }).click()
  await page.evaluate(() => (window as any).voiceFixture.collecting())
  await page.getByRole('button', { name: 'Cancel', exact: true }).focus()
  assert.equal(
    await page.getByRole('button', { name: 'Cancel', exact: true }).evaluate((el) => el === document.activeElement),
    true
  )
  if (directory) await page.screenshot({ path: `${directory}/forced-colors.png` })
  assert.deepEqual(errors, [])
  console.log(
    'Passed collecting, model wait, completion, cancellation and typed error at 390 and 1280 pixels; keyboard Cancel, forced colors and zero browser errors.'
  )
} finally {
  await browser?.close()
  await server.close()
}
