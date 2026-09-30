import { afterEach, expect, test } from 'bun:test'
import { acquireDomHarness } from '../test/domHarness'
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
