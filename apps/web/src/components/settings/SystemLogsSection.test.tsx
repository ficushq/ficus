import { afterEach, beforeEach, expect, test } from 'bun:test'
import { acquireDomHarness } from '../../test/domHarness'
import { SYSTEM_LOGS_WRAP_STORAGE_KEY, SystemLogsSection } from './SystemLogsSection'

/** Stands in for the browser WebSocket: records what the section opens and lets the test push frames. */
class FakeSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  static instances: FakeSocket[] = []
  readyState = FakeSocket.CONNECTING
  binaryType = 'blob'
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null
  closed: number | null = null
  constructor(readonly url: string) {
    FakeSocket.instances.push(this)
  }
  close(code: number) {
    this.closed = code
    this.readyState = FakeSocket.CLOSED
  }
  open() {
    this.readyState = FakeSocket.OPEN
    this.onopen?.()
  }
  send(text: string) {
    this.onmessage?.({ data: new TextEncoder().encode(text).buffer })
  }
  control(type: 'info' | 'error', message: string) {
    this.onmessage?.({ data: JSON.stringify({ type, message }) })
  }
}

const CLIENT_HEIGHT = 50
const SCROLL_PROPS = ['clientHeight', 'scrollHeight', 'scrollTop'] as const

/** Happy DOM has no layout: give elements a scroll geometry of 1px per character, clamped like a browser. */
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

const originalWebSocket = globalThis.WebSocket

beforeEach(() => {
  FakeSocket.instances = []
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket
})

afterEach(() => {
  globalThis.WebSocket = originalWebSocket
})

async function setup(storedWrap?: 'on' | 'off') {
  let restoreScrollGeometry = () => {}
  const dom = await acquireDomHarness({
    url: 'http://localhost/settings?section=system-logs',
    configureWindow: (window) => {
      restoreScrollGeometry = installScrollGeometry(window as never)
      // No backend: minting a ticket fails, and the section falls back to the session cookie.
      window.fetch = (async () => {
        throw new TypeError('offline')
      }) as unknown as typeof window.fetch
      if (storedWrap) window.localStorage.setItem(SYSTEM_LOGS_WRAP_STORAGE_KEY, storedWrap)
    },
    afterUnmount: () => restoreScrollGeometry(),
  })
  const { root } = dom.createRoot()
  await dom.act(async () => root.render(<SystemLogsSection />))
  const button = (name: string) =>
    [...document.querySelectorAll('button')].find((el) => el.textContent?.trim() === name) as
      HTMLButtonElement | undefined
  const click = (name: string) => dom.act(async () => button(name)!.click())
  const views = () => [...document.querySelectorAll<HTMLElement>('[role="log"]')]
  const view = () => views()[0]!
  const rows = () => [...view().querySelectorAll<HTMLElement>('.ficus-log-line')]
  /** Let the section's animation-frame flush run. */
  const nextFrame = () => dom.act(() => new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve())))
  const connect = async () => {
    await click('Connect')
    await dom.act(async () => {
      for (let i = 0; i < 5 && FakeSocket.instances.length === 0; i++) await Promise.resolve()
    })
    const socket = FakeSocket.instances.at(-1)!
    await dom.act(async () => socket.open())
    return socket
  }
  const stream = async (socket: FakeSocket, text: string) => {
    await dom.act(async () => socket.send(text))
    await nextFrame()
  }
  const typeSearch = (value: string) =>
    dom.act(async () => {
      const input = document.querySelector<HTMLInputElement>('input[aria-label="Search logs"]')!
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, value)
      input.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
  const pressSearchKey = (key: string, shiftKey = false) =>
    dom.act(async () => {
      const input = document.querySelector<HTMLInputElement>('input[aria-label="Search logs"]')!
      input.dispatchEvent(new window.KeyboardEvent('keydown', { key, shiftKey, bubbles: true }))
    })
  return { dom, button, click, views, view, rows, nextFrame, connect, stream, typeSearch, pressSearchKey }
}

test('streams lines into the pane with the component, timestamp and level marked', async () => {
  const ui = await setup()
  try {
    expect(ui.view().textContent).toContain('Connect to stream the latest log lines.')
    const socket = await ui.connect()
    expect(socket.url).toEndWith('/ws/system/logs?tailLines=500')
    expect(document.body.textContent).toContain('connected')
    await ui.dom.act(async () => socket.control('info', 'Streaming system logs via pm2'))
    await ui.stream(socket, '[api] 2026-11-20T09:07:56.347Z [http]   --> GET /api/agents 500 133ms\n[wor')
    await ui.stream(socket, 'ker] 2026-11-20T09:07:57.000Z [scheduler] tick\n[api] Warning: slow')

    const rows = ui.rows()
    expect(rows.map((row) => row.textContent)).toEqual([
      '[Streaming system logs via pm2]',
      '[api] 2026-11-20T09:07:56.347Z [http]   --> GET /api/agents 500 133ms',
      '[worker] 2026-11-20T09:07:57.000Z [scheduler] tick',
      '[api] Warning: slow',
    ])
    expect(rows[0].className).toContain('ficus-log-line-control')
    expect(rows[1].className).toContain('ficus-log-line-error')
    expect(rows[1].querySelector('.ficus-log-component-api')?.textContent).toBe('[api] ')
    expect(rows[1].querySelector('.ficus-log-timestamp')?.textContent).toBe('2026-11-20T09:07:56.347Z')
    expect(rows[2].className).not.toContain('ficus-log-line-error')
    expect(rows[2].querySelector('.ficus-log-component-worker')).not.toBeNull()
    expect(rows[3].className).toContain('ficus-log-line-warn')

    // Reconnecting starts a clean stream.
    await ui.click('Reconnect')
    expect(socket.closed).toBe(1000)
    expect(ui.rows()).toHaveLength(0)
  } finally {
    await ui.dom.cleanup()
  }
})

test('the wrap toggle switches the pane to horizontal scrolling and is remembered', async () => {
  const ui = await setup('off')
  try {
    const checkbox = () =>
      [...document.querySelectorAll('label')]
        .find((label) => label.textContent?.trim() === 'Wrap lines')!
        .querySelector('input')!
    expect(checkbox().checked).toBe(false)
    expect(ui.view().dataset.wrap).toBe('off')
    expect(ui.view().className).toContain('ficus-log-nowrap')
    await ui.dom.act(async () => checkbox().click())
    expect(ui.view().dataset.wrap).toBe('on')
    expect(ui.view().className).toContain('ficus-log-wrap')
    expect(window.localStorage.getItem(SYSTEM_LOGS_WRAP_STORAGE_KEY)).toBe('on')
  } finally {
    await ui.dom.cleanup()
  }
})

test('search highlights every match and Enter, Previous and Next move the active one', async () => {
  const ui = await setup()
  try {
    const socket = await ui.connect()
    await ui.stream(socket, '[api] boom one\n[api] fine\n[worker] BOOM two boom\n')
    await ui.typeSearch('boom')
    const counter = () => [...document.querySelectorAll('span')].find((el) => /\d+$/.test(el.textContent ?? ''))
    expect(ui.view().querySelectorAll('mark.ficus-log-match')).toHaveLength(3)
    expect(counter()?.textContent).toBe('– / 3')
    const active = () => ui.view().querySelector('[data-active-match]')?.closest('.ficus-log-line')?.textContent

    // Enter starts from the newest match, like the terminal search did.
    await ui.pressSearchKey('Enter')
    expect(counter()?.textContent).toBe('3 / 3')
    expect(active()).toBe('[worker] BOOM two boom')
    await ui.click('Previous')
    expect(counter()?.textContent).toBe('2 / 3')
    await ui.click('Next')
    await ui.click('Next')
    expect(counter()?.textContent).toBe('1 / 3')
    expect(active()).toBe('[api] boom one')

    await ui.typeSearch('nothing here')
    expect(counter()).toBeUndefined()
    expect(document.body.textContent).toContain('No matches')
    expect(ui.button('Next')!.disabled).toBe(true)
  } finally {
    await ui.dom.cleanup()
  }
})

test('scrolling up pauses following and Jump to latest counts new lines and resumes', async () => {
  const ui = await setup()
  try {
    const socket = await ui.connect()
    await ui.stream(socket, Array.from({ length: 20 }, (_, i) => `[api] line ${i}\n`).join(''))
    const box = ui.view()
    const bottom = () => box.scrollHeight - box.clientHeight
    expect(box.scrollTop).toBe(bottom())
    expect(ui.button('Jump to latest')).toBeUndefined()

    await ui.dom.act(async () => {
      box.scrollTop = 0
      box.dispatchEvent(new window.Event('scroll'))
    })
    await ui.stream(socket, '[api] new a\n[api] new b\n')
    expect(box.scrollTop).toBe(0)
    const jump = [...document.querySelectorAll('button')].find((el) => el.textContent?.includes('Jump to latest'))!
    expect(jump.textContent).toContain('2 new')

    await ui.dom.act(async () => jump.click())
    expect(box.scrollTop).toBe(bottom())
    expect([...document.querySelectorAll('button')].some((el) => el.textContent?.includes('Jump to latest'))).toBe(
      false
    )
    await ui.stream(socket, '[api] new c\n')
    expect(box.scrollTop).toBe(bottom())
  } finally {
    await ui.dom.cleanup()
  }
})

test('full screen moves the same log into a dialog and Escape brings it back', async () => {
  const ui = await setup()
  try {
    const socket = await ui.connect()
    await ui.stream(socket, '[api] kept across modes\n')
    await ui.click('Full screen')
    const dialog = document.querySelector('[role="dialog"][aria-label="Logs"]')!
    expect(dialog).not.toBeNull()
    expect(ui.views()).toHaveLength(1)
    expect(dialog.contains(ui.view())).toBe(true)
    expect(ui.view().textContent).toContain('kept across modes')
    expect(document.body.textContent).toContain('The logs are open in full screen.')
    expect(ui.button('Exit full screen')).toBeDefined()

    await ui.dom.act(async () => {
      window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(ui.views()).toHaveLength(1)
    expect(dialog.contains(ui.view())).toBe(false)
    expect(ui.view().textContent).toContain('kept across modes')
    expect(socket.closed).toBeNull()
  } finally {
    await ui.dom.cleanup()
  }
})
