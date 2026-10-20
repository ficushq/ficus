import { afterEach, expect, test } from 'bun:test'
import { act } from 'react'
import { fireEvent, getByRole, queryByRole, waitFor } from '@testing-library/dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { acquireDomHarness } from '../../test/domHarness'
import { PermissionsProvider, type PermissionsResult } from '../../hooks/usePermissions'
import { publicUrlQueryKeys } from '../../queryKeys'
import type { PublicAppUrlPreview, PublicAppUrlStatus } from '../../api/publicUrl'
import { PublicAddressSettings } from './PublicAddressSettings'

let cleanup: (() => Promise<void>) | undefined
afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
})

const localOnly: PublicAppUrlStatus = {
  url: 'http://localhost:61896',
  source: 'local-default',
  locked: false,
  localUrl: 'http://localhost:61896',
  desktopManaged: true,
  version: 'unset',
  lastChange: null,
  mobileReady: false,
  basePath: '',
}

const preview: PublicAppUrlPreview = {
  normalizedUrl: 'https://ficus.example.com',
  effectiveUrl: 'https://ficus.example.com',
  impact: {
    originChanged: true,
    relayReconnectRequired: true,
    mobileReady: true,
    basePathMismatch: false,
    oauthCallbacks: [
      {
        label: 'GitHub OAuth callback',
        before: 'http://localhost:61896/settings/integrations/oauth/callback/github',
        after: 'https://ficus.example.com/settings/integrations/oauth/callback/github',
      },
    ],
    webhooks: [
      {
        label: 'Linear webhook',
        before: 'http://localhost:61896/api/webhooks/linear',
        after: 'https://ficus.example.com/api/webhooks/linear',
      },
    ],
  },
}

type Reply = (body: unknown) => Response

async function render(
  status: PublicAppUrlStatus,
  options: { write?: boolean; put?: (body: unknown, reply: Reply) => Response; url?: string } = {}
) {
  const { write = true } = options
  const dom = await acquireDomHarness({ url: options.url ?? 'http://localhost:61896' })
  const requests: { method: string; path: string; body?: unknown }[] = []
  const previousFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    requests.push({ method, path: url.pathname, body })
    if (url.pathname === '/api/public-url/preview') return Response.json(preview)
    if (url.pathname === '/api/public-url' && method === 'PUT')
      return options.put
        ? options.put(body, (b) => Response.json(b))
        : Response.json({ ...status, url: 'https://ficus.example.com', source: 'setting' })
    return Response.json(status)
  }) as typeof fetch
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  queryClient.setQueryData(publicUrlQueryKeys.status(), status)
  cleanup = async () => {
    await dom.cleanup()
    queryClient.clear()
    globalThis.fetch = previousFetch
  }
  const { root, container } = dom.createRoot()
  const permissions: PermissionsResult = {
    permissions: ['settings:read', ...(write ? ['settings:write'] : [])],
    identity: { type: 'user', userId: 'test-user' },
    can: (permission) => permission === 'settings:read' || (permission === 'settings:write' && write),
    isLoading: false,
    isError: false,
  }
  const saved: string[] = []
  await act(async () =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <PermissionsProvider usePermissions={() => permissions}>
          <PublicAddressSettings onSaved={(message) => saved.push(message)} />
        </PermissionsProvider>
      </QueryClientProvider>
    )
  )
  return { container, dom, requests, saved }
}

test('an environment lock explains itself and offers no editing', async () => {
  const { container } = await render({
    ...localOnly,
    url: 'https://env.example.com',
    source: 'environment',
    locked: true,
    lockedBy: 'environment',
    desktopManaged: false,
  })
  expect(container.textContent).toContain('Set by the server environment (APP_URL)')
  expect(container.textContent).toContain('https://env.example.com')
  expect(queryByRole(container, 'button', { name: /public address/i })).toBeNull()
})

test('a Desktop environment lock points at updating Ficus Desktop', async () => {
  const { container } = await render({
    ...localOnly,
    source: 'environment',
    locked: true,
    lockedBy: 'environment',
  })
  expect(container.textContent).toContain('Update Ficus Desktop to change it here.')
  expect(queryByRole(container, 'button', { name: /public address/i })).toBeNull()
})

test('local-only state is explained and non-admins cannot change it', async () => {
  const { container } = await render(localOnly, { write: false })
  expect(container.textContent).toContain('Local only.')
  expect(container.textContent).not.toContain('APP_URL')
  expect(queryByRole(container, 'button', { name: /public address/i })).toBeNull()
})

test('change → review → confirm sends the version it reviewed and reports the reconnect', async () => {
  const { container, dom, requests, saved } = await render(localOnly)
  await dom.act(async () => fireEvent.click(getByRole(container, 'button', { name: 'Set public address…' })))
  const field = getByRole(container, 'textbox', { name: 'New public address' }) as HTMLInputElement
  await dom.act(async () => fireEvent.input(field, { target: { value: 'https://ficus.example.com' } }))
  await dom.act(async () => fireEvent.click(getByRole(container, 'button', { name: 'Review change' })))

  const dialog = await waitFor(() => getByRole(document.body, 'dialog', { name: 'Change the public address?' }))
  const text = dialog.textContent ?? ''
  expect(text).toContain('Passkeys don’t carry over to a new hostname')
  expect(text).toContain('keep working at the local address (http://localhost:61896)')
  expect(text).toContain('needs email delivery')
  expect(text).toContain('replaces all of your existing passkeys and signs out every session')
  expect(text).toContain('set APP_URL in the server environment and restart')
  expect(text).not.toContain('You may be signed out')
  expect(getByRole(dialog, 'button', { name: 'Copy new Linear webhook' })).toBeTruthy()
  expect(text).toContain('connect it again')
  expect(text).toContain('don’t move to the new one')
  expect(text).toContain('https://ficus.example.com/settings/integrations/oauth/callback/github')
  expect(text).toContain('https://ficus.example.com/api/webhooks/linear')
  expect(text).toContain('checks the address format only')
  expect(requests.some((r) => r.method === 'PUT')).toBe(false)

  await dom.act(async () => fireEvent.click(getByRole(dialog, 'button', { name: 'Save address' })))
  await waitFor(() => expect(saved).toHaveLength(1))
  expect(requests.find((r) => r.method === 'PUT')?.body).toEqual({
    url: 'https://ficus.example.com',
    expectedVersion: 'unset',
  })
  expect(requests.find((r) => r.path === '/api/public-url/preview')?.body).toEqual({ url: 'https://ficus.example.com' })
  expect(saved[0]).toContain('connect it again')
})

test('a stale version shows the conflict and reloads the current value', async () => {
  const { container, dom, requests } = await render(localOnly, {
    put: () => Response.json({ error: 'conflict', currentVersion: '2026-10-20T00:00:00.000Z' }, { status: 409 }),
  })
  await dom.act(async () => fireEvent.click(getByRole(container, 'button', { name: 'Set public address…' })))
  const field = getByRole(container, 'textbox', { name: 'New public address' })
  await dom.act(async () => fireEvent.input(field, { target: { value: 'https://ficus.example.com' } }))
  await dom.act(async () => fireEvent.click(getByRole(container, 'button', { name: 'Review change' })))
  const dialog = await waitFor(() => getByRole(document.body, 'dialog', { name: 'Change the public address?' }))
  await dom.act(async () => fireEvent.click(getByRole(dialog, 'button', { name: 'Save address' })))
  await waitFor(() => expect(getByRole(container, 'alert').textContent).toContain('Someone else changed'))
  await waitFor(() => expect(requests.filter((r) => r.path === '/api/public-url/status').length).toBeGreaterThan(0))
})

test('Clear sends null after confirmation', async () => {
  const configured: PublicAppUrlStatus = {
    ...localOnly,
    url: 'https://ficus.example.com',
    storedUrl: 'https://ficus.example.com',
    source: 'setting',
    version: '2026-10-20T00:00:00.000Z',
    lastChange: {
      previousValue: null,
      newValue: 'https://ficus.example.com',
      actor: 'Noah',
      source: 'admin-api',
      at: '2026-10-20T00:00:00.000Z',
    },
  }
  const { container, dom, requests } = await render(configured)
  expect(container.textContent).toContain('Configured here.')
  expect(container.textContent).toContain('Changed by Noah')
  expect(container.textContent).toContain('Local address')
  await dom.act(async () => fireEvent.click(getByRole(container, 'button', { name: 'Clear…' })))
  const dialog = await waitFor(() => getByRole(document.body, 'dialog', { name: 'Clear the public address?' }))
  await dom.act(async () => fireEvent.click(getByRole(dialog, 'button', { name: 'Clear address' })))
  await waitFor(() =>
    expect(requests.find((r) => r.method === 'PUT')?.body).toEqual({
      url: null,
      expectedVersion: '2026-10-20T00:00:00.000Z',
    })
  )
})

test('warns when the address in use stops being allowed', async () => {
  const configured: PublicAppUrlStatus = {
    ...localOnly,
    url: 'https://old.example.com',
    storedUrl: 'https://old.example.com',
    source: 'setting',
    version: '2026-10-20T00:00:00.000Z',
  }
  const { container, dom } = await render(configured, { url: 'https://old.example.com' })
  await dom.act(async () => fireEvent.click(getByRole(container, 'button', { name: 'Change public address…' })))
  const field = getByRole(container, 'textbox', { name: 'New public address' })
  await dom.act(async () => fireEvent.input(field, { target: { value: 'https://ficus.example.com' } }))
  await dom.act(async () => fireEvent.click(getByRole(container, 'button', { name: 'Review change' })))
  const dialog = await waitFor(() => getByRole(document.body, 'dialog', { name: 'Change the public address?' }))
  expect(dialog.textContent).toContain('You’re using https://old.example.com')
  expect(dialog.textContent).toContain('You may be signed out here')
})
