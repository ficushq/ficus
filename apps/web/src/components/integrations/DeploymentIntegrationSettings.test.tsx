import { afterEach, beforeEach, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, getByRole, queryAllByRole, queryByRole } from '@testing-library/dom'
import { MemoryRouter } from 'react-router'
import { acquireDomHarness } from '../../test/domHarness'
import { integrationQueryKeys, queryKeys } from '../../queryKeys'
import { DeploymentIntegrationSettings } from './DeploymentIntegrationSettings'

let harness: Awaited<ReturnType<typeof acquireDomHarness>>
let root: import('react-dom/client').Root
let container: HTMLDivElement
let oldFetch: typeof globalThis.fetch
let requests: { url: string; method: string; body: string }[]

const account = (overrides: Record<string, unknown>) => ({
  id: 'production',
  providerKey: 'vercel',
  displayName: 'Production',
  enabled: true,
  authState: 'authenticated',
  healthState: 'healthy',
  configuration: { version: 1 },
  usage: { squadCount: 0, squads: [] },
  ...overrides,
})

beforeEach(async () => {
  harness = await acquireDomHarness({ url: 'http://localhost/settings' })
  ;({ root, container } = harness.createRoot())
  oldFetch = globalThis.fetch
  requests = []
  globalThis.fetch = (async (input, init) => {
    requests.push({ url: String(input), method: init?.method ?? 'GET', body: String(init?.body ?? '') })
    return Response.json({})
  }) as typeof fetch
})

afterEach(async () => {
  await harness.cleanup()
  globalThis.fetch = oldFetch
})

async function render(accounts: unknown[], canWrite = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(integrationQueryKeys.pool('vercel'), accounts)
  client.setQueryData(queryKeys.squads.list(), [])
  client.setQueryData(queryKeys.auth.permissions(), { permissions: [] })
  await harness.act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <DeploymentIntegrationSettings provider="vercel" label="Vercel" canWrite={canWrite} />
        </MemoryRouter>
      </QueryClientProvider>
    )
  )
}

const row = (title: string) => container.querySelector<HTMLElement>(`li[aria-label="${title}"]`)!
const rowButtons = (title: string) =>
  [...row(title).querySelectorAll(':scope > div:first-child button')].map(
    (button) => button.getAttribute('aria-label') ?? button.textContent
  )

async function click(element: Element) {
  await harness.act(async () => {
    fireEvent.click(element)
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function openMenu(title: string) {
  await click(getByRole(row(title), 'button', { name: `More actions for ${title}` }))
  return queryAllByRole(document.body, 'menuitem').map((item) => item.textContent)
}

test('each account shows its status, only the fix for it inline, and the rest in its menu', async () => {
  await render([
    account({ isGlobalDefault: true, usage: { squadCount: 2, squads: [] } }),
    account({ id: 'staging', displayName: 'Staging', authState: 'invalid' }),
    account({ id: 'old', displayName: 'Old', enabled: false }),
    account({ id: 'preview', displayName: 'Preview' }),
  ])
  expect(row('Production').textContent).toContain('Healthy')
  expect(row('Production').textContent).toContain('Global default')
  expect(rowButtons('Production')).toEqual(['More actions for Production'])
  expect(row('Staging').textContent).toContain('Invalid credentials')
  expect(rowButtons('Staging')).toEqual(['More actions for Staging'])
  expect(row('Old').textContent).toContain('Disabled')
  expect(rowButtons('Old')).toEqual(['Enable', 'More actions for Old'])

  expect(await openMenu('Production')).toEqual(['Validate', 'Replace token', 'Disable…', 'Remove…'])
  await click(getByRole(row('Production'), 'button', { name: 'More actions for Production' }))
  // An account that cannot deploy is not offered as the default.
  expect(await openMenu('Staging')).toEqual(['Validate', 'Replace token', 'Disable…', 'Remove…'])
  await click(getByRole(row('Staging'), 'button', { name: 'More actions for Staging' }))
  expect(await openMenu('Preview')).toEqual(['Validate', 'Make global default', 'Replace token', 'Disable…', 'Remove…'])
})

test('Remove and Disable confirm in the row, naming how many squads lose access', async () => {
  await render([account({ usage: { squadCount: 2, squads: [] } })])
  await openMenu('Production')
  await click(getByRole(document.body, 'menuitem', { name: 'Remove…' }))
  expect(requests.filter((request) => request.method !== 'GET')).toEqual([])
  expect(row('Production').textContent).toContain('Remove the Production connection? 2 squads lose Vercel access.')
  await click(getByRole(row('Production'), 'button', { name: 'Cancel' }))
  expect(row('Production').textContent).not.toContain('Remove the Production connection?')

  await openMenu('Production')
  await click(getByRole(document.body, 'menuitem', { name: 'Disable…' }))
  expect(row('Production').textContent).toContain('Disable the Production connection? 2 squads lose Vercel access.')
  await click(getByRole(row('Production'), 'button', { name: 'Disable' }))
  expect(requests.filter((request) => request.method === 'POST')).toEqual([
    {
      url: 'http://localhost/api/integrations/connections/production/disable',
      method: 'POST',
      body: '{"confirmAssigned":true}',
    },
  ])
})

test('Replace token opens the replacement form under the row', async () => {
  await render([account({})])
  expect(row('Production').querySelector('input')).toBeNull()
  await openMenu('Production')
  await click(getByRole(document.body, 'menuitem', { name: 'Replace token' }))
  expect(row('Production').textContent).toContain('Replacement token')
  await click(getByRole(row('Production'), 'button', { name: 'Cancel' }))
  expect(row('Production').textContent).not.toContain('Replacement token')
})

test('readers see each status without any account actions', async () => {
  await render([account({}), account({ id: 'old', displayName: 'Old', enabled: false })], false)
  expect(row('Old').textContent).toContain('Disabled')
  expect(queryByRole(container, 'button', { name: /More actions/ })).toBeNull()
  expect(rowButtons('Old')).toEqual([])
  expect(container.textContent).not.toContain('Add account')
})
