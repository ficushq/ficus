import { afterEach, expect, test } from 'bun:test'
import { acquireDomHarness } from '../test/domHarness'
import { webkitTap } from '../test/webkitTap'
import { ActionPopup, SelectionPopup } from './ThemedPopup'
let dom: Awaited<ReturnType<typeof acquireDomHarness>> | undefined
afterEach(async () => {
  await dom?.cleanup()
  dom = undefined
})

test('disabled rows are skipped by arrows and Home/End; active value is not changed by focus', async () => {
  dom = await acquireDomHarness({ url: 'http://localhost' })
  const { root, container } = dom.createRoot()
  const values: string[] = []
  await dom.act(async () =>
    root.render(
      <SelectionPopup
        label="Test value"
        className=""
        value="two"
        options={[
          { value: 'one', label: 'One', disabled: true },
          { value: 'two', label: 'Two' },
          { value: 'three', label: 'Three' },
          { value: 'four', label: 'Four', disabled: true },
        ]}
        onChange={(value) => values.push(value)}
      >
        Choose
      </SelectionPopup>
    )
  )
  await dom.act(async () => container.querySelector('button')!.click())
  await dom.act(async () => {
    await new Promise((resolve) => dom!.window.requestAnimationFrame(resolve))
  })
  const key = async (key: string) =>
    dom!.act(async () =>
      dom!.window.document.activeElement!.dispatchEvent(
        new dom!.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
      )
    )
  expect(dom.window.document.activeElement?.textContent).toBe('Two')
  await key('End')
  expect(dom.window.document.activeElement?.textContent).toBe('Three')
  await key('ArrowDown')
  expect(dom.window.document.activeElement?.textContent).toBe('Two')
  await key('Home')
  expect(dom.window.document.activeElement?.textContent).toBe('Two')
  expect(values).toEqual([])
  await key('Escape')
  expect(dom.window.document.activeElement).toBe(container.querySelector('button'))
})

test('outside pointer does not restore focus and Escape does not reach document shortcuts', async () => {
  dom = await acquireDomHarness({ url: 'http://localhost' })
  const { root, container } = dom.createRoot()
  let escapes = 0
  dom.window.document.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'Escape') escapes++
    },
    true
  )
  await dom.act(async () =>
    root.render(
      <>
        <ActionPopup label="Actions" className="" items={[{ id: 'one', label: 'One', onSelect() {} }]}>
          Actions
        </ActionPopup>
        <button data-outside>Outside</button>
      </>
    )
  )
  const trigger = container.querySelector<HTMLButtonElement>('[aria-expanded]')!
  const outside = container.querySelector<HTMLButtonElement>('[data-outside]')!
  await dom.act(async () => trigger.click())
  await dom.act(async () =>
    dom!.window.document.dispatchEvent(new dom!.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  )
  expect(escapes).toBe(0)
  expect(dom.window.document.activeElement).toBe(trigger)
  await dom.act(async () => trigger.click())
  await dom.act(async () => {
    outside.dispatchEvent(new dom!.window.Event('pointerdown', { bubbles: true }))
    outside.focus()
  })
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
  expect(dom.window.document.activeElement).toBe(outside)
})

for (const target of ['null', 'body'] as const) {
  test(`inside touch selection survives a ${target} blur before click`, async () => {
    dom = await acquireDomHarness({ url: 'http://localhost' })
    const { root, container } = dom.createRoot()
    const values: string[] = []
    await dom.act(async () =>
      root.render(
        <SelectionPopup
          label="Value"
          className=""
          value="one"
          options={[
            { value: 'one', label: 'One' },
            { value: 'two', label: 'Two' },
          ]}
          onChange={(value) => values.push(value)}
        >
          Choose
        </SelectionPopup>
      )
    )
    await dom.act(async () => container.querySelector('button')!.click())
    await dom.act(async () => {
      await new Promise((resolve) => dom!.window.requestAnimationFrame(resolve))
    })
    const two = dom.window.document.querySelectorAll<HTMLButtonElement>('[role="option"]')[1]!
    await dom.act(async () => {
      two.dispatchEvent(new dom!.window.Event('pointerdown', { bubbles: true }))
      dom!.window.document.activeElement!.dispatchEvent(
        new dom!.window.FocusEvent('focusout', {
          bubbles: true,
          relatedTarget: target === 'body' ? dom!.window.document.body : null,
        })
      )
    })
    expect(container.querySelector('button')!.getAttribute('aria-expanded')).toBe('true')
    await dom.act(async () => two.click())
    expect(values).toEqual(['two'])
  })
}

// The popup is portaled to body, or into an enclosing aria-modal dialog: a WebKit tap on a row then focuses
// that dialog (the rows' nearest focusable ancestor) before the row's click.
for (const where of ['section', 'dialog'] as const) {
  test(`a WebKit tap on a row inside a ${where} selects it`, async () => {
    dom = await acquireDomHarness({ url: 'http://localhost' })
    const { root, container } = dom.createRoot()
    const values: string[] = []
    const opened: string[] = []
    const popups = (
      <>
        <SelectionPopup
          label="Value"
          className=""
          value="one"
          options={[
            { value: 'one', label: 'One' },
            { value: 'two', label: 'Two' },
          ]}
          onChange={(value) => values.push(value)}
        >
          Choose
        </SelectionPopup>
        <ActionPopup
          label="Actions"
          className=""
          items={[{ id: 'edit', label: 'Edit…', opensDialog: true, onSelect: () => opened.push('edit') }]}
        >
          Actions
        </ActionPopup>
      </>
    )
    await dom.act(async () =>
      root.render(
        where === 'section' ? (
          <section tabIndex={-1}>{popups}</section>
        ) : (
          <div role="dialog" aria-modal="true" tabIndex={-1}>
            {popups}
          </div>
        )
      )
    )
    const [choose, actions] = container.querySelectorAll<HTMLButtonElement>('[aria-expanded]')
    await dom.act(async () => choose!.click())
    expect(dom.window.document.activeElement?.textContent).toBe('One')
    const two = [...dom.window.document.querySelectorAll<HTMLButtonElement>('[role="option"]')][1]!
    expect(await webkitTap(two)).toBe(true)
    expect(values).toEqual(['two'])
    expect(choose!.getAttribute('aria-expanded')).toBe('false')

    await dom.act(async () => actions!.click())
    expect(await webkitTap(dom.window.document.querySelector('[role="menuitem"]')!, { touch: true })).toBe(true)
    expect(opened).toEqual(['edit'])
  })
}

test('keyboard focus leaving to an outside control closes the popup', async () => {
  dom = await acquireDomHarness({ url: 'http://localhost' })
  const { root, container } = dom.createRoot()
  await dom.act(async () =>
    root.render(
      <>
        <ActionPopup label="Actions" className="" items={[{ id: 'one', label: 'One', onSelect() {} }]}>
          Actions
        </ActionPopup>
        <button data-outside>Outside</button>
      </>
    )
  )
  const trigger = container.querySelector<HTMLButtonElement>('[aria-expanded]')!
  await dom.act(async () => trigger.click())
  await dom.act(async () => container.querySelector<HTMLButtonElement>('[data-outside]')!.focus())
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
})

test('the initially focused later row is scrolled into view after the popup gets its scroll height', async () => {
  dom = await acquireDomHarness({ url: 'http://localhost' })
  const { root, container } = dom.createRoot()
  const calls: Array<{ row: string | null; maxHeight: string }> = []
  dom.window.HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
    calls.push({ row: this.textContent, maxHeight: this.closest<HTMLElement>('[role="menu"]')?.style.maxHeight ?? '' })
  }
  const items = Array.from({ length: 12 }, (_, index) => ({
    id: `${index}`,
    label: `Tool ${index}`,
    active: index === 10,
    onSelect() {},
  }))
  await dom.act(async () =>
    root.render(
      <ActionPopup label="Tools" className="" items={items}>
        Tools
      </ActionPopup>
    )
  )
  await dom.act(async () => container.querySelector('button')!.click())
  expect(dom.window.document.activeElement?.textContent).toBe('Tool 10')
  const last = calls.findLast((call) => call.row === 'Tool 10')
  expect(last?.maxHeight).toMatch(/px$/)
  // A reopening with an identical placement still reveals the row.
  await dom.act(async () => container.querySelector('button')!.click())
  calls.length = 0
  await dom.act(async () => container.querySelector('button')!.click())
  expect(calls.findLast((call) => call.row === 'Tool 10')?.maxHeight).toMatch(/px$/)
})
