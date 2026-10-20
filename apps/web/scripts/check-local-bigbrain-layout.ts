/**
 * Focused, DB-free Chromium review of one-click local BigBrain setup (Desktop local runtime /
 * self-hosted Core), with the real components and stylesheet and synthetic API responses. No
 * BigBrain install, vault or credential is involved; paths are visibly synthetic.
 * Asserts that nothing widens the page at 390px and captures every state, light and dark.
 * From apps/web: CHROMIUM_PATH=/path/to/chromium SCREENSHOT_DIR=/tmp/shots bun scripts/check-local-bigbrain-layout.ts
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createServer } from 'vite'
import type { Browser, Page } from 'playwright-core'
import type { BigbrainLocalSetupState, IntegrationConnection } from '../src/api/integrations'

const root = resolve(import.meta.dir, '..')
const { chromium } = createRequire(resolve(root, '../core/package.json'))(
  'playwright-core'
) as typeof import('playwright-core')
const screenshotDir = process.env.SCREENSHOT_DIR
if (screenshotDir) await mkdir(screenshotDir, { recursive: true })

const VAULT = '/Users/ada/Library/Mobile Documents/BigBrain/Research and Personal Notes Vault'
const ready: BigbrainLocalSetupState = {
  state: 'ready',
  hostPlatform: 'darwin',
  executablePath: '/Users/ada/.local/bin/bigbrain',
  vaults: [
    {
      id: 'a'.repeat(16),
      label: 'BigBrain · Research and Personal Notes Vault',
      vaultPath: VAULT,
      source: 'bigbrain_default',
    },
  ],
  bindingsFile: 'none',
  connectionName: 'Local MCP configuration',
  access: ['vault:read', 'inbox:write'],
}
const connected: IntegrationConnection = {
  id: '33333333-3333-4333-8333-333333333333',
  providerKey: 'bigbrain',
  adapterVersion: 2,
  displayName: 'BigBrain · Research and Personal Notes Vault',
  configuration: {
    version: 2,
    bindingId: 'vault-0123456789ab',
    vaultPath: VAULT,
    executablePath: ready.executablePath,
  },
  credentialConfigured: true,
  enabled: true,
  authState: 'authenticated',
  healthState: 'healthy',
  grantedScopes: ['mcp:load_memory', 'mcp:search_vault', 'mcp:read_note', 'mcp:drop'],
  validatedAt: '2026-10-20T12:00:00.000Z',
  validationExpiresAt: '2026-10-20T12:15:00.000Z',
  lastErrorCode: null,
  usage: { squadCount: 0, squads: [] },
} as unknown as IntegrationConnection

const server = await createServer({
  configFile: false,
  root,
  server: { host: '127.0.0.1', port: 0 },
  esbuild: { jsx: 'automatic' },
  plugins: [
    {
      name: 'local-bigbrain-fixture',
      configureServer(server) {
        server.middlewares.use('/local-bigbrain-fixture', (_req, res) => {
          res.setHeader('Content-Type', 'text/html')
          res.end(
            '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/scripts/fixtures/local-bigbrain.tsx"></script></body></html>'
          )
        })
      },
    },
  ],
})

let browser: Browser | undefined
const errors: string[] = []
const measurements: unknown[] = []

type Outcome = { status: number; json: unknown }
async function mockApi(page: Page, setup: BigbrainLocalSetupState, connect?: Outcome) {
  let connections: IntegrationConnection[] = []
  await page.unroute('**/api/**').catch(() => {})
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (!url.pathname.startsWith('/api/')) return route.continue()
    const method = request.method()
    if (url.pathname === '/api/integrations/connections' && method === 'GET')
      return route.fulfill({ json: connections })
    if (url.pathname === '/api/integrations/providers/bigbrain/local-setup' && method === 'GET')
      return route.fulfill({ json: setup })
    if (url.pathname === '/api/integrations/providers/bigbrain/local-setup' && method === 'POST') {
      const outcome = connect ?? {
        status: 200,
        json: {
          connection: connected,
          vault: setup.vaults[0],
          bindingsFile: 'created',
          connectionOutcome: 'created',
          enabled: true,
        },
      }
      if (outcome.status === 200) connections = [connected]
      return route.fulfill({ status: outcome.status, json: outcome.json })
    }
    errors.push(`Unexpected API request: ${method} ${url.pathname}`)
    return route.fulfill({ status: 404, json: { error: 'not in fixture' } })
  })
}

async function open(page: Page, width: number, appearance: string) {
  await page.setViewportSize({ width, height: 900 })
  await page.goto(`${server.resolvedUrls!.local[0]!}local-bigbrain-fixture?appearance=${appearance}`, {
    timeout: 120_000,
  })
}

async function capture(page: Page, name: string, width: number, appearance: string) {
  const result = await page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>('[data-fixture-scroller]')!
    return {
      document: document.documentElement.scrollWidth,
      page: { client: scroller.clientWidth, scroll: scroller.scrollWidth, height: scroller.scrollHeight },
    }
  })
  measurements.push({ name, width, appearance, ...result })
  assert.ok(result.document <= width, `${name} ${width}px ${appearance}: the document is wider than the viewport`)
  assert.ok(result.page.scroll <= result.page.client, `${name} ${width}px ${appearance}: the page scrolls sideways`)
  if (screenshotDir) {
    await page.setViewportSize({ width, height: Math.max(600, Math.min(result.page.height + 48, 2400)) })
    await page.screenshot({ path: resolve(screenshotDir, `${name}-${width}-${appearance}.png`) })
    await page.setViewportSize({ width, height: 900 })
  }
}

const connectButton = (page: Page) => page.getByRole('button', { name: 'Connect BigBrain on this Mac' })

try {
  await server.listen()
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] })
  for (const width of [1280, 390]) {
    for (const appearance of ['light', 'dark']) {
      const page = await browser.newPage({ hasTouch: true })
      page.setDefaultTimeout(10000)
      await page.emulateMedia({ reducedMotion: 'reduce' })
      page.on('pageerror', (error) => errors.push(error.message))

      // Action, confirmation with the vault and whole-vault access, then connected.
      await mockApi(page, ready)
      await open(page, width, appearance)
      await connectButton(page).waitFor()
      await capture(page, 'setup-action', width, appearance)
      await connectButton(page).click()
      await page.getByText('can read the whole vault').waitFor()
      await capture(page, 'setup-confirm', width, appearance)
      await page.getByRole('button', { name: 'Confirm and connect' }).click()
      await page.getByText('BigBrain connected:').waitFor()
      await page.getByText('Enabled · healthy').waitFor()
      await capture(page, 'setup-connected', width, appearance)

      // No vault detected: a typed folder, and an existing hand-written file to adopt.
      await mockApi(page, { ...ready, vaults: [], bindingsFile: 'unmanaged' })
      await open(page, width, appearance)
      await connectButton(page).click()
      await page.getByLabel('BigBrain vault folder').fill('/Users/ada/Documents/Work Vault')
      await capture(page, 'setup-folder-adopt', width, appearance)

      // A sanitized upstream failure.
      await mockApi(page, ready, {
        status: 400,
        json: {
          error:
            'The "Local MCP configuration" connection was revoked in BigBrain. Reconnect it in BigBrain.app under Connected Clients, then try again.',
          code: 'upstream_connection_revoked',
        },
      })
      await open(page, width, appearance)
      await connectButton(page).click()
      await page.getByRole('button', { name: 'Confirm and connect' }).click()
      await page.getByText('was revoked in BigBrain').waitFor()
      await capture(page, 'setup-error', width, appearance)

      // BigBrain not installed.
      await mockApi(page, {
        ...ready,
        state: 'executable_missing',
        executablePath: undefined,
        vaults: [],
        reason:
          'BigBrain is not installed for the account that runs Ficus. Install and open BigBrain.app, then try again.',
      })
      await open(page, width, appearance)
      await page.getByText('Install and open BigBrain.app').waitFor()
      await capture(page, 'setup-missing', width, appearance)
      await page.close()
    }
  }
  assert.deepEqual(errors, [], 'No browser runtime errors or unexpected API requests')
  console.log(JSON.stringify(measurements))
  console.log(`Passed: ${measurements.length} captures without horizontal overflow at 1280 and 390px, light and dark.`)
} catch (error) {
  const pages = browser?.contexts().flatMap((context) => context.pages()) ?? []
  if (screenshotDir && pages.at(-1)) await pages.at(-1)!.screenshot({ path: resolve(screenshotDir, 'failure.png') })
  console.error('Errors so far:', errors)
  throw error
} finally {
  await browser?.close()
  await server.close()
}
