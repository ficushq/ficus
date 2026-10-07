import { afterEach, expect, test } from 'bun:test'
import { act } from 'react'
import { fireEvent, getByRole, queryByRole, waitFor } from '@testing-library/dom'
import { notifyManager, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { acquireDomHarness } from '../../test/domHarness'
import { PermissionsProvider } from '../../hooks/usePermissions'
import { queryKeys, serverConnectionQueryKeys } from '../../queryKeys'
import type { RelayAvailability, ServerConnection } from '../../api/serverConnection'
import type { DeviceSummary } from '../../api/devices'
import { MobileSection } from './MobileSection'

let cleanup: (() => Promise<void>) | undefined
afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
})

const device = (id: string, platform: string, name = id): DeviceSummary => ({
  id,
  name,
  platform,
  createdAt: '2026-10-01T12:00:00.000Z',
  lastUsedAt: null,
  revokedAt: null,
})

const selfHosted: ServerConnection = {
  managed: false,
  connected: false,
  configured: false,
  origin: 'https://ficus.example.com',
  baseUrl: 'https://ficus.sh',
  manageUrl: 'https://ficus.sh/account/pro',
}

type RenderOptions = {
  admin?: boolean
  devices?: DeviceSummary[]
  connection?: ServerConnection
  availability?: RelayAvailability | 'error'
  touch?: boolean
}

async function render({ admin = false, devices = [], connection, availability, touch = false }: RenderOptions = {}) {
  await cleanup?.()
  const dom = await acquireDomHarness({
    url: 'https://ficus.example.com/settings?section=mobile',
    configureWindow(window) {
      ;(window as unknown as { matchMedia: (query: string) => unknown }).matchMedia = (query: string) => ({
        matches: touch,
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      })
    },
  })
  const requests: string[] = []
  const previousFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    const method = init?.method ?? 'GET'
    requests.push(`${method} ${url.pathname}`)
    if (url.pathname === '/api/auth/pair/start' && method === 'POST')
      return Response.json({
        code: 'pair-code-1',
        serverUrl: 'https://ficus.example.com',
        expiresAt: new Date(Date.now() + 90_000).toISOString(),
      })
    if (url.pathname === '/api/auth/devices') return Response.json(devices)
    if (url.pathname === '/api/push/relay-config')
      return availability === 'error'
        ? Response.json({ error: 'Relay configuration is invalid' }, { status: 503 })
        : Response.json(availability ?? { enabled: false })
    return Response.json({ error: 'Unexpected request' }, { status: 404 })
  }) as typeof fetch
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.devices.list(), devices)
  if (connection) client.setQueryData(serverConnectionQueryKeys.status(), connection)
  cleanup = async () => {
    await dom.cleanup()
    client.clear()
    globalThis.fetch = previousFetch
  }
  const { root, container } = dom.createRoot()
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <PermissionsProvider
            usePermissions={() => ({
              permissions: admin ? ['settings:read'] : [],
              identity: { type: 'user', userId: 'member' },
              can: (permission) => admin && permission === 'settings:read',
              isLoading: false,
              isError: false,
            })}
          >
            <MobileSection />
          </PermissionsProvider>
        </MemoryRouter>
      </QueryClientProvider>
    )
  )
  // Readiness boundary: let the queries the page started settle inside act.
  await act(async () => {
    await Promise.allSettled(
      client
        .getQueryCache()
        .getAll()
        .map((query) => query.promise)
    )
    // Query results reach observers on React Query's notify schedule; flush it here too.
    await new Promise<void>((resolve) => notifyManager.schedule(resolve))
  })
  return { container, client, requests, dom }
}

test('personal Mobile is a plain settings page without the marketing grid', async () => {
  const { container } = await render()
  const text = container.textContent ?? ''
  expect(text).not.toContain('Ficus, to go.')
  expect(text).not.toContain('Pick up the thread')
  expect(text).toContain('Use Ficus from your phone: your Feed, squads, chats and questions.')
  const learnMore = getByRole(container, 'link', { name: /Learn more on ficus\.sh/ })
  expect(learnMore.getAttribute('href')).toBe('https://ficus.sh/mobile')
  expect(learnMore.getAttribute('target')).toBe('_blank')
  expect(learnMore.getAttribute('rel')).toContain('noopener')
  for (const heading of ['Pair your phone', 'Your phones', 'Free and Pro'])
    expect(getByRole(container, 'heading', { name: heading })).toBeTruthy()
  // Quiet links each stand on their own line; none run together.
  for (const link of container.querySelectorAll('a')) expect(link.parentElement?.querySelectorAll('a').length).toBe(1)
})

test('Pair your phone starts the shared pairing flow and shows the QR inline', async () => {
  const { container, requests, dom } = await render()
  await dom.act(async () => fireEvent.click(getByRole(container, 'button', { name: 'Pair your phone' })))
  await waitFor(() => expect(container.querySelector('img[alt="Pairing QR code"]')).not.toBeNull())
  expect(requests).toContain('POST /api/auth/pair/start')
  expect(container.textContent).toContain('pair-code-1')
  expect(queryByRole(container, 'link', { name: 'Open in Ficus app' })).toBeNull()
})

test('a narrow or touch viewport also offers the deep link carrying url and code', async () => {
  const { container, dom } = await render({ touch: true })
  await dom.act(async () => fireEvent.click(getByRole(container, 'button', { name: 'Pair your phone' })))
  const open = await waitFor(() => getByRole(container, 'link', { name: 'Open in Ficus app' }))
  const link = new URL(open.getAttribute('href')!)
  expect(link.protocol).toBe('ficus:')
  expect(link.searchParams.get('url')).toBe('https://ficus.example.com')
  expect(link.searchParams.get('code')).toBe('pair-code-1')
})

test('Your phones lists only paired phones and links to all devices', async () => {
  const { container } = await render({
    devices: [device('a', 'ios', 'Noah’s iPhone'), device('b', 'cli', 'atlas'), device('c', 'android', 'Pixel')],
  })
  const list = getByRole(container, 'list', { name: 'Your phones' })
  expect(list.querySelectorAll('li').length).toBe(2)
  expect(list.textContent).toContain('Noah’s iPhone')
  expect(list.textContent).toContain('iOS')
  expect(list.textContent).toContain('Pixel')
  expect(list.textContent).not.toContain('atlas')
  expect(getByRole(container, 'link', { name: 'Manage all devices →' }).getAttribute('href')).toBe(
    '/settings?section=devices'
  )
})

test('Your phones has a plain empty state', async () => {
  const { container } = await render({ devices: [device('b', 'cli')] })
  expect(container.textContent).toContain('No phones paired yet.')
})

test('the server address is shown with a Copy button', async () => {
  const { container } = await render()
  expect(container.textContent).toContain('https://ficus.example.com')
  expect(getByRole(container, 'button', { name: 'Copy address' })).toBeTruthy()
})

test("members see the server's configured address, not the browser's", async () => {
  const { container } = await render({
    availability: { enabled: true, instanceId: 'server-1', serverUrl: 'https://home.example.net/ficus' },
  })
  await waitFor(() => expect(container.textContent).toContain('https://home.example.net/ficus'))
  expect(container.textContent).not.toContain('by its address: https://ficus.example.com')
})

test('administrators see the configured address from the connection status', async () => {
  const { container, requests } = await render({
    admin: true,
    connection: { ...selfHosted, origin: 'https://studio.example.net/ficus' },
  })
  await waitFor(() => expect(container.textContent).toContain('https://studio.example.net/ficus'))
  expect(requests).not.toContain('GET /api/push/relay-config')
})

for (const admin of [false, true]) {
  test(`Cloud-only copy stays hidden on a self-hosted server (${admin ? 'admin' : 'member'})`, async () => {
    const { container } = await render({ admin, connection: selfHosted, availability: { enabled: false } })
    await waitFor(() => expect(container.textContent).toContain('Get Pro with your own Ficus Pro'))
    expect(container.textContent).not.toContain('Ficus Cloud')
  })
}

test('a member on Cloud reads that Pro is included', async () => {
  const { container } = await render({
    availability: { enabled: true, instanceId: '00000000-0000-4000-8000-000000000000', delivery: 'direct' },
  })
  await waitFor(() => expect(container.textContent).toContain('Paid Ficus Cloud includes Pro on this server'))
  expect(container.textContent).not.toContain('Ask your server administrator')
})

test('an administrator sees the Ficus account status row in each state', async () => {
  const notConnected = await render({ admin: true, connection: selfHosted })
  expect(notConnected.container.textContent).toContain('Ficus account: Not connected')
  expect(getByRole(notConnected.container, 'link', { name: 'Set up in Mobile & Pro →' }).getAttribute('href')).toBe(
    '/settings?section=mobile-pro'
  )
  expect(notConnected.requests).not.toContain('GET /api/push/relay-config')

  const connected = await render({
    admin: true,
    connection: {
      ...selfHosted,
      connected: true,
      configured: true,
      status: {
        instanceId: 'server-1',
        name: 'Studio',
        origin: selfHosted.origin!,
        instancePro: false,
        allowance: null,
        used: 0,
        registered: 1,
      },
    },
  })
  expect(connected.container.textContent).toContain('Ficus account: Connected as Studio')
})

test('a member makes no protected request and is asked to contact the administrator', async () => {
  const { container, client, requests } = await render({ availability: { enabled: false } })
  await waitFor(() =>
    expect(container.textContent).toContain(
      'Push notifications and Live Activities need this server connected to a Ficus account. Ask your server administrator.'
    )
  )
  expect(client.getQueryCache().find({ queryKey: serverConnectionQueryKeys.status() })).toBeUndefined()
  expect(requests.some((request) => request.includes('/push/server-connection'))).toBe(false)
  expect(container.textContent).not.toContain('Ficus account:')
  expect(container.querySelector('a[href="/settings?section=mobile-pro"]')).toBeNull()
})

test('a member on a connected server is not asked to contact the administrator', async () => {
  const { container } = await render({
    availability: { enabled: true, instanceId: '00000000-0000-4000-8000-000000000000' },
  })
  await waitFor(() => expect(container.textContent).toContain('Get Pro with your own Ficus Pro'))
  expect(container.textContent).not.toContain('Ask your server administrator')
})

test('a member who cannot learn the connection reads conditional copy', async () => {
  const { container } = await render({ availability: 'error' })
  await waitFor(() => expect(container.textContent).toContain('If they don’t arrive, ask your server administrator.'))
})
