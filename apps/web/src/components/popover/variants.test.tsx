/**
 * The popover variants: each one's keyboard model and ARIA, plus a WebKit tap (`test/webkitTap.ts`) on
 * each inside a settings-style `<section tabIndex={-1}>` — where Safari focuses the section, not the
 * tapped button, before the click — which must still run the tapped item.
 */
import { afterEach, expect, test } from 'bun:test'
import { useRef, useState, type ReactNode } from 'react'
import { acquireDomHarness } from '../../test/domHarness'
import { webkitTap } from '../../test/webkitTap'
import { ConfirmButton } from '../ConfirmButton'
import { ComboboxList, HoverCard, Menu, MenuItem, Panel, Picker, useHoverCard, usePopover } from '.'

let dom: Awaited<ReturnType<typeof acquireDomHarness>> | undefined
afterEach(async () => {
  await dom?.cleanup()
  dom = undefined
})

async function render(node: ReactNode) {
  dom = await acquireDomHarness({ url: 'http://localhost/' })
  const { root } = dom.createRoot()
  await dom.act(async () =>
    root.render(
      <>
        <section tabIndex={-1}>{node}</section>
        <button type="button">Outside</button>
      </>
    )
  )
  const doc = dom.window.document
  const button = (text: string) =>
    [...doc.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim() === text)!
  const key = (key: string, init: KeyboardEventInit = {}) =>
    dom!.act(async () => {
      ;(doc.activeElement ?? doc.body).dispatchEvent(
        new dom!.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
      )
    })
  const wait = (ms: number) => dom!.act(() => new Promise((resolve) => setTimeout(resolve, ms)))
  const open = (selector: string) => doc.querySelector<HTMLElement>(`${selector}[data-state="open"]`)
  return { doc, button, key, wait, open }
}

function ActionsMenu({ ran, initialFocus }: { ran: string[]; initialFocus?: 'first' | 'selected' | 'none' }) {
  const popover = usePopover({ kind: 'menu' })
  return (
    <>
      <button {...popover.triggerProps} type="button" onClick={popover.toggle}>
        Actions
      </button>
      <Menu {...popover.popoverProps} label="Actions" initialFocus={initialFocus}>
        <MenuItem onClick={() => ran.push('rename')}>Rename</MenuItem>
        <MenuItem disabled onClick={() => ran.push('locked')}>
          Locked
        </MenuItem>
        <MenuItem role="menuitemradio" checked onClick={() => ran.push('pinned')}>
          Pinned
        </MenuItem>
        <MenuItem opensDialog onClick={() => ran.push('delete')}>
          Delete…
        </MenuItem>
        <MenuItem onClick={(event) => (event.preventDefault(), ran.push('stay'))}>Stay open</MenuItem>
      </Menu>
    </>
  )
}

test('Menu: arrows loop and skip disabled items, Home/End jump, Enter runs once then closes with focus returned', async () => {
  const ran: string[] = []
  const { doc, button, key } = await render(<ActionsMenu ran={ran} />)
  const trigger = button('Actions')
  expect(trigger.getAttribute('aria-haspopup')).toBe('menu')
  await dom!.act(async () => trigger.click())
  expect(doc.querySelector('[role="menu"]')!.getAttribute('aria-label')).toBe('Actions')
  expect(doc.activeElement?.textContent).toBe('Rename')
  await key('ArrowDown')
  expect(doc.activeElement?.textContent).toBe('Pinned') // Locked is disabled
  await key('End')
  expect(doc.activeElement?.textContent).toBe('Stay open')
  await key('ArrowDown')
  expect(doc.activeElement?.textContent).toBe('Rename')
  await key('ArrowUp')
  expect(doc.activeElement?.textContent).toBe('Stay open')
  await key('Home')
  expect(doc.activeElement?.textContent).toBe('Rename')
  await key('Enter', { repeat: true })
  expect(ran).toEqual([])
  await key('Enter')
  expect(ran).toEqual(['rename'])
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
  expect(doc.activeElement).toBe(trigger)
})

test('Menu: ArrowDown on the trigger opens it; selected focus, opensDialog, preventDefault and Tab', async () => {
  const ran: string[] = []
  const { doc, button, key } = await render(<ActionsMenu ran={ran} initialFocus="selected" />)
  const trigger = button('Actions')
  await dom!.act(async () => trigger.focus())
  await key('ArrowDown')
  expect(trigger.getAttribute('aria-expanded')).toBe('true')
  expect(doc.activeElement?.textContent).toBe('Pinned')
  expect(doc.activeElement?.getAttribute('aria-checked')).toBe('true')
  // An item that prevents default keeps the menu open.
  await dom!.act(async () => button('Stay open').click())
  expect(ran).toEqual(['stay'])
  expect(trigger.getAttribute('aria-expanded')).toBe('true')
  // A dialog-opening item never pulls focus back behind its dialog.
  await dom!.act(async () => button('Delete…').focus())
  await dom!.act(async () => button('Delete…').click())
  expect(ran).toEqual(['stay', 'delete'])
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
  expect(doc.activeElement).not.toBe(trigger)
  // Tab closes it and continues from the trigger; Shift+Tab lands on the trigger.
  await dom!.act(async () => trigger.click())
  await key('Tab', { shiftKey: true })
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
  expect(doc.activeElement).toBe(trigger)
})

test('Menu: plain buttons picked by itemSelector become menu items', async () => {
  function Plain() {
    const popover = usePopover({ kind: 'menu' })
    return (
      <>
        <button {...popover.triggerProps} type="button" onClick={popover.toggle}>
          More
        </button>
        <Menu {...popover.popoverProps} label="More" itemSelector="[data-items] button">
          <div data-items>
            <button type="button">One</button>
            <button type="button">Two</button>
          </div>
        </Menu>
      </>
    )
  }
  const { doc, button, key } = await render(<Plain />)
  await dom!.act(async () => button('More').click())
  expect([...doc.querySelectorAll('[role="menu"] button')].map((item) => item.getAttribute('role'))).toEqual([
    'menuitem',
    'menuitem',
  ])
  await key('ArrowDown')
  expect(doc.activeElement?.textContent).toBe('Two')
})

test('Menu: a WebKit tap inside a focusable section runs the item, then closes', async () => {
  const ran: string[] = []
  const { button } = await render(<ActionsMenu ran={ran} />)
  await dom!.act(async () => button('Actions').click())
  expect(await webkitTap(button('Pinned'), { touch: true })).toBe(true)
  expect(ran).toEqual(['pinned'])
  expect(button('Actions').getAttribute('aria-expanded')).toBe('false')
})

function Choice({ values }: { values: string[] }) {
  const popover = usePopover({ kind: 'listbox' })
  const [value, setValue] = useState<'one' | 'two' | 'three'>('two')
  return (
    <>
      <button {...popover.triggerProps} type="button" role="combobox" onClick={popover.toggle}>
        {value}
      </button>
      <Picker
        {...popover.popoverProps}
        label="Count"
        value={value}
        options={[
          { value: 'one', label: 'One' },
          { value: 'two', label: 'Two', description: 'The default' },
          { value: 'three', label: 'Three' },
        ]}
        onChange={(next) => {
          values.push(next)
          setValue(next)
        }}
      />
    </>
  )
}

test('Picker: the selected option takes focus, arrows never change the value, Enter commits and closes', async () => {
  const values: string[] = []
  const { doc, key } = await render(<Choice values={values} />)
  const trigger = doc.querySelector<HTMLButtonElement>('[role="combobox"]')!
  expect(trigger.getAttribute('aria-haspopup')).toBe('listbox')
  await dom!.act(async () => trigger.click())
  const options = [...doc.querySelectorAll('[role="option"]')]
  expect(options.map((option) => option.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false'])
  expect(doc.activeElement?.getAttribute('aria-label')).toBe('Two')
  expect(doc.getElementById(doc.activeElement!.getAttribute('aria-describedby')!)?.textContent).toBe('The default')
  await key('ArrowDown')
  expect(doc.activeElement?.getAttribute('aria-label')).toBe('Three')
  expect(values).toEqual([])
  await key(' ')
  expect(values).toEqual(['three'])
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
  expect(doc.activeElement).toBe(trigger)
  expect(trigger.textContent).toBe('three')
})

test('Picker: a WebKit tap on an option selects it', async () => {
  const values: string[] = []
  const { doc } = await render(<Choice values={values} />)
  await dom!.act(async () => doc.querySelector<HTMLButtonElement>('[role="combobox"]')!.click())
  expect(await webkitTap(doc.querySelectorAll('[role="option"]')[0]!)).toBe(true)
  expect(values).toEqual(['one'])
})

function Filters() {
  const popover = usePopover({ kind: 'dialog' })
  const [on, setOn] = useState(false)
  return (
    <>
      <button {...popover.triggerProps} type="button" onClick={popover.toggle}>
        Filters
      </button>
      <Panel {...popover.popoverProps} label="Filters">
        <button type="button" aria-pressed={on} onClick={() => setOn(!on)}>
          Blocked
        </button>
        <input aria-label="Search" />
      </Panel>
    </>
  )
}

test('Panel: focus moves in, stays open across inside presses, and closes when keyboard focus leaves', async () => {
  const { doc, button, open, wait } = await render(<Filters />)
  const trigger = button('Filters')
  expect(trigger.getAttribute('aria-haspopup')).toBe('dialog')
  await dom!.act(async () => trigger.click())
  expect(open('[role="dialog"]')?.getAttribute('aria-label')).toBe('Filters')
  expect(doc.activeElement).toBe(button('Blocked'))
  expect(await webkitTap(button('Blocked'), { touch: true })).toBe(true)
  expect(button('Blocked').getAttribute('aria-pressed')).toBe('true')
  expect(trigger.getAttribute('aria-expanded')).toBe('true')
  await wait(0)
  await dom!.act(async () => doc.querySelector<HTMLInputElement>('[aria-label="Search"]')!.focus())
  await dom!.act(async () => button('Outside').focus())
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
})

test('Panel: two WebKit taps on a confirm-to-run action (the agent actions panel) arm it, then run it', async () => {
  const ran: string[] = []
  function AgentActions() {
    const popover = usePopover({ kind: 'disclosure' })
    return (
      <>
        <button {...popover.triggerProps} type="button" onClick={popover.toggle}>
          Agent actions
        </button>
        <Panel {...popover.popoverProps} role="group" label="Agent actions">
          <ConfirmButton
            label="Reset"
            onConfirm={() => {
              ran.push('reset')
              popover.setOpen(false)
            }}
          />
        </Panel>
      </>
    )
  }
  const { button } = await render(<AgentActions />)
  const trigger = button('Agent actions')
  expect(trigger.hasAttribute('aria-haspopup')).toBe(false)
  await dom!.act(async () => trigger.click())
  expect(await webkitTap(button('Reset'), { touch: true })).toBe(true)
  expect(trigger.getAttribute('aria-expanded')).toBe('true')
  expect(await webkitTap(button('Confirm?'), { touch: true })).toBe(true)
  expect(ran).toEqual(['reset'])
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
})

function Reference() {
  const anchor = useRef<HTMLButtonElement>(null)
  const hover = useHoverCard({ openDelay: 30, closeDelay: 30 })
  return (
    <>
      <button ref={anchor} type="button" {...hover.anchorHandlers}>
        Reference
      </button>
      <HoverCard hover={hover} anchor={anchor} label="Preview">
        <a href="/details">Details</a>
      </HoverCard>
    </>
  )
}

test('HoverCard: opens after the hover delay, survives crossing onto the card, closes after leaving both', async () => {
  const { doc, button, wait, open } = await render(<Reference />)
  const anchor = button('Reference')
  const mouse = (target: Element, type: 'mouseover' | 'mouseout') =>
    dom!.act(async () => void target.dispatchEvent(new dom!.window.MouseEvent(type, { bubbles: true })))
  // Leaving before the delay cancels it.
  await mouse(anchor, 'mouseover')
  await mouse(anchor, 'mouseout')
  await wait(50)
  expect(open('[role="dialog"]')).toBeNull()

  await mouse(anchor, 'mouseover')
  expect(open('[role="dialog"]')).toBeNull()
  await wait(50)
  const card = open('[role="dialog"]')!
  expect(card.getAttribute('aria-label')).toBe('Preview')
  expect(doc.activeElement).not.toBe(card.querySelector('a')) // never takes focus on open
  await mouse(anchor, 'mouseout')
  await mouse(card, 'mouseover')
  await wait(50)
  expect(open('[role="dialog"]')).not.toBeNull()
  await mouse(card, 'mouseout')
  await wait(50)
  expect(open('[role="dialog"]')).toBeNull()
})

test('HoverCard: keyboard focus opens it at once, Tab enters it, Escape closes it and returns focus', async () => {
  const { doc, button, key, open } = await render(<Reference />)
  const anchor = button('Reference')
  anchor.matches = ((selector: string) => selector === ':focus-visible') as typeof anchor.matches
  await dom!.act(async () => anchor.focus())
  expect(open('[role="dialog"]')).not.toBeNull()
  await key('Tab')
  expect(doc.activeElement?.textContent).toBe('Details')
  await key('Escape')
  expect(open('[role="dialog"]')).toBeNull()
  expect(doc.activeElement).toBe(anchor)
})

test('HoverCard: a WebKit tap on a focused card link follows it', async () => {
  const { doc, button, key, open } = await render(<Reference />)
  const anchor = button('Reference')
  anchor.matches = ((selector: string) => selector === ':focus-visible') as typeof anchor.matches
  const followed: string[] = []
  await dom!.act(async () => anchor.focus())
  await key('Tab')
  const link = open('[role="dialog"]')!.querySelector('a')!
  link.addEventListener('click', (event) => {
    event.preventDefault()
    followed.push(link.getAttribute('href')!)
  })
  expect(doc.activeElement).toBe(link)
  expect(await webkitTap(link, { touch: true })).toBe(true)
  expect(followed).toEqual(['/details'])
})

function Composer({ picked, closed }: { picked: string[]; closed: () => void }) {
  const field = useRef<HTMLTextAreaElement>(null)
  const [open, setOpen] = useState(true)
  return (
    <>
      <textarea ref={field} aria-label="Message" />
      <ComboboxList
        open={open}
        onDismiss={() => {
          closed()
          setOpen(false)
        }}
        input={field}
        listId="files"
        activeId="files-1"
      >
        <div id="files" role="listbox" aria-label="Files">
          {['a.ts', 'b.ts'].map((file, index) => (
            <button key={file} id={`files-${index}`} type="button" role="option" onClick={() => picked.push(file)}>
              {file}
            </button>
          ))}
        </div>
      </ComboboxList>
    </>
  )
}

test('ComboboxList: focus stays in the field, which carries the combobox ARIA; only an outside press closes it', async () => {
  const picked: string[] = []
  let closed = 0
  const { doc, button, key } = await render(<Composer picked={picked} closed={() => closed++} />)
  const field = doc.querySelector('textarea')!
  await dom!.act(async () => field.focus())
  expect(doc.activeElement).toBe(field)
  expect(field.getAttribute('aria-controls')).toBe('files')
  expect(field.getAttribute('aria-expanded')).toBe('true')
  expect(field.getAttribute('aria-activedescendant')).toBe('files-1')
  // A mouse press on an option never takes focus from the field.
  const press = new dom!.window.MouseEvent('mousedown', { bubbles: true, cancelable: true })
  button('b.ts').dispatchEvent(press)
  expect(press.defaultPrevented).toBe(true)
  await dom!.act(async () => button('b.ts').click())
  expect(picked).toEqual(['b.ts'])
  expect(doc.activeElement).toBe(field)
  // Escape belongs to the field's own key handler.
  await key('Escape')
  expect(closed).toBe(0)
  // A WebKit tap on an option still lands.
  expect(await webkitTap(button('a.ts'))).toBe(true)
  expect(picked).toEqual(['b.ts', 'a.ts'])
  expect(closed).toBe(0)
  await webkitTap(button('Outside'))
  expect(closed).toBe(1)
  expect(field.hasAttribute('aria-expanded')).toBe(false)
})
