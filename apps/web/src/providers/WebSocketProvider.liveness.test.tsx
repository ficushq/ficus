import { act } from 'react'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { acquireDomHarness } from '../test/domHarness'
import { WebSocketProvider } from './WebSocketProvider'

/**
 * The provider's console trail for a live-update stall: what it believes about
 * its socket when the window comes back, and how quiet the socket had been when
 * it closed. Timestamps come from the console itself.
 */

class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  readyState = 0
  onopen: (() => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this)
  }
  send() {}
  open() {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.()
  }
  serverMessage(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent)
  }
  serverClose(code: number, reason = '') {
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.({ code, reason } as CloseEvent)
  }
  close() {
    this.readyState = FakeWebSocket.CLOSED
  }
}

type ConsoleCall = unknown[]

describe('WebSocketProvider liveness trail', () => {
  let dom: Awaited<ReturnType<typeof acquireDomHarness>>
  let oldWebSocket: typeof globalThis.WebSocket
  let root: import('react-dom/client').Root
  const infoCalls: ConsoleCall[] = []
  const logCalls: ConsoleCall[] = []
  const originalInfo = console.info
  const originalLog = console.log

  beforeEach(async () => {
    FakeWebSocket.instances = []
    infoCalls.length = 0
    logCalls.length = 0
    oldWebSocket = globalThis.WebSocket
    dom = await acquireDomHarness({ url: 'http://localhost/' })
    globalThis.WebSocket = FakeWebSocket as unknown as typeof globalThis.WebSocket
    console.info = (...args: unknown[]) => void infoCalls.push(args)
    console.log = (...args: unknown[]) => void logCalls.push(args)
    root = dom.createRoot().root
  })

  afterEach(async () => {
    console.info = originalInfo
    console.log = originalLog
    globalThis.WebSocket = oldWebSocket
    await dom.cleanup()
  })

  async function mountOpenSocket() {
    await act(async () => {
      root.render(
        <WebSocketProvider getUrl={async () => 'ws://test/ws'}>
          <span />
        </WebSocketProvider>
      )
      await Promise.resolve()
    })
    const socket = FakeWebSocket.instances[0]!
    await act(async () => socket.open())
    return socket
  }

  const livenessLines = () => infoCalls.filter((call) => call[0] === '[WebSocket] liveness')

  test('a window focus logs what the page believes about its open socket', async () => {
    const socket = await mountOpenSocket()
    socket.serverMessage({ type: 'event', topic: 'agents', event: 'agent.updated', data: {} })

    dom.window.dispatchEvent(new dom.window.Event('focus'))

    expect(livenessLines()).toEqual([
      [
        '[WebSocket] liveness',
        'focus',
        expect.objectContaining({
          readyState: 'open',
          openForMs: expect.any(Number),
          sinceLastMessageMs: expect.any(Number),
          visibility: 'visible',
          online: true,
          reconnectPending: false,
        }),
      ],
    ])
  })

  test('the disconnect line says how long the socket lived, how quiet it had been and when it retries', async () => {
    const socket = await mountOpenSocket()

    await act(async () => socket.serverClose(1006))

    const disconnected = logCalls.filter((call) => call[0] === '[WebSocket] Disconnected')
    expect(disconnected).toHaveLength(1)
    expect(disconnected[0]![1]).toEqual({
      code: 1006,
      reason: '',
      openForMs: expect.any(Number),
      sinceLastMessageMs: null,
      reconnectInMs: 1000,
    })

    dom.window.dispatchEvent(new dom.window.Event('focus'))
    expect(livenessLines().at(-1)![2]).toEqual(
      expect.objectContaining({ readyState: 'closed', reconnectPending: true })
    )
  })

  test('an unmounted provider logs nothing more', async () => {
    await mountOpenSocket()
    await act(async () => root.unmount())

    dom.window.dispatchEvent(new dom.window.Event('focus'))

    expect(livenessLines()).toEqual([])
  })
})
