import { afterEach, expect, test } from 'bun:test'
import { acquireDomHarness } from '../test/domHarness'
import { TypingIndicator } from './TypingIndicator'

let dom: Awaited<ReturnType<typeof acquireDomHarness>> | undefined
afterEach(async () => {
  await dom?.cleanup()
  dom = undefined
})

test('the plant jumps on every click; the status label still says what is happening', async () => {
  dom = await acquireDomHarness({ url: 'http://localhost/' })
  const { container, root } = dom.createRoot()
  await dom.act(async () => root.render(<TypingIndicator label="Waiting for the sandbox to start…" />))
  const status = container.querySelector('[role="status"]')!
  expect(status.getAttribute('aria-label')).toBe('Waiting for the sandbox to start…')
  const plant = container.querySelector<HTMLButtonElement>('button.ficus-plant-jump')!
  // Flair, not a control: out of the tab order and hidden from assistive tech.
  expect(plant.tabIndex).toBe(-1)
  expect(plant.getAttribute('aria-hidden')).toBe('true')
  expect(plant.hasAttribute('data-jump')).toBe(false)

  const jumps: Array<string | null> = []
  for (let click = 0; click < 3; click++) {
    await dom.act(async () => plant.click())
    jumps.push(plant.getAttribute('data-jump'))
  }
  // Alternating names restart the animation even mid-jump.
  expect(jumps).toEqual(['a', 'b', 'a'])
})
