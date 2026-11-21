/** Foreground synthetic visual check. No live backend, account or inference is used. */
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
  path: '/public-voice-setup-fixture',
  entry: '/scripts/fixtures/public-voice-setup.tsx',
})
let browser: Browser | undefined
const errors: string[] = []
try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] })
  const page = await browser.newPage()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  page.setDefaultTimeout(10_000)
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  await page.route('**/api/**', (route) => {
    if (!new URL(route.request().url()).pathname.startsWith('/api/')) return route.continue()
    errors.push('Unexpected live API request')
    return route.abort()
  })
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 1000 })
    const capture = async (name: string) => {
      assert.equal(await page.locator('html').evaluate((el) => el.scrollWidth <= window.innerWidth), true)
      if (directory) await page.screenshot({ path: `${directory}/${name}-${width}.png` })
    }
    const url = `${server.resolvedUrls!.local[0]}public-voice-setup-fixture`
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    await page.getByRole('heading', { name: 'Voices', exact: true }).waitFor()
    await capture('settings-list')
    const assignments = page.locator('[data-voice-profile="platform"]')
    const disclosure = assignments.locator('summary')
    await disclosure.focus()
    await page.keyboard.press('Enter')
    assert.equal(await assignments.getByRole('checkbox', { name: 'Security reviews (read-only)' }).isDisabled(), true)
    for (const label of await assignments.locator('[data-squad-id]').all())
      assert.ok((await label.boundingBox())!.height >= 44)
    await assignments.locator('fieldset').scrollIntoViewIfNeeded()
    await capture('settings-assignments')
    await disclosure.click()

    // Choosing another profile as the instance default moves the badge and reports the change.
    assert.equal(await page.locator('[data-voice-profile="default"] [data-instance-default]').count(), 1)
    await page.getByRole('button', { name: 'Set Platform voice as default', exact: true }).click()
    await page.getByText('Platform voice is now the default voice for every squad without an assignment.').waitFor()
    await page.locator('[data-voice-profile="platform"] [data-instance-default]').waitFor()
    assert.equal(await page.locator('[data-voice-profile="default"] [data-instance-default]').count(), 0)
    await page.locator('[data-voice-profile="default"]').scrollIntoViewIfNeeded()
    await capture('settings-default')
    // Disabling the current default asks first.
    const disableDefault = page.getByRole('button', { name: 'Disable Platform voice', exact: true })
    await disableDefault.click()
    assert.match(await disableDefault.innerText(), /Unassigned squads use the shipped default/)
    await capture('settings-disable-default-confirm')

    await page.getByRole('heading', { name: 'Create a voice from GitHub', exact: true }).scrollIntoViewIfNeeded()
    assert.equal(
      await page
        .locator('details')
        .filter({ has: page.getByText('Filter activity (optional)', { exact: true }) })
        .evaluate((el) => (el as HTMLDetailsElement).open),
      false
    )
    await capture('settings-derive')
    await page.getByRole('button', { name: 'Derive', exact: true }).click()
    await page.getByRole('button', { name: 'Save as new profile', exact: true }).click()
    await page.getByLabel('Profile id', { exact: true }).fill('team-style')
    await page.getByRole('textbox', { name: 'Profile name', exact: true }).fill('Team style')
    await capture('profile-dialog')
    await page.getByRole('button', { name: 'Create', exact: true }).click()
    await page.getByRole('dialog', { name: 'New voice profile', exact: true }).waitFor({ state: 'hidden' })
    await page.getByRole('textbox', { name: 'Profile name', exact: true }).scrollIntoViewIfNeeded()
    await capture('settings-editor')
    await page.goto(`${url}?onboarding=1&partial=1`, { waitUntil: 'domcontentloaded' })
    await page.locator('[aria-controls="setup-step-public_voice"]').first().click()
    await page.getByLabel('GitHub account to read through').scrollIntoViewIfNeeded()
    await capture('onboarding-derive')
    await page.getByRole('button', { name: 'Derive', exact: true }).click()
    await page.getByRole('button', { name: 'Use this draft', exact: true }).click()
    await page.getByRole('button', { name: 'Back to derivation', exact: true }).click()
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'GitHub login')
    await page.getByRole('button', { name: 'Use this draft', exact: true }).click()
    assert.equal(await page.getByLabel('GitHub login').isVisible(), false)
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Profile name')
    await page.getByRole('heading', { name: 'Review your voice', exact: true }).scrollIntoViewIfNeeded()
    await capture('onboarding-editor')
    await page.getByRole('button', { name: 'Save and use as default voice', exact: true }).scrollIntoViewIfNeeded()
    // The confirmation says how many squads change, not only which keep their own voice.
    await page.getByText('It changes the voice of 1 squad now.', { exact: false }).waitFor()
    await capture('onboarding-save-default')
    await page.getByRole('button', { name: 'Save and use as default voice', exact: true }).click()
    await page.getByRole('alert').scrollIntoViewIfNeeded()
    assert.match(
      await page.getByRole('alert').innerText(),
      /Profile saved; could not make it the default voice: Forbidden/
    )
    await capture('onboarding-partial-failure')
    await page.getByRole('button', { name: 'Retry setting as default', exact: true }).click()
    await page.getByText('From GitHub is now the default voice.', { exact: false }).waitFor()
    await capture('onboarding-success')
  }
  assert.deepEqual(errors, [])
  console.log(
    'Passed Settings and onboarding at 390 and 1280 pixels: account selection, choosing the instance default, confirming before disabling it, derivation, named draft editor, how many squads the new default changes, a failed set-as-default and its retry without recreating the profile, no horizontal overflow and zero browser errors.'
  )
} catch (error) {
  console.error('Browser errors:', errors)
  const page = browser?.contexts()[0]?.pages()[0]
  if (page && directory) await page.screenshot({ path: `${directory}/failure.png` })
  throw error
} finally {
  await browser?.close()
  await server.close()
}
