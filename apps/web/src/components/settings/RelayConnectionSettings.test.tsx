import { afterEach, expect, test } from 'bun:test'
import { act } from 'react'
import { fireEvent, getByRole, queryByRole, waitFor } from '@testing-library/dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { acquireDomHarness } from '../../test/domHarness'
import { PermissionsProvider, type PermissionsResult } from '../../hooks/usePermissions'
import { serverConnectionQueryKeys } from '../../queryKeys'
import type { ServerConnection } from '../../api/serverConnection'
import { RelayConnectionSettings } from './RelayConnectionSettings'

let cleanup: (() => Promise<void>) | undefined
afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
})

const selfHosted: ServerConnection = {
  managed: false,
  connected: false,
  configured: false,
  origin: 'https://ficus.example.com',
  baseUrl: 'https://ficus.sh',
  manageUrl: 'https://ficus.sh/account/pro',
}
const connectedStatus = (overrides: Partial<NonNullable<ServerConnection['status']>> = {}): ServerConnection => ({
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
    registered: 0,
    ...overrides,
  },
})

async function render(data: ServerConnection, write = true, human = true) {
  const dom = await acquireDomHarness({ url: 'https://ficus.example.com' })
  const requests: string[] = []
  const previousFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    requests.push(`${init?.method ?? 'GET'} ${url.pathname}`)
    if (url.pathname === '/api/push/server-connection' && init?.method === 'DELETE')
      return Response.json({ disconnected: true })
    return Response.json(data)
  }) as typeof fetch
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  queryClient.setQueryData(serverConnectionQueryKeys.status(), data)
  cleanup = async () => {
    await dom.cleanup()
    queryClient.clear()
    globalThis.fetch = previousFetch
  }
  const { root, container } = dom.createRoot()
  const permissions: PermissionsResult = {
    permissions: ['settings:read', ...(write ? ['settings:write'] : [])],
    identity: human ? { type: 'user', userId: 'test-user' } : undefined,
    can: (permission) => permission === 'settings:read' || (permission === 'settings:write' && write),
    isLoading: false,
    isError: false,
  }
  await act(async () =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <PermissionsProvider usePermissions={() => permissions}>
          <RelayConnectionSettings />
        </PermissionsProvider>
      </QueryClientProvider>
    )
  )
  return { container, dom, requests }
}

test('Cloud access is one tidy row without credentials or subscription controls', async () => {
  const { container } = await render({ ...selfHosted, managed: true, connected: true, configured: true })
  expect(container.textContent).toContain('Ficus Cloud manages this automatically. Nothing to set up.')
  expect(queryByRole(container, 'button', { name: /Connect|Disconnect/i })).toBeNull()
  expect(queryByRole(container, 'textbox')).toBeNull()
  expect(queryByRole(container, 'link', { name: /Manage Pro and devices/ })).toBeNull()
})

test('not connected: the status row offers Connect Ficus account as the primary action', async () => {
  const { container } = await render(selfHosted)
  expect(container.textContent).toContain('Not connected')
  expect(getByRole(container, 'button', { name: 'Connect Ficus account' }).className).toContain('ficus-button-primary')
  expect(getByRole(container, 'link', { name: 'Mobile setup guide' }).getAttribute('href')).toBe(
    'https://ficus.example.com/docs/connect/mobile/'
  )
  expect(container.textContent).not.toContain('Connection & Pro coverage')
})

test('the explanation says Connect Ficus account, not push relay, and covers personal Pro', async () => {
  const { container } = await render(selfHosted)
  const text = container.textContent ?? ''
  expect(text).toContain('Connecting this server to a Ficus account lets it use the shared relays Ficus runs')
  expect(text).toContain('It doesn’t start a subscription.')
  expect(text).toContain('You don’t need Instance Pro to connect.')
  expect(text).toContain('People with their own Ficus Pro get push notifications and Live Activities')
  expect(text).not.toMatch(/push relay/i)
})

test('the server name is prefilled from the server address, never a placeholder', async () => {
  const { container } = await render(selfHosted)
  const field = getByRole(container, 'textbox', { name: 'Server name' }) as HTMLInputElement
  expect(field.value).toBe('ficus.example.com')
  expect(container.innerHTML).not.toContain('My Ficus server')
})

test('the Instance Pro empty state shows before connecting', async () => {
  const { container } = await render(selfHosted)
  expect(getByRole(container, 'heading', { name: 'Instance Pro' })).toBeTruthy()
  expect(container.textContent).toContain('Connect a Ficus account to see this server’s Instance Pro allowance.')
})

test('connected: the status row shows Connected as the server name, with no primary button', async () => {
  const { container } = await render(connectedStatus())
  expect(container.textContent).toContain('Connected')
  expect(container.textContent).toContain('as Studio')
  expect(container.querySelector('.ficus-button-primary')).toBeNull()
  expect(queryByRole(container, 'button', { name: /Reconnect Ficus account/ })).toBeNull()
  expect(container.textContent).not.toContain('Reconnecting replaces')
  expect(container.textContent).not.toContain('Disconnecting stops')
})

test('connected: the server name is read-only', async () => {
  const { container } = await render(connectedStatus())
  expect(queryByRole(container, 'textbox')).toBeNull()
  expect(container.textContent).toContain('NameStudio')
})

test('connected: the menu actions open confirmations', async () => {
  const { container, dom, requests } = await render(connectedStatus())
  const openMenu = () =>
    dom.act(async () => fireEvent.click(getByRole(container, 'button', { name: 'Ficus account actions' })))

  await openMenu()
  await dom.act(async () => fireEvent.click(getByRole(container, 'button', { name: 'Reconnect…' })))
  const reconnect = getByRole(document.body, 'dialog', { name: 'Reconnect Ficus account' })
  expect(reconnect.textContent).toContain('replaces this server’s saved credential')
  expect((getByRole(reconnect, 'textbox', { name: 'Server name' }) as HTMLInputElement).value).toBe('Studio')
  await dom.act(async () => fireEvent.click(getByRole(reconnect, 'button', { name: 'Cancel' })))

  await openMenu()
  await dom.act(async () => fireEvent.click(getByRole(container, 'button', { name: 'Disconnect…' })))
  const disconnect = getByRole(document.body, 'dialog', { name: 'Disconnect Ficus account?' })
  expect(disconnect.textContent).toContain('subscription isn’t cancelled')
  expect(requests).not.toContain('DELETE /api/push/server-connection')
  await dom.act(async () => fireEvent.click(getByRole(disconnect, 'button', { name: 'Disconnect' })))
  await waitFor(() => expect(requests).toContain('DELETE /api/push/server-connection'))
})

test('connected: the Instance Pro rows show the allowance and slot use', async () => {
  const none = await render(connectedStatus())
  expect(none.container.textContent).toContain('AllowanceNone')
  expect(none.container.textContent).toContain('Devices using instance slots0')
  expect(none.container.textContent).toContain('without using a slot')

  await cleanup?.()
  const allowance = await render(connectedStatus({ instancePro: true, allowance: 5, used: 2, registered: 4 }))
  expect(allowance.container.textContent).toContain('2 of 5 slots used')
  expect(allowance.container.textContent).toContain('Devices using instance slots2')
  const manage = getByRole(allowance.container, 'link', { name: 'Manage Pro and devices on ficus.sh' })
  expect(manage.getAttribute('href')).toBe('https://ficus.sh/account/pro')
  expect(manage.getAttribute('target')).toBe('_blank')
  expect(manage.getAttribute('rel')).toContain('noopener')
})

test('read-only settings show coverage without mutation controls', async () => {
  const { container } = await render(connectedStatus({ instancePro: true, allowance: 5, used: 2 }), false)
  expect(container.textContent).toContain('2 of 5 slots used')
  expect(queryByRole(container, 'button')).toBeNull()
})

test('an identity without a human account cannot see relay management', async () => {
  const { container } = await render(selfHosted, true, false)
  expect(container.textContent).toBe('')
})

test('a saved credential can be repaired or disconnected when Cloud verification is unavailable', async () => {
  const { container } = await render({ ...selfHosted, configured: true, error: 'Could not reach Ficus Cloud.' })
  expect(container.textContent).toContain('Connection needs attention')
  expect(getByRole(container, 'button', { name: 'Reconnect Ficus account' })).toBeTruthy()
  expect(getByRole(container, 'button', { name: 'Disconnect…' })).toBeTruthy()
  expect(container.textContent).toContain('Could not reach Ficus Cloud.')
})
