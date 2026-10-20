import { fireEvent, waitFor } from '@testing-library/dom'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { acquireDomHarness } from '../../test/domHarness'
import { PermissionsProvider } from '../../hooks/usePermissions'
import { integrationQueryKeys, queryKeys } from '../../queryKeys'
import { IntegrationSettings } from './IntegrationSettings'

let harness: Awaited<ReturnType<typeof acquireDomHarness>>
let root: import('react-dom/client').Root
let container: HTMLDivElement

beforeEach(async () => {
  harness = await acquireDomHarness({ url: 'http://localhost' })
  ;({ root, container } = harness.createRoot())
})

afterEach(async () => harness.cleanup())

type PermissionState = { permissions?: string[]; isError?: boolean }

async function renderMatrix(instance: PermissionState, squad: PermissionState) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.squads.basic('squad-1'), {
    id: 'squad-1',
    name: 'Research',
    purpose: 'Research',
    status: 'active',
    metadata: {},
  })
  client.setQueryData(queryKeys.secrets.list(), { secrets: [] })
  client.setQueryData(integrationQueryKeys.catalog(), {
    integrations: [
      {
        key: 'bigbrain',
        enabled: true,
        label: 'BigBrain',
        description: 'BigBrain',
        capabilities: [],
        assignable: true,
        authorization: { kind: 'manual' },
      },
    ],
  })
  client.setQueryData(integrationQueryKeys.pool('bigbrain'), [])
  client.setQueryData(integrationQueryKeys.squad('squad-1', 'bigbrain'), {
    providerKey: 'bigbrain',
    scope: { enabled: true, inheritDefault: false, globalDefaultId: null },
    assignment: null,
    connections: [
      { id: 'connection-1', providerKey: 'bigbrain', displayName: 'Primary', enabled: true, healthState: 'healthy' },
    ],
  })
  const state = (value: PermissionState) => {
    const permissions = value.permissions ?? []
    return {
      permissions,
      can: (permission: string) => permissions.includes(permission),
      isLoading: false,
      isError: value.isError ?? false,
    }
  }
  await harness.act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <PermissionsProvider usePermissions={(squadId) => state(squadId ? squad : instance)}>
          <MemoryRouter>
            <IntegrationSettings squadId="squad-1" />
          </MemoryRouter>
        </PermissionsProvider>
      </QueryClientProvider>
    )
  )
  return client
}

async function expand() {
  const button = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Settings'))
  expect(button).toBeDefined()
  await harness.act(async () => fireEvent.click(button!))
}
test('global management permissions do not grant squad access or expose global credential forms', async () => {
  await renderMatrix({ permissions: ['integrations:read:bigbrain', 'integrations:write:bigbrain'] }, {})
  expect(container.textContent).toContain('You do not have permission')
  expect(container.querySelector('article')).toBeNull()
  expect(container.textContent).not.toContain('on this Mac')
})
test('squad readers can expand enabled cards without global management rights', async () => {
  await renderMatrix({}, { permissions: ['integrations:read'] })
  expect(container.textContent).toContain('BigBrain')
  expect(container.querySelector<HTMLButtonElement>('[role="switch"]')?.disabled).toBe(true)
  await expand()
  expect(container.textContent).toContain('Connection for this squad')
  expect(container.textContent).not.toContain('on this Mac')
  expect(container.querySelector('select[aria-label="BigBrain connection for this squad"]')).toBeNull()
})
test('squad writers get an editable account selector, never global credential management', async () => {
  await renderMatrix({ isError: true }, { permissions: ['integrations:read', 'integrations:write'] })
  await expand()
  expect(
    container.querySelector<HTMLSelectElement>('select[aria-label="BigBrain connection for this squad"]')?.disabled
  ).toBe(false)
  expect(container.textContent).not.toContain('on this Mac')
  expect(container.textContent).not.toContain('API base:')
})
test('write alone and failed squad permission lookup fail closed', async () => {
  await renderMatrix({}, { permissions: ['integrations:write'] })
  expect(container.querySelector('article')).toBeNull()
  await renderMatrix({ permissions: ['integrations:write:bigbrain'] }, { isError: true })
  expect(container.textContent).toContain('Unable to load squad integrations')
  expect(container.querySelector('article')).toBeNull()
})
test('globally disabled providers are absent from the squad directory', async () => {
  const client = await renderMatrix({}, { permissions: ['integrations:read'] })
  await harness.act(async () => {
    client.setQueryData(integrationQueryKeys.catalog(), {
      integrations: [{ key: 'bigbrain', label: 'BigBrain', enabled: false, assignable: true }],
    })
    await waitFor(() => expect(container.querySelectorAll('article').length).toBe(0))
  })
  expect(container.querySelector('article')).toBeNull()
})
