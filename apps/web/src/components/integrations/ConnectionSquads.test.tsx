import { afterEach, beforeEach, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, getByRole, queryByRole } from '@testing-library/dom'
import { MemoryRouter } from 'react-router'
import { acquireDomHarness } from '../../test/domHarness'
import { queryKeys } from '../../queryKeys'
import type { IntegrationConnection } from '../../api/integrations'

let harness: Awaited<ReturnType<typeof acquireDomHarness>>
let root: import('react-dom/client').Root
let container: HTMLDivElement
let oldFetch: typeof globalThis.fetch
let requests: { url: string; method: string; body: unknown }[]

beforeEach(async () => {
  harness = await acquireDomHarness({ url: 'http://localhost/settings' })
  ;({ root, container } = harness.createRoot())
  oldFetch = globalThis.fetch
  requests = []
  globalThis.fetch = (async (input, init) => {
    requests.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    })
    return init?.method === 'PUT' ? Response.json({ id: 'x' }) : new Promise<Response>(() => {})
  }) as typeof fetch
})
afterEach(async () => {
  globalThis.fetch = oldFetch
  await harness.cleanup()
})

const account = (id: string, squads: { id: string; name: string }[], overrides: Partial<IntegrationConnection> = {}) =>
  ({
    id,
    providerKey: 'vercel',
    displayName: id,
    enabled: true,
    authState: 'authenticated',
    healthState: 'healthy',
    configuration: { version: 1 },
    usage: { squadCount: squads.length, squads },
    ...overrides,
  }) as IntegrationConnection

async function render(provider: string, connection: IntegrationConnection, connections: IntegrationConnection[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.squads.list(), [
    { id: 'squad-1', name: 'Web', status: 'active' },
    { id: 'squad-2', name: 'Mobile', status: 'paused' },
  ])
  client.setQueryData(queryKeys.auth.permissions(), { permissions: ['*'] })
  const { ConnectionSquads } = await import('./ConnectionSquads')
  await harness.act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <ConnectionSquads
            provider={provider}
            providerLabel="Vercel"
            connection={connection}
            connections={connections}
            inherited={connection.isGlobalDefault}
          />
        </MemoryRouter>
      </QueryClientProvider>
    )
  )
}

async function add(squadId: string) {
  await harness.act(async () => {
    fireEvent.change(getByRole(container, 'combobox'), { target: { value: squadId } })
  })
  await harness.act(async () => {
    fireEvent.click(getByRole(container, 'button', { name: 'Add to squad' }))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

test('several-account providers add another account beside a squad’s current one, and make the first one its default', async () => {
  const second = account('second', [])
  await render('vercel', second, [account('first', [{ id: 'squad-1', name: 'Web' }]), second])
  // A squad keeps its other accounts, so nothing is "replaced".
  expect([...getByRole(container, 'combobox').querySelectorAll('option')].map((option) => option.textContent)).toEqual([
    'Choose a squad',
    'Web',
    'Mobile',
  ])
  await add('squad-1')
  await add('squad-2')
  expect(requests.filter((request) => request.method === 'PUT').map((request) => [request.url, request.body])).toEqual([
    [
      'http://localhost/api/squads/squad-1/integrations/vercel/assignment',
      { connectionId: 'second', makeDefault: false },
    ],
    [
      'http://localhost/api/squads/squad-2/integrations/vercel/assignment',
      { connectionId: 'second', makeDefault: true },
    ],
  ])
})

test('a global default that squads inherit is not reported as unused', async () => {
  const fallback = account('default', [], { providerKey: 'github', isGlobalDefault: true })
  await render('github', fallback, [fallback])
  expect(container.textContent).toContain('Squads use this account as the global default')
  expect(container.textContent).not.toContain('No squad can use')
})

test('a long list of squads stays one line with a count of the rest', async () => {
  const squads = Array.from({ length: 11 }, (_, index) => ({ id: `squad-${index}`, name: `Squad ${index}` }))
  const busy = account('busy', squads)
  await render('vercel', busy, [busy])
  expect(container.querySelectorAll('a')).toHaveLength(8)
  expect(container.textContent).toContain('and 3 more')
  expect(queryByRole(container, 'combobox')).toBeNull()
})
