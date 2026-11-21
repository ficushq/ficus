import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { fireEvent } from '@testing-library/dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { queryKeys } from '../../queryKeys'
import type { RoleSummary } from '../../api/roles'
import { acquireDomHarness } from '../../test/domHarness'

type TestRole = RoleSummary & { readOnly?: boolean }

const ROLES: TestRole[] = [
  {
    id: 'source',
    name: 'Support Lead',
    slug: 'support-lead',
    permissions: ['squads:read', 'agents:read'],
  },
  {
    id: 'resource-wildcard',
    name: 'Agent Operator',
    slug: 'agent-operator',
    permissions: ['agents:*'],
    isSystem: true,
    readOnly: true,
  },
  { id: 'global', name: 'Administrator', slug: 'admin', permissions: ['*'], isSystem: true },
  { id: 'legacy', name: 'Legacy Role', slug: 'legacy', permissions: ['squads:read', 'legacy:manage'] },
]

describe('RolesSection cloning', () => {
  let dom: Awaited<ReturnType<typeof acquireDomHarness>>
  let root: import('react-dom/client').Root
  let container: HTMLDivElement
  let queryClient: QueryClient
  let RolesSection: typeof import('./RolesSection').RolesSection

  beforeEach(async () => {
    dom = await acquireDomHarness({
      url: 'http://localhost/settings',
      beforeUnmount: () => queryClient?.cancelQueries(),
      // Clearing the cache while the tree is mounted would refetch its queries.
      afterUnmount: () => queryClient?.clear(),
    })
    ;({ RolesSection } = await import('./RolesSection'))
    ;({ root, container } = dom.createRoot())
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Infinity, refetchOnMount: false },
        mutations: { retry: false },
      },
    })
    queryClient.setQueryData(queryKeys.roles.list(), ROLES)
    await dom.act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <RolesSection />
        </QueryClientProvider>
      )
    })
  })

  afterEach(async () => dom.cleanup())

  async function clickButton(label: string) {
    const button = container.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement
    await dom.act(async () => fireEvent.click(button))
    return button
  }

  async function permissionCheckbox(resource: string, action: string): Promise<HTMLInputElement> {
    const search = container.querySelector('[aria-label="Search permissions"]')!
    await dom.act(async () => fireEvent.change(search, { target: { value: `${resource}:${action}` } }))
    const checkbox = container.querySelector(`input[aria-label="${resource}:${action}"]`) as HTMLInputElement | null
    if (!checkbox) throw new Error(`Missing permission checkbox ${resource}:${action}`)
    return checkbox
  }

  test('lists only create-compatible sources and explains disabled duplicates', async () => {
    await clickButton('Create role')

    const select = container.querySelector('#create-role-clone-source') as HTMLSelectElement
    const values = [...select.options].map((option) => option.value)
    expect(values).toContain('source')
    expect(values).toContain('resource-wildcard')
    expect(values).not.toContain('global')
    expect(values).not.toContain('legacy')

    const duplicate = container.querySelector('button[aria-label="Duplicate role Administrator"]') as HTMLButtonElement
    expect(duplicate.getAttribute('aria-disabled')).toBe('true')
    expect(duplicate.disabled).toBe(false)
    const reasonId = duplicate.getAttribute('aria-describedby')
    expect(reasonId).toBeTruthy()
    expect(container.querySelector(`#${reasonId}`)?.textContent).toContain('cannot be assigned to a new role')
  })

  test('Duplicate reseeds and focuses the existing create form', async () => {
    await clickButton('Create role')
    const name = container.querySelector('#create-role-name') as HTMLInputElement
    const slug = container.querySelector('#create-role-slug') as HTMLInputElement
    await dom.act(async () => {
      fireEvent.input(name, { target: { value: 'Stale draft' } })
      fireEvent.input(slug, { target: { value: 'stale-draft' } })
    })

    await clickButton('Duplicate role Support Lead')
    await dom.act(async () => Bun.sleep(20))

    expect(container.querySelectorAll('#create-role-clone-source')).toHaveLength(1)
    expect((container.querySelector('#create-role-clone-source') as HTMLSelectElement).value).toBe('source')
    expect(name.value).toBe('')
    expect(slug.value).toBe('')
    expect((await permissionCheckbox('squads', 'read')).checked).toBe(true)
    expect((await permissionCheckbox('agents', 'read')).checked).toBe(true)
    expect(dom.window.document.activeElement).toBe(name)
  })

  test('Cancel clears the selected source and copied permissions', async () => {
    await clickButton('Create role')
    const select = container.querySelector('#create-role-clone-source') as HTMLSelectElement
    await dom.act(async () => fireEvent.change(select, { target: { value: 'source' } }))

    const cancel = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Cancel')!
    await dom.act(async () => fireEvent.click(cancel))
    await clickButton('Create role')

    expect((container.querySelector('#create-role-clone-source') as HTMLSelectElement).value).toBe('')
    expect((await permissionCheckbox('squads', 'read')).checked).toBe(false)
    expect((await permissionCheckbox('agents', 'read')).checked).toBe(false)
  })

  test('an earlier create response does not erase a newer duplicate draft', async () => {
    let resolveCreate!: (response: Response) => void
    const createResponse = new Promise<Response>((resolve) => {
      resolveCreate = resolve
    })
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_input, init) => {
      if (init?.method === 'POST') return createResponse
      return Response.json(ROLES)
    }) as typeof fetch
    dom.window.fetch = globalThis.fetch

    try {
      await clickButton('Create role')
      await dom.act(async () => {
        fireEvent.input(container.querySelector('#create-role-name')!, { target: { value: 'First draft' } })
        fireEvent.input(container.querySelector('#create-role-slug')!, { target: { value: 'first-draft' } })
      })
      const create = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Create')!
      await dom.act(async () => fireEvent.click(create))

      await clickButton('Duplicate role Agent Operator')
      expect((container.querySelector('#create-role-clone-source') as HTMLSelectElement).value).toBe(
        'resource-wildcard'
      )

      await dom.act(async () => {
        resolveCreate(
          Response.json(
            {
              id: 'created',
              name: 'First draft',
              slug: 'first-draft',
              permissions: [],
              isSystem: false,
            },
            { status: 201 }
          )
        )
        await createResponse
        for (let attempt = 0; attempt < 20 && queryClient.isMutating() > 0; attempt += 1) {
          await Bun.sleep(0)
        }
      })

      expect((container.querySelector('#create-role-clone-source') as HTMLSelectElement).value).toBe(
        'resource-wildcard'
      )
      expect((container.querySelector('#create-role-name') as HTMLInputElement).value).toBe('')
      expect((container.querySelector('#create-role-slug') as HTMLInputElement).value).toBe('')
    } finally {
      globalThis.fetch = originalFetch
      dom.window.fetch = originalFetch
    }
  })

  test('successful creation sends only editable fields and resets cloned state', async () => {
    const requests: Array<{ method: string; body?: Record<string, unknown> }> = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_input, init) => {
      const method = init?.method ?? 'GET'
      requests.push({
        method,
        body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined,
      })
      if (method === 'POST') {
        return Response.json(
          {
            id: 'created',
            name: 'Escalation Lead',
            slug: 'escalation-lead',
            permissions: ['squads:read', 'agents:read'],
            isSystem: false,
          },
          { status: 201 }
        )
      }
      return Response.json(ROLES)
    }) as typeof fetch
    dom.window.fetch = globalThis.fetch

    try {
      await clickButton('Create role')
      await dom.act(async () =>
        fireEvent.change(container.querySelector('#create-role-clone-source')!, { target: { value: 'source' } })
      )
      await dom.act(async () => {
        fireEvent.input(container.querySelector('#create-role-name')!, { target: { value: 'Escalation Lead' } })
        fireEvent.input(container.querySelector('#create-role-slug')!, { target: { value: 'escalation-lead' } })
      })
      const create = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Create')!
      await dom.act(async () => {
        fireEvent.click(create)
        await Bun.sleep(0)
      })

      expect(requests.find((request) => request.method === 'POST')?.body).toEqual({
        name: 'Escalation Lead',
        slug: 'escalation-lead',
        permissions: ['squads:read', 'agents:read'],
      })
      expect(container.querySelector('#create-role-clone-source')).toBeNull()

      await clickButton('Create role')
      expect((container.querySelector('#create-role-clone-source') as HTMLSelectElement).value).toBe('')
      expect((await permissionCheckbox('squads', 'read')).checked).toBe(false)
      expect((await permissionCheckbox('agents', 'read')).checked).toBe(false)
    } finally {
      globalThis.fetch = originalFetch
      dom.window.fetch = originalFetch
    }
  })

  test('selector copies permissions and editing the draft does not mutate its source', async () => {
    await clickButton('Create role')
    const select = container.querySelector('#create-role-clone-source') as HTMLSelectElement

    await dom.act(async () => fireEvent.change(select, { target: { value: 'source' } }))

    expect((await permissionCheckbox('squads', 'read')).checked).toBe(true)
    expect((await permissionCheckbox('agents', 'read')).checked).toBe(true)

    const agentRead = await permissionCheckbox('agents', 'read')
    await dom.act(async () => fireEvent.click(agentRead))
    expect((await permissionCheckbox('agents', 'read')).checked).toBe(false)
    expect(
      queryClient.getQueryData<TestRole[]>(queryKeys.roles.list())?.find((role) => role.id === 'source')?.permissions
    ).toEqual(['squads:read', 'agents:read'])
  })
})
