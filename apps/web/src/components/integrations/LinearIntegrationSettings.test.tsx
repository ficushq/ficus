import { afterEach, beforeEach, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, getByRole, queryByRole } from '@testing-library/dom'
import { MemoryRouter } from 'react-router'
import { acquireDomHarness } from '../../test/domHarness'
import { integrationQueryKeys, queryKeys } from '../../queryKeys'

let harness: Awaited<ReturnType<typeof acquireDomHarness>>
let root: import('react-dom/client').Root
let container: HTMLDivElement
let oldFetch: typeof globalThis.fetch

const localApp = {
  authority: 'local',
  configured: false,
  clientId: null,
  callbackUrl: 'https://ficus.example/settings/integrations/oauth/callback/linear',
  webhookUrl: 'https://ficus.example/api/webhooks/linear-app',
  requiredCapabilities: [],
}
const hostedApp = {
  authority: 'platform_broker',
  configured: true,
  clientId: null,
  callbackUrl: 'x',
  requiredCapabilities: [],
}

const connection = (overrides: Record<string, unknown>) => ({
  id: 'connection-1',
  providerKey: 'linear',
  displayName: 'Personal key',
  enabled: true,
  authState: 'authenticated',
  healthState: 'healthy',
  configuration: { version: 1 },
  usage: { squadCount: 0, squads: [] },
  ...overrides,
})
const appConfiguration = {
  version: 2,
  mode: 'app',
  organizationId: 'org-1',
  organizationName: 'Acme',
  organizationUrlKey: 'acme',
  missingScopes: [],
}
const appConnection = (overrides: Record<string, unknown> = {}) =>
  connection({ id: 'app-connection', displayName: 'Acme (Ficus app)', configuration: appConfiguration, ...overrides })

const squads = [
  { id: 'squad-1', name: 'Platform', status: 'active' },
  { id: 'squad-2', name: 'Growth', status: 'active' },
  { id: 'squad-3', name: 'Old', status: 'archived' },
]

beforeEach(async () => {
  harness = await acquireDomHarness({ url: 'http://localhost/settings' })
  ;({ root, container } = harness.createRoot())
  oldFetch = globalThis.fetch
})
afterEach(async () => {
  globalThis.fetch = oldFetch
  await harness.cleanup()
})

async function render(
  app: Record<string, unknown>,
  pool: unknown[] = [],
  access: { permissions?: string[]; squadPermissions?: Record<string, string[]> } = {
    permissions: ['integrations:write'],
  }
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(integrationQueryKeys.pool('linear'), pool)
  client.setQueryData(integrationQueryKeys.linearWebhook(), {
    configured: false,
    webhookUrl: 'https://ficus.example/api/webhooks/linear',
  })
  client.setQueryData([...integrationQueryKeys.all, 'oauth-app', 'linear'], app)
  client.setQueryData(queryKeys.squads.list(), squads)
  client.setQueryData(queryKeys.auth.permissions(), { permissions: access.permissions ?? [] })
  for (const [squadId, permissions] of Object.entries(access.squadPermissions ?? {}))
    client.setQueryData(queryKeys.auth.permissions(squadId), { permissions })
  const { LinearIntegrationSettings } = await import('./LinearIntegrationSettings')
  await harness.act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <LinearIntegrationSettings canWrite />
        </MemoryRouter>
      </QueryClientProvider>
    )
  )
}

const buttonNamed = (name: string) =>
  [...container.querySelectorAll('button')].find((candidate) => candidate.textContent === name)
const row = (title: string) => container.querySelector<HTMLLIElement>(`li[aria-label="${title}"]`)!
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

async function click(element: Element) {
  await harness.act(async () => {
    fireEvent.click(element)
    await settle()
  })
}

async function chooseFromMenu(title: string, item: string) {
  await click(getByRole(row(title), 'button', { name: `More actions for ${title}` }))
  await click(getByRole(document.body, 'menuitem', { name: item }))
}

async function type(label: string, value: string) {
  const input = [...container.querySelectorAll('label')]
    .find((candidate) => candidate.textContent?.startsWith(label))!
    .querySelector('input')!
  await harness.act(async () => {
    fireEvent.change(input, { target: { value } })
  })
}

function recordRequests(respond: (url: string, init?: RequestInit) => Response | Promise<Response> | undefined) {
  const requests: { url: string; method: string; body: unknown }[] = []
  globalThis.fetch = (async (input, init) => {
    const url = String(input)
    requests.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined })
    return respond(url, init) ?? new Promise<Response>(() => {})
  }) as typeof fetch
  return requests
}

test('a self-hosted operator saves the Linear app settings and sees both URLs; secrets are cleared after saving', async () => {
  const requests: { url: string; body: string }[] = []
  globalThis.fetch = (async (input, init) => {
    requests.push({ url: String(input), body: String(init?.body) })
    // Saving refreshes every integration query; only the app settings change.
    if (!String(input).endsWith('/oauth-app')) return new Promise<Response>(() => {})
    return Response.json({ ...localApp, configured: true, clientId: 'linear-client' })
  }) as typeof fetch
  await render(localApp)
  expect(container.querySelector('[data-testid="linear-app-callback-url"]')?.textContent).toBe(localApp.callbackUrl)
  expect(container.querySelector('[data-testid="linear-app-webhook-url"]')?.textContent).toBe(localApp.webhookUrl)
  expect(buttonNamed('Install Ficus in Linear')).toBeUndefined()

  await type('Client ID', 'linear-client')
  await type('Client secret', 'synthetic-client-secret')
  await type('Webhook signing secret', 'synthetic-webhook-secret')
  expect(buttonNamed('Save Linear application')?.hasAttribute('disabled')).toBe(true)
  const acknowledge = container.querySelector<HTMLInputElement>('section input[type="checkbox"]')!
  await harness.act(async () => {
    fireEvent.click(acknowledge)
  })
  await click(buttonNamed('Save Linear application')!)
  const saved = requests.find((request) => request.url.endsWith('/integrations/providers/linear/oauth-app'))!
  expect(JSON.parse(saved.body)).toEqual({
    clientId: 'linear-client',
    clientSecret: 'synthetic-client-secret',
    webhookSecret: 'synthetic-webhook-secret',
    capabilitiesAcknowledged: true,
  })
  for (const input of container.querySelectorAll<HTMLInputElement>('input[type="password"]'))
    expect(input.value).toBe('')
})

test('a configured app installs through Linear with the safe return path', async () => {
  const requests = recordRequests(() => undefined)
  await render({ ...localApp, configured: true, clientId: 'linear-client' })
  expect(container.textContent).toContain('Linear application configured')
  expect(container.textContent).toContain('linear-client')
  await click(buttonNamed('Install Ficus in Linear')!)
  const start = requests.find((request) => request.url.endsWith('/integrations/providers/linear/authorization/start'))!
  expect(start.body).toEqual({ returnTo: '/settings' })
})

test('before anything is connected, installing is the one primary action and the API-key form waits until asked for', async () => {
  recordRequests(() => undefined)
  await render(hostedApp)
  const install = buttonNamed('Install Ficus in Linear')!
  expect(install.className).toContain('ficus-button-primary')
  expect(container.querySelectorAll('.ficus-button-primary')).toHaveLength(1)
  expect(container.textContent).toContain('A Linear workspace admin must approve it.')
  expect(container.querySelector('[data-testid="linear-app-callback-url"]')).toBeNull()
  expect(buttonNamed('Replace application settings')).toBeUndefined()
  expect(buttonNamed('Create and validate')).toBeUndefined()

  await click(buttonNamed('Use a personal API key instead')!)
  expect(buttonNamed('Create and validate')).toBeDefined()
  await click(buttonNamed('Cancel')!)
  expect(buttonNamed('Create and validate')).toBeUndefined()
})

test('an installed workspace reads as one row: workspace, kind, health, and its actions in a menu', async () => {
  recordRequests(() => undefined)
  await render(hostedApp, [appConnection()])
  const acme = row('Acme')
  expect(acme.textContent).toContain('Agent app · linear.app/acme')
  expect(acme.textContent).toContain('Healthy')
  expect(acme.textContent).not.toContain('(Ficus app)')
  // Healthy: nothing to fix, so no action buttons sit in the row besides the menu.
  expect(
    [...acme.querySelectorAll('button')].map((button) => button.getAttribute('aria-label') ?? button.textContent)
  ).toEqual(['More actions for Acme', 'Add to squad', 'Add to all 2 squads without Linear'])
  // Installing again is still possible, but no longer the primary action.
  const another = buttonNamed('Install in another workspace')!
  expect(another.className).toContain('ficus-button-secondary')
  expect(buttonNamed('Install Ficus in Linear')).toBeUndefined()
  expect(buttonNamed('Create and validate')).toBeUndefined()
})

test('app connections reconnect through Linear; API-key connections keep key replacement', async () => {
  const requests = recordRequests(() => undefined)
  await render({ ...localApp, configured: true, clientId: 'linear-client' }, [connection({}), appConnection()])
  await click(getByRole(row('Personal key'), 'button', { name: 'More actions for Personal key' }))
  expect(queryByRole(document.body, 'menuitem', { name: 'Replace API key' })).not.toBeNull()
  expect(queryByRole(document.body, 'menuitem', { name: 'Reconnect' })).toBeNull()
  await click(getByRole(document.body, 'menuitem', { name: 'Replace API key' }))
  expect(row('Personal key').textContent).toContain('New API key')

  await chooseFromMenu('Acme', 'Reconnect')
  const start = requests.find((request) => request.url.endsWith('/authorization/start'))!
  expect(start.body).toEqual({ returnTo: '/settings', connectionId: 'app-connection' })
})

test('removing a connection asks first and names the squads that lose access', async () => {
  const requests = recordRequests((url, init) =>
    init?.method === 'DELETE' ? new Response(null, { status: 204 }) : undefined
  )
  await render(hostedApp, [
    appConnection({
      usage: {
        squadCount: 2,
        squads: [
          { id: 'squad-1', name: 'Platform' },
          { id: 'squad-2', name: 'Growth' },
        ],
      },
    }),
  ])
  await chooseFromMenu('Acme', 'Remove…')
  expect(requests.filter((request) => request.method === 'DELETE')).toEqual([])
  expect(row('Acme').textContent).toContain('Remove the Acme connection? 2 squads lose Linear access.')
  expect(row('Acme').textContent).toContain('uninstall it in Linear')
  await click(getByRole(row('Acme'), 'button', { name: 'Remove' }))
  expect(requests.filter((request) => request.method === 'DELETE').map((request) => request.url)).toEqual([
    'http://localhost/api/integrations/connections/app-connection?confirmAssigned=true',
  ])
})

test('a disabled connection offers Enable in the row', async () => {
  const requests = recordRequests(() => undefined)
  await render(hostedApp, [appConnection({ enabled: false })])
  expect(row('Acme').textContent).toContain('Disabled')
  await click(getByRole(row('Acme'), 'button', { name: 'Enable' }))
  expect(requests.some((request) => request.url.endsWith('/connections/app-connection/enable'))).toBe(true)
})

test('a workspace another Ficus Cloud instance holds is explained on its app connection only', async () => {
  recordRequests(() => undefined)
  await render(hostedApp, [
    appConnection({ id: 'claimed', relaySubscribeErrorCode: 'linear_organization_claimed' }),
    appConnection({
      id: 'other',
      displayName: 'Beta (Ficus app)',
      configuration: { ...appConfiguration, organizationId: 'org-2', organizationName: 'Beta' },
    }),
  ])
  expect(row('Acme').querySelector('[role="alert"]')?.textContent).toContain(
    'This Linear workspace is already connected to another Ficus Cloud instance'
  )
  expect(getByRole(row('Acme'), 'button', { name: 'Reconnect' })).toBeDefined()
  expect(row('Beta').textContent).not.toContain('another Ficus Cloud instance')
})

test('an app connection without the write scope, or refused for a scope, asks an admin to reconnect', async () => {
  recordRequests(() => undefined)
  await render(hostedApp, [
    appConnection({
      id: 'old',
      configuration: { ...appConfiguration, organizationName: 'Old', missingScopes: ['write'] },
    }),
    appConnection({
      id: 'refused',
      configuration: { ...appConfiguration, organizationName: 'Refused' },
      authState: 'reauthorization_required',
      lastErrorCode: 'insufficient_scope',
    }),
    appConnection({ id: 'current', configuration: { ...appConfiguration, organizationName: 'Current' } }),
    connection({ id: 'key', displayName: 'Key', lastErrorCode: 'insufficient_scope' }),
  ])
  for (const title of ['Old', 'Refused']) {
    expect(row(title).querySelector('[role="alert"]')?.textContent).toContain('Ficus needs new Linear permissions')
    expect(getByRole(row(title), 'button', { name: 'Reconnect' })).toBeDefined()
  }
  expect(row('Old').textContent).toContain('Needs permissions')
  expect(row('Refused').textContent).toContain('Reconnect required')
  expect(row('Current').textContent).not.toContain('new Linear permissions')
  // An API key cannot gain scopes by reconnecting; the card offers no reconnect for it.
  expect(row('Key').textContent).not.toContain('new Linear permissions')
  expect(queryByRole(row('Key'), 'button', { name: 'Reconnect' })).toBeNull()
})

for (const authority of ['local', 'platform_broker'] as const) {
  test(`with only an API-key connection, the agent app install stays available (${authority})`, async () => {
    recordRequests(() => undefined)
    await render({ ...localApp, authority, configured: true }, [connection({})])
    expect(container.querySelector('#linear-agent-app')).not.toBeNull()
    expect(buttonNamed('Install Ficus in Linear')?.className).toContain('ficus-button-secondary')
    expect(row('Personal key').textContent).toContain('Personal API key')
    await click(buttonNamed('Use a personal API key instead')!)
    expect(buttonNamed('Create and validate')).toBeDefined()
  })
}

for (const [authority, status, code, message] of [
  [
    'platform_broker',
    503,
    'broker_unconfigured',
    "Ficus's hosted Linear app isn't set up for this instance yet. Try again later, or connect with a personal API key.",
  ],
  ['local', 400, 'oauth_app_unconfigured', 'Save the Linear application settings before installing the app.'],
] as const) {
  test(`a failed install explains ${code} instead of a generic error`, async () => {
    recordRequests((url) =>
      url.endsWith('/authorization/start') ? Response.json({ error: code, code }, { status }) : undefined
    )
    await render({ ...localApp, authority, configured: true, clientId: 'linear-client' })
    await click(buttonNamed('Install Ficus in Linear')!)
    expect(container.querySelector('#linear-agent-app ~ [role="alert"]')?.textContent).toBe(message)
  })
}

test('an earlier failed settings save does not hide a newer install failure', async () => {
  recordRequests((url) =>
    url.endsWith('/oauth-app')
      ? Response.json({ error: 'Linear rejected the client ID.' }, { status: 400 })
      : url.endsWith('/authorization/start')
        ? Response.json({ error: 'broker_unconfigured', code: 'broker_unconfigured' }, { status: 503 })
        : undefined
  )
  await render({ ...localApp, configured: true, clientId: 'linear-client' })
  await click(buttonNamed('Replace application settings')!)
  await type('Client ID', 'other-client')
  await type('Client secret', 'synthetic-client-secret')
  await type('Webhook signing secret', 'synthetic-webhook-secret')
  await harness.act(async () => {
    fireEvent.click(container.querySelector<HTMLInputElement>('form input[type="checkbox"]')!)
  })
  await click(buttonNamed('Save Linear application')!)
  await click(buttonNamed('Install Ficus in Linear')!)
  const alerts = [...container.querySelectorAll('[role="alert"]')].map((alert) => alert.textContent)
  expect(alerts).toContain('Linear rejected the client ID.')
  expect(alerts).toContain(
    "Ficus's hosted Linear app isn't set up for this instance yet. Try again later, or connect with a personal API key."
  )
})

test('a new workspace says no squad can use it yet and adds it to a chosen squad right here', async () => {
  const requests = recordRequests((_url, init) =>
    init?.method === 'PUT' ? Response.json({ id: 'app-connection', providerKey: 'linear' }) : undefined
  )
  await render(hostedApp, [appConnection()])
  expect(row('Acme').textContent).toContain('No squad can use this workspace yet.')
  const select = getByRole(row('Acme'), 'combobox', { name: 'Squad to add Acme (Ficus app) to' }) as HTMLSelectElement
  // Archived squads are never offered.
  expect([...select.options].map((option) => option.textContent)).toEqual(['Choose a squad', 'Platform', 'Growth'])
  await harness.act(async () => {
    fireEvent.change(select, { target: { value: 'squad-2' } })
  })
  await click(buttonNamed('Add to squad')!)
  expect(requests.filter((request) => request.method === 'PUT')).toEqual([
    {
      url: 'http://localhost/api/squads/squad-2/integrations/linear/assignment',
      method: 'PUT',
      body: { connectionId: 'app-connection', makeDefault: true },
    },
  ])
})

test('an attached workspace links each squad to its Integrations tab and says what is left there', async () => {
  const requests = recordRequests((_url, init) =>
    init?.method === 'DELETE' ? new Response(null, { status: 204 }) : undefined
  )
  await render(hostedApp, [appConnection({ usage: { squadCount: 1, squads: [{ id: 'squad-1', name: 'Platform' }] } })])
  const acme = row('Acme')
  expect(acme.textContent).not.toContain('No squad can use')
  expect(getByRole(acme, 'link', { name: 'Platform' }).getAttribute('href')).toBe(
    '/squads/squad-1/settings?section=integrations'
  )
  expect(acme.textContent).toContain('choose the Linear teams whose issues it handles')
  // Only the squads that do not use it yet are offered.
  const select = getByRole(acme, 'combobox', { name: /^Squad to add/ }) as HTMLSelectElement
  expect([...select.options].map((option) => option.value)).toEqual(['', 'squad-2'])

  const detach = getByRole(acme, 'button', { name: 'Remove Acme (Ficus app) from Platform' })
  await click(detach)
  expect(requests.filter((request) => request.method === 'DELETE')).toEqual([])
  await click(detach)
  expect(requests.filter((request) => request.method === 'DELETE').map((request) => request.url)).toEqual([
    'http://localhost/api/squads/squad-1/integrations/linear/assignment?connectionId=app-connection',
  ])
})

test('a squad on another Linear connection is offered as a replacement, and only squads without one are added in bulk', async () => {
  const requests = recordRequests((_url, init) =>
    init?.method === 'PUT' ? Response.json({ id: 'app-connection', providerKey: 'linear' }) : undefined
  )
  await render(
    hostedApp,
    [appConnection(), connection({ usage: { squadCount: 1, squads: [{ id: 'squad-1', name: 'Platform' }] } })],
    { permissions: ['integrations:write'] }
  )
  const select = getByRole(row('Acme'), 'combobox', { name: /^Squad to add/ }) as HTMLSelectElement
  expect([...select.options].map((option) => option.textContent)).toEqual([
    'Choose a squad',
    'Platform (replaces Personal key)',
    'Growth',
  ])
  // One squad without Linear is not "all squads": a bulk action would hide which one it changes.
  expect(queryByRole(row('Acme'), 'button', { name: /^Add to all/ })).toBeNull()
  expect(requests.filter((request) => request.method === 'PUT')).toEqual([])
})

test('adding to every squad without Linear assigns each one, and names any squad that failed', async () => {
  const requests = recordRequests((url, init) =>
    init?.method !== 'PUT'
      ? undefined
      : url.includes('/squads/squad-2/')
        ? Response.json({ error: 'Forbidden' }, { status: 403 })
        : Response.json({ id: 'app-connection', providerKey: 'linear' })
  )
  await render(hostedApp, [appConnection()])
  await click(buttonNamed('Add to all 2 squads without Linear')!)
  expect(requests.filter((request) => request.method === 'PUT').map((request) => request.url)).toEqual([
    'http://localhost/api/squads/squad-1/integrations/linear/assignment',
    'http://localhost/api/squads/squad-2/integrations/linear/assignment',
  ])
  expect(row('Acme').querySelector('[role="alert"]')?.textContent).toBe(
    'Could not add this workspace to Growth. Try again.'
  )
})

test('only squads where this person manages integrations are offered', async () => {
  recordRequests(() => undefined)
  await render(hostedApp, [appConnection()], {
    permissions: ['integrations:write:linear'],
    squadPermissions: { 'squad-1': ['integrations:read'], 'squad-2': ['integrations:write'] },
  })
  const select = getByRole(row('Acme'), 'combobox', { name: /^Squad to add/ }) as HTMLSelectElement
  expect([...select.options].map((option) => option.value)).toEqual(['', 'squad-2'])
})

test('without permission to change any squad, the notice says who can finish the setup', async () => {
  recordRequests(() => undefined)
  await render(hostedApp, [appConnection()], {
    permissions: ['integrations:write:linear'],
    squadPermissions: { 'squad-1': ['integrations:read'], 'squad-2': ['integrations:read'] },
  })
  expect(row('Acme').textContent).toContain(
    "Someone who manages a squad's integrations can add it in that squad's Integrations tab."
  )
  expect(queryByRole(row('Acme'), 'combobox')).toBeNull()
})

test('a connection that cannot be used yet says to fix it before adding squads', async () => {
  recordRequests(() => undefined)
  await render(hostedApp, [appConnection({ authState: 'reauthorization_required' })])
  expect(row('Acme').textContent).toContain('Enable or reconnect it first')
  expect(queryByRole(row('Acme'), 'combobox')).toBeNull()
})
