import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent } from '@testing-library/dom'
import { acquireDomHarness } from '../../test/domHarness'
import { integrationQueryKeys } from '../../queryKeys'

let harness: Awaited<ReturnType<typeof acquireDomHarness>>
let root: import('react-dom/client').Root
let container: HTMLDivElement
let oldFetch: typeof globalThis.fetch
let requests: { url: string; method: string; body: string }[]
let fetchHandler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

const connection = {
  id: 'connection-1',
  providerKey: 'bigbrain',
  adapterVersion: 2,
  displayName: 'Primary Brain',
  configuration: {
    version: 2,
    bindingId: 'approved',
    bindingFingerprint: 'a'.repeat(64),
    vaultPath: '/vault',
    executablePath: '/bin/bigbrain',
  },
  credentialConfigured: true,
  enabled: true,
  authState: 'authenticated',
  healthState: 'healthy',
  grantedScopes: ['mcp:load_memory', 'mcp:search_vault', 'mcp:read_note', 'mcp:drop'],
  validatedAt: '2026-01-01',
  validationExpiresAt: '2026-01-02',
  lastErrorCode: null,
  usage: { squadCount: 0, squads: [] },
}
const secondConnection = {
  ...connection,
  id: 'connection-2',
  displayName: 'Secondary Brain',
  configuration: {
    version: 2,
    bindingId: 'second',
    bindingFingerprint: 'b'.repeat(64),
    vaultPath: '/second',
    executablePath: '/bin/bigbrain',
  },
  enabled: false,
}

beforeEach(async () => {
  harness = await acquireDomHarness({ url: 'http://localhost' })
  ;({ root, container } = harness.createRoot())
  oldFetch = globalThis.fetch
  requests = []
  fetchHandler = async (_input, init) => Response.json((init?.method ?? 'GET') === 'GET' ? [connection] : connection)
  globalThis.fetch = (async (input, init) => {
    requests.push({ url: String(input), method: init?.method ?? 'GET', body: String(init?.body ?? '') })
    if (String(input).endsWith('/local-bindings'))
      return Response.json({
        state: 'available',
        bindings: [{ id: 'approved', label: 'Approved vault', vaultPath: '/vault', executablePath: '/bin/bigbrain' }],
      })
    if ((init?.method ?? 'GET') === 'GET') return Response.json([connection])
    return fetchHandler(input, init)
  }) as typeof fetch
})

afterEach(async () => {
  globalThis.fetch = oldFetch
  await harness.cleanup()
})

async function render(data: unknown[] | undefined, canRead = true, canWrite = true) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
  })
  client.setQueryData(integrationQueryKeys.localBindings(), {
    state: 'available',
    bindings: [{ id: 'approved', label: 'Approved vault', vaultPath: '/vault', executablePath: '/bin/bigbrain' }],
  })
  if (data !== undefined) client.setQueryData(integrationQueryKeys.pool('bigbrain'), data)
  const { BigbrainIntegrationSettings } = await import('./BigbrainIntegrationSettings')
  await harness.act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <BigbrainIntegrationSettings canRead={canRead} canWrite={canWrite} />
      </QueryClientProvider>
    )
  )
  return { client, BigbrainIntegrationSettings }
}

function button(label: string, scope: ParentNode = container): HTMLButtonElement {
  return [...scope.querySelectorAll('button')].find((candidate) => candidate.textContent === label)!
}

async function settle() {
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('BigbrainIntegrationSettings', () => {
  test('does not query or render without global read permission', async () => {
    await render(undefined, false, false)
    expect(container.innerHTML).toBe('')
    expect(requests).toHaveLength(0)
  })
  test('explains Core host paths without credential or transcript controls', async () => {
    await render([connection, secondConnection], true, false)
    expect(container.textContent).toContain('Core host')
    expect(container.textContent).toContain('/vault')
    expect(container.textContent).toContain('Enabled · healthy')
    expect(container.textContent).toContain('Configured · disabled')
    expect(container.querySelector('input[type=password]')).toBeNull()
    expect(container.textContent).not.toContain('Replace credential')
    expect(container.textContent).not.toContain('consent')
  })
  test('selects only an approved binding and creates without API or token fields', async () => {
    await render([])
    await harness.act(async () => {
      fireEvent.click(container.querySelector('[role=combobox]')!)
      await settle()
    })
    await harness.act(async () => {
      fireEvent.click(document.querySelector('[role=option]')!)
      await settle()
    })
    const name = container.querySelector<HTMLInputElement>('input[aria-label="BigBrain display name"]')!
    await harness.act(async () => {
      fireEvent.input(name, { target: { value: 'Memory' } })
      name.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      await settle()
    })
    const request = requests.find((r) => r.method === 'POST')!
    expect(request.url).toContain('/providers/bigbrain/local-connections')
    expect(JSON.parse(request.body)).toEqual({ bindingId: 'approved', displayName: 'Memory' })
  })
  test.each(['unsupported_host', 'setup_required', 'invalid_configuration'] as const)(
    'shows actionable %s setup state',
    async (state) => {
      const { client } = await render([])
      await harness.act(async () => {
        client.setQueryData(integrationQueryKeys.localBindings(), { state, bindings: [] })
        await settle()
      })
      expect(container.textContent).toContain(
        state === 'unsupported_host' ? 'same-host self-hosted' : 'bigbrain-bindings.json'
      )
      expect(button('Create and validate')).toBeUndefined()
    }
  )
  test('reports validation failures instead of claiming success on a safe response', async () => {
    fetchHandler = async () => Response.json({ ...connection, lastErrorCode: 'invalid_auth' })
    await render([connection])
    await harness.act(async () => {
      fireEvent.click(button('Validate'))
      await settle()
    })
    expect(container.textContent).not.toContain('Connection validated.')
    expect(container.textContent).toContain('invalid_auth')
  })
  test('requires authoritative assigned-squad confirmation for disabling', async () => {
    fetchHandler = async (_input, init) =>
      init?.body && !String(init.body).includes('confirmAssigned')
        ? Response.json(
            { error: 'Assigned', usage: { squadCount: 1, squads: [{ id: 'squad', name: 'Research' }] } },
            { status: 409 }
          )
        : Response.json(connection)
    await render([connection])
    await harness.act(async () => {
      fireEvent.click(button('Disable'))
      await settle()
    })
    expect(container.textContent).toContain('Research')
    await harness.act(async () => {
      fireEvent.click(button('Confirm impact'))
      await settle()
    })
    expect(requests.some((r) => r.body.includes('"confirmAssigned":true'))).toBe(true)
  })
})

test('supported Desktop with no binding explains local setup and trusted host limits, not an unsupported deployment', async () => {
  const { client } = await render([])
  await harness.act(async () => {
    client.setQueryData(integrationQueryKeys.localBindings(), { state: 'setup_required', bindings: [] })
    await settle()
  })
  expect(container.querySelector('h3')?.textContent).toBe('BigBrain')
  expect(container.textContent).toContain('Desktop local runtime')
  expect(container.textContent).toContain('HOME_DIR')
  expect(container.textContent).toContain('OS HOME')
  expect(container.textContent).toContain('no filesystem isolation')
  expect(container.textContent).not.toContain('requires same-host self-hosted Ficus with an isolated')
})

test('missing executable/credential and invalid permissions give different actionable setup guidance', async () => {
  const { client } = await render([])
  for (const [state, text] of [
    ['binding_unavailable', 'missing or unreadable'],
    ['invalid_configuration', 'ownership and permissions'],
  ] as const) {
    await harness.act(async () => {
      client.setQueryData(integrationQueryKeys.localBindings(), { state, bindings: [] })
      await settle()
    })
    expect(container.textContent).toContain(text)
    expect(container.textContent).not.toContain('isolated agent runtime')
  }
})
