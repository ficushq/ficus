import { afterEach, expect, test } from 'bun:test'
import { acquireDomHarness } from '../../test/domHarness'
import { Menu, MenuItem, useHoverOpen, usePopover } from '.'

let dom: Awaited<ReturnType<typeof acquireDomHarness>> | undefined
afterEach(async () => {
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
  const { container, root } = dom.createRoot()
  await dom.act(async () => root.render(<HoverMenu enabled={enabled} />))
  const trigger = container.querySelector('button')!
  const hover = () =>
    dom!.act(async () => {
      trigger.dispatchEvent(new dom!.window.PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }))
    })
  return { trigger, hover }
}

test('disabled, hovering does nothing and a click toggles as before (ActionPopup without openOnHover)', async () => {
  const { trigger, hover } = await render(false)
  await hover()
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
  await dom!.act(async () => trigger.click())
  expect(trigger.getAttribute('aria-expanded')).toBe('true')
  await dom!.act(async () => trigger.click())
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
})

test('enabled, a mouse hovering opens it', async () => {
  const { trigger, hover } = await render(true)
  await hover()
  expect(trigger.getAttribute('aria-expanded')).toBe('true')
})
