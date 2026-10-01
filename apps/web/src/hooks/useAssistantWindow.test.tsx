import { expect, test } from 'bun:test'
import { useRef } from 'react'
import { acquireDomHarness } from '../test/domHarness'
import { useAssistantWindow } from './useAssistantWindow'

const STORAGE_KEY = 'ficus-assistant-window'

async function setup({ small = false, initial }: { small?: boolean; initial?: unknown } = {}) {
  const dom = await acquireDomHarness({
    url: 'http://localhost/',
    windowOptions: { innerWidth: 1200, innerHeight: 900 },
  })
  const viewport = Object.assign(new dom.window.EventTarget(), {
    offsetLeft: 0,
    offsetTop: 0,
    width: 1200,
    height: 900,
  })
  Object.defineProperty(dom.window, 'visualViewport', { configurable: true, value: viewport })
  if (initial !== undefined) dom.window.localStorage.setItem(STORAGE_KEY, JSON.stringify(initial))
  const { root, container } = dom.createRoot()
  function Panel({ compact }: { compact: boolean }) {
    const ref = useRef<HTMLDivElement>(null)
    const win = useAssistantWindow(ref, { visible: true, small: compact })
    return (
      <div
        ref={(node) => {
          ref.current = node
          // Happy DOM has no layout: the box is what the style says, else the CSS default size.
          if (node)
            node.getBoundingClientRect = () =>
              ({
                left: Number.parseFloat(node.style.left) || 0,
                top: Number.parseFloat(node.style.top) || 0,
                width: Number.parseFloat(node.style.width) || (compact ? 256 : 704),
                height: Math.min(
                  Number.parseFloat(node.style.height) || (compact ? 60 : 640),
                  Number.parseFloat(node.style.maxHeight) || Infinity
                ),
              }) as DOMRect
        }}
        style={win.style}
        data-snap={win.placement.snap ?? ''}
        {...win.panelHandlers}
      >
        <header data-assistant-drag-handle>
          Assistant<button onClick={() => win.snap('left')}>Snap left</button>
          <button onClick={win.reset}>Reset</button>
        </header>
        <textarea defaultValue="Keep this draft" />
        <button aria-label="Resize assistant" {...win.resizeHandle} />
      </div>
    )
  }
  await dom.act(async () => root.render(<Panel compact={small} />))
  const panel = container.firstElementChild as HTMLDivElement
  for (const element of [panel, panel.querySelector('[aria-label="Resize assistant"]')!] as HTMLElement[]) {
    element.setPointerCapture = () => {}
    element.hasPointerCapture = () => true
    element.releasePointerCapture = () => {}
  }
  const pointer = async (target: Element, type: string, x: number, y: number) => {
    const event = new dom.window.MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 })
    Object.defineProperty(event, 'pointerId', { value: 1 })
    await dom.act(async () => target.dispatchEvent(event))
  }
  const box = () => ({
    left: Number.parseFloat(panel.style.left),
    top: Number.parseFloat(panel.style.top),
    width: Number.parseFloat(panel.style.width),
    height: Number.parseFloat(panel.style.height),
  })
  const saved = () => JSON.parse(dom.window.localStorage.getItem(STORAGE_KEY) ?? 'null')
  const resizeViewport = async (width: number, height: number, offsetTop = 0) => {
    Object.assign(viewport, { width, height, offsetTop })
    await dom.act(async () => viewport.dispatchEvent(new dom.window.Event('resize')))
  }
  return {
    dom,
    root,
    panel,
    pointer,
    box,
    saved,
    resizeViewport,
    rerender: (compact: boolean) => root.render(<Panel compact={compact} />),
  }
}

test('by default it is a card centered on the screen with its CSS size', async () => {
  const { dom, panel } = await setup()
  try {
    expect(panel.style.left).toBe(`${(1200 - 704) / 2}px`)
    expect(panel.style.top).toBe(`${(900 - 640) / 2}px`)
    expect(panel.style.width).toBe('')
    expect(panel.style.maxHeight).toBe(`${900 - (900 - 640) / 2 - 8}px`)
  } finally {
    await dom.cleanup()
  }
})

test('dragging the header places it anywhere, stays put, and is remembered; header buttons do not drag', async () => {
  const { dom, panel, pointer, box, saved } = await setup()
  try {
    const header = panel.querySelector('header')!
    await pointer(panel.querySelector('button')!, 'pointerdown', 300, 170)
    await pointer(panel, 'pointermove', 500, 400)
    await pointer(panel, 'pointerup', 500, 400)
    expect(box().left).toBe(248)
    expect(saved()).toBeNull()

    await pointer(header, 'pointerdown', 300, 170)
    await pointer(panel, 'pointermove', 402, 291)
    expect(panel.style.transition).toBe('none')
    await pointer(panel, 'pointerup', 402, 291)
    // No corner snapping: it stays exactly where it was dropped.
    expect(box()).toEqual({ left: 350, top: 251, width: 704, height: 640 })
    expect(saved()).toEqual({ rect: { x: 350, y: 251, w: 704, h: 640 } })
    // Dropped past an edge, it stays on screen.
    await pointer(header, 'pointerdown', 400, 290)
    await pointer(panel, 'pointermove', 400, 890)
    await pointer(panel, 'pointerup', 400, 890)
    expect(box().top).toBe(900 - 640 - 8)
    expect(panel.style.transition).toBe('')
  } finally {
    await dom.cleanup()
  }
})

test('the corner handle resizes and is remembered; arrow keys nudge; double-click restores the default', async () => {
  const { dom, panel, pointer, box, saved } = await setup({ initial: { rect: { x: 100, y: 100, w: 500, h: 400 } } })
  try {
    const handle = panel.querySelector('[aria-label="Resize assistant"]')!
    await pointer(handle, 'pointerdown', 600, 500)
    await pointer(handle, 'pointermove', 700, 560)
    await pointer(handle, 'pointerup', 700, 560)
    expect(box()).toEqual({ left: 100, top: 100, width: 600, height: 460 })
    expect(saved()).toEqual({ rect: { x: 100, y: 100, w: 600, h: 460 } })
    await dom.act(async () =>
      handle.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    )
    expect(box().width).toBe(584)
    await dom.act(async () => handle.dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true })))
    expect(saved()).toBeNull()
    // Re-measured at its default size (a ResizeObserver does this in a browser), it's centered again.
    await dom.act(async () => dom.window.dispatchEvent(new dom.window.Event('resize')))
    expect(panel.style.top).toBe(`${(900 - 640) / 2}px`)
  } finally {
    await dom.cleanup()
  }
})

test('a snap fills its region, refits as the screen resizes, and dragging unsnaps it', async () => {
  const { dom, panel, pointer, box, saved, resizeViewport } = await setup()
  try {
    await dom.act(async () => (panel.querySelector('header button') as HTMLButtonElement).click())
    expect(panel.dataset.snap).toBe('left')
    expect(box()).toEqual({ left: 8, top: 8, width: 588, height: 884 })
    expect(saved().snap).toBe('left')
    await resizeViewport(1000, 700)
    expect(box()).toEqual({ left: 8, top: 8, width: 488, height: 684 })
    await pointer(panel.querySelector('header')!, 'pointerdown', 100, 20)
    await pointer(panel, 'pointermove', 300, 20)
    await pointer(panel, 'pointerup', 300, 20)
    expect(panel.dataset.snap).toBe('')
    expect(saved()).toEqual({ rect: { x: 208, y: 8, w: 488, h: 684 } })
  } finally {
    await dom.cleanup()
  }
})

test('Ctrl+Option shortcuts snap the open window', async () => {
  const { dom, panel, box } = await setup()
  try {
    await dom.act(async () =>
      dom.window.document.dispatchEvent(
        new dom.window.KeyboardEvent('keydown', { code: 'KeyG', ctrlKey: true, altKey: true, bubbles: true })
      )
    )
    expect(panel.dataset.snap).toBe('right-third')
    expect(box().left + box().width).toBe(1192)
  } finally {
    await dom.cleanup()
  }
})

test('an on-screen keyboard shrinks and lifts a placed window, which regrows without losing its draft or focus', async () => {
  const { dom, panel, box, resizeViewport } = await setup({ initial: { rect: { x: 300, y: 160, w: 600, h: 672 } } })
  try {
    const input = panel.querySelector('textarea')!
    await dom.act(async () => input.focus())
    await resizeViewport(1200, 300, 100)
    expect(box()).toEqual({ left: 300, top: 108, width: 600, height: 284 })
    await resizeViewport(1200, 900, 0)
    expect(box()).toEqual({ left: 300, top: 160, width: 600, height: 672 })
    expect(panel.querySelector('textarea')).toBe(input)
    expect(input.value).toBe('Keep this draft')
    expect(dom.window.document.activeElement).toBe(input)
  } finally {
    await dom.cleanup()
  }
})

test('the live-voice command bar follows a free placement with its own size', async () => {
  const { dom, panel, pointer, saved } = await setup({
    small: true,
    initial: { rect: { x: 1100, y: 40, w: 500, h: 400 } },
  })
  try {
    // Moved (not resized) to stay on screen at its own 256px width.
    expect(panel.style.left).toBe(`${1200 - 256 - 8}px`)
    expect(panel.style.top).toBe('40px')
    expect(panel.style.width).toBe('')
    await pointer(panel.querySelector('header')!, 'pointerdown', 1000, 50)
    await pointer(panel, 'pointermove', 500, 300)
    await pointer(panel, 'pointerup', 500, 300)
    // Its position is shared with the window, which keeps its own size for when it expands.
    expect(saved()).toEqual({ rect: { x: 436, y: 290, w: 500, h: 400 } })
  } finally {
    await dom.cleanup()
  }
})

test('the live-voice command bar ignores a snap and uses the command-center anchor', async () => {
  const { dom, panel } = await setup({ small: true, initial: { snap: 'full' } })
  try {
    expect(panel.style.left).toBe(`${(1200 - 256) / 2}px`)
    expect(panel.style.top).toBe('160px')
    expect(panel.style.width).toBe('')
  } finally {
    await dom.cleanup()
  }
})
