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

async function renderSwitcher(path = '/squads/alpha/work?ws=12') {
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
        <MemoryRouter initialEntries={[path]}>
          <input aria-label="Composer" />
          <SquadSwitcher active />
          <Probe />
        </MemoryRouter>
      </QueryClientProvider>
    )
  )
  const doc = dom.window.document
  const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Switch squad"]')!
  const items = () => [...doc.querySelectorAll<HTMLButtonElement>('[data-state="open"] [role="menuitem"]')]
  const menu = () => doc.querySelector<HTMLElement>('[role="menu"][data-state="open"]')
  const frame = () =>
    dom!.act(async () => {
      await new Promise((resolve) => dom!.window.requestAnimationFrame(resolve))
    })
  const wait = (ms: number) => dom!.act(() => new Promise((resolve) => setTimeout(resolve, ms)))
  /** A pointer arriving on (`over`) or leaving (`out`) an element; React derives enter/leave from these. */
  const pointer = (target: Element, type: 'over' | 'out', pointerType = 'mouse') =>
    dom!.act(async () => {
      target.dispatchEvent(new dom!.window.PointerEvent(`pointer${type}`, { bubbles: true, pointerType }))
    })
  const click = (target: HTMLElement) => dom!.act(async () => target.click())
  const key = (key: string) =>
    dom!.act(async () => {
      ;(doc.activeElement ?? doc.body).dispatchEvent(
        new dom!.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
      )
    })
  return { client, doc, trigger, items, menu, frame, wait, pointer, click, key, location }
}

test('picks another squad on the same tab; the current one is marked', async () => {
  const { client, trigger, items, frame, click, location } = await renderSwitcher()
  await click(trigger)
  await frame()
  // Each row: the squad's avatar (its initial, with no image), then its name.
  expect(items().map((item) => item.textContent?.trim())).toEqual(['AAlpha', 'BBeta', 'All squads'])
  expect(items()[0]!.getAttribute('aria-current')).toBe('page')

  await click(items()[1]!)
  expect(location.current).toBe('/squads/beta/work')

  await click(trigger)
  await frame()
  await click(items().at(-1)!)
  expect(location.current).toBe('/squads')
  client.clear()
})

describe('hover', () => {
  test('a mouse hovering opens it without taking focus; leaving closes it after a short delay', async () => {
    const { client, doc, trigger, menu, items, frame, wait, pointer } = await renderSwitcher()
    const composer = doc.querySelector<HTMLInputElement>('input')!
    await dom!.act(async () => composer.focus())
    await pointer(trigger, 'over')
    await frame()
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(menu()).not.toBeNull()
    expect(doc.activeElement).toBe(composer)

    await pointer(trigger, 'out')
    expect(menu()).not.toBeNull() // not yet: the pointer may be crossing the gap
    await wait(200)
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(menu()).toBeNull()
    expect(doc.activeElement).toBe(composer)

    // The pointer over a row focuses it (as in any menu); leaving hands focus back to the composer.
    await pointer(trigger, 'over')
    await pointer(trigger, 'out')
    await pointer(menu()!, 'over')
    await dom!.act(async () => {
      items()[1]!.dispatchEvent(new dom!.window.MouseEvent('mousemove', { bubbles: true }))
    })
    expect(doc.activeElement).toBe(items()[1]!)
    await pointer(menu()!, 'out')
    await wait(200)
    expect(menu()).toBeNull()
    expect(doc.activeElement).toBe(composer)
    client.clear()
  })

  test('crossing from the trigger into the menu, or back onto the trigger, cancels the close', async () => {
    const { client, trigger, menu, items, wait, pointer, click, location } = await renderSwitcher()
    await pointer(trigger, 'over')
    await pointer(trigger, 'out')
    await pointer(menu()!, 'over')
    await wait(200)
    expect(menu()).not.toBeNull()

    await pointer(menu()!, 'out')
    await pointer(trigger, 'over')
    await wait(200)
    expect(menu()).not.toBeNull()

    await pointer(trigger, 'out')
    await pointer(menu()!, 'over')
    await click(items()[1]!)
    expect(location.current).toBe('/squads/beta/work')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')

    // A fresh hover opens it again.
    await pointer(trigger, 'over')
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    client.clear()
  })

  test('opened by click it stays open when the pointer leaves; a click closes it as before', async () => {
    const { client, trigger, menu, items, doc, frame, wait, pointer, click } = await renderSwitcher()
    await click(trigger)
    await frame()
    expect(doc.activeElement).toBe(items()[0]!) // the current squad, as before
    await pointer(trigger, 'out')
    await wait(200)
    expect(menu()).not.toBeNull()
    await click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    client.clear()
  })

  test('a click on a hover-opened menu pins it open and focuses the current squad', async () => {
    const { client, trigger, menu, items, doc, wait, pointer, click, key } = await renderSwitcher()
    await pointer(trigger, 'over')
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(doc.activeElement).not.toBe(items()[0]!)
    await click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(doc.activeElement).toBe(items()[0]!)
    await pointer(trigger, 'out')
    await wait(200)
    expect(menu()).not.toBeNull()
    await key('ArrowDown')
    expect(doc.activeElement).toBe(items()[1]!)
    await key('Escape')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(doc.activeElement).toBe(trigger)
    client.clear()
  })

  test('touch and pen never open it on hover; a tap still does', async () => {
    const { client, trigger, menu, wait, pointer, click } = await renderSwitcher()
    await pointer(trigger, 'over', 'touch')
    await pointer(trigger, 'over', 'pen')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    await click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    await pointer(trigger, 'out', 'touch')
    await wait(200)
    expect(menu()).not.toBeNull()
    client.clear()
  })

  test('Escape closes a hover-opened menu without moving focus; the keyboard then opens it as before', async () => {
    const { client, doc, trigger, items, frame, pointer, key } = await renderSwitcher('/feed')
    const composer = doc.querySelector<HTMLInputElement>('input')!
    await dom!.act(async () => composer.focus())
    await pointer(trigger, 'over')
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    await key('Escape')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(doc.activeElement).toBe(composer)

    await dom!.act(async () => trigger.focus())
    await key('ArrowDown')
    await frame()
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(doc.activeElement).toBe(items()[0]!) // no current squad off a squad page: the first
    await pointer(trigger, 'out')
    await frame()
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    client.clear()
  })
})
