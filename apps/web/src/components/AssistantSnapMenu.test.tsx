import { expect, mock, test } from 'bun:test'
import { acquireDomHarness } from '../test/domHarness'
import { webkitTap } from '../test/webkitTap'
import { AssistantSnapMenu } from './AssistantSnapMenu'

test('the layout menu offers the default first, then every region with its shortcut, marks the current one, and closes on choice or Escape', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/' })
  const { root, container } = dom.createRoot()
  const onSnap = mock(() => {})
  const onReset = mock(() => {})
  try {
    await dom.act(async () => root.render(<AssistantSnapMenu snap="left" onSnap={onSnap} onReset={onReset} />))
    const button = container.querySelector('button[aria-label="Arrange assistant"]') as HTMLButtonElement
    // A closed menu stays mounted (inert) only for its exit animation.
    const menu = () =>
      dom.window.document.querySelector('[role="menu"][aria-label="Arrange assistant"]:not([data-state="closed"])')
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

test('a WebKit tap on a region snaps to it; an outside tap and Escape close the menu', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/' })
  const { root, container } = dom.createRoot()
  const onSnap = mock(() => {})
  try {
    await dom.act(async () =>
      root.render(
        <div role="dialog" tabIndex={-1}>
          <AssistantSnapMenu snap="left" onSnap={onSnap} onReset={() => {}} />
        </div>
      )
    )
    const button = container.querySelector('button[aria-label="Arrange assistant"]') as HTMLButtonElement
    // A closed menu stays mounted (inert) only for its exit animation.
    const menu = () =>
      dom.window.document.querySelector('[role="menu"][aria-label="Arrange assistant"]:not([data-state="closed"])')
    await dom.act(async () => button.focus())
    await dom.act(async () => button.click())
    const items = [...menu()!.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]
    expect(await webkitTap(items[2]!, { touch: true })).toBe(true)
    expect(onSnap).toHaveBeenCalledWith('right')
    expect(menu()).toBeNull()

    await dom.act(async () => button.click())
    await webkitTap(dom.window.document.body)
    expect(menu()).toBeNull()

    await dom.act(async () => button.click())
    await dom.act(async () =>
      dom.window.document.body.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    )
    expect(menu()).toBeNull()
    expect(dom.window.document.activeElement).toBe(button)
  } finally {
    await dom.cleanup()
  }
})
