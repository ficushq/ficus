import { afterEach, describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { acquireDomHarness } from '../test/domHarness'
import { queries } from '../queryOptions'
import { squadSwitchPath, SquadSwitcher } from './SquadSwitcher'

describe('squadSwitchPath', () => {
  test('keeps the squad tab you are on and drops its query', () => {
    expect(squadSwitchPath('/squads/alpha/work', 'beta')).toBe('/squads/beta/work')
    expect(squadSwitchPath('/squads/alpha/agents', 'beta')).toBe('/squads/beta/agents')
    expect(squadSwitchPath('/squads/alpha/manager', 'beta')).toBe('/squads/beta/manager')
  })

  test('home, unknown pages and pages outside a squad land on the squad home', () => {
    expect(squadSwitchPath('/squads/alpha', 'beta')).toBe('/squads/beta')
    expect(squadSwitchPath('/squads/alpha/home', 'beta')).toBe('/squads/beta')
    expect(squadSwitchPath('/squads/alpha/not-a-tab', 'beta')).toBe('/squads/beta')
    expect(squadSwitchPath('/feed', 'beta')).toBe('/squads/beta')
  })
})

let dom: Awaited<ReturnType<typeof acquireDomHarness>> | undefined
afterEach(async () => {
  await dom?.cleanup()
  dom = undefined
})

test('picks another squad on the same tab; the current one is marked', async () => {
  dom = await acquireDomHarness({ url: 'http://localhost/' })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const squad = (id: string, name: string, extra: object = {}) => ({
    id,
    name,
    purpose: '',
    status: 'active',
    isAnonymous: false,
    avatarUrl: null,
    createdAt: `2026-09-0${id.length}T00:00:00Z`,
    ...extra,
  })
  client.setQueryData(queries.squads.list().queryKey, [
    squad('a', 'Alpha'),
    squad('bb', 'Beta'),
    squad('ccc', 'Old', { status: 'archived' }),
  ] as never)
  const location = { current: '' }
  function Probe() {
    const current = useLocation()
    location.current = current.pathname + current.search
    return null
  }
  const { container, root } = dom.createRoot()
  await dom.act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/squads/alpha/work?ws=12']}>
          <SquadSwitcher active />
          <Probe />
        </MemoryRouter>
      </QueryClientProvider>
    )
  )
  await dom.act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Switch squad"]')!.click())
  await dom.act(async () => {
    await new Promise((resolve) => dom!.window.requestAnimationFrame(resolve))
  })
  const items = () => [...dom!.window.document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
  // Each row: the squad's avatar (its initial, with no image), then its name.
  expect(items().map((item) => item.textContent?.trim())).toEqual(['AAlpha', 'BBeta', 'All squads'])
  expect(items()[0]!.getAttribute('aria-current')).toBe('page')

  await dom.act(async () => items()[1]!.click())
  expect(location.current).toBe('/squads/beta/work')

  await dom.act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Switch squad"]')!.click())
  await dom.act(async () => {
    await new Promise((resolve) => dom!.window.requestAnimationFrame(resolve))
  })
  await dom.act(async () => items().at(-1)!.click())
  expect(location.current).toBe('/squads')
  client.clear()
})
