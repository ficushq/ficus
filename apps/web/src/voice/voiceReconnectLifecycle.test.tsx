import { expect, test } from 'bun:test'
import { acquireDomHarness } from '../test/domHarness'
import { RealtimeTransport, type TransportCallbacks, type RealtimeSessionConfig } from './realtimeTransport'
import { useRealtimeVoiceAssistant, type UseRealtimeVoiceAssistantReturn } from './useRealtimeVoiceAssistant'

const config: RealtimeSessionConfig = {
  model: 'test',
  instructions: '',
  tools: [],
  output_modalities: ['audio'],
  tool_choice: 'auto',
  audio: { input: { turn_detection: null } },
}

test('automatic reconnection preserves browser timer receivers, has a finite retry budget, and cancels on disconnect', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/' })
  const originalSet = globalThis.setTimeout
  const originalClear = globalThis.clearTimeout
  // Firefox accepts the global receiver (or an unbound call), but rejects timer-holder objects.
  globalThis.setTimeout = function (this: unknown, ...args: Parameters<typeof setTimeout>) {
    if (this !== undefined && this !== globalThis && this !== window)
      throw new TypeError('setTimeout requires Window receiver')
    return originalSet(...args)
  } as typeof setTimeout
  globalThis.clearTimeout = function (this: unknown, ...args: Parameters<typeof clearTimeout>) {
    if (this !== undefined && this !== globalThis && this !== window)
      throw new TypeError('clearTimeout requires Window receiver')
    return originalClear(...args)
  } as typeof clearTimeout
  let connects = 0
  let latest!: UseRealtimeVoiceAssistantReturn<null>
  class FailedTransport extends RealtimeTransport {
    override async connect(_config: RealtimeSessionConfig, _callbacks: TransportCallbacks) {
      connects++
      throw new Error('Peer connection failed')
    }
    override disconnect() {}
  }
  const controller = {
    id: 'retry-test',
    initialState: null,
    useEnvironment: () => null,
    prepareSession: async () => ({ sessionConfig: config }),
    executeTool: async () => ({ result: null, followUp: false as const }),
  }
  function Probe() {
    latest = useRealtimeVoiceAssistant(controller, {
      autoReconnect: true,
      maxReconnectAttempts: 2,
      reconnectDelayMs: 0,
      createTransport: () => new FailedTransport(),
    })
    return <span>{latest.status}</span>
  }
  try {
    const { root } = dom.createRoot()
    await dom.act(async () => root.render(<Probe />))
    await dom.act(async () => latest.connect())
    for (let i = 0; i < 6; i++)
      await dom.act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10))
      })
    expect(connects).toBe(3)
    expect(latest.status).toBe('error')
    await dom.act(async () => {
      await latest.connect()
      latest.disconnect()
    })
    for (let i = 0; i < 3; i++)
      await dom.act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10))
      })
    expect(connects).toBe(4)
    expect(latest.status).toBe('idle')
  } finally {
    // These are the harness window's timers: put them back while it is still installed, and let
    // cleanup restore the process's own.
    globalThis.setTimeout = originalSet
    globalThis.clearTimeout = originalClear
    await dom.cleanup()
  }
})
