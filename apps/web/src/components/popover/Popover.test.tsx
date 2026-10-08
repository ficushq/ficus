import { afterEach, expect, test } from 'bun:test'
import { useRef, useState, type ReactNode } from 'react'
import { acquireDomHarness } from '../../test/domHarness'
import { Panel, Popover, usePopover, type PopoverDismissReason, type PopoverKind, type PopoverProps } from '.'

let dom: Awaited<ReturnType<typeof acquireDomHarness>> | undefined
afterEach(async () => {
  await dom?.cleanup()
  dom = undefined
})

const rect = (left: number, top: number, width: number, height: number) =>
  ({ left, top, right: left + width, bottom: top + height, width, height, x: left, y: top }) as DOMRect

/** A trigger + Popover pair; `content` renders inside the surface. */
function Fixture({
  kind = 'dialog',
  content,
  onDismissed,
  ...props
}: { kind?: PopoverKind; content?: ReactNode; onDismissed?: (reason: PopoverDismissReason) => void } & Partial<
  Omit<PopoverProps, 'content'>
>) {
  const popover = usePopover({ kind })
  return (
    <>
      <button {...popover.triggerProps} type="button" onClick={popover.toggle}>
        Open
      </button>
      <Popover
        {...popover.popoverProps}
        onDismiss={(reason) => {
          onDismissed?.(reason)
          popover.close()
        }}
        aria-label="Surface"
        {...props}
      >
        {content ?? (
          <>
            <button type="button">First</button>
            <button type="button" aria-selected="true">
              Chosen
            </button>
            <button type="button">Last</button>
          </>
        )}
      </Popover>
      <button type="button">Outside</button>
    </>
  )
}

async function render(node: ReactNode) {
  dom = await acquireDomHarness({ url: 'http://localhost/' })
  const { root, container } = dom.createRoot()
  await dom.act(async () => root.render(node))
  const doc = dom.window.document
  const button = (text: string) =>
    [...doc.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim() === text)!
  const trigger = button('Open')
  const surface = () => doc.querySelector<HTMLElement>('[data-popover][data-state="open"]')
  const open = () => dom!.act(async () => trigger.click())
  const key = (key: string, init: KeyboardEventInit = {}) =>
    dom!.act(async () => {
      ;(doc.activeElement ?? doc.body).dispatchEvent(
        new dom!.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
      )
    })
  const pointerdown = (target: Element) =>
    dom!.act(async () => {
      target.dispatchEvent(new dom!.window.Event('pointerdown', { bubbles: true, composed: true }))
    })
  return { container, doc, button, trigger, surface, open, key, pointerdown }
}

test('placement: opens below end-aligned, flips above near the bottom, and keeps an 8px viewport margin', async () => {
  const { trigger, surface, open, doc } = await render(<Fixture width={200} gap={6} />)
  const { innerWidth, innerHeight } = dom!.window
  trigger.getBoundingClientRect = () => rect(300, 40, 40, 20)
  await open()
  expect(surface()!.dataset.placement).toBe('below')
  expect(surface()!.style.top).toBe('66px')
  expect(surface()!.style.left).toBe('140px') // right edges line up: 340 - 200
  expect(surface()!.style.width).toBe('200px')
  // Near the bottom-right corner it flips above and shifts back inside the 8px margin.
  for (const [name, value] of [
    ['scrollHeight', 120],
    ['offsetHeight', 120],
    ['clientHeight', 120],
  ] as const)
    Object.defineProperty(surface()!, name, { configurable: true, value })
  trigger.getBoundingClientRect = () => rect(innerWidth - 20, innerHeight - 30, 40, 20)
  await dom!.act(async () => dom!.window.dispatchEvent(new dom!.window.Event('resize')))
  expect(surface()!.dataset.placement).toBe('above')
  expect(Number.parseFloat(surface()!.style.top)).toBe(innerHeight - 30 - 6 - 120)
  expect(Number.parseFloat(surface()!.style.left)).toBe(innerWidth - 8 - 200)
  expect(doc.body.contains(surface())).toBe(true)
})

test('placement: start alignment, a preferred side above, anchor width and a max height', async () => {
  const { trigger, surface, open } = await render(
    <Fixture side="above" align="start" gap={8} width="anchor" maxHeight={(viewport) => viewport.bottom / 2} />
  )
  trigger.getBoundingClientRect = () => rect(24, 400, 180, 30)
  await open()
  expect(surface()!.dataset.placement).toBe('above')
  expect(surface()!.style.left).toBe('24px')
  expect(surface()!.style.width).toBe('180px')
  expect(surface()!.style.maxHeight).toBe(`${dom!.window.innerHeight / 2}px`)
})

test('portal: the surface escapes a clipping ancestor, and presses inside it are inside', async () => {
  const dismissed: string[] = []
  const { container, surface, open, pointerdown, button, trigger } = await render(
    <div style={{ overflow: 'hidden', height: 10 }}>
      <Fixture onDismissed={(reason) => dismissed.push(reason)} />
    </div>
  )
  await open()
  expect(container.contains(surface())).toBe(false)
  expect(surface()!.parentElement).toBe(dom!.window.document.body)
  await pointerdown(button('Last'))
  expect(trigger.getAttribute('aria-expanded')).toBe('true')
  await pointerdown(trigger)
  expect(dismissed).toEqual([])
  await pointerdown(button('Outside'))
  expect(dismissed).toEqual(['pointer'])
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
})

test('portal: inside an aria-modal dialog it portals into the dialog; inline renders in place', async () => {
  const { surface, open } = await render(
    <div role="dialog" aria-modal="true" data-dialog>
      <Fixture />
    </div>
  )
  await open()
  expect(surface()!.parentElement!.hasAttribute('data-dialog')).toBe(true)
  await dom!.cleanup()

  const inline = await render(
    <div data-host>
      <Fixture portal={false} />
    </div>
  )
  await inline.open()
  expect(inline.surface()!.parentElement!.hasAttribute('data-host')).toBe(true)
  expect(inline.surface()!.className).toContain('fixed')
})

test('focus: first (default), selected or none on open; Escape and closing from inside return it to the trigger', async () => {
  for (const [initialFocus, expected] of [
    [undefined, 'First'],
    ['selected', 'Chosen'],
    ['none', 'Open'],
  ] as const) {
    const { open, doc, trigger } = await render(<Fixture initialFocus={initialFocus} />)
    await dom!.act(async () => trigger.focus())
    await open()
    expect(doc.activeElement?.textContent).toBe(expected)
    await dom!.cleanup()
  }

  const { open, doc, trigger, key, button } = await render(<Fixture />)
  await open()
  await key('Escape')
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
  expect(doc.activeElement).toBe(trigger)

  // An outside press never steals focus from what the user targeted.
  await open()
  await dom!.act(async () => {
    button('Outside').dispatchEvent(new dom!.window.Event('pointerdown', { bubbles: true }))
    button('Outside').focus()
  })
  expect(doc.activeElement).toBe(button('Outside'))
})

test('focus: closing while focus is inside (an item ran) hands it back to the trigger', async () => {
  function Closer() {
    const popover = usePopover({ kind: 'dialog' })
    return (
      <>
        <button {...popover.triggerProps} type="button" onClick={popover.toggle}>
          Open
        </button>
        <Panel {...popover.popoverProps} label="Panel">
          <button type="button" onClick={() => popover.setOpen(false)}>
            Done
          </button>
        </Panel>
      </>
    )
  }
  const { open, doc, trigger, button } = await render(<Closer />)
  await open()
  expect(doc.activeElement).toBe(button('Done'))
  await dom!.act(async () => button('Done').click())
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
  expect(doc.activeElement).toBe(trigger)
})

test('ARIA: the trigger carries aria-haspopup, aria-expanded and aria-controls for its surface', async () => {
  const { open, trigger, surface } = await render(<Fixture kind="menu" role="menu" />)
  expect(trigger.getAttribute('aria-haspopup')).toBe('menu')
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
  await open()
  expect(trigger.getAttribute('aria-expanded')).toBe('true')
  expect(trigger.getAttribute('aria-controls')).toBe(surface()!.id)
  expect(surface()!.getAttribute('role')).toBe('menu')
  await dom!.cleanup()

  const disclosure = await render(<Fixture kind="disclosure" />)
  expect(disclosure.trigger.hasAttribute('aria-haspopup')).toBe(false)
  expect(disclosure.trigger.getAttribute('aria-expanded')).toBe('false')
})

test('closing keeps the surface only for its exit animation, inert and hidden', async () => {
  const { open, key, doc } = await render(<Fixture />)
  await open()
  await key('Escape')
  const closing = doc.querySelector<HTMLElement>('[data-popover]')!
  expect(closing.dataset.state).toBe('closed')
  expect(closing.hasAttribute('inert')).toBe(true)
  expect(closing.getAttribute('aria-hidden')).toBe('true')
  await dom!.act(() => new Promise((resolve) => setTimeout(resolve, 200)))
  expect(doc.querySelector('[data-popover]')).toBeNull()
})

test('nested popovers stack above their parent; a press in the inner one is inside the outer one', async () => {
  function Nested() {
    const outer = usePopover({ kind: 'dialog' })
    const inner = usePopover({ kind: 'menu' })
    return (
      <>
        <button {...outer.triggerProps} type="button" onClick={outer.toggle}>
          Open
        </button>
        <Panel {...outer.popoverProps} label="Outer">
          <button {...inner.triggerProps} type="button" onClick={inner.toggle}>
            More
          </button>
          <Popover {...inner.popoverProps} role="menu" aria-label="Inner">
            <button type="button">Deep</button>
          </Popover>
        </Panel>
        <button type="button">Outside</button>
      </>
    )
  }
  const { open, doc, button, pointerdown, key } = await render(<Nested />)
  await open()
  await dom!.act(async () => button('More').click())
  const outer = doc.querySelector<HTMLElement>('[aria-label="Outer"]')!
  const inner = doc.querySelector<HTMLElement>('[aria-label="Inner"]')!
  expect(Number(inner.style.zIndex)).toBe(Number(outer.style.zIndex) + 1)
  expect(outer.contains(inner)).toBe(false) // both portaled to the body
  await pointerdown(button('Deep'))
  expect(outer.dataset.state).toBe('open')
  expect(inner.dataset.state).toBe('open')
  // Escape closes the innermost only.
  await key('Escape')
  expect(inner.dataset.state).toBe('closed')
  expect(outer.dataset.state).toBe('open')
  await pointerdown(button('Outside'))
  expect(outer.dataset.state).toBe('closed')
})

test('layers: the default popover layer sits above modals; the companion layer below them', async () => {
  const { open, surface } = await render(<Fixture />)
  await open()
  expect(Number(surface()!.style.zIndex)).toBe(90)
  await dom!.cleanup()
  const companion = await render(<Fixture layer="companion" />)
  await companion.open()
  expect(Number(companion.surface()!.style.zIndex)).toBe(50)
})

test('Tab order across the portal: the open trigger enters it, the ends lead back through the trigger', async () => {
  const { open, doc, key, trigger, button } = await render(<Fixture initialFocus="none" />)
  await dom!.act(async () => trigger.focus())
  await open()
  await key('Tab')
  expect(doc.activeElement).toBe(button('First'))
  await key('Tab', { shiftKey: true })
  expect(doc.activeElement).toBe(trigger)
  await dom!.act(async () => button('Last').focus())
  // Forward Tab off the end focuses the trigger without preventDefault, so the browser's own Tab
  // continues from there to whatever follows the trigger in the page.
  const event = new dom!.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
  await dom!.act(async () => void button('Last').dispatchEvent(event))
  expect(doc.activeElement).toBe(trigger)
  expect(event.defaultPrevented).toBe(false)
})

test('a trigger hidden by a breakpoint closes its popover; a non-dismissible one stays', async () => {
  const dismissed: string[] = []
  const { open, trigger } = await render(<Fixture onDismissed={(reason) => dismissed.push(reason)} />)
  await open()
  trigger.getClientRects = () => [] as unknown as DOMRectList
  await dom!.act(async () => dom!.window.dispatchEvent(new dom!.window.Event('resize')))
  expect(dismissed).toEqual(['anchor'])
  await dom!.cleanup()

  function Persistent() {
    const [open, setOpen] = useState(false)
    const trigger = useRef<HTMLButtonElement>(null)
    return (
      <>
        <button ref={trigger} type="button" onClick={() => setOpen(true)}>
          Open
        </button>
        <Popover
          open={open}
          onDismiss={() => setOpen(false)}
          trigger={trigger}
          dismissible={false}
          aria-label="Mini player"
        >
          Playing
        </Popover>
      </>
    )
  }
  const persistent = await render(<Persistent />)
  await persistent.open()
  persistent.trigger.getClientRects = () => [] as unknown as DOMRectList
  const before = persistent.surface()!.style.top
  await dom!.act(async () => dom!.window.dispatchEvent(new dom!.window.Event('resize')))
  expect(persistent.surface()).not.toBeNull()
  expect(persistent.surface()!.style.top).toBe(before)
})
