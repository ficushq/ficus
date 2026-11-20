import { afterEach, beforeEach, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent } from '@testing-library/dom'
import { acquireDomHarness } from '../../test/domHarness'
import { integrationQueryKeys } from '../../queryKeys'

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
  available: true,
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

beforeEach(async () => {
  harness = await acquireDomHarness({ url: 'http://localhost/settings' })
  ;({ root, container } = harness.createRoot())
  oldFetch = globalThis.fetch
})
afterEach(async () => {
  globalThis.fetch = oldFetch
  await harness.cleanup()
})

async function render(app: Record<string, unknown>, pool: unknown[] = []) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(integrationQueryKeys.pool('linear'), pool)
  client.setQueryData(integrationQueryKeys.linearWebhook(), {
    configured: false,
    webhookUrl: 'https://ficus.example/api/webhooks/linear',
  })
  client.setQueryData([...integrationQueryKeys.all, 'oauth-app', 'linear'], app)
  const { LinearIntegrationSettings } = await import('./LinearIntegrationSettings')
  await harness.act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <LinearIntegrationSettings canWrite />
      </QueryClientProvider>
    )
  )
}

const buttonNamed = (name: string) =>
  [...container.querySelectorAll('button')].find((candidate) => candidate.textContent === name)

async function type(label: string, value: string) {
  const input = [...container.querySelectorAll('label')]
    .find((candidate) => candidate.textContent?.startsWith(label))!
    .querySelector('input')!
  await harness.act(async () => {
    fireEvent.change(input, { target: { value } })
  })
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
  await harness.act(async () => {
    fireEvent.click(buttonNamed('Save Linear application')!)
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
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
  let body = ''
  let url = ''
  globalThis.fetch = (async (input, init) => {
    url = String(input)
    body = String(init?.body)
    return new Promise<Response>(() => {})
  }) as typeof fetch
  await render({ ...localApp, configured: true, clientId: 'linear-client' })
  expect(container.textContent).toContain('Linear application configured')
  expect(container.textContent).toContain('linear-client')
  await harness.act(async () => {
    fireEvent.click(buttonNamed('Install Ficus in Linear')!)
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  expect(url).toEndWith('/integrations/providers/linear/authorization/start')
  expect(JSON.parse(body)).toEqual({ returnTo: '/settings' })
})

test('hosted instances offer the install without local application settings', async () => {
  globalThis.fetch = (async () => new Promise<Response>(() => {})) as typeof fetch
  await render({
    authority: 'platform_broker',
    configured: true,
    clientId: null,
    callbackUrl: 'x',
    available: true,
    requiredCapabilities: [],
  })
  expect(buttonNamed('Install Ficus in Linear')).toBeDefined()
  expect(container.querySelector('[data-testid="linear-app-callback-url"]')).toBeNull()
  expect(buttonNamed('Replace application settings')).toBeUndefined()
})

test('app connections reconnect through Linear; API-key connections keep key replacement', async () => {
  let body = ''
  globalThis.fetch = (async (_input, init) => {
    body = String(init?.body)
    return new Promise<Response>(() => {})
  }) as typeof fetch
  await render({ ...localApp, configured: true, clientId: 'linear-client' }, [
    connection({}),
    connection({
      id: 'app-connection',
      displayName: 'Acme (Ficus app)',
      configuration: { version: 2, mode: 'app', organizationId: 'org-1', organizationName: 'Acme' },
    }),
  ])
  const [keyAccount, appAccount] = [...container.querySelectorAll('article')]
  expect(keyAccount!.textContent).toContain('Replace API key')
  expect(keyAccount!.textContent).not.toContain('Reconnect')
  expect(appAccount!.textContent).toContain('Agent app')
  expect(appAccount!.textContent).not.toContain('Replace API key')
  const reconnect = [...appAccount!.querySelectorAll('button')].find((button) => button.textContent === 'Reconnect')!
  await harness.act(async () => {
    fireEvent.click(reconnect)
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  expect(JSON.parse(body)).toEqual({ returnTo: '/settings', connectionId: 'app-connection' })
})

for (const authority of ['local', 'platform_broker'] as const) {
  test(`the agent app stays hidden while the server reports it unavailable (${authority}); API keys are unaffected`, async () => {
    globalThis.fetch = (async () => new Promise<Response>(() => {})) as typeof fetch
    await render({ ...localApp, authority, configured: true, available: false }, [connection({})])
    expect(container.querySelector('#linear-agent-app')).toBeNull()
    expect(buttonNamed('Install Ficus in Linear')).toBeUndefined()
    expect(container.querySelector('[data-testid="linear-app-callback-url"]')).toBeNull()
    expect(container.textContent).toContain('personal API key')
    expect(container.textContent).toContain('Replace API key')
    expect(buttonNamed('Create and validate')).toBeDefined()
  })
}
