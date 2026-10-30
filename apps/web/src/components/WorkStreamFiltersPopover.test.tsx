import { afterEach, expect, test } from 'bun:test'
import { acquireDomHarness } from '../test/domHarness'
import { expectHoverMenuContract } from '../test/hoverMenuContract'
import { restPointerOn } from '../test/hoverTimer'
import { WorkStreamFiltersPopover } from './WorkStreamFiltersPopover'

let dom: Awaited<ReturnType<typeof acquireDomHarness>> | undefined
afterEach(async () => {
  await dom?.cleanup()
  dom = undefined
})

async function renderFilters() {
  dom = await acquireDomHarness({ url: 'http://localhost/' })
  const { root, container } = dom.createRoot()
  await dom.act(async () =>
    root.render(
      <>
        <input aria-label="Search" />
        <WorkStreamFiltersPopover count={0}>
          <button type="button">In progress</button>
        </WorkStreamFiltersPopover>
      </>
    )
  )
  const doc = dom.window.document
  const trigger = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
    button.textContent?.startsWith('Filters')
  )!
  const filter = () => doc.querySelector<HTMLButtonElement>('[aria-label="Feed filters"][data-state="open"] button')!
  return { doc, container, trigger, filter }
}

test('Filters opens on hover; toggling a filter keeps hover mode, so leaving still closes it', async () => {
  const { trigger, filter } = await renderFilters()
  await expectHoverMenuContract({ trigger, pressInside: { target: filter, pins: false } })
})

test('a click on the Filters button pins a hover-opened panel: toggling filters and leaving keep it open', async () => {
  const { doc, trigger, filter } = await renderFilters()
  const win = dom!.window
  const pointer = (target: Element, type: string, init: PointerEventInit = {}) =>
    dom!.act(async () => {
      target.dispatchEvent(new win.PointerEvent(type, { bubbles: true, pointerType: 'mouse', ...init }))
    })
  const panel = () => doc.querySelector<HTMLElement>('[aria-label="Feed filters"]')!
  const isOpen = () => trigger.getAttribute('aria-expanded') === 'true'

  await restPointerOn(trigger)
  expect(isOpen()).toBe(true)
  await dom!.act(async () => trigger.click())
  await pointer(trigger, 'pointerout')
  await pointer(panel(), 'pointerover')
  for (let i = 0; i < 2; i++) {
    await pointer(filter(), 'pointerdown', { buttons: 1 })
    await dom!.act(async () => filter().click())
  }
  await pointer(panel(), 'pointerout')
  await dom!.act(() => new Promise<void>((resolve) => setTimeout(resolve, 200)))
  expect(isOpen()).toBe(true)

  await dom!.act(async () => {
    doc.activeElement!.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
  expect(isOpen()).toBe(false)
})

test('opened by a click, focus still moves to the first filter', async () => {
  const { doc, trigger, filter } = await renderFilters()
  await dom!.act(async () => trigger.click())
  await dom!.act(async () => {
    await new Promise((resolve) => dom!.window.requestAnimationFrame(resolve))
  })
  expect(trigger.getAttribute('aria-expanded')).toBe('true')
  expect(doc.activeElement).toBe(filter())
})
