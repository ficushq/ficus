import { afterEach, expect, test } from 'bun:test'
import { acquireDomHarness } from '../../test/domHarness'
import { hoverOpenClock } from '../../test/hoverTimer'
import { Menu, MenuItem, useHoverOpen, usePopover } from '.'

let dom: Awaited<ReturnType<typeof acquireDomHarness>> | undefined
let openTimer: ReturnType<typeof hoverOpenClock> | undefined
afterEach(async () => {
  openTimer?.restore()
  openTimer = undefined
  await dom?.cleanup()
  dom = undefined
})

function HoverMenu({ enabled }: { enabled: boolean }) {
  const popover = usePopover({ kind: 'menu' })
  const hover = useHoverOpen(popover, { enabled, closeDelay: 30 })
  return (
    <>
      <button {...popover.triggerProps} type="button" {...hover.triggerProps}>
        Actions
      </button>
      <Menu {...popover.popoverProps} {...hover.popoverProps} label="Actions">
        <MenuItem>Rename</MenuItem>
      </Menu>
    </>
  )
}

async function render(enabled: boolean) {
  dom = await acquireDomHarness({ url: 'http://localhost/' })
  openTimer = hoverOpenClock()
  const { container, root } = dom.createRoot()
  await dom.act(async () => root.render(<HoverMenu enabled={enabled} />))
  const trigger = container.querySelector('button')!
  const pointer = (type: 'over' | 'out', init: PointerEventInit = {}) =>
    dom!.act(async () => {
      trigger.dispatchEvent(
        new dom!.window.PointerEvent(`pointer${type}`, { bubbles: true, pointerType: 'mouse', ...init })
      )
    })
  const expanded = () => trigger.getAttribute('aria-expanded')
  const wait = (ms: number) => dom!.act(() => new Promise((resolve) => setTimeout(resolve, ms)))
  return { trigger, pointer, expanded, wait, rest: () => openTimer!.advance() }
}

test('disabled, hovering does nothing and a click toggles as before (ActionPopup without openOnHover)', async () => {
  const { trigger, pointer, expanded, rest } = await render(false)
  await pointer('over')
  await rest()
  expect(expanded()).toBe('false')
  await dom!.act(async () => trigger.click())
  expect(expanded()).toBe('true')
  await dom!.act(async () => trigger.click())
  expect(expanded()).toBe('false')
})

test('enabled, a mouse resting on the trigger opens it once the open delay passes, not before', async () => {
  const { pointer, expanded, rest } = await render(true)
  await pointer('over')
  expect(expanded()).toBe('false')
  expect(openTimer!.pending()).toBe(1)
  await rest()
  expect(expanded()).toBe('true')
})

test('a pointer passing over the trigger, leaving before the delay, never opens it', async () => {
  const { pointer, expanded, rest } = await render(true)
  await pointer('over')
  await pointer('out')
  expect(openTimer!.pending()).toBe(0)
  await rest()
  expect(expanded()).toBe('false')
})

test('a mouse arriving with a button held (a drag) does not open it', async () => {
  const { pointer, expanded, rest } = await render(true)
  await pointer('over', { buttons: 1 })
  expect(openTimer!.pending()).toBe(0)
  await rest()
  expect(expanded()).toBe('false')
})

test('touch and pen never open it on hover', async () => {
  const { pointer, expanded, rest } = await render(true)
  for (const pointerType of ['touch', 'pen']) {
    await pointer('over', { pointerType })
    await rest()
    expect(expanded()).toBe('false')
    await pointer('out', { pointerType })
  }
})

test('leaving closes it after the close delay; re-entering the trigger first cancels that', async () => {
  const { pointer, expanded, rest, wait } = await render(true)
  await pointer('over')
  await rest()
  await pointer('out')
  await pointer('over') // back before the close delay
  await wait(60)
  expect(expanded()).toBe('true')
  await pointer('out')
  await wait(60)
  expect(expanded()).toBe('false')
})

test('a click during the delay opens it by click: the pending hover-open is dropped, leaving keeps it open', async () => {
  const { trigger, pointer, expanded, rest, wait } = await render(true)
  await pointer('over')
  await dom!.act(async () => trigger.click())
  expect(expanded()).toBe('true')
  expect(openTimer!.pending()).toBe(0)
  await rest()
  await pointer('out')
  await wait(60)
  expect(expanded()).toBe('true')
})

test('a click on a hover-opened trigger pins it: leaving no longer closes it', async () => {
  const { trigger, pointer, expanded, rest, wait } = await render(true)
  await pointer('over')
  await rest()
  await dom!.act(async () => trigger.click())
  await pointer('out')
  await wait(60)
  expect(expanded()).toBe('true')
})
