import { afterEach, expect, test } from 'bun:test'
import { act } from 'react'
import { getByRole, queryByRole } from '@testing-library/dom'
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
  manageUrl: 'https://ficus.sh/account/push',
}
async function render(data: ServerConnection, write = true, human = true) {
  const dom = await acquireDomHarness({ url: 'https://ficus.example.com' })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.setQueryData(serverConnectionQueryKeys.status(), data)
  cleanup = async () => {
    await dom.cleanup()
    queryClient.clear()
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
  return container
}

test('Cloud access explains automatic setup without editable credentials or subscription controls', async () => {
  const container = await render({ ...selfHosted, managed: true, connected: true, configured: true })
  expect(container.textContent).toContain('managed automatically')
  expect(queryByRole(container, 'button', { name: /Connect|Disconnect/i })).toBeNull()
  expect(queryByRole(container, 'textbox')).toBeNull()
  expect(queryByRole(container, 'link', { name: 'Manage Pro and devices →' })).toBeNull()
})

test('self-hosted setup presents connection as primary action and does not imply a purchase', async () => {
  const container = await render(selfHosted)
  expect(getByRole(container, 'button', { name: 'Connect Ficus account' }).className).toContain('ficus-button-primary')
  expect(container.textContent).toContain('Connecting does not start a subscription')
  expect(getByRole(container, 'link', { name: 'Mobile setup guide →' }).getAttribute('href')).toBe(
    'https://ficus.example.com/docs/connect/mobile/'
  )
  expect(getByRole(container, 'textbox', { name: 'Server name' })).toBeTruthy()
})

test('read-only settings show coverage and personal-device exclusion without mutation controls', async () => {
  const container = await render(
    {
      ...selfHosted,
      connected: true,
      configured: true,
      status: {
        instanceId: 'server-1',
        name: 'Studio',
        origin: selfHosted.origin!,
        instancePro: true,
        allowance: 5,
        used: 2,
        registered: 4,
      },
    },
    false
  )
  expect(container.textContent).toContain('2 of 5 device slots in use')
  expect(container.textContent).toContain('Personal Ficus Pro devices do not use instance slots')
  expect(queryByRole(container, 'button')).toBeNull()
})

test('an identity without a human account cannot see relay management', async () => {
  const container = await render(selfHosted, true, false)
  expect(container.textContent).toBe('')
})

test('a saved credential can be disconnected locally when Cloud verification is unavailable', async () => {
  const container = await render({ ...selfHosted, configured: true, error: 'Could not reach Ficus Cloud.' })
  expect(getByRole(container, 'button', { name: 'Disconnect server' })).toBeTruthy()
  expect(getByRole(container, 'button', { name: 'Reconnect Ficus account' })).toBeTruthy()
  expect(container.textContent).toContain('Could not reach Ficus Cloud.')
})
