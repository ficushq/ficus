import { afterEach, describe, expect, test } from 'bun:test'
import { acquireDomHarness } from '../../test/domHarness'
import { restPointerOn } from '../../test/hoverTimer'
import { SquadNavigation } from './SquadNavigation'
let dom: Awaited<ReturnType<typeof acquireDomHarness>> | undefined

afterEach(async () => {
  await dom?.cleanup()
  dom = undefined
})
test('secondary tools remain reachable and Escape restores focus without changing tabs', async () => {
  dom = await acquireDomHarness({ url: 'http://localhost/settings' })
  const { container, root } = dom.createRoot()
  const changes: string[] = []
  const tabs = ['home', 'agents', 'work', 'activity', 'workspace', 'memory', 'apps', 'settings'].map((path) => ({
    path,
    label: path,
  }))
  await dom.act(async () =>
    root.render(<SquadNavigation tabs={tabs} activeTab="memory" onChange={(tab) => changes.push(tab)} />)
  )
  // Workspace and Apps sit in the tab bar right after Activity; the rest stay under More.
  expect([...container.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)).toEqual([
    'home',
    'agents',
    'work',
    'activity',
    'workspace',
    'apps',
  ])
  const trigger = container.querySelector<HTMLButtonElement>('[aria-label="More squad tools"]')!
  expect(trigger.textContent).toBe('memory')
  await dom.act(async () => trigger.click())
  await dom.act(async () => {
    await new Promise((resolve) => dom!.window.requestAnimationFrame(resolve))
  })
  expect(dom.window.document.activeElement?.textContent).toBe('memory')
  await dom.act(async () =>
    dom!.window.document.dispatchEvent(new dom!.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  )
  expect(dom.window.document.activeElement).toBe(trigger)
  expect(changes).toEqual([])
  await dom.act(async () => trigger.click())
  await dom.act(async () => {
    await new Promise((resolve) => dom!.window.requestAnimationFrame(resolve))
  })
  const settings = [...dom.window.document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
    (button) => button.textContent === 'settings'
  )!
  await dom.act(async () => settings.click())
  expect(changes).toEqual(['settings'])
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
})

test('touch selection survives a blur without a new focus target', async () => {
  dom = await acquireDomHarness({ url: 'http://localhost/squads/test' })
  const { container, root } = dom.createRoot()
  const changes: string[] = []
  const tabs = ['home', 'memory', 'settings'].map((path) => ({ path, label: path }))
  await dom.act(async () =>
    root.render(<SquadNavigation tabs={tabs} activeTab="home" onChange={(tab) => changes.push(tab)} />)
  )
  const trigger = container.querySelector<HTMLButtonElement>('[aria-label="More squad tools"]')!
  await dom.act(async () => trigger.click())
  await dom.act(async () => {
    await new Promise((resolve) => dom!.window.requestAnimationFrame(resolve))
  })
  const settings = dom.window.document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')[1]!
  // Touch browsers may blur the focused item before click without focusing the tapped button.
  await dom.act(async () => {
    settings.dispatchEvent(new dom!.window.Event('pointerdown', { bubbles: true }))
    dom!.window.document.activeElement!.dispatchEvent(
      new dom!.window.FocusEvent('focusout', { bubbles: true, relatedTarget: null })
    )
  })
  expect(trigger.getAttribute('aria-expanded')).toBe('true')
  expect(settings.closest('[role="menu"]')).not.toBeNull()
  await dom.act(async () => settings.click())
  expect(changes).toEqual(['settings'])
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
})

test('outside taps and keyboard focus leaving the menu still dismiss it', async () => {
  dom = await acquireDomHarness({ url: 'http://localhost/squads/test' })
  const { container, root } = dom.createRoot()
  await dom.act(async () =>
    root.render(
      <>
        <SquadNavigation tabs={[{ path: 'settings', label: 'Settings' }]} activeTab="home" onChange={() => {}} />
        <button data-outside>Outside</button>
      </>
    )
  )
  const trigger = container.querySelector<HTMLButtonElement>('[aria-label="More squad tools"]')!
  const outside = container.querySelector<HTMLButtonElement>('[data-outside]')!
  await dom.act(async () => trigger.click())
  await dom.act(async () => {
    await new Promise((resolve) => dom!.window.requestAnimationFrame(resolve))
  })
  await dom.act(async () => outside.focus())
  await dom.act(async () => {
    await Bun.sleep(0)
  })
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
  await dom.act(async () => trigger.click())
  await dom.act(async () => {
    await new Promise((resolve) => dom!.window.requestAnimationFrame(resolve))
  })
  await dom.act(async () => outside.dispatchEvent(new dom!.window.Event('pointerdown', { bubbles: true })))
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
})

test('later active tool gets initial focus and arrows do not navigate until Enter', async () => {
  dom = await acquireDomHarness({ url: 'http://localhost/squads/test' })
  const { container, root } = dom.createRoot()
  const changes: string[] = []
  await dom.act(async () =>
    root.render(
      <SquadNavigation
        tabs={['memory', 'settings', 'skills'].map((path) => ({ path, label: path }))}
        activeTab="settings"
        onChange={(tab) => changes.push(tab)}
      />
    )
  )
  const trigger = container.querySelector<HTMLButtonElement>('[aria-expanded]')!
  await dom.act(async () => trigger.click())
  await dom.act(async () => {
    await new Promise((resolve) => dom!.window.requestAnimationFrame(resolve))
  })
  expect(dom.window.document.activeElement?.textContent).toBe('settings')
  await dom.act(async () =>
    dom!.window.document.activeElement!.dispatchEvent(
      new dom!.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
    )
  )
  expect(dom.window.document.activeElement?.textContent).toBe('skills')
  expect(changes).toEqual([])
  await dom.act(async () =>
    dom!.window.document.activeElement!.dispatchEvent(
      new dom!.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    )
  )
  expect(changes).toEqual(['skills'])
  expect(dom.window.document.activeElement).toBe(trigger)
})

test('tabs and More draw an inset focus ring so the scrolling row cannot clip it', async () => {
  dom = await acquireDomHarness({ url: 'http://localhost/squads/test' })
  const { container, root } = dom.createRoot()
  const tabs = ['home', 'agents', 'memory'].map((path) => ({ path, label: path }))
  await dom.act(async () => root.render(<SquadNavigation tabs={tabs} activeTab="home" onChange={() => {}} />))
  // The tab row scrolls sideways, which also clips vertically; an outset ring would lose its edges.
  expect(container.querySelector('[role="tablist"]')!.className).toContain('overflow-x-auto')
  const controls = [
    ...container.querySelectorAll<HTMLElement>('[role="tab"]'),
    container.querySelector<HTMLElement>('[aria-label="More squad tools"]')!,
  ]
  expect(controls).toHaveLength(3)
  for (const control of controls) expect(control.classList.contains('focus-visible:outline-offset-[-2px]')).toBe(true)
  // A focused tab partly past the scroller's edge is brought fully into view, ring included.
  const scrolls: unknown[] = []
  const tab = controls[1]!
  tab.scrollIntoView = (options?: boolean | ScrollIntoViewOptions) => void scrolls.push(options)
  await dom.act(async () => tab.focus())
  expect(scrolls).toEqual([{ block: 'nearest', inline: 'nearest' }])
})

describe('More on hover', () => {
  async function renderMore() {
    dom = await acquireDomHarness({ url: 'http://localhost/squads/test' })
    const { container, root } = dom.createRoot()
    const changes: string[] = []
    const tabs = ['home', 'memory', 'schedules', 'settings'].map((path) => ({ path, label: path }))
    await dom.act(async () =>
      root.render(
        <>
          <input aria-label="Composer" />
          <SquadNavigation tabs={tabs} activeTab="home" onChange={(tab) => changes.push(tab)} />
        </>
      )
    )
    const doc = dom.window.document
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="More squad tools"]')!
    const composer = container.querySelector<HTMLInputElement>('input')!
    const menu = () => doc.querySelector<HTMLElement>('[role="menu"][data-state="open"]')
    const items = () => [...doc.querySelectorAll<HTMLButtonElement>('[data-state="open"] [role="menuitem"]')]
    const wait = (ms: number) => dom!.act(() => new Promise((resolve) => setTimeout(resolve, ms)))
    /** A pointer arriving on (`over`, resting past the hover-open delay) or leaving (`out`) an element; React derives enter/leave from these. */
    const pointer = (target: Element, type: 'over' | 'out', pointerType = 'mouse') =>
      type === 'over'
        ? restPointerOn(target, pointerType)
        : dom!.act(async () => {
            target.dispatchEvent(new dom!.window.PointerEvent(`pointer${type}`, { bubbles: true, pointerType }))
          })
    const click = (target: HTMLElement) => dom!.act(async () => target.click())
    return { doc, changes, trigger, composer, menu, items, wait, pointer, click }
  }

  test('a mouse hovering opens it without taking focus; leaving closes it after a short delay', async () => {
    const { doc, changes, trigger, composer, menu, wait, pointer } = await renderMore()
    await dom!.act(async () => composer.focus())
    await pointer(trigger, 'over')
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(menu()?.textContent).toContain('Squad tools')
    expect(doc.activeElement).toBe(composer)

    await pointer(trigger, 'out')
    expect(menu()).not.toBeNull() // not yet: the pointer may be crossing the gap
    await wait(200)
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(menu()).toBeNull()
    expect(doc.activeElement).toBe(composer)
    expect(changes).toEqual([])
  })

  test('re-entering the menu or the trigger cancels the close; choosing a tool opens it and closes', async () => {
    const { changes, trigger, menu, items, wait, pointer, click } = await renderMore()
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
    await click(items().find((item) => item.textContent === 'schedules')!)
    expect(changes).toEqual(['schedules'])
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
  })

  test('a click on the trigger pins a hover-opened menu and focuses its first tool', async () => {
    const { doc, trigger, menu, items, wait, pointer, click } = await renderMore()
    await pointer(trigger, 'over')
    expect(doc.activeElement).not.toBe(items()[0]!)
    await click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(doc.activeElement).toBe(items()[0]!)
    await pointer(trigger, 'out')
    await wait(200)
    expect(menu()).not.toBeNull()
    await click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
  })

  test('a click inside a hover-opened menu, off the tools, does not pin it', async () => {
    const { changes, trigger, menu, wait, pointer, click } = await renderMore()
    await pointer(trigger, 'over')
    await pointer(trigger, 'out')
    await pointer(menu()!, 'over')
    const heading = [...menu()!.querySelectorAll<HTMLElement>('*')].find((el) => el.textContent === 'Squad tools')!
    await click(heading)
    expect(menu()).not.toBeNull()
    await pointer(menu()!, 'out')
    await wait(200)
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(changes).toEqual([])
  })

  test('touch and pen never open it on hover; a tap still does and stays open', async () => {
    const { trigger, menu, wait, pointer, click } = await renderMore()
    await pointer(trigger, 'over', 'touch')
    await pointer(trigger, 'over', 'pen')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    await click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    await pointer(trigger, 'out', 'touch')
    await wait(200)
    expect(menu()).not.toBeNull()
  })
})
