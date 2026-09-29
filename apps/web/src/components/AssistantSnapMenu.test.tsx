import { expect, mock, test } from 'bun:test'
import { acquireDomHarness } from '../test/domHarness'
import { AssistantSnapMenu } from './AssistantSnapMenu'

test('the layout menu lists every region with its shortcut, marks the current snap, and closes on choice or Escape', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/' })
  const { root, container } = dom.createRoot()
  const onSnap = mock(() => {})
  const onReset = mock(() => {})
  try {
    await dom.act(async () => root.render(<AssistantSnapMenu snap="left" onSnap={onSnap} onReset={onReset} />))
    const button = container.querySelector('button[aria-label="Arrange assistant"]') as HTMLButtonElement
    const menu = () => dom.window.document.querySelector('[role="menu"][aria-label="Arrange assistant"]')
    expect(menu()).toBeNull()

    await dom.act(async () => button.click())
    expect(button.getAttribute('aria-expanded')).toBe('true')
    const items = [...menu()!.querySelectorAll('[role="menuitemradio"]')]
    expect(items.map((item) => item.textContent?.replace(/(⌃⌥|Ctrl\+Alt\+).*$/, ''))).toEqual([
      'Left half',
      'Right half',
      'Top half',
      'Bottom half',
      'Top left',
      'Top right',
      'Bottom left',
      'Bottom right',
      'Left third',
      'Middle third',
      'Right third',
      'Fill the screen',
    ])
    expect(
      items.filter((item) => item.getAttribute('aria-checked') === 'true').map((item) => item.textContent)
    ).toEqual([expect.stringContaining('Left half')])
    expect(items.every((item) => item.querySelector('svg') && item.querySelector('kbd'))).toBe(true)

    await dom.act(async () => (items[10] as HTMLButtonElement).click())
    expect(onSnap).toHaveBeenCalledWith('right-third')
    expect(menu()).toBeNull()

    await dom.act(async () => button.click())
    await dom.act(async () =>
      menu()!.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    )
    expect(menu()).toBeNull()

    await dom.act(async () => button.click())
    const reset = [...menu()!.querySelectorAll('[role="menuitem"]')].find(
      (item) => item.textContent === 'Default size and position'
    ) as HTMLButtonElement
    await dom.act(async () => reset.click())
    expect(onReset).toHaveBeenCalledTimes(1)
    expect(menu()).toBeNull()
  } finally {
    await dom.cleanup()
  }
})
