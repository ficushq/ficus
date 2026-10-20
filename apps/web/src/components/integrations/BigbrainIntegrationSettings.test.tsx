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

const readyState = {
  state: 'ready',
  hostPlatform: 'darwin',
  executablePath: '/Users/me/.local/bin/bigbrain',
  vaults: [{ id: 'a'.repeat(16), label: 'BigBrain · vault', vaultPath: '/Users/me/vault', source: 'bigbrain_default' }],
  bindingsFile: 'none',
  connectionName: 'Local MCP configuration',
  access: ['vault:read', 'inbox:write'],
}
let setupState: Record<string, unknown> = readyState

beforeEach(async () => {
  setupState = readyState
  harness = await acquireDomHarness({ url: 'http://localhost' })
  ;({ root, container } = harness.createRoot())
  oldFetch = globalThis.fetch
  requests = []
  fetchHandler = async (_input, init) => Response.json((init?.method ?? 'GET') === 'GET' ? [connection] : connection)
  globalThis.fetch = (async (input, init) => {
    requests.push({ url: String(input), method: init?.method ?? 'GET', body: String(init?.body ?? '') })
    if ((init?.method ?? 'GET') === 'GET' && String(input).endsWith('/local-setup')) return Response.json(setupState)
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
  if (canWrite) client.setQueryData(integrationQueryKeys.localSetup(), setupState)
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
  test('connects a detected vault after showing whole-vault access, without paths, argv or tokens', async () => {
    fetchHandler = async () =>
      Response.json({
        connection: { ...connection, displayName: 'BigBrain · vault' },
        vault: readyState.vaults[0],
        bindingsFile: 'created',
        connectionOutcome: 'created',
        enabled: true,
      })
    await render([])
    expect(container.textContent).not.toContain('bigbrain-bindings.json')
    expect(container.textContent).not.toContain('Connected Clients')
    await harness.act(async () => {
      fireEvent.click(button('Connect BigBrain on this Mac'))
      await settle()
    })
    expect(container.textContent).toContain('/Users/me/vault')
    expect(container.textContent).toContain('read the whole vault')
    expect(container.textContent).toContain('Local MCP configuration')
    expect(requests.some((r) => r.method === 'POST')).toBe(false)
    await harness.act(async () => {
      fireEvent.click(button('Confirm and connect'))
      await settle()
    })
    const request = requests.find((r) => r.method === 'POST')!
    expect(request.url).toContain('/providers/bigbrain/local-setup')
    expect(JSON.parse(request.body)).toEqual({ vaultId: 'a'.repeat(16), confirmVaultAccess: true })
    expect(container.textContent).toContain('BigBrain connected: BigBrain · vault')
  })
  test('another folder can be typed; an existing hand-written file needs explicit adoption', async () => {
    setupState = { ...readyState, vaults: [], bindingsFile: 'unmanaged' }
    await render([])
    await harness.act(async () => {
      fireEvent.click(button('Connect BigBrain on this Mac'))
      await settle()
    })
    expect(container.textContent).toContain('did not find a BigBrain vault')
    const folder = container.querySelector<HTMLInputElement>('input[aria-label="BigBrain vault folder"]')!
    await harness.act(async () => {
      fireEvent.input(folder, { target: { value: '/Users/me/Work Vault' } })
      await settle()
    })
    expect(button('Confirm and connect').disabled).toBe(true)
    await harness.act(async () => {
      fireEvent.click(container.querySelector('input[type=checkbox]')!)
      await settle()
    })
    await harness.act(async () => {
      fireEvent.click(button('Confirm and connect'))
      await settle()
    })
    expect(JSON.parse(requests.find((r) => r.method === 'POST')!.body)).toEqual({
      vaultPath: '/Users/me/Work Vault',
      replaceExisting: true,
      confirmVaultAccess: true,
    })
  })
  test('shows the sanitized server error when setup fails', async () => {
    fetchHandler = async () =>
      Response.json(
        { error: 'BigBrain did not answer in time. Open BigBrain.app, then try again.', code: 'upstream_timeout' },
        { status: 400 }
      )
    await render([])
    await harness.act(async () => {
      fireEvent.click(button('Connect BigBrain on this Mac'))
      await settle()
    })
    await harness.act(async () => {
      fireEvent.click(button('Confirm and connect'))
      await settle()
    })
    expect(container.querySelector('[role=alert]')?.textContent).toContain('BigBrain did not answer in time')
  })
  test.each([
    ['unsupported_host', 'unavailable on Ficus Cloud'],
    ['executable_missing', 'Install and open BigBrain.app'],
  ] as const)('shows actionable %s setup state without a connect action', async (state, reason) => {
    setupState = { ...readyState, state, reason: `Reason: ${reason}`, vaults: [] }
    await render([])
    expect(container.textContent).toContain(reason)
    expect(button('Confirm and connect')).toBeUndefined()
    expect(button('Connect BigBrain on this Mac')).toBeUndefined()
  })
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

test('explains trusted host limits and never asks for hand-written setup', async () => {
  await render([])
  expect(container.querySelector('h3')?.textContent).toBe('BigBrain')
  expect(container.textContent).toContain('Desktop local runtime')
  expect(container.textContent).toContain('no filesystem isolation')
  expect(container.textContent).not.toContain('HOME_DIR')
  expect(container.textContent).not.toContain('bigbrain-bindings.json')
})
