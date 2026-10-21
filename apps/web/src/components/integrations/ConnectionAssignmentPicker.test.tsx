import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { fireEvent } from '@testing-library/dom'
import { acquireDomHarness } from '../../test/domHarness'
import { integrationQueryKeys } from '../../queryKeys'

let harness: Awaited<ReturnType<typeof acquireDomHarness>>
let root: import('react-dom/client').Root
let container: HTMLDivElement
let oldFetch: typeof globalThis.fetch
let requests: { url: string; method: string; body: string }[]

const selection = {
  providerKey: 'bigbrain',
  assignment: { id: 'one', providerKey: 'bigbrain', displayName: 'Primary', enabled: true, healthState: 'healthy' },
  connections: [
    { id: 'one', providerKey: 'bigbrain', displayName: 'Primary', enabled: true, healthState: 'healthy' },
    { id: 'two', providerKey: 'bigbrain', displayName: 'Unavailable', enabled: false, healthState: 'unknown' },
    { id: 'three', providerKey: 'bigbrain', displayName: 'Secondary', enabled: true, healthState: 'healthy' },
  ],
}

beforeEach(async () => {
  harness = await acquireDomHarness({ url: 'http://localhost' })
  ;({ root, container } = harness.createRoot())
  oldFetch = globalThis.fetch
  requests = []
  globalThis.fetch = (async (input, init) => {
    requests.push({ url: String(input), method: init?.method ?? 'GET', body: String(init?.body ?? '') })
    return Response.json(selection)
  }) as typeof fetch
})

afterEach(async () => {
  globalThis.fetch = oldFetch
  await harness.cleanup()
})

async function render(canWrite: boolean) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(integrationQueryKeys.squad('squad-1', 'bigbrain'), selection)
  const { ConnectionAssignmentPicker } = await import('./ConnectionAssignmentPicker')
  await harness.act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ConnectionAssignmentPicker
          squadId="squad-1"
          provider="bigbrain"
          presentation={{ label: 'BigBrain' }}
          canRead
          canWrite={canWrite}
        />
      </QueryClientProvider>
    )
  )
  return client
}

describe('ConnectionAssignmentPicker', () => {
  test('renders only redacted assignment summary and disabled options', async () => {
    await render(false)
    expect(container.textContent).toContain('Primary')
    expect(container.textContent).toContain('Unavailable')
    expect(container.innerHTML).not.toContain('apiBase')
    expect(container.querySelector('select')).toBeNull()
  })

  test('retries degraded projection without mutating the assignment', async () => {
    const client = await render(true)
    await harness.act(async () => {
      client.setQueryData(integrationQueryKeys.squad('squad-1', 'bigbrain'), {
        ...selection,
        projection: { status: 'degraded', lastErrorCode: 'install_failed' },
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    const retry = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Retry')!
    await harness.act(async () => {
      fireEvent.click(retry)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(requests.find((request) => request.url.includes('/projection/retry'))).toMatchObject({ method: 'POST' })
    expect(requests.some((request) => request.method === 'PUT')).toBe(false)
  })

  test('assigns and unassigns while invalidating squad and pool queries', async () => {
    const client = await render(true)
    client.setQueryData(integrationQueryKeys.pool('bigbrain'), [])
    const select = container.querySelector<HTMLSelectElement>(
      'select[aria-label="BigBrain connection for this squad"]'
    )!
    await harness.act(async () => {
      fireEvent.change(select, { target: { value: 'three' } })
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(requests.find((request) => request.method === 'PUT')).toMatchObject({
      method: 'PUT',
      body: JSON.stringify({ connectionId: 'three' }),
    })

    await harness.act(async () => {
      fireEvent.change(select, { target: { value: '' } })
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(requests.find((request) => request.method === 'DELETE')).toMatchObject({ method: 'DELETE' })
    expect(client.getQueryState(integrationQueryKeys.squad('squad-1', 'bigbrain'))).toBeDefined()
    expect(client.getQueryState(integrationQueryKeys.pool('bigbrain'))?.isInvalidated).toBe(true)
  })
  describe('GitHub commit signing', () => {
    const account = (id: string, displayName: string) => ({
      id,
      providerKey: 'github',
      displayName,
      enabled: true,
      healthState: 'healthy',
    })
    const github = (accounts: { connectionId: string; login: string; state: string; signsFor: string[] }[]) => ({
      providerKey: 'github',
      assignment: account('a', 'Agent account'),
      connections: [account('a', 'Agent account'), account('b', 'Owner account'), account('c', 'Spare account')],
      attached: [
        { ...account('a', 'Agent account'), isDefault: true },
        { ...account('b', 'Owner account'), isDefault: false },
      ],
      commitSigning: {
        defaultConnectionId: 'a',
        accounts: accounts.map((item) => ({ ...item, isDefault: item.connectionId === 'a' })),
      },
    })
    const show = async (data: ReturnType<typeof github>) => {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
      client.setQueryData(integrationQueryKeys.squad('squad-1', 'github'), data)
      const { ConnectionAssignmentPicker } = await import('./ConnectionAssignmentPicker')
      await harness.act(async () =>
        root.render(
          <QueryClientProvider client={client}>
            <ConnectionAssignmentPicker
              squadId="squad-1"
              provider="github"
              presentation={{ label: 'GitHub' }}
              canRead
              canWrite={false}
            />
          </QueryClientProvider>
        )
      )
    }

    test('shows which attached accounts sign and that the committer email chooses the key', async () => {
      await show(
        github([
          { connectionId: 'a', login: 'agent', state: 'on', signsFor: ['1+agent@users.noreply.github.com'] },
          { connectionId: 'b', login: 'owner', state: 'off', signsFor: [] },
        ])
      )
      expect(container.textContent).toContain('Signs commits committed as 1+agent@users.noreply.github.com')
      expect(container.textContent).toContain('Commit signing is off for @owner: its commits are not signed')
      expect(container.textContent).toContain('Commits made as an attached account with signing off are not signed')
      expect(container.textContent).toContain('belongs to no attached account is refused')
      expect(container.textContent).toContain('signed by the attached account its committer email belongs to')
      expect(container.textContent).not.toContain('Spare accountSigns')
    })

    test('does not describe signing when no attached account signs', async () => {
      await show(
        github([
          { connectionId: 'a', login: 'agent', state: 'needs_attention', signsFor: [] },
          { connectionId: 'b', login: 'owner', state: 'off', signsFor: [] },
        ])
      )
      expect(container.textContent).toContain('Commit signing for @agent needs attention')
      expect(container.textContent).not.toContain('signed by the attached account')
    })
  })
})

describe('managed shared vaults', () => {
  const managedSelection = {
    providerKey: 'bigbrain',
    assignment: null,
    attached: [
      {
        id: 'a',
        providerKey: 'bigbrain',
        displayName: 'Alpha',
        enabled: true,
        healthState: 'healthy',
        isDefault: false,
      },
    ],
    connections: [
      { id: 'a', providerKey: 'bigbrain', displayName: 'Alpha', enabled: true, healthState: 'healthy' },
      { id: 'b', providerKey: 'bigbrain', displayName: 'Beta', enabled: true, healthState: 'healthy' },
      { id: 'c', providerKey: 'bigbrain', displayName: 'Revoked', enabled: false, healthState: 'unknown' },
    ],
  }
  async function renderManaged(canWrite: boolean, data: unknown = managedSelection) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    client.setQueryData(integrationQueryKeys.squad('squad-1', 'bigbrain'), data)
    const { ConnectionAssignmentPicker } = await import('./ConnectionAssignmentPicker')
    await harness.act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <ConnectionAssignmentPicker
              squadId="squad-1"
              provider="bigbrain"
              presentation={{ label: 'BigBrain' }}
              managed
              canRead
              canWrite={canWrite}
            />
          </MemoryRouter>
        </QueryClientProvider>
      )
    )
  }
  const box = (name: string) =>
    [...container.querySelectorAll('label')].find((l) => l.textContent?.includes(name))!.querySelector('input')!
  const settle = async () => {
    for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve, 0))
  }

  test('attaches B alongside A with no default and no single-select', async () => {
    await renderManaged(true)
    expect(container.querySelector('select')).toBeNull()
    expect(container.textContent).not.toContain('Make default')
    expect(container.textContent).toContain('must name the vault they read')
    expect(box('Alpha').checked).toBe(true)
    expect(box('Beta').checked).toBe(false)
    await harness.act(async () => {
      fireEvent.click(box('Beta'))
      await settle()
    })
    const writes = requests.filter((r) => r.method !== 'GET')
    expect(writes).toHaveLength(1)
    expect([writes[0]!.method, new URL(writes[0]!.url).pathname]).toEqual([
      'PUT',
      '/api/squads/squad-1/integrations/bigbrain/assignment',
    ])
    expect(JSON.parse(writes[0]!.body)).toEqual({ connectionId: 'b', makeDefault: false })
  })

  test('detaching A removes only A', async () => {
    await renderManaged(true)
    await harness.act(async () => {
      fireEvent.click(box('Alpha'))
      await settle()
    })
    const writes = requests.filter((r) => r.method !== 'GET')
    expect(writes.map((w) => [w.method, new URL(w.url).search])).toEqual([['DELETE', '?connectionId=a']])
  })

  test('a vault without read access cannot be newly attached, and says why', async () => {
    await renderManaged(true)
    const revoked = box('Revoked')
    expect(revoked.disabled).toBe(true)
    const reason = container.querySelector(`#${revoked.getAttribute('aria-describedby')}`)!
    expect(reason.textContent).toContain('Ficus cannot read this vault yet, so it cannot be attached.')
    expect(reason.querySelector('a')?.getAttribute('href')).toBe('/settings?section=integrations')
    expect(container.textContent).not.toContain('read access off')
    // Where the other half of the setup lives: the agent type's BigBrain tools.
    const agentTypes = [...container.querySelectorAll('a')].find((a) => a.textContent === 'Agent types')
    expect(agentTypes?.getAttribute('href')).toBe('/settings?section=agent-types')
    expect(box('Beta').getAttribute('aria-describedby')).toBeNull()
  })

  test('rows are the vaults the server lists: an attachment it leaves out (a deleted vault) is never shown', async () => {
    const retired = {
      id: 'r',
      providerKey: 'bigbrain',
      displayName: 'ficus-shared (retired 8b6f29ae)',
      enabled: false,
      healthState: 'unknown',
      isDefault: false,
    }
    await renderManaged(true, { ...managedSelection, attached: [...managedSelection.attached, retired] })
    expect(container.textContent).not.toContain('retired')
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(3)
  })

  test('a squad whose only attachment was a deleted vault shows no vaults', async () => {
    await renderManaged(false, { ...managedSelection, attached: [], connections: [] })
    expect(container.textContent).toContain('No shared vaults are attached to this squad.')
    expect(container.querySelector('input')).toBeNull()
  })

  test('a squad reader sees only its attached vaults and cannot change them', async () => {
    await renderManaged(false, { ...managedSelection, connections: managedSelection.attached })
    expect(container.textContent).toContain('Alpha')
    expect(container.textContent).not.toContain('Beta')
    expect(box('Alpha').disabled).toBe(true)
  })
})
