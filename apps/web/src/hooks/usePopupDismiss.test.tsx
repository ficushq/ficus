import { afterEach, expect, test } from 'bun:test'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { acquireDomHarness } from '../test/domHarness'
import { webkitTap } from '../test/webkitTap'
import { Presence } from '../components/Presence'
import { usePopupDismiss, type PopupDismissReason } from './usePopupDismiss'

let dom: Awaited<ReturnType<typeof acquireDomHarness>> | undefined
afterEach(async () => {
  await dom?.cleanup()
  dom = undefined
})

const log: string[] = []

/** A minimal popup on the primitive: the first item takes focus on open; an item click acts, then closes. */
function Menu({ name, portal = false, children }: { name: string; portal?: boolean; children?: ReactNode }) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const popup = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (open) popup.current?.querySelector('button')?.focus()
  }, [open])
  usePopupDismiss({
    open,
    popup,
    trigger,
    onDismiss: (reason: PopupDismissReason) => {
      log.push(`${name} dismissed by ${reason}`)
      setOpen(false)
    },
  })
  const surface = (
    <Presence ref={popup} open={open} role="menu" aria-label={`${name} menu`}>
      <button
        type="button"
        onClick={() => {
          log.push(`${name} item ran`)
          setOpen(false)
        }}
      >
        {name} item
      </button>
      {children}
    </Presence>
  )
  return (
    <div>
      <button ref={trigger} type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
        {name}
      </button>
      {portal ? createPortal(surface, document.body) : surface}
    </div>
  )
}

/** The pattern every past regression shared: close on a blur whose relatedTarget is outside. */
function BlurClosingMenu() {
  const [open, setOpen] = useState(false)
  return (
    <div
      onBlur={(event) => {
        const next = event.relatedTarget
        if (next && !event.currentTarget.contains(next)) setOpen(false)
      }}
    >
      <button type="button" onClick={() => setOpen(true)}>
        Naive
      </button>
      <Presence ref={(node) => void (open && node?.querySelector('button')?.focus())} open={open}>
        <button type="button" onClick={() => log.push('naive item ran')}>
          Naive item
        </button>
      </Presence>
    </div>
  )
}

async function render(node: ReactNode) {
  log.length = 0
  dom = await acquireDomHarness({ url: 'http://localhost' })
  const { root, container } = dom.createRoot()
  await dom.act(async () => root.render(node))
  const doc = dom.window.document
  const button = (name: string) =>
    [...doc.querySelectorAll<HTMLButtonElement>('button')].find((candidate) => candidate.textContent === name)!
  const open = (name: string) => dom!.act(async () => button(name).click())
  const expanded = (name: string) => button(name).getAttribute('aria-expanded') === 'true'
  const key = (target: Element, key: string, init: KeyboardEventInit = {}) =>
    dom!.act(async () => {
      target.dispatchEvent(new dom!.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }))
    })
  return { container, doc, button, open, expanded, key }
}

const inSection = (node: ReactNode) => (
  <section data-setting-target="example" tabIndex={-1}>
    {node}
  </section>
)

test('the WebKit tap helper reproduces the bug: a blur-closing popup inside a focusable section loses the tap', async () => {
  const { button, open, doc } = await render(inSection(<BlurClosingMenu />))
  await open('Naive')
  expect(doc.activeElement?.textContent).toBe('Naive item')
  const delivered = await webkitTap(button('Naive item'))
  expect(doc.activeElement?.tagName).toBe('SECTION')
  expect(delivered).toBe(false)
  expect(log).toEqual([])
})

for (const touch of [false, true]) {
  test(`a WebKit tap (${touch ? 'iOS touch order' : 'desktop Safari order'}) on an item inside a focusable section runs it`, async () => {
    const { button, open, expanded, doc } = await render(inSection(<Menu name="Actions" />))
    await open('Actions')
    expect(doc.activeElement?.textContent).toBe('Actions item')
    expect(await webkitTap(button('Actions item'), { touch })).toBe(true)
    expect(log).toEqual(['Actions item ran'])
    expect(expanded('Actions')).toBe(false)
  })
}

test('a WebKit tap with no focusable ancestor (focus drops to null) runs the item', async () => {
  const { button, open, expanded, doc } = await render(<Menu name="Actions" />)
  await open('Actions')
  expect(await webkitTap(button('Actions item'))).toBe(true)
  expect(doc.activeElement).toBe(doc.body)
  expect(log).toEqual(['Actions item ran'])
  expect(expanded('Actions')).toBe(false)
})

test('a WebKit tap inside a portaled popup inside a dialog runs the item', async () => {
  const { button, open } = await render(
    <div role="dialog" aria-modal="true" tabIndex={-1}>
      <Menu name="Actions" portal />
    </div>
  )
  await open('Actions')
  expect(await webkitTap(button('Actions item'))).toBe(true)
  expect(log).toEqual(['Actions item ran'])
})

test('focus moving to an ancestor of the popup, or to nothing, never closes it', async () => {
  const { button, open, expanded, doc } = await render(inSection(<Menu name="Actions" />))
  await open('Actions')
  await dom!.act(async () => doc.querySelector<HTMLElement>('section')!.focus())
  expect(expanded('Actions')).toBe(true)
  await dom!.act(async () => button('Actions item').focus())
  await dom!.act(async () => button('Actions item').blur())
  expect(expanded('Actions')).toBe(true)
  expect(log).toEqual([])
})

test('a press outside closes without moving focus; a press on the trigger toggles instead', async () => {
  const { button, open, expanded, doc } = await render(
    <>
      <Menu name="Actions" />
      <button type="button">Elsewhere</button>
    </>
  )
  await open('Actions')
  expect(await webkitTap(button('Elsewhere'))).toBe(true)
  expect(expanded('Actions')).toBe(false)
  expect(log).toEqual(['Actions dismissed by pointer'])
  expect(doc.activeElement).not.toBe(button('Actions'))

  log.length = 0
  await open('Actions')
  await webkitTap(button('Actions'))
  expect(expanded('Actions')).toBe(false)
  expect(log).toEqual([])
})

test('Escape closes, returns focus to the trigger, and is consumed before document listeners', async () => {
  const { button, open, expanded, doc, key } = await render(<Menu name="Actions" />)
  let reached = 0
  doc.addEventListener('keydown', () => reached++, true)
  await open('Actions')
  await key(doc.activeElement!, 'Escape')
  expect(expanded('Actions')).toBe(false)
  expect(doc.activeElement).toBe(button('Actions'))
  expect(reached).toBe(0)
  expect(log).toEqual(['Actions dismissed by escape'])
  // Closed popups listen to nothing.
  await key(doc.body, 'Escape')
  expect(reached).toBe(1)
})

test('keyboard focus leaving to an outside control closes it', async () => {
  const { button, open, expanded } = await render(
    <>
      <Menu name="Actions" />
      <button type="button">Next</button>
    </>
  )
  await open('Actions')
  await dom!.act(async () => button('Next').focus())
  expect(expanded('Actions')).toBe(false)
  expect(log).toEqual(['Actions dismissed by focus'])
})

test('focus loss during an inside press never closes, even to an outside control', async () => {
  const { button, open, expanded } = await render(
    <>
      <Menu name="Actions" />
      <button type="button">Next</button>
    </>
  )
  await open('Actions')
  await dom!.act(async () => {
    button('Actions item').dispatchEvent(new dom!.window.MouseEvent('pointerdown', { bubbles: true, composed: true }))
  })
  await dom!.act(async () => button('Next').focus())
  expect(expanded('Actions')).toBe(true)
  // The press ends with its click, after which keyboard focus loss counts again.
  await dom!.act(async () => {
    button('Actions item').dispatchEvent(new dom!.window.MouseEvent('pointerup', { bubbles: true }))
  })
  await dom!.act(async () => button('Actions item').focus())
  await dom!.act(async () => button('Actions item').click())
  expect(log).toEqual(['Actions item ran'])
  await open('Actions')
  await dom!.act(async () => button('Next').focus())
  expect(expanded('Actions')).toBe(false)
})

test('a popup opened inside another counts as inside it: presses, focus and Escape go to the inner one first', async () => {
  const { button, open, expanded, doc, key } = await render(
    <Menu name="Outer">
      <Menu name="Inner" portal />
    </Menu>
  )
  await open('Outer')
  await open('Inner')
  expect(expanded('Outer')).toBe(true)
  expect(doc.activeElement?.textContent).toBe('Inner item')
  // The inner surface is portaled outside the outer one, yet tapping it keeps the outer open.
  expect(await webkitTap(button('Inner item'))).toBe(true)
  expect(log).toEqual(['Inner item ran'])
  expect(expanded('Outer')).toBe(true)

  log.length = 0
  await open('Inner')
  await key(doc.activeElement!, 'Escape')
  expect(log).toEqual(['Inner dismissed by escape'])
  expect(expanded('Outer')).toBe(true)
  expect(doc.activeElement).toBe(button('Inner'))
  await key(doc.activeElement!, 'Escape')
  expect(log).toEqual(['Inner dismissed by escape', 'Outer dismissed by escape'])
  expect(expanded('Outer')).toBe(false)
})
