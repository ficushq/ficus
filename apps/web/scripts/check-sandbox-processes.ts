/** DB-free browser proof of the real Processes panel and squad header. All API data
 * and controls are synthetic. CHROMIUM_PATH selects a browser; SCREENSHOT_DIR is optional.
 * From apps/web: bun scripts/check-sandbox-processes.ts
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createServer } from 'vite'
import type { Browser } from 'playwright-core'
import type { SandboxPressure, SandboxProcesses } from '@ficus/shared'

const root = resolve(import.meta.dir, '..')
const { chromium } = createRequire(resolve(root, '../core/package.json'))(
  'playwright-core'
) as typeof import('playwright-core')
const screenshots = process.env.SCREENSHOT_DIR
if (screenshots) await mkdir(screenshots, { recursive: true })
const server = await createServer({
  configFile: false,
  root,
  server: { host: '127.0.0.1', port: 0 },
  esbuild: { jsx: 'automatic' },
  plugins: [
    {
      name: 'processes-fixture',
      configureServer(server) {
        server.middlewares.use('/processes-fixture', (_req, res) => {
          res.setHeader('Content-Type', 'text/html')
          res.end(
            '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/scripts/fixtures/sandbox-processes.tsx"></script></body></html>'
          )
        })
      },
    },
  ],
})
let browser: Browser | undefined
try {
  await server.listen()
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
    if (path === '/api/squads/synthetic/sandbox/containers/db/stop') {
      actions.push(path)
      return route.fulfill({ json: { id: 'db' } })
    }
    errors.push(`Unexpected API request: ${path}`)
    return route.abort()
  })
  for (const kind of ['host', 'local', 'missing'] as const)
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
                  cpuPercent: 20,
                  sampleMs: 1000,
                  cpuPressureSome: quiet,
                  memoryPressureSome: kind === 'local' ? { avg10: 25, avg60: 10, avg300: 5 } : quiet,
                },
              }),
        }
        actions = []
        await page.setViewportSize({ width, height: 900 })
        await page.goto(`${server.resolvedUrls!.local[0]}processes-fixture${dark ? '?dark' : ''}`)
        await page.getByRole('button', { name: 'Show processes' }).click()
        const label = kind === 'local' ? 'This sandbox overloaded' : 'Host overloaded'
        const panel = page.getByRole('region', { name: 'Processes' })
        await panel.getByText(`${label}:`, { exact: true }).waitFor()
        assert.match(await panel.innerText(), /Load 35.8 on 8 CPUs/)
        assert.match(await panel.innerText(), kind === 'missing' ? /CPU unavailable/ : /20.0% CPU/)
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
      }
  assert.deepEqual(errors, [])
  console.log(
    'PASS: 12 browser cases (host/local/missing metrics, phone/desktop, light/dark), header attribution, protected rows and container control; no page errors.'
  )
} finally {
  await browser?.close()
  await server.close()
}
