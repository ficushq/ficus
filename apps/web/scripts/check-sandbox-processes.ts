/** DB-free browser proof of the real Processes panel and squad header. All API data
 * and controls are synthetic. CHROMIUM_PATH selects a browser; SCREENSHOT_DIR is optional.
 * From apps/web: bun scripts/check-sandbox-processes.ts
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Browser } from 'playwright-core'
import type { SandboxPressure, SandboxProcesses } from '@ficus/shared'
import { startFixtureServer } from './fixture-server'

const root = resolve(import.meta.dir, '..')
const { chromium } = createRequire(resolve(root, '../core/package.json'))(
  'playwright-core'
) as typeof import('playwright-core')
const screenshots = process.env.SCREENSHOT_DIR
if (screenshots) await mkdir(screenshots, { recursive: true })
const server = await startFixtureServer({
  path: '/processes-fixture',
  entry: '/scripts/fixtures/sandbox-processes.tsx',
})
let browser: Browser | undefined
try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH })
  const page = await browser.newPage()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  page.setDefaultTimeout(5000)
  page.setDefaultNavigationTimeout(30000)
  const errors: string[] = []
  page.on('pageerror', (error) => {
    errors.push(error.message)
    console.error(error.message)
  })
  const quiet = { avg10: 0, avg60: 0, avg300: 0 }
  let pressure: SandboxPressure
  let actions: string[] = []
  const processes: SandboxProcesses['processes'] = [
    {
      pid: 501,
      startTicks: 900000,
      ppid: 1,
      cpuPercent: 2,
      memRssMb: 200,
      ageSeconds: 100,
      state: 'S',
      command: 'bash -c renice 10; bun test focused.test.ts',
      protected: false,
    },
    ...(['Docker runtime', 'Box listener', 'Session bus'] as const).map((protectionReason, i) => ({
      pid: 601 + i,
      ppid: 1,
      cpuPercent: 1,
      memRssMb: 20,
      ageSeconds: 86400,
      state: 'S',
      command: ['dockerd --rootless', 'systemd-socket-proxyd /run/box/server.sock', 'dbus-daemon --session'][i]!,
      protected: true,
      protectionReason,
    })),
  ]
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (!path.startsWith('/api/')) return route.continue()
    if (path === '/api/squads/synthetic/sandbox/status')
      return route.fulfill({
        json: {
          status: 'running',
          runtime: 'vm',
          chain: { boxProvisioned: true, machine: 'reachable', boxServer: 'up' },
          pressure,
          hostCapacity: pressure.box
            ? {
                allowed: true,
                reason: 'already-accounted',
                cpus: 8,
                budgetCpus: 12,
                activeQuotaCpus: pressure.box.cpuQuotaPercent === 97.5 ? 12 : 8,
              }
            : { allowed: false, reason: 'unknown' },
        },
      })
    if (path === '/api/squads/synthetic/sandbox/processes')
      return route.fulfill({
        json: {
          pressure,
          processes,
          containers: {
            available: true,
            containers: [{ id: 'db', name: 'test-db', image: 'postgres', state: 'running', status: 'Up 1 hour' }],
          },
        },
      })
    if (path === '/api/squads/synthetic/sandbox/processes/501/signal') {
      assert.deepEqual(route.request().postDataJSON(), { signal: 'TERM', startTicks: 900000 })
      actions.push(path)
      return route.fulfill({
        status: 409,
        json: { error: 'Process 501 no longer matches the listed startTicks; refresh the process list' },
      })
    }
    if (path === '/api/squads/synthetic/sandbox/containers/db/stop') {
      actions.push(path)
      return route.fulfill({ json: { id: 'db' } })
    }
    errors.push(`Unexpected API request: ${path}`)
    return route.abort()
  })
  for (const kind of ['host', 'quota', 'local', 'missing'] as const)
    for (const width of [390, 1280])
      for (const dark of [false, true]) {
        pressure = {
          cpus: 8,
          load: [35.8, 30, 20],
          memTotalMb: 16000,
          memAvailableMb: 4000,
          ...(kind === 'missing'
            ? {}
            : {
                box: {
                  cpuPercent: kind === 'quota' ? 390 : 20,
                  sampleMs: 1000,
                  cpuQuotaCpus: 4,
                  cpuQuotaPercent: kind === 'quota' ? 97.5 : 5,
                  cpuThrottledPeriods: kind === 'quota' ? 8 : 0,
                  cpuThrottledUsec: kind === 'quota' ? 200000 : 0,
                  memoryHighEvents: kind === 'local' ? 12 : 0,
                  memoryMaxEvents: 0,
                  cpuPressureSome: { avg10: 65, avg60: 30, avg300: 10 },
                  memoryPressureSome: kind === 'local' ? { avg10: 25, avg60: 10, avg300: 5 } : quiet,
                },
              }),
        }
        actions = []
        await page.setViewportSize({ width, height: 900 })
        await page.goto(`${server.resolvedUrls!.local[0]}processes-fixture${dark ? '?dark' : ''}`)
        await page.getByRole('button', { name: 'Show processes' }).click()
        const label = kind === 'local' || kind === 'quota' ? 'This sandbox overloaded' : 'Host overloaded'
        const header = page.locator('header')
        assert.match(await header.innerText(), /Host load 4.5×/)
        assert.match(
          await header.innerText(),
          kind === 'missing' ? /Host quota unknown/ : kind === 'quota' ? /quota 12\/12 CPUs/ : /quota 8\/12 CPUs/
        )
        if (kind === 'quota')
          assert.match(
            (await header.locator('[title*="not measured CPU usage"]').getAttribute('title')) ?? '',
            /Additional box demand waits/
          )
        const panel = page.getByRole('region', { name: 'Processes' })
        await panel.getByText(`${label}:`, { exact: true }).waitFor()
        assert.match(await panel.innerText(), /Load 35.8 on 8 CPUs/)
        assert.match(
          await panel.innerText(),
          kind === 'missing' ? /CPU unavailable/ : kind === 'quota' ? /97.5% of 4 CPU quota/ : /20.0% CPU/
        )
        for (const label of ['Docker runtime', 'Box listener', 'Session bus']) {
          const row = panel.getByRole('row').filter({ hasText: label })
          assert.equal(await row.getByRole('button').count(), 0)
        }
        assert.equal(await panel.getByRole('button', { name: 'Stop process 501', exact: true }).count(), 1)
        if (screenshots)
          await page.screenshot({
            path: resolve(screenshots, `processes-${kind}-${width}-${dark ? 'dark' : 'light'}-panel.png`),
            fullPage: true,
          })
        await page.getByRole('button', { name: 'Sandbox warning', exact: true }).click()
        const warning = page.getByRole('dialog', { name: 'Sandbox warning details' })
        await warning.waitFor()
        await page.waitForFunction(() => {
          const card = document.querySelector('[role=dialog][data-state=open]')
          return card && getComputedStyle(card).opacity === '1'
        })
        assert.match(await warning.innerText(), new RegExp(label))
        assert.match(
          await warning.innerText(),
          kind === 'host'
            ? /Host busy with other boxes/
            : kind === 'quota'
              ? /97.5% of 4 CPU quota/
              : kind === 'local'
                ? /Memory PSI some 25.0\/10.0\/5.0%/
                : /unavailable/
        )
        assert.ok(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          'viewport must not scroll horizontally'
        )
        if (screenshots)
          await page.screenshot({
            path: resolve(screenshots, `processes-${kind}-${width}-${dark ? 'dark' : 'light'}.png`),
            fullPage: true,
          })
        await page.keyboard.press('Escape')
        const stop = panel.getByRole('button', { name: 'Stop container test-db', exact: true })
        await stop.click()
        await Promise.all([
          page.waitForResponse((response) => response.url().endsWith('/containers/db/stop')),
          stop.click(),
        ])
        assert.equal(actions.length, 1)
        const signal = panel.getByRole('button', { name: 'Stop process 501', exact: true })
        await signal.click()
        await Promise.all([
          page.waitForResponse((response) => response.url().endsWith('/processes/501/signal')),
          signal.click(),
        ])
        await panel.getByRole('alert').filter({ hasText: 'no longer matches' }).waitFor()
        assert.equal(actions.length, 2)
      }
  assert.deepEqual(errors, [])
  console.log(
    'PASS: 16 browser cases (host/quota/reclaim/missing metrics, phone/desktop, light/dark), header attribution and aggregate quota, protected rows, container control and stale-PID refusal; no page errors.'
  )
} finally {
  await browser?.close()
  await server.close()
}
