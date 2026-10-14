import { expect, test } from 'bun:test'
import { acquireDomHarness } from '../test/domHarness'
import { Modal, VIEWPORT_MODAL_HEIGHT } from './Modal'

async function renderModal(size?: 'default' | 'viewport' | 'content') {
  const dom = await acquireDomHarness({})
  const rendered = dom.createRoot()
  await dom.act(async () =>
    rendered.root.render(
      <Modal isOpen onClose={() => undefined} title="Layout probe" size={size}>
        Content
      </Modal>
    )
  )
  return { dom, rendered, panel: dom.window.document.querySelector<HTMLElement>('[data-modal-size]')! }
}

test('default modal has no viewport geometry', async () => {
  const { dom, panel } = await renderModal()
  try {
    expect(panel.dataset.modalSize).toBe('default')
    const style = panel.getAttribute('style') ?? ''
    expect(style).not.toContain(VIEWPORT_MODAL_HEIGHT)
    expect(style).not.toContain('calc(100vw - 2rem)')
  } finally {
    await dom.cleanup()
  }
})

test('viewport modal applies observable viewport geometry', async () => {
  const { dom, panel } = await renderModal('viewport')
  try {
    expect(panel.dataset.modalSize).toBe('viewport')
    // Happy DOM drops dvh/env() from CSSStyleDeclaration properties but preserves the
    // rendered style attribute, which proves Modal actually applies its selected map.
    const style = panel.getAttribute('style') ?? ''
    expect(style).toContain(VIEWPORT_MODAL_HEIGHT)
    expect(style).toContain('calc(100vw - 2rem)')
  } finally {
    await dom.cleanup()
  }
})

test('content modal shrinks to what it shows and stays inside the viewport', async () => {
  const { dom, panel } = await renderModal('content')
  try {
    expect(panel.dataset.modalSize).toBe('content')
    const style = panel.getAttribute('style') ?? ''
    // Inline width beats the panel's `w-full`, so the dialog is only as wide as its content.
    expect(style).toContain('width: auto')
    expect(style).toContain(`max-height: ${VIEWPORT_MODAL_HEIGHT}`)
    expect(style).toContain('max-width: calc(100vw - 2rem)')
  } finally {
    await dom.cleanup()
  }
})

for (const mobileFullscreen of [false, true])
  test(`modal (fullscreen=${mobileFullscreen}) follows keyboard viewport changes and removes its listeners on close`, async () => {
    const dom = await acquireDomHarness({})
    const previous = Object.getOwnPropertyDescriptor(window, 'visualViewport')
    const viewport = new dom.window.EventTarget()
    Object.assign(viewport, { height: 812, offsetTop: 0 })
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport })
    try {
      const { root } = dom.createRoot()
      await dom.act(async () =>
        root.render(
          <Modal isOpen mobileFullscreen={mobileFullscreen} title="Chat" onClose={() => undefined}>
            Conversation
          </Modal>
        )
      )
      const overlay = dom.window.document.querySelector<HTMLElement>('[role="dialog"]')!
      expect(overlay.style.getPropertyValue('--modal-viewport-height')).toBe('812px')
      Object.assign(viewport, { height: 420, offsetTop: 22 })
      viewport.dispatchEvent(new dom.window.Event('resize'))
      expect(overlay.style.getPropertyValue('--modal-viewport-height')).toBe('420px')
      expect(overlay.style.getPropertyValue('--modal-viewport-top')).toBe('22px')
      await dom.act(async () => root.unmount())
      Object.assign(viewport, { height: 812 })
      viewport.dispatchEvent(new dom.window.Event('resize'))
      expect(overlay.style.getPropertyValue('--modal-viewport-height')).toBe('420px')
    } finally {
      if (previous) Object.defineProperty(window, 'visualViewport', previous)
      else Reflect.deleteProperty(window, 'visualViewport')
      await dom.cleanup()
    }
  })

test('a never-opened modal renders no portal in a static render even when a DOM is available', async () => {
  const dom = await acquireDomHarness({})
  try {
    const { renderToStaticMarkup } = await import('react-dom/server')
    expect(
      renderToStaticMarkup(
        <Modal isOpen={false} onClose={() => undefined}>
          Closed
        </Modal>
      )
    ).toBe('')
  } finally {
    await dom.cleanup()
  }
})

test('keyboard resize reveals the focused field by scrolling dialog content, without scrolling the page', async () => {
  const dom = await acquireDomHarness({})
  const viewportDescriptor = Object.getOwnPropertyDescriptor(window, 'visualViewport')
  const ownedWindow = window
  const requestFrame = window.requestAnimationFrame
  const cancelFrame = window.cancelAnimationFrame
  const scrollTo = window.scrollTo
  const callbacks = new Map<number, FrameRequestCallback>()
  let nextFrame = 0
  let pageScrolls = 0
  window.requestAnimationFrame = (callback) => {
    callbacks.set(++nextFrame, callback)
    return nextFrame
  }
  window.cancelAnimationFrame = (id) => {
    callbacks.delete(id)
  }
  window.scrollTo = () => {
    pageScrolls++
  }
  const viewport = new dom.window.EventTarget()
  Object.assign(viewport, { height: 812, offsetTop: 0 })
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport })
  try {
    const { root } = dom.createRoot()
    await dom.act(async () =>
      root.render(
        <Modal isOpen title="Answer question" onClose={() => {}} footer={<button>Submit</button>}>
          <textarea aria-label="Answer" />
        </Modal>
      )
    )
    const body = document.querySelector<HTMLElement>('[data-modal-body]')!
    const input = document.querySelector('textarea')!
    body.getBoundingClientRect = () => ({ top: 60, bottom: 350, height: 290 }) as DOMRect
    input.getBoundingClientRect = () => ({ top: 490, bottom: 530, height: 40 }) as DOMRect
    await dom.act(async () => {
      input.focus()
      Object.assign(viewport, { height: 420 })
      viewport.dispatchEvent(new dom.window.Event('resize'))
      const pending = [...callbacks.values()]
      callbacks.clear()
      for (const callback of pending) callback(0)
    })
    expect(body.scrollTop).toBe(192)
    expect(pageScrolls).toBe(0)
    expect(document.activeElement).toBe(input)
  } finally {
    await dom.cleanup()
    ownedWindow.requestAnimationFrame = requestFrame
    ownedWindow.cancelAnimationFrame = cancelFrame
    ownedWindow.scrollTo = scrollTo
    if (viewportDescriptor) Object.defineProperty(ownedWindow, 'visualViewport', viewportDescriptor)
    else Reflect.deleteProperty(ownedWindow, 'visualViewport')
  }
})
