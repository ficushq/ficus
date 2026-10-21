import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent } from '@testing-library/dom'
import { acquireDomHarness } from '../../test/domHarness'
import { integrationQueryKeys, queryKeys } from '../../queryKeys'
import type { ManagedBigbrainVault } from '../../api/integrations'

let harness: Awaited<ReturnType<typeof acquireDomHarness>>
let root: import('react-dom/client').Root
let container: HTMLDivElement
let oldFetch: typeof globalThis.fetch
let requests: { url: string; method: string; body: string }[]
let respond: (url: string, method: string, body: string) => Response | Promise<Response>

const INVITE_SECRET = `https://bb-${'1'.repeat(32)}.vaults.example.com/invite#${'S'.repeat(43)}`
const vault = (patch: Partial<ManagedBigbrainVault>): ManagedBigbrainVault => ({
  vaultId: '11111111-1111-4111-8111-111111111111',
  displayName: 'Research',
  ownerHandle: 'ficus',
  ownerLinksAvailable: true,
  state: 'ready',
  readAccess: 'active',
  desiredGeneration: 3,
  appliedGeneration: 3,
  upstreamVaultId: null,
  origin: null,
  connectionId: null,
  lastErrorCode: null,
  retryable: false,
  pendingAction: null,
  backup: 'included',
  assignedSquads: [],
  updatedAt: '2026-10-20T00:00:00.000Z',
  ...patch,
})
const research = vault({
  origin: `https://bb-${'1'.repeat(32)}.vaults.example.com`,
  assignedSquads: [{ id: 'squad-r', name: 'Research squad' }],
})
const design = vault({
  vaultId: '22222222-2222-4222-8222-222222222222',
  displayName: 'Design',
  state: 'failed',
  retryable: true,
  backup: 'excluded',
  ownerHandle: 'ada',
  ownerLinksAvailable: false,
  lastErrorCode: 'storage_unavailable',
})

beforeEach(async () => {
  harness = await acquireDomHarness({ url: 'http://localhost' })
  ;({ root, container } = harness.createRoot())
  oldFetch = globalThis.fetch
  requests = []
  respond = (url, method) =>
    method === 'GET' ? Response.json({ vaults: [research, design] }) : Response.json(research)
  globalThis.fetch = (async (input, init) => {
    const entry = { url: String(input), method: init?.method ?? 'GET', body: String(init?.body ?? '') }
    requests.push(entry)
    return respond(entry.url, entry.method, entry.body)
  }) as typeof fetch
})
afterEach(async () => {
  globalThis.fetch = oldFetch
  await harness.cleanup()
})

async function render(canWrite = true, list: ManagedBigbrainVault[] = [research, design]) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
  })
  client.setQueryData(integrationQueryKeys.managedBigbrainVaults(), list)
  client.setQueryData(queryKeys.auth.me(), { id: 'owner', email: 'Ada.Lovelace+ficus@example.com', displayName: 'Ada' })
  const { ManagedBigbrainIntegrationSettings } = await import('./ManagedBigbrainIntegrationSettings')
  await harness.act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ManagedBigbrainIntegrationSettings canWrite={canWrite} />
      </QueryClientProvider>
    )
  )
  return client
}
const rows = () => [...container.querySelectorAll('li')]
const row = (name: string) => rows().find((li) => li.textContent?.includes(name))!
function button(label: string, scope: ParentNode = container): HTMLButtonElement {
  return [...scope.querySelectorAll('button')].find((candidate) => candidate.textContent === label)!
}
async function settle() {
  for (let i = 0; i < 3; i++) {
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}
async function act(run: () => void) {
  await harness.act(async () => {
    run()
    await settle()
  })
}
const mutations = () => requests.filter((r) => r.method !== 'GET')

describe('ManagedBigbrainIntegrationSettings', () => {
  test('two named vaults each show their own state and only the applicable controls', async () => {
    await render()
    expect(rows()).toHaveLength(2)
    expect(row('Research').textContent).toContain('Ready')
    expect(row('Research').textContent).toContain('Ficus can read')
    expect(row('Design').textContent).toContain('Failed')
    expect(row('Design').textContent).toContain('storage_unavailable')
    // Owner device links only where the vault can issue them; retry only where it applies.
    expect(button('Connect owner device', row('Research'))).toBeTruthy()
    expect(button('Connect owner device', row('Design'))).toBeUndefined()
    expect(button('Retry', row('Design'))).toBeTruthy()
    expect(button('Retry', row('Research'))).toBeUndefined()
  })

  test('each row names the vault’s owner in BigBrain and who may connect as it, before any click', async () => {
    await render()
    expect(row('Research').textContent).toContain(
      'Owner in BigBrain: ficus. People who manage BigBrain here can connect a device as this owner.'
    )
    expect(row('Design').textContent).toContain('Owner in BigBrain: ada. Owner device links are no longer available')
    for (const name of ['Research', 'Design'])
      expect(row(name).textContent).toContain('Other members are invited from the BigBrain app.')
  })

  test('the card never treats the viewer as a vault owner', async () => {
    await render(false)
    expect(container.textContent).toContain('belong to it, not to one person')
    expect(container.textContent).toContain("In BigBrain each new vault's owner is ficus")
    expect(container.textContent).not.toMatch(/\byou(r)?\b/i)
    await render(true)
    expect(container.textContent).not.toMatch(/\byou(r)?\b/i)
  })

  test('device links are offered only once the vault is fully ready at its address', async () => {
    const pending = (displayName: string, patch: Partial<ManagedBigbrainVault>) =>
      vault({ ...research, vaultId: crypto.randomUUID(), displayName, ...patch })
    await render(true, [
      research,
      pending('Settingup', { state: 'provisioning', readAccess: 'pending' }),
      pending('Renaming', { pendingAction: 'rename' }),
      pending('Unpublished', { origin: null }),
      pending('Degraded', { state: 'degraded' }),
    ])
    expect(button('Connect owner device', row('Research'))).toBeTruthy()
    for (const name of ['Settingup', 'Renaming', 'Unpublished', 'Degraded'])
      expect(button('Connect owner device', row(name))).toBeUndefined()
  })

  test('a failure in one vault row stays in that row and sends that vault’s own generation', async () => {
    await render()
    respond = (url, method) =>
      method === 'GET'
        ? Response.json({ vaults: [research, design] })
        : Response.json({ code: 'generation_conflict', currentGeneration: 4 }, { status: 409 })
    await act(() => fireEvent.click(button('Retry', row('Design'))))
    expect(mutations().map((r) => [new URL(r.url).pathname, JSON.parse(r.body).expectedGeneration])).toEqual([
      [`/api/integrations/providers/bigbrain/shared-vaults/${design.vaultId}/retry`, 3],
    ])
    expect(row('Design').textContent).toContain('changed meanwhile')
    expect(row('Research').textContent).not.toContain('changed meanwhile')
  })

  test('a retried create reuses the same request ID; success starts a fresh draft', async () => {
    await render()
    const [name, ...others] = [...container.querySelectorAll<HTMLInputElement>('form input')]
    // The vault name is the only input: every new vault is owned by `ficus` in BigBrain.
    expect(others).toEqual([])
    await act(() => fireEvent.input(name!, { target: { value: 'Archive' } }))
    respond = (url, method) =>
      method === 'GET'
        ? Response.json({ vaults: [research] })
        : Response.json({ code: 'host_unreachable' }, { status: 503 })
    await act(() => fireEvent.submit(name!.closest('form')!))
    expect(container.textContent).toContain('temporarily unavailable')
    respond = (url, method) => (method === 'GET' ? Response.json({ vaults: [research] }) : Response.json(research))
    await act(() => fireEvent.submit(name!.closest('form')!))
    const [first, second] = mutations().map((r) => JSON.parse(r.body))
    expect(first).toEqual({ requestId: expect.any(String), displayName: 'Archive' })
    expect(second.requestId).toBe(first.requestId)
    expect(name!.value).toBe('')
  })

  test('the create form says the new vault is owned by ficus in BigBrain', async () => {
    await render()
    const form = container.querySelector('form')!
    expect(form.textContent).toContain("In BigBrain, the vault's owner is ficus.")
    expect(form.textContent).not.toContain('handle')
    await act(() => fireEvent.input(form.querySelector('input')!, { target: { value: 'Archive' } }))
    expect(button('Create vault').disabled).toBe(false)
  })

  for (const list of [[], [research], [research, design]]) {
    test(`exactly one divider separates ${list.length} vault(s) from the new vault form`, async () => {
      await render(true, list)
      expect(rows()).toHaveLength(list.length)
      // Rows are separated by the list; none draws its own edge next to the form's top border.
      expect(container.querySelector('ul')!.className).toContain('divide-y')
      for (const li of rows()) expect(li.className).not.toMatch(/\bborder-[bt]\b/)
      expect(container.querySelector('form')!.className).toContain('border-t')
    })
  }

  test('deleting requires the exact name and states that existing backups are not removed', async () => {
    await render()
    await act(() => fireEvent.click(button('Delete', row('Research'))))
    expect(row('Research').textContent).toContain('existing Ficus server backups are not removed')
    expect(row('Research').textContent).toContain('Research squad')
    expect(row('Research').textContent).toContain(
      'Restoring this server from a backup taken before now brings this vault back'
    )
    const confirm = row('Research').querySelector<HTMLInputElement>('[role=alert] input')!
    await act(() => fireEvent.input(confirm, { target: { value: 'research' } }))
    expect(button('Delete vault', row('Research')).disabled).toBe(true)
    await act(() => fireEvent.input(confirm, { target: { value: 'Research' } }))
    await act(() => fireEvent.click(button('Delete vault', row('Research'))))
    expect(mutations()).toHaveLength(1)
    expect(mutations()[0]!.method).toBe('DELETE')
    expect(JSON.parse(mutations()[0]!.body)).toMatchObject({
      expectedGeneration: 3,
      confirmedVaultId: research.vaultId,
      confirmedName: 'Research',
    })
  })

  test('a vault that can no longer issue owner device links says so and offers none', async () => {
    await render()
    expect(row('Research').textContent).not.toContain('no longer available')
    expect(row('Design').textContent).toContain('Owner device links are no longer available for this vault')
    expect(button('Connect owner device', row('Design'))).toBeUndefined()
  })

  test('a vault left out of the last backup says so', async () => {
    await render()
    expect(row('Design').textContent).toContain('Last backup did not include this vault')
    expect(row('Research').textContent).not.toContain('Last backup did not include')
  })

  test('without write permission there are no actions, owner device links included', async () => {
    await render(false)
    for (const label of ['Rename', 'Delete', 'Connect owner device', 'Revoke Ficus read access'])
      expect(button(label, row('Research'))).toBeUndefined()
    expect(container.querySelector('form')).toBeNull()
  })

  test('the owner device link never enters the query cache or storage', async () => {
    const client = await render()
    respond = (url, method) =>
      method === 'GET'
        ? Response.json({ vaults: [research, design] })
        : Response.json({ inviteUrl: INVITE_SECRET, expiresAt: new Date(Date.now() + 3_600_000).toISOString() })
    await act(() => fireEvent.click(button('Connect owner device', row('Research'))))
    expect(mutations()).toHaveLength(0)
    await act(() => fireEvent.click(button('Create device link', document.body)))
    expect(document.querySelector<HTMLInputElement>('input[aria-label="Owner device link"]')?.value).toBe(INVITE_SECRET)
    expect(
      JSON.stringify(
        client
          .getQueryCache()
          .getAll()
          .map((query) => query.state.data)
      )
    ).not.toContain(INVITE_SECRET)
    expect(
      JSON.stringify(
        client
          .getMutationCache()
          .getAll()
          .map((m) => m.state.data)
      )
    ).not.toContain(INVITE_SECRET)
    // The harness provides localStorage only; sessionStorage is checked when present.
    const storages = [globalThis.localStorage, globalThis.sessionStorage].filter(Boolean)
    for (const storage of storages) expect(JSON.stringify({ ...storage })).not.toContain(INVITE_SECRET)
  })
})
