/**
 * Focused, DB-free Chromium review of managed shared BigBrain (Ficus Cloud) settings and squad
 * attachment, with the real components and stylesheet and synthetic API responses. No managed
 * server, credential or real owner link is involved: the owner link is a visibly synthetic value.
 * Asserts that nothing widens the page at 390px and captures every state, light and dark.
 * From apps/web: CHROMIUM_PATH=/path/to/chromium SCREENSHOT_DIR=/tmp/shots bun scripts/check-managed-bigbrain-layout.ts
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createServer } from 'vite'
import type { Browser, Page } from 'playwright-core'
import type { ManagedBigbrainVault } from '../src/api/integrations'

const root = resolve(import.meta.dir, '..')
const { chromium } = createRequire(resolve(root, '../core/package.json'))(
  'playwright-core'
) as typeof import('playwright-core')
const screenshotDir = process.env.SCREENSHOT_DIR
if (screenshotDir) await mkdir(screenshotDir, { recursive: true })

const RESEARCH = '11111111-1111-4111-8111-111111111111'
const DESIGN = '22222222-2222-4222-8222-222222222222'
const vault = (patch: Partial<ManagedBigbrainVault>): ManagedBigbrainVault => ({
  vaultId: RESEARCH,
  displayName: 'Research notes',
  ownerHandle: 'ficus',
  ownerLinksAvailable: true,
  state: 'ready',
  readAccess: 'active',
  desiredGeneration: 2,
  appliedGeneration: 2,
  upstreamVaultId: null,
  // Owner device links are only offered on a vault published at its address.
  origin: `https://bb-${'1'.repeat(32)}.vaults.example.test`,
  connectionId: `connection-${RESEARCH}`,
  lastErrorCode: null,
  retryable: false,
  pendingAction: null,
  backup: 'included',
  assignedSquads: [
    { id: 'squad-research', name: 'Research squad' },
    { id: 'squad-support', name: 'Customer support squad' },
  ],
  updatedAt: '2026-10-20T12:00:00.000Z',
  ...patch,
})
const scenarios: Record<string, ManagedBigbrainVault[]> = {
  empty: [],
  one: [vault({})],
  two: [
    vault({}),
    vault({
      vaultId: DESIGN,
      displayName: 'Design decisions',
      state: 'provisioning',
      readAccess: 'pending',
      appliedGeneration: 0,
      connectionId: null,
    }),
  ],
  attention: [
    vault({ state: 'degraded', readAccess: 'revoked', lastErrorCode: 'upstream_unavailable', retryable: true }),
    vault({
      vaultId: DESIGN,
      displayName: 'Design decisions',
      // A vault from before instance ownership whose anchor was lost: its old handle, no owner links.
      ownerHandle: 'ada',
      ownerLinksAvailable: false,
      state: 'failed',
      readAccess: 'pending',
      lastErrorCode: 'storage_unavailable',
      retryable: true,
      connectionId: null,
      backup: 'excluded',
      assignedSquads: [],
    }),
  ],
}
const SYNTHETIC_MEMBER_LINK = `https://bb-${'1'.repeat(32)}.vaults.example.test/invite#SYNTHETIC-member-preview-not-a-secret-000`
const rosterMember = (handle: string, displayName: string, patch: object = {}) => ({
  handle,
  displayName,
  role: 'member',
  access: 'write',
  status: 'active',
  createdAt: '2026-10-20T12:00:00.000Z',
  system: null,
  editable: true,
  ...patch,
})
const SYNTHETIC_LINK = `https://bb-${'1'.repeat(32)}.vaults.example.test/invite#SYNTHETIC-preview-link-not-a-secret-000000`

const server = await createServer({
  configFile: false,
  root,
  server: { host: '127.0.0.1', port: 0 },
  esbuild: { jsx: 'automatic' },
  plugins: [
    {
      name: 'managed-bigbrain-fixture',
      configureServer(server) {
        server.middlewares.use('/managed-bigbrain-fixture', (_req, res) => {
          res.setHeader('Content-Type', 'text/html')
          res.end(
            '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/scripts/fixtures/managed-bigbrain.tsx"></script></body></html>'
          )
        })
      },
    },
  ],
})

let browser: Browser | undefined
const errors: string[] = []
const measurements: unknown[] = []

/** Synthetic API with mutable state, per page. */
async function mockApi(page: Page, initial: ManagedBigbrainVault[]) {
  let vaults = initial.map((v) => ({ ...v }))
  let members = [
    rosterMember('ficus', 'Ficus', { role: 'owner', system: 'owner', editable: false, createdAt: null }),
    rosterMember('ficus-reader', 'Ficus', { access: 'read', system: 'reader', editable: false }),
    rosterMember('invite-0f3c9a7d2b1e4c5a6f7e8d9c', 'Grace Hopper'),
    rosterMember('invite-a1b2c3d4e5f60718293a4b5c', 'Katherine Johnson-Okonkwo (Research operations lead)', {
      access: 'read',
    }),
    rosterMember('invite-9e8d7c6b5a4f3e2d1c0b9a8f', 'lin.chen.with.a.very.long.address@example.test', {
      status: 'pending',
      access: 'read',
    }),
  ]
  let invites = [
    {
      inviteId: 'c'.repeat(24),
      displayName: 'Ada Lovelace',
      access: 'write',
      expiresAt: new Date(Date.now() + 20 * 3_600_000).toISOString(),
    },
  ]
  const attached = new Set(vaults.filter((v) => v.connectionId && v.vaultId === RESEARCH).map((v) => v.connectionId!))
  await page.unroute('**/api/**').catch(() => {})
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (!url.pathname.startsWith('/api/')) return route.continue()
    const method = request.method()
    const body = request.postData() ? JSON.parse(request.postData()!) : {}
    const base = '/api/integrations/providers/bigbrain/shared-vaults'
    if (url.pathname === base && method === 'GET') return route.fulfill({ json: { vaults } })
    if (url.pathname === base && method === 'POST') {
      const created = vault({
        vaultId: crypto.randomUUID(),
        displayName: body.displayName,
        state: 'provisioning',
        readAccess: 'pending',
        desiredGeneration: 1,
        appliedGeneration: 0,
        connectionId: null,
      })
      vaults = [...vaults, created]
      return route.fulfill({ status: 201, json: created })
    }
    const memberMatch = url.pathname.match(
      /^\/api\/integrations\/providers\/bigbrain\/shared-vaults\/[0-9a-f-]{36}\/(members|invites)(?:\/([a-z0-9._-]+)\/(access|remove|cancel))?$/
    )
    if (memberMatch) {
      const [, kind, target, action] = memberMatch
      if (kind === 'members' && !target && method === 'GET')
        return route.fulfill({ json: { members, invites, membersTruncated: false, invitesTruncated: false } })
      if (kind === 'invites' && !target && method === 'POST') {
        const created = {
          inviteId: 'd'.repeat(24),
          displayName: body.displayName,
          access: body.access,
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        }
        invites = [...invites, created]
        return route.fulfill({ status: 201, json: { ...created, inviteUrl: SYNTHETIC_MEMBER_LINK } })
      }
      if (action === 'cancel') {
        invites = invites.filter((i) => i.inviteId !== target)
        return route.fulfill({ json: { inviteId: target, cancelled: true } })
      }
      if (action === 'access' || action === 'remove') {
        const updated = {
          ...members.find((m) => m.handle === target)!,
          ...(action === 'access' ? { access: body.access } : { status: 'removed', editable: false }),
        }
        members =
          action === 'remove'
            ? members.filter((m) => m.handle !== target)
            : members.map((m) => (m.handle === target ? updated : m))
        return route.fulfill({ json: updated })
      }
    }
    const match = url.pathname.match(
      /^\/api\/integrations\/providers\/bigbrain\/shared-vaults\/([0-9a-f-]{36})(\/[a-z-]+)?$/
    )
    if (match) {
      const [, id, action] = match
      const current = vaults.find((v) => v.vaultId === id)!
      const update = (patch: Partial<ManagedBigbrainVault>) => {
        const next = { ...current, ...patch, desiredGeneration: current.desiredGeneration + 1 }
        vaults = vaults.map((v) => (v.vaultId === id ? next : v))
        return route.fulfill({ json: next })
      }
      if (action === '/owner-invite')
        return route.fulfill({
          json: { inviteUrl: SYNTHETIC_LINK, expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
        })
      if (action === '/read-access') return update({ readAccess: body.action === 'revoke' ? 'revoked' : 'pending' })
      if (action === '/retry') return update({ state: 'provisioning' })
      if (!action && method === 'PATCH') return update({ displayName: body.displayName })
      if (!action && method === 'DELETE') return update({ state: 'deleting' })
    }
    const squad = '/api/squads/squad-fixture/integrations/bigbrain'
    if (url.pathname === squad && method === 'GET') {
      const connections = vaults
        .filter((v) => v.connectionId)
        .map((v) => ({
          id: v.connectionId!,
          providerKey: 'bigbrain',
          displayName: v.displayName,
          enabled: v.readAccess === 'active',
          healthState: 'healthy',
        }))
      return route.fulfill({
        json: {
          providerKey: 'bigbrain',
          scope: { enabled: true, inheritDefault: false, globalDefaultId: null },
          assignment: null,
          connections,
          attached: connections.filter((c) => attached.has(c.id)).map((c) => ({ ...c, isDefault: false })),
        },
      })
    }
    if (url.pathname === `${squad}/assignment`) {
      if (method === 'PUT') attached.add(body.connectionId)
      if (method === 'DELETE') attached.delete(url.searchParams.get('connectionId')!)
      return method === 'DELETE' ? route.fulfill({ status: 204 }) : route.fulfill({ json: {} })
    }
    errors.push(`Unexpected API request: ${method} ${url.pathname}`)
    return route.fulfill({ status: 404, json: { error: 'not in fixture' } })
  })
}

async function open(page: Page, width: number, appearance: string, view = 'settings') {
  await page.setViewportSize({ width, height: 900 })
  await page.goto(`${server.resolvedUrls!.local[0]!}managed-bigbrain-fixture?appearance=${appearance}&view=${view}`)
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
    const dialog = page.getByRole('dialog')
    if (await dialog.count())
      await page.screenshot({ path: resolve(screenshotDir, `${name}-${width}-${appearance}.png`) })
    else {
      await page.setViewportSize({ width, height: Math.max(600, Math.min(result.page.height + 48, 2400)) })
      await page.screenshot({ path: resolve(screenshotDir, `${name}-${width}-${appearance}.png`) })
      await page.setViewportSize({ width, height: 900 })
    }
  }
}

try {
  await server.listen()
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] })
  for (const width of [1280, 390]) {
    for (const appearance of ['light', 'dark']) {
      const page = await browser.newPage({ hasTouch: true })
      page.setDefaultTimeout(10000)
      await page.emulateMedia({ reducedMotion: 'reduce' })
      page.on('pageerror', (error) => errors.push(error.message))
      const row = (name: string) => page.locator('li', { hasText: name })

      // Catalog in managed mode with zero, one and two vaults, and attention states.
      for (const [name, data] of Object.entries(scenarios)) {
        await mockApi(page, data)
        await open(page, width, appearance)
        await page
          .getByText(data.length ? data[0]!.displayName : 'No shared vaults yet.')
          .first()
          .waitFor()
        await capture(page, `vaults-${name}`, width, appearance)
      }

      // Create: a filled form, then the new vault setting up.
      await mockApi(page, scenarios.one!)
      await open(page, width, appearance)
      await page.getByLabel('Vault name').fill('Customer interviews')
      await capture(page, 'create-filled', width, appearance)
      await page.getByRole('button', { name: 'Create vault' }).click()
      await row('Customer interviews').getByText('Setting up').waitFor()
      await capture(page, 'create-provisioning', width, appearance)

      // Rename.
      await row('Research notes').getByRole('button', { name: 'Rename' }).click()
      await page.getByLabel('New name').fill('Research archive')
      await capture(page, 'rename-open', width, appearance)
      await page.getByRole('button', { name: 'Save' }).click()
      await row('Research archive').waitFor()

      // Revoke (two-step confirm), then reconnect.
      await row('Research archive').getByRole('button', { name: 'Revoke Ficus read access' }).click()
      await capture(page, 'revoke-confirm', width, appearance)
      await row('Research archive').getByRole('button', { name: 'Confirm revoke' }).click()
      await row('Research archive').getByText('Ficus read access revoked').waitFor()
      await capture(page, 'revoked-reconnect', width, appearance)
      await row('Research archive').getByRole('button', { name: 'Reconnect Ficus read access' }).click()
      await row('Research archive').getByText('Ficus read access pending').waitFor()

      // Delete confirmation with the backup-retention disclosure.
      await row('Research archive').getByRole('button', { name: 'Delete' }).click()
      await page.getByLabel('Type the vault name to confirm').fill('Research archive')
      await capture(page, 'delete-confirm', width, appearance)

      // Owner device link dialog with a synthetic link.
      await mockApi(page, scenarios.one!)
      await open(page, width, appearance)
      await row('Research notes').getByRole('button', { name: 'Connect owner device' }).click()
      await page.getByRole('dialog').waitFor()
      await capture(page, 'owner-link-before', width, appearance)
      await page.getByRole('button', { name: 'Create device link' }).click()
      await page.getByLabel('Owner device link').waitFor()
      assert.equal(await page.getByLabel('Owner device link').inputValue(), SYNTHETIC_LINK)
      await capture(page, 'owner-link-created', width, appearance)

      // Members: system members, a long name, a pending email member and a pending invite.
      await mockApi(page, scenarios.one!)
      await open(page, width, appearance)
      await row('Research notes').getByRole('button', { name: 'Members' }).first().click()
      await page.getByText('Katherine Johnson-Okonkwo (Research operations lead)', { exact: true }).waitFor()
      await capture(page, 'members-open', width, appearance)
      await page.getByRole('button', { name: 'Remove Grace Hopper' }).click()
      await capture(page, 'member-remove-confirm', width, appearance)
      // Armed, the button keeps its row-specific accessible name and shows "Confirm remove".
      await page.getByRole('button', { name: 'Remove Grace Hopper' }).getByText('Confirm remove').waitFor()
      await page.getByRole('button', { name: 'Remove Grace Hopper' }).click()
      await page.getByText('Grace Hopper', { exact: true }).waitFor({ state: 'detached' })
      await page.getByLabel('Access for Katherine Johnson-Okonkwo (Research operations lead)').selectOption('write')

      // Invite a member with a synthetic link.
      await page.getByRole('button', { name: 'Invite member' }).click()
      await page.getByRole('dialog').waitFor()
      await page.getByRole('dialog').getByLabel('Name', { exact: true }).fill('Mary Jackson')
      await page.getByRole('dialog').getByLabel('Read and write').check()
      await capture(page, 'member-invite-before', width, appearance)
      await page.getByRole('button', { name: 'Create invite link' }).click()
      await page.getByLabel('Member invite link').waitFor()
      assert.equal(await page.getByLabel('Member invite link').inputValue(), SYNTHETIC_MEMBER_LINK)
      await capture(page, 'member-invite-created', width, appearance)
      await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click()
      await page.getByRole('dialog').waitFor({ state: 'detached' })
      await page.getByText('Mary Jackson', { exact: true }).waitFor()
      await capture(page, 'members-after-invite', width, appearance)

      // Squad multi-vault attach: attach the second vault alongside the first.
      await mockApi(
        page,
        scenarios.two!.map((v) => ({ ...v, connectionId: `connection-${v.vaultId}`, readAccess: 'active' as const }))
      )
      await open(page, width, appearance, 'squad')
      await page.getByRole('button', { name: 'Settings' }).click()
      await page.getByText('Shared vaults for this squad').waitFor()
      // Controlled by server state: the box turns on once the squad selection is refetched.
      await page.getByLabel('Design decisions').click()
      await page.waitForFunction(() =>
        [...document.querySelectorAll('label')].some(
          (label) => label.textContent?.includes('Design decisions') && label.querySelector('input')?.checked
        )
      )
      assert.equal(await page.getByLabel('Research notes').isChecked(), true, 'attaching B keeps A attached')
      await capture(page, 'squad-attach-two', width, appearance)
      await page.close()
    }
  }
  assert.deepEqual(errors, [], 'No browser runtime errors or unexpected API requests')
  console.log(JSON.stringify(measurements))
  console.log(`Passed: ${measurements.length} captures without horizontal overflow at 1280 and 390px, light and dark.`)
} catch (error) {
  // Diagnostics only: the current page and any runtime errors, then fail.
  const pages = browser?.contexts().flatMap((context) => context.pages()) ?? []
  if (screenshotDir && pages.at(-1)) await pages.at(-1)!.screenshot({ path: resolve(screenshotDir, 'failure.png') })
  console.error('Errors so far:', errors)
  throw error
} finally {
  await browser?.close()
  await server.close()
}
