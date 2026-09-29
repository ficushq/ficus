import { afterEach, expect, test } from 'bun:test'
import { acquireDomHarness } from '../../test/domHarness'
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
  expect(dom.window.document.activeElement?.textContent).toBe('memory')
  await dom.act(async () =>
    dom!.window.document.dispatchEvent(new dom!.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  )
  expect(dom.window.document.activeElement).toBe(trigger)
  expect(changes).toEqual([])
  await dom.act(async () => trigger.click())
  const settings = [...container.querySelectorAll<HTMLButtonElement>('[data-squad-menu-item]')].find(
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
  const settings = container.querySelectorAll<HTMLButtonElement>('[data-squad-menu-item]')[1]!
  // Touch browsers may blur the focused item before click without focusing the tapped button.
  await dom.act(async () => {
    settings.dispatchEvent(new dom!.window.Event('pointerdown', { bubbles: true }))
    dom!.window.document.activeElement!.dispatchEvent(
      new dom!.window.FocusEvent('focusout', { bubbles: true, relatedTarget: null })
    )
  })
  expect(trigger.getAttribute('aria-expanded')).toBe('true')
  expect(settings.closest('[data-state]')?.getAttribute('data-state')).toBe('open')
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
  await dom.act(async () => outside.focus())
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
  await dom.act(async () => trigger.click())
  await dom.act(async () => outside.dispatchEvent(new dom!.window.Event('pointerdown', { bubbles: true })))
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
})
