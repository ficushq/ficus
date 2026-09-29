import { expect, test } from 'bun:test'
import { useRef } from 'react'
import { acquireDomHarness } from '../test/domHarness'
import { dockAssistant } from './useAssistantPosition'
import { assistantResizeHandle, resizeAssistant, useAssistantSize } from './useAssistantSize'

const viewport = { left: 0, top: 0, width: 1200, height: 900 }

test('the resize handle takes the corner opposite the pin', () => {
  expect(assistantResizeHandle('top-left')).toEqual({ corner: 'bottom-right', horizontal: 1, vertical: 1 })
  expect(assistantResizeHandle('top-right')).toEqual({ corner: 'bottom-left', horizontal: -1, vertical: 1 })
  expect(assistantResizeHandle('bottom-left')).toEqual({ corner: 'top-right', horizontal: 1, vertical: -1 })
  expect(assistantResizeHandle('bottom-right')).toEqual({ corner: 'top-left', horizontal: -1, vertical: -1 })
  // Center-lane docks grow on both sides.
  expect(assistantResizeHandle('center')).toEqual({ corner: 'bottom-right', horizontal: 2, vertical: 1 })
  expect(assistantResizeHandle('top-center')).toEqual({ corner: 'bottom-right', horizontal: 2, vertical: 1 })
  expect(assistantResizeHandle('bottom-center')).toEqual({ corner: 'top-right', horizontal: 2, vertical: -1 })
})

test('resizing keeps the pinned edges and the center line where they were', () => {
  const start = { width: 672, height: 500 }
  const before = {
    right: dockAssistant('bottom-right', viewport, start.width, start.height),
    center: dockAssistant('center', viewport, start.width, start.height),
  }

  // Dragging a bottom-right dock's top-left handle up and left grows it toward the pointer.
  const grown = resizeAssistant('bottom-right', start, -100, -50, viewport)
  expect(grown).toEqual({ width: 772, height: 550 })
  const right = dockAssistant('bottom-right', viewport, grown.width, grown.height)
  expect(right.left + grown.width).toBe(before.right.left + start.width)
  expect(right.top + grown.height).toBe(before.right.top + start.height)

  // A centered dock widens on both sides and keeps its top anchor.
  const wide = resizeAssistant('center', start, 60, 40, viewport)
  expect(wide).toEqual({ width: 792, height: 540 })
  const center = dockAssistant('center', viewport, wide.width, wide.height)
  expect(center.left + wide.width / 2).toBe(before.center.left + start.width / 2)
  expect(center.top).toBe(before.center.top)
})

test('resizing clamps to a usable minimum and to the viewport', () => {
  const start = { width: 672, height: 500 }
  expect(resizeAssistant('top-left', start, -1000, -1000, viewport)).toEqual({ width: 320, height: 280 })
  expect(resizeAssistant('top-left', start, 5000, 5000, viewport)).toEqual({ width: 1184, height: 884 })
})

test('dragging the handle resizes and persists, arrow keys nudge, and double-click resets', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/' })
  const { root, container } = dom.createRoot()
  function Panel() {
    const ref = useRef<HTMLDivElement>(null)
    const { size, handle } = useAssistantSize(ref, 'bottom-right')
    return (
      <div ref={ref} style={size ? { width: size.width, height: size.height } : undefined}>
        <button aria-label="Resize assistant" {...handle} />
      </div>
    )
  }
  try {
    window.localStorage.removeItem('ficus-assistant-size')
    await dom.act(async () => root.render(<Panel />))
    const panel = container.firstElementChild as HTMLDivElement
    const handle = panel.querySelector('button')!
    handle.setPointerCapture = () => {}
    handle.hasPointerCapture = () => false
    panel.getBoundingClientRect = () =>
      ({
        width: Number.parseFloat(panel.style.width) || 672,
        height: Number.parseFloat(panel.style.height) || 500,
      }) as DOMRect
    const pointer = async (type: string, x: number, y: number) => {
      const event = new dom.window.MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 })
      Object.defineProperty(event, 'pointerId', { value: 1 })
      await dom.act(async () => handle.dispatchEvent(event))
    }

    await pointer('pointerdown', 100, 100)
    await pointer('pointermove', 40, 70)
    expect(panel.style.width).toBe('732px')
    expect(panel.style.height).toBe('530px')
    expect(window.localStorage.getItem('ficus-assistant-size')).toBeNull()
    await pointer('pointerup', 40, 70)
    expect(JSON.parse(window.localStorage.getItem('ficus-assistant-size')!)).toEqual({ width: 732, height: 530 })

    // The handle sits on the left edge of a right-pinned dock, so ArrowLeft grows it.
    await dom.act(async () =>
      handle.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    )
    expect(panel.style.width).toBe('748px')

    await dom.act(async () => root.render(null))
    await dom.act(async () => root.render(<Panel />))
    const remounted = container.firstElementChild as HTMLDivElement
    expect(remounted.style.width).toBe('748px')

    await dom.act(async () =>
      remounted.querySelector('button')!.dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true }))
    )
    expect(remounted.style.width).toBe('')
    expect(window.localStorage.getItem('ficus-assistant-size')).toBeNull()
  } finally {
    window.localStorage.removeItem('ficus-assistant-size')
    await dom.cleanup()
  }
})
