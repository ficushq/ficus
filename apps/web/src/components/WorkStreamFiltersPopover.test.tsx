import { afterEach, expect, test } from 'bun:test'
import { acquireDomHarness } from '../test/domHarness'
import { expectHoverMenuContract } from '../test/hoverMenuContract'
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

test('Filters opens on hover; toggling a filter pins it, so it stays while the results change', async () => {
  const { trigger, filter } = await renderFilters()
  await expectHoverMenuContract({ trigger, pressInside: { target: filter, pins: true } })
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
