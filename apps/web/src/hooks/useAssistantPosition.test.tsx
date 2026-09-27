import { expect, spyOn, test } from 'bun:test'
import { useRef } from 'react'
import { acquireDomHarness } from '../test/domHarness'
import { dockAssistant, snapAssistant, useAssistantPosition, type AssistantCorner } from './useAssistantPosition'

test('docked assistant stays inside a resized visual viewport', () => {
  expect(dockAssistant('center', { left: 0, top: 0, width: 1200, height: 900 }, 672, 500)).toEqual({
    left: 264,
    top: 160,
  })
  expect(dockAssistant('top-center', { left: 0, top: 0, width: 1200, height: 900 }, 256, 60)).toEqual({
    left: 472,
    top: 8,
  })
  expect(dockAssistant('bottom-center', { left: 0, top: 0, width: 1200, height: 900 }, 256, 60)).toEqual({
    left: 472,
    top: 832,
  })
  expect(dockAssistant('bottom-right', { left: 0, top: 0, width: 390, height: 844 }, 256, 60)).toEqual({
    left: 126,
    top: 776,
  })
  expect(dockAssistant('bottom-right', { left: 0, top: 100, width: 390, height: 300 }, 374, 284)).toEqual({
    left: 8,
    top: 108,
  })
  expect(dockAssistant('top-left', { left: 0, top: 100, width: 390, height: 300 }, 374, 284)).toEqual({
    left: 8,
    top: 108,
  })
})

test('command-center anchor does not move as results or inline conversations change height', () => {
  const viewport = { left: 0, top: 0, width: 1200, height: 900 }
  expect(dockAssistant('center', viewport, 672, 200)).toEqual(dockAssistant('center', viewport, 672, 700))
  expect(dockAssistant('center', { left: 0, top: 100, width: 390, height: 300 }, 374, 200)).toEqual({
    left: 8,
    top: 154,
  })
})

test('dragging snaps to a corner and button interaction does not drag the assistant', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/' })
  const { root, container } = dom.createRoot()
  function Panel() {
    const ref = useRef<HTMLDivElement>(null)
    const { style, corner, setCorner: _setCorner, ...handlers } = useAssistantPosition(ref, true)
    return (
      <div ref={ref} style={style} {...handlers} data-corner={corner}>
        <div data-assistant-drag-handle>
          Drag<button>Action</button>
        </div>
      </div>
    )
  }
  try {
    await dom.act(async () => root.render(<Panel />))
    const panel = container.firstElementChild as HTMLDivElement
    panel.setPointerCapture = () => {}
    panel.hasPointerCapture = () => false
    panel.getBoundingClientRect = () =>
      ({
        left: Number.parseFloat(panel.style.left) || 500,
        top: Number.parseFloat(panel.style.top) || 80,
        width: 256,
        height: 60,
      }) as DOMRect
    const pointer = async (target: Element, type: string, x: number, y: number) => {
      const event = new dom.window.MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 })
      Object.defineProperty(event, 'pointerId', { value: 1 })
      await dom.act(async () => target.dispatchEvent(event))
    }
    const initialLeft = panel.style.left
    await pointer(panel.querySelector('button')!, 'pointerdown', 520, 90)
    await pointer(panel, 'pointermove', 30, 30)
    expect(panel.style.left).toBe(initialLeft)
    await pointer(
      panel.firstElementChild!,
      'pointerdown',
      Number.parseFloat(panel.style.left) + 20,
      Number.parseFloat(panel.style.top) + 10
    )
    await pointer(panel, 'pointermove', 30, 30)
    await pointer(panel, 'pointerup', 30, 30)
    expect(panel.dataset.corner).toBe('top-left')
    expect(panel.style.left).toBe('8px')
    expect(panel.style.top).toBe('8px')
    expect(window.localStorage.getItem('ficus-assistant-position')).toBe('top-left')
  } finally {
    await dom.cleanup()
  }
})

test('pin choices survive remounting and are restored when a mounted assistant reopens', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/' })
  const { root, container } = dom.createRoot()
  function Panel({ visible }: { visible: boolean }) {
    const ref = useRef<HTMLDivElement>(null)
    const { corner, setCorner } = useAssistantPosition(ref, visible, 'center')
    return (
      <div ref={ref} data-corner={corner}>
        <button onClick={() => setCorner('bottom-left')}>Pin</button>
      </div>
    )
  }
  try {
    await dom.act(async () => root.render(<Panel visible />))
    expect(container.firstElementChild?.getAttribute('data-corner')).toBe('center')
    expect(window.localStorage.getItem('ficus-assistant-position')).toBeNull()
    await dom.act(async () => container.querySelector('button')!.click())
    expect(window.localStorage.getItem('ficus-assistant-position')).toBe('bottom-left')
    await dom.act(async () => root.render(null))
    await dom.act(async () => root.render(<Panel visible />))
    expect(container.firstElementChild?.getAttribute('data-corner')).toBe('bottom-left')
    await dom.act(async () => root.render(<Panel visible={false} />))
    window.localStorage.setItem('ficus-assistant-position', 'top-center')
    await dom.act(async () => root.render(<Panel visible />))
    expect(container.firstElementChild?.getAttribute('data-corner')).toBe('top-center')
  } finally {
    await dom.cleanup()
  }
})

test('invalid or unavailable position storage keeps the assistant usable', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/' })
  const { root, container } = dom.createRoot()
  function Panel() {
    const ref = useRef<HTMLDivElement>(null)
    const { corner, setCorner } = useAssistantPosition(ref, true, 'center')
    return (
      <div ref={ref} data-corner={corner}>
        <button onClick={() => setCorner('bottom-right')}>Pin</button>
      </div>
    )
  }
  let read: ReturnType<typeof spyOn> | undefined
  let write: ReturnType<typeof spyOn> | undefined
  try {
    window.localStorage.setItem('ficus-assistant-position', 'invalid')
    await dom.act(async () => root.render(<Panel />))
    expect(container.firstElementChild?.getAttribute('data-corner')).toBe('center')
    await dom.act(async () => root.render(null))
    read = spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new Error('Unavailable')
    })
    write = spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('Unavailable')
    })
    await dom.act(async () => root.render(<Panel />))
    expect(container.firstElementChild?.getAttribute('data-corner')).toBe('center')
    await dom.act(async () => container.querySelector('button')!.click())
    expect(container.firstElementChild?.getAttribute('data-corner')).toBe('bottom-right')
  } finally {
    read?.mockRestore()
    write?.mockRestore()
    await dom.cleanup()
  }
})

test('center-lane drops can return to the upper-center command anchor as well as the screen edges', () => {
  const viewport = { left: 0, top: 0, width: 1200, height: 900 }
  const panel = { left: 264, top: 170, width: 672, height: 500 }
  expect(snapAssistant(viewport, panel)).toBe('center')
  expect(snapAssistant(viewport, { ...panel, top: 8 })).toBe('top-center')
  expect(snapAssistant(viewport, { ...panel, top: 392 })).toBe('bottom-center')
  expect(snapAssistant(viewport, { left: 936, top: 10, width: 256, height: 60 })).toBe('top-right')
})

test('layout mode changes dock using the final panel size without waiting for ResizeObserver', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/' })
  const { root, container } = dom.createRoot()
  function Panel({ compact }: { compact: boolean }) {
    const ref = useRef<HTMLDivElement>(null)
    const { style } = useAssistantPosition(ref, true, 'top-right', compact ? 'compact' : 'expanded')
    return (
      <div
        style={style}
        ref={(node) => {
          ref.current = node
          if (node)
            node.getBoundingClientRect = () =>
              ({ left: 0, top: 0, width: compact ? 256 : 672, height: compact ? 60 : 500 }) as DOMRect
        }}
      />
    )
  }
  try {
    await dom.act(async () => root.render(<Panel compact={false} />))
    const viewport = {
      left: window.visualViewport?.offsetLeft ?? 0,
      top: window.visualViewport?.offsetTop ?? 0,
      width: window.visualViewport?.width ?? window.innerWidth,
      height: window.visualViewport?.height ?? window.innerHeight,
    }
    await dom.act(async () => root.render(<Panel compact />))
    const panel = container.firstElementChild as HTMLDivElement
    expect(panel.style.left).toBe(`${dockAssistant('top-right', viewport, 256, 60).left}px`)
    expect(panel.style.top).toBe(`${viewport.top + 8}px`)
  } finally {
    await dom.cleanup()
  }
})

for (const corner of [
  'center',
  'top-left',
  'top-center',
  'top-right',
  'bottom-left',
  'bottom-center',
  'bottom-right',
] as AssistantCorner[]) {
  test(`${corner} assistant shrinks above the keyboard and regrows without losing its draft or focus`, async () => {
    const dom = await acquireDomHarness({
      url: 'http://localhost/',
      windowOptions: { innerWidth: 390, innerHeight: 844 },
    })
    const viewport = Object.assign(new dom.window.EventTarget(), {
      offsetLeft: 0,
      offsetTop: 0,
      width: 390,
      height: 844,
    })
    Object.defineProperty(dom.window, 'visualViewport', { configurable: true, value: viewport })
    dom.window.localStorage.setItem('ficus-assistant-position', corner)
    const { root, container } = dom.createRoot()
    function Panel() {
      const ref = useRef<HTMLDivElement>(null)
      const { style } = useAssistantPosition(ref, true, corner)
      return (
        <div
          style={style}
          ref={(node) => {
            ref.current = node
            if (node)
              node.getBoundingClientRect = () =>
                ({
                  left: Number.parseFloat(node.style.left) || 0,
                  top: Number.parseFloat(node.style.top) || 0,
                  width: 374,
                  height: Math.min(672, Number.parseFloat(node.style.maxHeight) || 672),
                }) as DOMRect
          }}
        >
          <textarea defaultValue="Keep this draft" />
        </div>
      )
    }
    // The second layout event models ResizeObserver redocking after max-height
    // changes the measured panel size (Happy DOM does not compute CSS layout).
    const update = async (height: number, offsetTop: number, event: 'resize' | 'scroll') => {
      Object.assign(viewport, { height, offsetTop })
      await dom.act(async () => viewport.dispatchEvent(new dom.window.Event(event)))
      await dom.act(async () => viewport.dispatchEvent(new dom.window.Event('resize')))
    }
    try {
      await dom.act(async () => root.render(<Panel />))
      const panel = container.firstElementChild as HTMLDivElement
      const input = panel.querySelector('textarea')!
      await dom.act(async () => input.focus())
      const originalCap = Number.parseFloat(panel.style.maxHeight)
      await update(300, 100, 'resize')
      expect(Number.parseFloat(panel.style.maxHeight)).toBeLessThanOrEqual(284)
      expect(panel.getBoundingClientRect().top).toBeGreaterThanOrEqual(108)
      expect(panel.getBoundingClientRect().top + panel.getBoundingClientRect().height).toBeLessThanOrEqual(392)
      await update(300, 40, 'scroll')
      expect(panel.getBoundingClientRect().top).toBeGreaterThanOrEqual(48)
      expect(panel.getBoundingClientRect().top + panel.getBoundingClientRect().height).toBeLessThanOrEqual(332)
      await update(844, 0, 'resize')
      expect(Number.parseFloat(panel.style.maxHeight)).toBe(originalCap)
      expect(panel.getBoundingClientRect().height).toBe(672)
      expect(panel.querySelector('textarea')).toBe(input)
      expect(input.value).toBe('Keep this draft')
      expect(dom.window.document.activeElement).toBe(input)
    } finally {
      await dom.cleanup()
    }
  })
}
