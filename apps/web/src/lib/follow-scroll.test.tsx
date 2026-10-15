import { expect, test } from 'bun:test'
import { acquireDomHarness } from '../test/domHarness'
import { agentToolRenderers, ToolArgsView, ToolResultView } from './tool-renderers'

const CLIENT_HEIGHT = 50

const SCROLL_PROPS = ['clientHeight', 'scrollHeight', 'scrollTop'] as const

/**
 * Happy DOM has no layout, so give every element a scroll geometry that grows
 * with its text (1px per character) and clamps scrollTop like a browser does.
 * Happy DOM shares element classes across windows, so this returns a restore
 * that must run when the test ends, or the patch leaks into later test files.
 */
function installScrollGeometry(window: { HTMLElement: { prototype: object } }) {
  const proto = window.HTMLElement.prototype
  const originals = SCROLL_PROPS.map((name) => [name, Object.getOwnPropertyDescriptor(proto, name)] as const)
  const tops = new WeakMap<object, number>()
  const scrollHeight = (el: HTMLElement) => Math.max(CLIENT_HEIGHT, el.textContent?.length ?? 0)
  Object.defineProperty(proto, 'clientHeight', { configurable: true, get: () => CLIENT_HEIGHT })
  Object.defineProperty(proto, 'scrollHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return scrollHeight(this)
    },
  })
  Object.defineProperty(proto, 'scrollTop', {
    configurable: true,
    get(this: HTMLElement) {
      return tops.get(this) ?? 0
    },
    set(this: HTMLElement, value: number) {
      tops.set(this, Math.max(0, Math.min(value, scrollHeight(this) - CLIENT_HEIGHT)))
    },
  })
  return () => {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(proto, name, descriptor)
      else Reflect.deleteProperty(proto, name)
    }
  }
}

function maxScrollTop(el: HTMLElement) {
  return el.scrollHeight - el.clientHeight
}

async function setup() {
  let restoreScrollGeometry = () => {}
  const dom = await acquireDomHarness({
    url: 'http://localhost/',
    configureWindow: (window) => {
      restoreScrollGeometry = installScrollGeometry(window as never)
    },
    afterUnmount: () => restoreScrollGeometry(),
  })
  const { root } = dom.createRoot()
  const box = () => document.querySelector('[data-follow-scroll]') as HTMLElement
  const followButton = () => document.querySelector('button[title="Resume auto-scroll"]') as HTMLButtonElement | null
  /** A user scroll gesture: move the box, then fire the scroll event the browser would. */
  const userScrollTo = async (top: number) =>
    dom.act(async () => {
      box().scrollTop = top
      box().dispatchEvent(new window.Event('scroll'))
    })
  return { dom, root, box, followButton, userScrollTo }
}

const bashArgs = (lines: number) =>
  JSON.stringify({ command: Array.from({ length: lines }, (_, i) => `echo line ${i}`).join('\n') })

test('streaming raw (still unparseable) args stay pinned to the bottom as text arrives in bursts', async () => {
  const { dom, root, box } = await setup()
  try {
    const full = bashArgs(60)
    // A renderer without streamingArgs shows partial JSON as the raw fallback; grow it in uneven bursts.
    for (const end of [20, 90, 95, 400, 410, full.length - 1]) {
      await dom.act(async () =>
        root.render(<ToolArgsView renderers={agentToolRenderers} toolName="read" args={full.slice(0, end)} follow />)
      )
      expect(box().textContent).toBe(full.slice(0, end))
      expect(box().scrollTop).toBe(maxScrollTop(box()))
    }
  } finally {
    await dom.cleanup()
  }
})

test('partially streamed bash args render the command and stay pinned to the bottom', async () => {
  const { dom, root, box } = await setup()
  try {
    const full = bashArgs(60)
    const command = JSON.parse(full).command as string
    for (const end of [20, 90, 95, 400, 410, full.length - 2]) {
      await dom.act(async () =>
        root.render(<ToolArgsView renderers={agentToolRenderers} toolName="bash" args={full.slice(0, end)} follow />)
      )
      // The partial command, decoded: real newlines instead of the JSON escapes.
      const shown = box().textContent!.replace(/^\$ /, '')
      expect(command.startsWith(shown)).toBe(true)
      expect(shown).not.toContain('\\n')
      expect(box().scrollTop).toBe(maxScrollTop(box()))
    }
  } finally {
    await dom.cleanup()
  }
})

test('parsed bash args follow, pause on a user scroll-up, and resume back at the bottom', async () => {
  const { dom, root, box, followButton, userScrollTo } = await setup()
  const render = (lines: number, follow = true) =>
    dom.act(async () =>
      root.render(
        <ToolArgsView renderers={agentToolRenderers} toolName="bash" args={bashArgs(lines)} follow={follow} />
      )
    )
  try {
    await render(10)
    expect(box().scrollTop).toBe(maxScrollTop(box()))
    await render(30)
    expect(box().scrollTop).toBe(maxScrollTop(box()))
    expect(followButton()).toBeNull()

    // Scrolling up pauses following: new text no longer moves the box.
    await userScrollTo(5)
    await render(50)
    expect(box().scrollTop).toBe(5)
    expect(followButton()).not.toBeNull()

    // Scrolling back down to the bottom resumes it.
    await userScrollTo(maxScrollTop(box()))
    expect(followButton()).toBeNull()
    await render(70)
    expect(box().scrollTop).toBe(maxScrollTop(box()))

    // An upward wheel pauses immediately, before the scroll lands, so a busy stream cannot snap it back.
    await dom.act(async () => {
      box().dispatchEvent(new window.WheelEvent('wheel', { deltaY: -40, bubbles: true }))
    })
    await render(80)
    expect(box().scrollTop).toBeLessThan(maxScrollTop(box()))

    // The Follow button resumes and jumps to the bottom.
    await dom.act(async () => followButton()!.click())
    expect(box().scrollTop).toBe(maxScrollTop(box()))
    await render(90)
    expect(box().scrollTop).toBe(maxScrollTop(box()))
  } finally {
    await dom.cleanup()
  }
})

test('finished args are not force-scrolled', async () => {
  const { dom, root, box } = await setup()
  try {
    await dom.act(async () =>
      root.render(<ToolArgsView renderers={agentToolRenderers} toolName="bash" args={bashArgs(40)} />)
    )
    expect(maxScrollTop(box())).toBeGreaterThan(0)
    expect(box().scrollTop).toBe(0)
  } finally {
    await dom.cleanup()
  }
})

test('bash output still follows while running and pauses on a user scroll-up', async () => {
  const { dom, root, box, followButton, userScrollTo } = await setup()
  const output = (lines: number) => Array.from({ length: lines }, (_, i) => `output ${i}`).join('\n')
  const render = (lines: number, autoScroll = true) =>
    dom.act(async () =>
      root.render(
        <ToolResultView
          renderers={agentToolRenderers}
          toolName="bash"
          result={output(lines)}
          isError={false}
          autoScroll={autoScroll}
        />
      )
    )
  try {
    await render(20)
    expect(box().scrollTop).toBe(maxScrollTop(box()))
    await userScrollTo(0)
    await render(40)
    expect(box().scrollTop).toBe(0)
    expect(followButton()).not.toBeNull()
    // Once the command finishes the Follow button goes away and nothing scrolls.
    await render(40, false)
    expect(followButton()).toBeNull()
    expect(box().scrollTop).toBe(0)
  } finally {
    await dom.cleanup()
  }
})
