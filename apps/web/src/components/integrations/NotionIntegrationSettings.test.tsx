import { afterEach, beforeEach, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent } from '@testing-library/dom'
import { acquireDomHarness } from '../../test/domHarness'
import { integrationQueryKeys } from '../../queryKeys'

let harness: Awaited<ReturnType<typeof acquireDomHarness>>
let root: import('react-dom/client').Root
let container: HTMLDivElement
let oldFetch: typeof globalThis.fetch

beforeEach(async () => {
  harness = await acquireDomHarness({ url: 'http://localhost/settings' })
  ;({ root, container } = harness.createRoot())
  oldFetch = globalThis.fetch
})
afterEach(async () => {
  globalThis.fetch = oldFetch
  await harness.cleanup()
})

test('starts Notion OAuth with the server-accepted safe return and renders lifecycle guidance', async () => {
  let body = ''
  globalThis.fetch = (async (_input, init) => {
    body = String(init?.body)
    return new Promise<Response>(() => {})
  }) as typeof fetch
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(integrationQueryKeys.pool('notion'), [])
  client.setQueryData([...integrationQueryKeys.all, 'oauth-app', 'notion'], {
    authority: 'local',
    configured: true,
    clientId: 'client-id',
    callbackUrl: 'https://ficus.example/settings/integrations/oauth/callback',
    requiredCapabilities: ['read_content', 'insert_content', 'update_content'],
  })
  const { NotionIntegrationSettings } = await import('./NotionIntegrationSettings')
  await harness.act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <NotionIntegrationSettings canRead canWrite />
      </QueryClientProvider>
    )
  )
  expect(container.textContent).toContain('Read content')
  const callbackUrl = container.querySelector('[data-testid="notion-callback-url"]')!
  expect(callbackUrl.textContent).toContain('https://ficus.example/settings/integrations/oauth/callback')
  expect(callbackUrl.className).toContain('break-all')
  expect(callbackUrl.className).toContain('[overflow-wrap:anywhere]')
  expect(callbackUrl.parentElement?.className).not.toContain('break-all')
  const button = [...container.querySelectorAll('button')].find(
    (candidate) => candidate.textContent === 'Connect Notion'
  )!
  await harness.act(async () => {
    fireEvent.click(button)
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  expect(JSON.parse(body)).toEqual({ returnTo: '/settings' })
})

test('unknown authority renders neutral loading copy without local OAuth guidance', async () => {
  globalThis.fetch = (async () => new Promise<Response>(() => {})) as typeof fetch
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(integrationQueryKeys.pool('notion'), [])
  const { NotionIntegrationSettings } = await import('./NotionIntegrationSettings')
  await harness.act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <NotionIntegrationSettings canRead canWrite />
      </QueryClientProvider>
    )
  )

  expect(container.textContent).toContain('Loading Notion integration settings')
  expect(container.textContent).not.toContain('Notion Developer Portal')
  expect(container.querySelector('[aria-label="Notion OAuth client ID"]')).toBeNull()
})

test('failed OAuth settings query shows a safe retry action', async () => {
  let calls = 0
  globalThis.fetch = (async () => {
    calls += 1
    return new Response(JSON.stringify({ error: 'unavailable' }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(integrationQueryKeys.pool('notion'), [])
  const { NotionIntegrationSettings } = await import('./NotionIntegrationSettings')
  await harness.act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <NotionIntegrationSettings canRead canWrite />
      </QueryClientProvider>
    )
  )
  await harness.act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    'Notion integration settings could not be loaded'
  )
  const alert = container.querySelector('[role="alert"]')
  expect(alert?.tagName).toBe('P')
  const retry = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Try again')!
  expect(retry.className).toContain('focus-visible:ring-2')
  await harness.act(async () => {
    fireEvent.click(retry)
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  expect(calls).toBe(2)
})

test('hosted mode offers Connect Notion without OAuth application fields', async () => {
  globalThis.fetch = (async () => new Promise<Response>(() => {})) as typeof fetch
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(integrationQueryKeys.pool('notion'), [])
  client.setQueryData([...integrationQueryKeys.all, 'oauth-app', 'notion'], {
    authority: 'platform_broker',
    configured: true,
    clientId: null,
    callbackUrl: '',
    requiredCapabilities: [],
  })
  const { NotionIntegrationSettings } = await import('./NotionIntegrationSettings')
  await harness.act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <NotionIntegrationSettings canRead canWrite />
      </QueryClientProvider>
    )
  )

  expect([...container.querySelectorAll('button')].some((button) => button.textContent === 'Connect Notion')).toBe(true)
  expect(container.querySelector('[aria-label="Notion OAuth client ID"]')).toBeNull()
  expect(container.querySelector('[aria-label="Notion OAuth client secret"]')).toBeNull()
  expect(container.textContent).not.toContain('Notion Developer Portal')
})

test('self-hosted mode still shows the OAuth application fields', async () => {
  globalThis.fetch = (async () => new Promise<Response>(() => {})) as typeof fetch
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(integrationQueryKeys.pool('notion'), [])
  client.setQueryData([...integrationQueryKeys.all, 'oauth-app', 'notion'], {
    authority: 'local',
    configured: false,
    clientId: null,
    callbackUrl: 'https://ficus.example/settings/integrations/oauth/callback',
    requiredCapabilities: ['read_content', 'insert_content', 'update_content'],
  })
  const { NotionIntegrationSettings } = await import('./NotionIntegrationSettings')
  await harness.act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <NotionIntegrationSettings canRead canWrite />
      </QueryClientProvider>
    )
  )

  expect(container.querySelector('[aria-label="Notion OAuth client ID"]')).not.toBeNull()
  expect(container.querySelector('[aria-label="Notion OAuth client secret"]')).not.toBeNull()
  expect(container.textContent).toContain('Notion Developer Portal')
})

test('requires explicit second-click confirmation before removing an assigned workspace', async () => {
  const requests: string[] = []
  globalThis.fetch = (async (input) => {
    const url = String(input)
    requests.push(url)
    if (url.includes('/connections?provider=notion')) return Response.json([])
    if (url.includes('/providers/notion/oauth-app'))
      return Response.json({
        authority: 'platform_broker',
        configured: true,
        clientId: 'client-id',
        callbackUrl: 'https://ficus.example/settings/integrations/oauth/callback',
        requiredCapabilities: [],
      })
    return new Response(null, { status: 204 })
  }) as typeof fetch
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(integrationQueryKeys.pool('notion'), [
    {
      id: 'connection-1',
      providerKey: 'notion',
      adapterVersion: 1,
      displayName: 'Workspace',
      configuration: { version: 1, workspaceId: 'workspace-1', workspaceName: 'Workspace' },
      credentialConfigured: true,
      refreshAvailable: false,
      enabled: true,
      authState: 'authenticated',
      healthState: 'healthy',
      grantedScopes: [],
      validatedAt: null,
      validationExpiresAt: null,
      lastErrorCode: null,
      usage: { squadCount: 2, squads: [] },
    },
  ])
  client.setQueryData([...integrationQueryKeys.all, 'oauth-app', 'notion'], {
    authority: 'platform_broker',
    configured: true,
    clientId: 'client-id',
    callbackUrl: 'https://ficus.example/settings/integrations/oauth/callback',
    requiredCapabilities: [],
  })
  const { NotionIntegrationSettings } = await import('./NotionIntegrationSettings')
  await harness.act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <NotionIntegrationSettings canRead canWrite />
      </QueryClientProvider>
    )
  )
  const remove = [...container.querySelectorAll('button')].find((candidate) => candidate.textContent === 'Remove')!
  await harness.act(async () => fireEvent.click(remove))
  expect(requests).toEqual([])
  expect(remove.textContent).toContain('Confirm remove from 2 squads')
  await harness.act(async () => fireEvent.click(remove))
  expect(requests[0]).toBe('http://localhost/api/integrations/connections/connection-1?confirmAssigned=true')
  expect(container.textContent).not.toContain('Refresh')
})

test('requires explicit capability acknowledgement and clears the client-secret draft after setup', async () => {
  let submitted: unknown
  globalThis.fetch = (async (_input, init) => {
    submitted = JSON.parse(String(init?.body))
    return Response.json({
      authority: 'local',
      configured: true,
      clientId: 'client-id',
      callbackUrl: 'https://ficus.example/settings/integrations/oauth/callback',
      requiredCapabilities: ['read_content', 'insert_content', 'update_content'],
    })
  }) as typeof fetch
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(integrationQueryKeys.pool('notion'), [])
  client.setQueryData([...integrationQueryKeys.all, 'oauth-app', 'notion'], {
    authority: 'local',
    configured: false,
    clientId: null,
    callbackUrl: 'https://ficus.example/settings/integrations/oauth/callback',
    requiredCapabilities: ['read_content', 'insert_content', 'update_content'],
  })
  const { NotionIntegrationSettings } = await import('./NotionIntegrationSettings')
  await harness.act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <NotionIntegrationSettings canRead canWrite />
      </QueryClientProvider>
    )
  )
  const id = container.querySelector('[aria-label="Notion OAuth client ID"]') as HTMLInputElement
  const secret = container.querySelector('[aria-label="Notion OAuth client secret"]') as HTMLInputElement
  const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement
  const submit = [...container.querySelectorAll('button')].find((candidate) =>
    candidate.textContent?.includes('Save OAuth application')
  ) as HTMLButtonElement
  await harness.act(async () => {
    fireEvent.change(id, { target: { value: 'client-id' } })
    fireEvent.change(secret, { target: { value: 'client-secret' } })
  })
  expect(submit.disabled).toBe(true)
  await harness.act(async () => fireEvent.click(checkbox))
  expect(submit.disabled).toBe(false)
  await harness.act(async () => fireEvent.click(submit))
  expect(submitted).toEqual({ clientId: 'client-id', clientSecret: 'client-secret', capabilitiesAcknowledged: true })
  expect(secret.value).toBe('')
})
