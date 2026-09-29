import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { queryKeys } from '../../queryKeys'
import { isUserAssignableRole, type RoleSummary } from '../../api/roles'
import { acquireDomHarness } from '../../test/domHarness'

const ROLES: RoleSummary[] = [
  { id: 'r-admin', name: 'Admin', slug: 'admin', permissions: ['*'], appliesTo: 'user', isSystem: true },
  { id: 'r-operator', name: 'Operator', slug: 'operator', permissions: ['squads:*'], appliesTo: 'user' },
  { id: 'r-viewer', name: 'Viewer', slug: 'viewer', permissions: ['squads:read'], appliesTo: 'user' },
  { id: 'r-worker', name: 'Squad Worker', slug: 'default-worker', permissions: ['chat:send'], appliesTo: 'agent' },
  { id: 'r-manager', name: 'Squad Manager', slug: 'default-manager', permissions: ['chat:send'], appliesTo: 'agent' },
]

describe('isUserAssignableRole', () => {
  test('keeps user and both roles, drops agent roles', () => {
    expect(ROLES.filter(isUserAssignableRole).map((r) => r.slug)).toEqual(['admin', 'operator', 'viewer'])
    expect(isUserAssignableRole({ id: 'x', name: 'X', slug: 'x', permissions: [], appliesTo: 'both' })).toBe(true)
  })

  test('treats a role from an older server (no appliesTo) as user-assignable', () => {
    expect(isUserAssignableRole({ id: 'x', name: 'X', slug: 'x', permissions: [] })).toBe(true)
  })
})

describe('invite form role picker', () => {
  let dom: Awaited<ReturnType<typeof acquireDomHarness>>
  let container: HTMLDivElement
  let root: import('react-dom/client').Root
  let queryClient: QueryClient | undefined
  let UsersSection: typeof import('./UsersSection').UsersSection

  beforeEach(async () => {
    dom = await acquireDomHarness({
      url: 'http://localhost/',
      beforeUnmount: async () => {
        await queryClient?.cancelQueries()
        queryClient?.clear()
      },
    })
    ;({ UsersSection } = await import('./UsersSection'))
    ;({ root, container } = dom.createRoot())
  })

  afterEach(async () => {
    await dom.cleanup()
    queryClient = undefined
  })

  async function openInviteForm(roles: RoleSummary[] = ROLES) {
    queryClient = new QueryClient({
      // Seeded data only — never let a queryFn reach the network in a unit test.
      defaultOptions: { queries: { retry: false, staleTime: Infinity, refetchOnMount: false } },
    })
    queryClient.setQueryData(queryKeys.users.list(), [
      { id: 'u1', email: 'admin@example.com', displayName: 'Admin', disabledAt: null, createdAt: '2026-01-01' },
    ])
    queryClient.setQueryData(queryKeys.roles.list(), roles)
    queryClient.setQueryData(queryKeys.users.roles('u1'), [])

    await dom.act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <UsersSection />
        </QueryClientProvider>
      )
    })

    const inviteButton = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Invite User')
    await dom.act(async () => {
      inviteButton!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })
    return container.querySelector('#invite-user-role') as HTMLSelectElement
  }

  const given = () =>
    [...container.querySelectorAll('[aria-label="Roles to give"] li > span')].map((el) => el.textContent)

  async function choose(select: HTMLSelectElement | null, value: string) {
    await dom.act(async () => {
      select!.value = value
      select!.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
    })
  }

  test('the invite form gives Operator system-wide until you change it', async () => {
    await openInviteForm()
    expect(given()).toEqual(['Operator · System'])
  })

  test('viewer and admin are offered to add', async () => {
    const select = await openInviteForm()
    const values = [...select.querySelectorAll('option')].map((o) => o.getAttribute('value'))
    expect(values).toContain('r-viewer')
    expect(values).toContain('r-admin')
  })

  test('agent roles never appear in the picker', async () => {
    const select = await openInviteForm()
    const values = [...select.querySelectorAll('option')].map((o) => o.getAttribute('value'))
    expect(values).not.toContain('r-worker')
    expect(values).not.toContain('r-manager')
    expect(select.textContent).not.toContain('Squad Worker')
  })

  test('adds a role scoped to one squad or every squad, and removes the default', async () => {
    const select = await openInviteForm()
    queryClient!.setQueryData(queryKeys.squads.list(), [{ id: 'squad-1', name: 'Attune' }])
    await choose(select, 'r-viewer')
    await choose(container.querySelector('#invite-user-scope'), 'squad')
    await choose(container.querySelector('#invite-user-squad'), 'squad-1')
    const add = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Add')!
    await dom.act(async () => {
      add.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })
    await choose(container.querySelector('#invite-user-role'), 'r-viewer')
    await choose(container.querySelector('#invite-user-scope'), 'squad_default')
    await dom.act(async () => {
      ;[...container.querySelectorAll('button')]
        .find((b) => b.textContent === 'Add')!
        .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })
    const remove = container.querySelector('button[aria-label="Remove Operator (System)"]')!
    await dom.act(async () => {
      remove.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })
    expect(given()).toEqual(['Viewer · Attune', 'Viewer · Every squad'])

    let body: unknown
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body))
      return new Response(JSON.stringify({ id: 'u2', email: 'new@example.com' }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch
    try {
      const email = container.querySelector('input[type="email"]') as HTMLInputElement
      await dom.act(async () => {
        const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!
        setValue.call(email, 'new@example.com')
        email.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      })
      await dom.act(async () => {
        email.form!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
      })
      await dom.act(async () => {})
    } finally {
      globalThis.fetch = originalFetch
    }
    expect(body).toMatchObject({
      email: 'new@example.com',
      assignments: [
        { roleId: 'r-viewer', scope: 'squad', squadId: 'squad-1' },
        { roleId: 'r-viewer', scope: 'squad_default' },
      ],
    })
  })

  test('a role picked but not added holds off the invite until added or cleared', async () => {
    const select = await openInviteForm()
    const submit = () => [...container.querySelectorAll('button[type="submit"]')].at(-1) as HTMLButtonElement
    const email = container.querySelector('input[type="email"]') as HTMLInputElement
    await dom.act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!
      setValue.call(email, 'new@example.com')
      email.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    })
    expect(submit().disabled).toBe(false)
    await choose(select, 'r-viewer')
    expect(submit().disabled).toBe(true)
    expect(container.textContent).toContain('Add the role you picked (or clear it) before inviting.')
    await choose(container.querySelector('#invite-user-role'), '')
    expect(submit().disabled).toBe(false)
  })

  test('the per-user role editor is fed the same filtered list', async () => {
    await openInviteForm()
    // Expanding a user row renders its own role <select>; nothing agent-derived
    // may reach it either.
    const manage = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Manage Roles')
    await dom.act(async () => {
      manage!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })
    const rowSelect = container.querySelector('#assign-u1-role') as HTMLSelectElement
    expect(rowSelect).not.toBeNull()
    const values = [...rowSelect.querySelectorAll('option')].map((o) => o.getAttribute('value'))
    expect(values).toContain('r-viewer')
    expect(values).not.toContain('r-worker')
    expect(values).not.toContain('r-manager')
  })

  test('says every new person also gets Farmer, when the instance has it', async () => {
    await openInviteForm()
    expect(container.textContent).not.toContain('along with Farmer')
    await dom.act(async () => root.unmount())
    ;({ root, container } = dom.createRoot())
    await openInviteForm([
      ...ROLES,
      { id: 'r-farmer', name: 'Farmer', slug: 'farmer', permissions: ['farm:read', 'farm:chat'], appliesTo: 'user' },
    ])
    expect(container.textContent).toContain('along with Farmer (the farm), which every new person gets')
  })

  test('falls back to the first available role when operator is absent', async () => {
    await openInviteForm(ROLES.filter((r) => r.slug !== 'operator'))
    expect(given()).toEqual(['Admin · System'])
  })
})
