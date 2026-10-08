import { expect, mock, test } from 'bun:test'
import { useRef } from 'react'
import { acquireDomHarness } from '../test/domHarness'
import {
  FIELD_REVEAL_MARGIN_PX,
  KEYBOARD_OPEN_THRESHOLD_PX,
  isKeyboardField,
  keyboardShellHeight,
  revealScrollDelta,
  useVisualViewportShell,
  type VisualViewportLike,
} from './useVisualViewportShell'

test('the shell pins to the visual viewport only when the difference looks like a keyboard', () => {
  expect(keyboardShellHeight(812, 812)).toBeNull()
  expect(keyboardShellHeight(812 - KEYBOARD_OPEN_THRESHOLD_PX, 812)).toBeNull()
  expect(keyboardShellHeight(500.4, 812)).toBe(500)
})

function fakeViewport(height: number): VisualViewportLike & { emit: (type: 'resize' | 'scroll') => void } {
  const listeners = { resize: new Set<() => void>(), scroll: new Set<() => void>() }
  return {
    height,
    offsetTop: 0,
    addEventListener: (type, listener) => listeners[type].add(listener),
    removeEventListener: (type, listener) => listeners[type].delete(listener),
    emit: (type) => listeners[type].forEach((listener) => listener()),
  }
}

test('opening the keyboard sizes the shell to the visible area and undoes the page scroll; closing restores it', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/' })
  const viewport = fakeViewport(812)
  const resetScroll = mock(() => {})
  let shell: HTMLDivElement | null = null
  function Shell() {
    const ref = useRef<HTMLDivElement>(null)
    useVisualViewportShell(ref, { viewport, innerHeight: () => 812, resetScroll })
    return (
      <div
        ref={(node) => {
          ref.current = node
          shell = node
        }}
        className="h-full"
      />
    )
  }
  const { root } = dom.createRoot()
  try {
    await dom.act(async () => root.render(<Shell />))
    expect(shell!.style.height).toBe('')
    expect(shell!.dataset.keyboard).toBeUndefined()
    // Keyboard opens: Safari shrinks the visual viewport and scrolls the fixed page to the input.
    viewport.height = 470
    viewport.offsetTop = 342
    await dom.act(async () => viewport.emit('resize'))
    expect(shell!.style.height).toBe('470px')
    expect(shell!.style.maxHeight).toBe('470px')
    expect(shell!.dataset.keyboard).toBe('open')
    expect(resetScroll).toHaveBeenCalledTimes(1)
    // A later visual-viewport scroll with no offset does nothing extra.
    viewport.offsetTop = 0
    await dom.act(async () => viewport.emit('scroll'))
    expect(resetScroll).toHaveBeenCalledTimes(1)
    // Keyboard closes: the shell returns to the CSS-driven full height.
    viewport.height = 812
    await dom.act(async () => viewport.emit('resize'))
    expect(shell!.style.height).toBe('')
    expect(shell!.dataset.keyboard).toBeUndefined()
    await dom.act(async () => root.unmount())
  } finally {
    await dom.cleanup()
  }
})

test('a field is revealed with its label above and its next action below, never past its label', () => {
  const view = { top: 56, bottom: 470 }
  // Comfortably visible: left alone (the chat composer, a field the person scrolled to).
  expect(revealScrollDelta({ top: 300, bottom: 340 }, { top: 280, bottom: 390 }, view)).toBe(0)
  // Below the keyboard edge: scroll until the next action clears it, plus breathing room.
  expect(revealScrollDelta({ top: 620, bottom: 660 }, { top: 600, bottom: 708 }, view)).toBe(
    708 + FIELD_REVEAL_MARGIN_PX - 470
  )
  // Too little room for everything: the label lands just under the top edge instead.
  expect(revealScrollDelta({ top: 620, bottom: 660 }, { top: 600, bottom: 1200 }, view)).toBe(
    600 - FIELD_REVEAL_MARGIN_PX - 56
  )
  // Hugging the bottom edge still counts as hidden behind the keyboard.
  expect(revealScrollDelta({ top: 420, bottom: 465 }, { top: 420, bottom: 465 }, view)).toBe(
    465 + FIELD_REVEAL_MARGIN_PX - 470
  )
  // Above the visible area: scroll up to the label.
  expect(revealScrollDelta({ top: 20, bottom: 60 }, { top: 0, bottom: 60 }, view)).toBe(0 - FIELD_REVEAL_MARGIN_PX - 56)
})

test('only controls that raise the keyboard are revealed', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/' })
  try {
    const make = (html: string) => {
      const host = document.createElement('div')
      host.innerHTML = html
      return host.firstElementChild
    }
    expect(isKeyboardField(make('<input />'))).toBe(true)
    expect(isKeyboardField(make('<input type="email" />'))).toBe(true)
    expect(isKeyboardField(make('<textarea></textarea>'))).toBe(true)
    expect(isKeyboardField(make('<select></select>'))).toBe(true)
    expect(isKeyboardField(make('<input type="checkbox" />'))).toBe(false)
    expect(isKeyboardField(make('<button>Save</button>'))).toBe(false)
    expect(isKeyboardField(null)).toBe(false)
  } finally {
    await dom.cleanup()
  }
})

/** Happy DOM has no layout: give an element a box that moves with its scroll container. */
function place(element: Element, top: () => number, height: number) {
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ top: top(), bottom: top() + height, left: 0, right: 390, width: 390, height, x: 0, y: top() }),
  })
}

function setScrollSize(element: HTMLElement, scrollHeight: number, clientHeight: () => number) {
  Object.defineProperty(element, 'scrollHeight', { configurable: true, get: () => scrollHeight })
  Object.defineProperty(element, 'clientHeight', { configurable: true, get: clientHeight })
}

const LAYOUT_HEIGHT = 812
const HEADER_HEIGHT = 56

/**
 * A settings-like page: a header, then the main scroll container holding a nested scrolling
 * section with a labelled "Server name" field and its submit button far down the page.
 */
async function renderSettingsShell(viewport: VisualViewportLike, resetScroll: () => void) {
  const dom = await acquireDomHarness({ url: 'http://localhost/' })
  let shell: HTMLDivElement | null = null
  function Shell() {
    const ref = useRef<HTMLDivElement>(null)
    useVisualViewportShell(ref, { viewport, innerHeight: () => LAYOUT_HEIGHT, resetScroll })
    return (
      <div
        ref={(node) => {
          ref.current = node
          shell = node
        }}
      >
        <header />
        <main data-testid="main" style={{ overflowY: 'auto' }}>
          <section data-testid="section" style={{ overflowY: 'auto' }}>
            <form>
              <label data-testid="label">
                Server name
                <input data-testid="name" />
              </label>
              <button type="submit">Connect Ficus account</button>
              <input data-testid="later" />
            </form>
          </section>
        </main>
        <textarea data-testid="composer" />
      </div>
    )
  }
  const { root } = dom.createRoot()
  await dom.act(async () => root.render(<Shell />))
  const get = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement
  const main = get('main')
  const section = get('section')
  const shellBottom = () => Number.parseFloat(shell!.style.height) || LAYOUT_HEIGHT
  Object.defineProperty(shell!, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ top: 0, bottom: shellBottom(), left: 0, right: 390, width: 390, height: shellBottom() }),
  })
  // main fills the shell below the header and scrolls once the shell shrinks; the nested section holds the form.
  const mainHeight = () => shellBottom() - HEADER_HEIGHT
  Object.defineProperty(main, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ top: HEADER_HEIGHT, bottom: shellBottom(), height: mainHeight() }),
  })
  setScrollSize(main, LAYOUT_HEIGHT - HEADER_HEIGHT, mainHeight)
  Object.defineProperty(section, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ top: HEADER_HEIGHT, bottom: shellBottom(), height: mainHeight() }),
  })
  setScrollSize(section, 1600, mainHeight)
  const inSection = (y: number) => () => y - section.scrollTop
  place(get('label'), inSection(600), 60)
  place(get('name'), inSection(620), 40)
  place(section.querySelector('button')!, inSection(672), 36)
  place(get('later'), inSection(1200), 40)
  place(get('composer'), () => shellBottom() - 60, 46)
  return { dom, root, shell: () => shell!, get, main, section }
}

test('opening the keyboard scrolls a focused settings field into view inside its scroll container', async () => {
  const viewport = fakeViewport(LAYOUT_HEIGHT)
  const resetScroll = mock(() => {})
  const { dom, root, shell, get, main, section } = await renderSettingsShell(viewport, resetScroll)
  try {
    get('name').focus()
    // Before the keyboard shows nothing moves: the shell is not pinned yet.
    expect(section.scrollTop).toBe(0)
    // Keyboard opens; Safari pans the fixed page to find the field.
    viewport.height = 470
    viewport.offsetTop = 342
    await dom.act(async () => viewport.emit('resize'))
    expect(shell().style.height).toBe('470px')
    // The field, its label and the Connect button now sit above the keyboard, inside the section.
    expect(section.scrollTop).toBe(672 + 36 + FIELD_REVEAL_MARGIN_PX - 470)
    expect(get('label').getBoundingClientRect().top).toBeGreaterThanOrEqual(HEADER_HEIGHT)
    expect(section.querySelector('button')!.getBoundingClientRect().bottom).toBeLessThanOrEqual(470)
    // The page itself did not scroll and Safari's pan was undone.
    expect(main.scrollTop).toBe(0)
    expect(resetScroll).toHaveBeenCalledTimes(1)
    // A repeat event with the same height and no pan leaves the person's scroll alone.
    section.scrollTop = 40
    viewport.offsetTop = 0
    await dom.act(async () => viewport.emit('scroll'))
    expect(section.scrollTop).toBe(40)
    // Moving focus to a field further down while the keyboard stays open reveals that one too.
    await dom.act(async () => get('later').focus())
    expect(get('later').getBoundingClientRect().bottom).toBeLessThanOrEqual(470 - FIELD_REVEAL_MARGIN_PX)
    expect(get('later').getBoundingClientRect().top).toBeGreaterThanOrEqual(HEADER_HEIGHT)
    // Keyboard closes: focus changes no longer scroll anything.
    viewport.height = LAYOUT_HEIGHT
    await dom.act(async () => viewport.emit('resize'))
    const settled = section.scrollTop
    await dom.act(async () => get('name').focus())
    expect(section.scrollTop).toBe(settled)
    await dom.act(async () => root.unmount())
  } finally {
    await dom.cleanup()
  }
})

test('a composer already above the keyboard and fields outside the shell are never scrolled', async () => {
  const viewport = fakeViewport(LAYOUT_HEIGHT)
  const { dom, root, get, main, section } = await renderSettingsShell(viewport, () => {})
  try {
    // Chat composer: pinned to the shell bottom, outside any scrolling container.
    get('composer').focus()
    viewport.height = 470
    await dom.act(async () => viewport.emit('resize'))
    expect(main.scrollTop).toBe(0)
    expect(section.scrollTop).toBe(0)
    // A modal's input lives outside the shell (portaled); the modal reveals its own fields.
    const modal = document.createElement('div')
    modal.style.overflowY = 'auto'
    const input = document.createElement('input')
    modal.append(input)
    document.body.append(modal)
    setScrollSize(modal, 2000, () => 300)
    place(input, () => 1500 - modal.scrollTop, 40)
    await dom.act(async () => input.focus())
    viewport.height = 400
    await dom.act(async () => viewport.emit('resize'))
    expect(modal.scrollTop).toBe(0)
    expect(section.scrollTop).toBe(0)
    modal.remove()
    await dom.act(async () => root.unmount())
  } finally {
    await dom.cleanup()
  }
})
