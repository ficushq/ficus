import { expect, mock, test } from 'bun:test'
import { acquireDomHarness } from '../test/domHarness'
import { AssistantSnapMenu } from './AssistantSnapMenu'

test('the layout menu offers the default first, then every region with its shortcut, marks the current one, and closes on choice or Escape', async () => {
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
      'Default (centered)',
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

    await dom.act(async () => (items[11] as HTMLButtonElement).click())
    expect(onSnap).toHaveBeenCalledWith('right-third')
    expect(menu()).toBeNull()

    await dom.act(async () => button.click())
    await dom.act(async () =>
      menu()!.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    )
    expect(menu()).toBeNull()

    await dom.act(async () => button.click())
    const reset = menu()!.querySelector('[role="menuitemradio"]') as HTMLButtonElement
    expect(reset.textContent).toContain('Default (centered)')
    expect(reset.getAttribute('aria-checked')).toBe('false')
    await dom.act(async () => reset.click())
    expect(onReset).toHaveBeenCalledTimes(1)
    expect(menu()).toBeNull()
  } finally {
    await dom.cleanup()
  }
})

test('the default is checked when the assistant is neither snapped nor moved', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/' })
  const { root, container } = dom.createRoot()
  try {
    await dom.act(async () => root.render(<AssistantSnapMenu isDefault onSnap={() => {}} onReset={() => {}} />))
    await dom.act(async () =>
      (container.querySelector('button[aria-label="Arrange assistant"]') as HTMLButtonElement).click()
    )
    const checked = [...dom.window.document.querySelectorAll('[role="menuitemradio"][aria-checked="true"]')]
    expect(checked.map((item) => item.textContent)).toEqual([expect.stringContaining('Default (centered)')])
  } finally {
    await dom.cleanup()
  }
})
