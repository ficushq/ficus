import { afterEach, beforeEach, expect, test } from 'bun:test'
import { useState, useEffect } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, getByRole, waitFor } from '@testing-library/dom'
import { acquireDomHarness } from '../../test/domHarness'
import { queryKeys } from '../../queryKeys'
import { PermissionPicker } from './PermissionPicker'
import { SystemTokensSection } from './SystemTokensSection'

let dom: Awaited<ReturnType<typeof acquireDomHarness>>
let client: QueryClient
let oldFetch: typeof fetch
let value: string[]
beforeEach(async () => {
  dom = await acquireDomHarness({ url: 'http://localhost/settings' })
  client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  oldFetch = globalThis.fetch
  value = []
})
afterEach(async () => {
  globalThis.fetch = oldFetch
  client.clear()
  await dom.cleanup()
})
function ControlledPicker({ initial = [] }: { initial?: string[] }) {
  const [selected, setSelected] = useState(initial)
  useEffect(() => {
    value = selected
  })
  return <PermissionPicker value={selected} onChange={setSelected} />
}
async function render(node: React.ReactNode) {
  const { root, container } = dom.createRoot()
  await dom.act(async () => root.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>))
  return container
}
async function search(page: HTMLElement, text: string) {
  await dom.act(async () =>
    fireEvent.change(getByRole(page, 'searchbox', { name: 'Search permissions' }), { target: { value: text } })
  )
}
async function click(page: HTMLElement, role: 'checkbox' | 'button', name: string) {
  await dom.act(async () => fireEvent.click(getByRole(page, role, { name, exact: true })))
}

test('search finds descriptions and nested agent permissions in full rows', async () => {
  const page = await render(<ControlledPicker />)
  expect(page.querySelector('[aria-label="agents:scopes:manage"]')).toBeNull()
  await search(page, 'extra agent permissions')
  expect(page.textContent).toContain('within the caller’s own authority')
  await click(page, 'checkbox', 'agents:scopes:manage')
  expect(value).toEqual(['agents:scopes:manage'])
  await search(page, 'squads:read')
  await click(page, 'checkbox', 'squads:read')
  expect(value).toEqual(['agents:scopes:manage', 'squads:read'])
  await search(page, '')
  await click(page, 'checkbox', 'Show selected only')
  expect(page.querySelectorAll('input[type="checkbox"][aria-label]')).toHaveLength(2)
})

test('selecting every permission in a group keeps explicit scopes instead of widening to a wildcard', async () => {
  const page = await render(<ControlledPicker />)
  await search(page, 'memory:')
  await click(page, 'checkbox', 'memory:read')
  await click(page, 'checkbox', 'memory:write')
  expect(value).toEqual(['memory:read', 'memory:write'])
})

test('editing other scopes preserves existing wildcards and unknown grants exactly', async () => {
  const page = await render(<ControlledPicker initial={['agents:*', 'custom:existing']} />)
  await search(page, 'agents:scopes:manage')
  const included = getByRole(page, 'checkbox', { name: 'agents:scopes:manage' }) as HTMLInputElement
  expect(included.checked).toBe(true)
  expect(included.disabled).toBe(true)
  await search(page, 'memory:read')
  await click(page, 'checkbox', 'memory:read')
  expect(value).toEqual(['agents:*', 'custom:existing', 'memory:read'])
  await click(page, 'button', 'Remove agents:*')
  expect(value).toEqual(['custom:existing', 'memory:read'])
})

test('bare secret grants explain included groups and removing the parent preserves explicit leaves', async () => {
  const page = await render(<ControlledPicker initial={['secrets:read', 'secrets:read:integration']} />)
  await search(page, 'secrets:read')
  expect((getByRole(page, 'checkbox', { name: 'secrets:read:system' }) as HTMLInputElement).disabled).toBe(true)
  await click(page, 'checkbox', 'secrets:read')
  expect(value).toEqual(['secrets:read:integration'])
  expect((getByRole(page, 'checkbox', { name: 'secrets:read:system' }) as HTMLInputElement).checked).toBe(false)
})

test('system token creation submits selected catalog scopes and preserves one-time reveal', async () => {
  client.setQueryData(queryKeys.systemTokens.list(false), [])
  const bodies: unknown[] = []
  globalThis.fetch = (async (_url, init) => {
    if (init?.method === 'POST') {
      bodies.push(JSON.parse(String(init.body)))
      return new Response(
        JSON.stringify({
          id: 'test-token',
          name: 'CI',
          scopes: ['agents:scopes:read'],
          token: 'one-time-test-token',
          createdAt: new Date().toISOString(),
          lastUsedAt: null,
          kind: 'manual',
        }),
        { status: 201 }
      )
    }
    return new Response('[]')
  }) as typeof fetch
  const page = await render(<SystemTokensSection />)
  await dom.act(async () =>
    fireEvent.change(getByRole(page, 'textbox', { name: 'Token name' }), { target: { value: 'CI' } })
  )
  await search(page, 'agents:scopes:read')
  await click(page, 'checkbox', 'agents:scopes:read')
  await click(page, 'button', 'Create token')
  await waitFor(() => expect(page.textContent).toContain('one-time-test-token'))
  expect(bodies).toEqual([{ name: 'CI', scopes: ['agents:scopes:read'] }])
  await click(page, 'button', 'Dismiss')
  expect(page.textContent).not.toContain('one-time-test-token')
})
