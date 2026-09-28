import { describe, expect, test } from 'bun:test'
import type { StreamEvent } from '@ficus/shared'
import { agentsResource } from './agents'
import type { Transport, RequestOptions } from '../transport'

function mockTransport(responder?: (path: string, options?: RequestOptions) => unknown) {
  const calls: Array<{ path: string; options?: RequestOptions }> = []
  const t: Transport = {
    request: async <T>(path: string, options?: RequestOptions) => {
      calls.push({ path, options })
      return (responder?.(path, options) ?? { success: true }) as T
    },
    openStream: async (path: string, options?: RequestOptions) => {
      calls.push({ path, options })
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close()
        },
      }).getReader()
    },
    wsUrl: (path: string) => `ws://test${path}`,
    url: (path: string) => `http://test/api${path}`,
  }
  return { t, calls }
}

function streamReaderFromSse(chunks: string[]): ReadableStreamDefaultReader<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  }).getReader()
}

describe('agentsResource listAgents filters', () => {
  test('listAgents passes parentAgentId to fetch child subagents', async () => {
    const { t, calls } = mockTransport(() => [])

    await agentsResource(t).listAgents({ parentAgentId: 'agt-parent' })

    expect(calls[0].path).toBe('/agents?parentAgentId=agt-parent')
  })

  test('listAgents with no filters hits /agents with no query', async () => {
    const { t, calls } = mockTransport(() => [])

    await agentsResource(t).listAgents()

    expect(calls[0].path).toBe('/agents')
  })
})

describe('agentsResource continuation methods', () => {
  test('continues one exact halted agent', async () => {
    const { t, calls } = mockTransport(() => ({ resumed: true }))

    await agentsResource(t).continueAgent('agt-1')

    expect(calls[0]).toEqual({ path: '/agents/agt-1/continue', options: { method: 'POST' } })
  })

  test('continues exactly the submitted halted action IDs', async () => {
    const { t, calls } = mockTransport(() => ({
      resumed: 1,
      resumedActionIds: ['agent-error:agt-1'],
      staleActionIds: [],
    }))

    await agentsResource(t).continueHaltedActions(['agent-error:agt-1'])

    expect(calls[0]).toEqual({
      path: '/agents/continue-halted',
      options: { method: 'POST', body: { actionIds: ['agent-error:agt-1'] } },
    })
  })
})

describe('agentsResource live execution methods', () => {
  test('getActiveExecution fetches the active execution endpoint', async () => {
    const { t, calls } = mockTransport(() => ({
      active: true,
      executionId: 'exec-1',
      agentId: 'agt-1',
      status: 'running',
    }))

    const result = await agentsResource(t).getActiveExecution('agt-1')

    expect(calls[0].path).toBe('/agents/agt-1/active')
    expect(result).toEqual({ active: true, executionId: 'exec-1', agentId: 'agt-1', status: 'running' })
  })

  test('subscribeToAgentStream follows an exact execution when provided', async () => {
    const calls: string[] = []
    const t = mockTransport().t
    t.openStream = async (path) => {
      calls.push(path)
      return streamReaderFromSse(['event: done\ndata: \n\n'])
    }
    await new Promise<void>((resolve) => {
      agentsResource(t).subscribeToAgentStream('agt-1', { onEvent: () => {}, onDone: resolve }, 'exec-1')
    })
    expect(calls).toEqual(['/agents/agt-1/executions/exec-1/stream'])
  })

  test('terminal exact snapshot closes without reconnecting', async () => {
    let opens = 0
    const t = mockTransport().t
    t.openStream = async () => {
      opens += 1
      return streamReaderFromSse([
        'data: {"type":"execution_snapshot","executionId":"exec-1","executionVersion":3,"status":"completed"}\n\n',
      ])
    }
    let disconnects = 0
    await new Promise<void>((resolve) => {
      agentsResource(t).subscribeToAgentStream(
        'agt-1',
        { onEvent: () => {}, onDisconnect: () => (disconnects += 1), onDone: resolve },
        'exec-1'
      )
    })
    expect(opens).toBe(1)
    expect(disconnects).toBe(0)
  })

  test('terminal snapshot plus done frame delivers completion exactly once', async () => {
    const t = mockTransport().t
    t.openStream = async () =>
      streamReaderFromSse([
        'data: {"type":"execution_snapshot","executionId":"exec-1","executionVersion":3,"status":"completed"}\n\n',
        'event: done\ndata: \n\n',
      ])
    let dones = 0
    await new Promise<void>((resolve) => {
      agentsResource(t).subscribeToAgentStream(
        'agt-1',
        {
          onEvent: () => {},
          onDone: () => {
            dones += 1
            resolve()
          },
        },
        'exec-1'
      )
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(dones).toBe(1)
  })

  test('unsubscribe during retry delay prevents reconnect and terminal callbacks', async () => {
    let opens = 0
    let releaseRetry: (() => void) | undefined
    const realSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = ((callback: () => void) => {
      releaseRetry = callback
      return 1 as unknown as ReturnType<typeof setTimeout>
    }) as typeof setTimeout
    try {
      const t = mockTransport().t
      t.openStream = async () => {
        opens += 1
        throw new Error('transport frozen')
      }
      let disconnect!: () => void
      const disconnected = new Promise<void>((resolve) => (disconnect = resolve))
      let errors = 0
      let dones = 0
      const unsubscribe = agentsResource(t).subscribeToAgentStream('agt-1', {
        onEvent: () => {},
        onDisconnect: disconnect,
        onError: () => (errors += 1),
        onDone: () => (dones += 1),
      })
      await disconnected
      unsubscribe()
      releaseRetry?.()
      await Promise.resolve()

      expect(opens).toBe(1)
      expect(errors).toBe(0)
      expect(dones).toBe(0)
    } finally {
      globalThis.setTimeout = realSetTimeout
    }
  })

  test('subscribeToAgentStream opens the reconnectable agent stream endpoint', async () => {
    const calls: Array<{ path: string; options?: RequestOptions }> = []
    const events: StreamEvent[] = []
    let done = false
    const t: Transport = {
      request: async <T>() => ({ success: true }) as T,
      openStream: async (path, options) => {
        calls.push({ path, options })
        return streamReaderFromSse(['data: {"type":"text","text":"hello"}\n\n', 'event: done\ndata: \n\n'])
      },
      wsUrl: (path: string) => `ws://test${path}`,
      url: (path: string) => `http://test/api${path}`,
    }

    await new Promise<void>((resolve) => {
      agentsResource(t).subscribeToAgentStream('agt-1', {
        onEvent: (event) => events.push(event),
        onDone: () => {
          done = true
          resolve()
        },
      })
    })

    expect(calls[0].path).toBe('/agents/agt-1/stream')
    expect(calls[0].options?.method).toBe('GET')
    expect(calls[0].options?.signal).toBeInstanceOf(AbortSignal)
    expect(events).toEqual([{ type: 'text', text: 'hello' }])
    expect(done).toBe(true)
  })
})

describe('agentsResource catchup forwarding', () => {
  test('onCatchup receives catchup batch and catchup events do NOT arrive via onEvent', async () => {
    const catchupBatches: Array<Array<{ type: string; text?: string; streamGroupId?: string }>> = []
    const singleEvents: Array<{ type: string }> = []

    const catchupFrame = 'event: catchup\ndata: {"events":[{"type":"text","text":"a","streamGroupId":"S"}]}\n\n'
    const doneFrame = 'event: done\ndata: \n\n'

    const t: Transport = {
      request: async <T>() => ({ success: true }) as T,
      openStream: async () => streamReaderFromSse([catchupFrame, doneFrame]),
      wsUrl: (path: string) => `ws://test${path}`,
      url: (path: string) => `http://test/api${path}`,
    }

    await new Promise<void>((resolve) => {
      agentsResource(t).subscribeToAgentStream('a1', {
        onEvent: (event) => singleEvents.push(event),
        onCatchup: (events) =>
          catchupBatches.push(events as Array<{ type: string; text?: string; streamGroupId?: string }>),
        onDone: () => resolve(),
      })
    })

    expect(catchupBatches).toHaveLength(1)
    expect(catchupBatches[0]).toEqual([{ type: 'text', text: 'a', streamGroupId: 'S' }])
    expect(singleEvents).toHaveLength(0) // no double-delivery
  })
})

describe('agentsResource message methods', () => {
  test('getMessage fetches one durable message in its agent scope', async () => {
    const { t, calls } = mockTransport()

    await agentsResource(t).getMessage('agt-1', 'msg-1')

    expect(calls[0].path).toBe('/agents/agt-1/messages/msg-1')
  })

  test('sendMessage POSTs to /agents/:id/message with deliveryMode intent', async () => {
    const { t, calls } = mockTransport(() => ({ success: true, status: 'queued' }))
    const result = await agentsResource(t).sendMessage('agt-1', 'stop and look', {
      imageIds: ['img-1'],
      deliveryMode: 'steer',
    })

    expect(result).toEqual({ success: true, status: 'queued' })
    expect(calls[0].path).toBe('/agents/agt-1/message')
    expect(calls[0].options?.method).toBe('POST')
    expect(calls[0].options?.body).toEqual({ content: 'stop and look', imageIds: ['img-1'], deliveryMode: 'steer' })
  })

  test('steer POSTs to /agents/:id/steer with message + imageIds', async () => {
    const { t, calls } = mockTransport()
    await agentsResource(t).steer('agt-1', 'stop and look')
    expect(calls[0].path).toBe('/agents/agt-1/steer')
    expect(calls[0].options?.method).toBe('POST')
    expect(calls[0].options?.body).toEqual({ message: 'stop and look', imageIds: undefined })
  })

  test('followUp POSTs to /agents/:id/follow-up', async () => {
    const { t, calls } = mockTransport()
    await agentsResource(t).followUp('agt-1', 'afterwards', ['img-1'])
    expect(calls[0].path).toBe('/agents/agt-1/follow-up')
    expect(calls[0].options?.body).toEqual({ message: 'afterwards', imageIds: ['img-1'] })
  })

  test('stream opens the unified agent stream without sending another message', async () => {
    const { t, calls } = mockTransport()
    await agentsResource(t).stream('agt-1', { onEvent: () => undefined })
    expect(calls[0].path).toBe('/agents/agt-1/stream')
    expect(calls[0].options?.method).toBe('GET')
    expect(calls[0].options?.signal).toBeInstanceOf(AbortSignal)
  })

  test('clearQueue POSTs to /agents/:id/clear-queue', async () => {
    const { t, calls } = mockTransport()
    await agentsResource(t).clearQueue('agt-1')
    expect(calls[0].path).toBe('/agents/agt-1/clear-queue')
    expect(calls[0].options?.method).toBe('POST')
  })

  test('sendMessage includes clientId in the body when provided', async () => {
    const { t, calls } = mockTransport(() => ({ success: true, status: 'queued' }))
    await agentsResource(t).sendMessage('agt-1', 'hi', { clientId: 'c-1', deliveryMode: 'steer' })
    expect(calls[0].options?.body).toMatchObject({ content: 'hi', deliveryMode: 'steer', clientId: 'c-1' })
  })

  test('stopAgent posts to the stop endpoint', async () => {
    const { t, calls } = mockTransport()
    await agentsResource(t).stopAgent('agt-1')
    expect(calls[0].path).toBe('/agents/agt-1/stop')
    expect(calls[0].options?.method).toBe('POST')
  })

  test('abortTool posts to the abort-tool endpoint', async () => {
    const { t, calls } = mockTransport()
    await agentsResource(t).abortTool('agt-1')
    expect(calls[0].path).toBe('/agents/agt-1/abort-tool')
    expect(calls[0].options?.method).toBe('POST')
  })
})

describe('subscription cancellation fences buffered frames', () => {
  test('unsubscribe inside onEvent cancels the reader and suppresses buffered catchup/done/status', async () => {
    const t = mockTransport().t
    let canceled = false
    let drained!: () => void
    const opened = new Promise<void>((resolve) => {
      drained = resolve
    })
    t.openStream = async () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"type":"text","text":"one","streamGroupId":"S"}\n\n' +
                'event: catchup\ndata: {"events":[{"type":"flush_agent"}]}\n\n' +
                'event: done\ndata: \n\n'
            )
          )
        },
        cancel() {
          canceled = true
          drained()
        },
      }).getReader()
    const seen: string[] = []
    const stop = agentsResource(t).subscribeToAgentStream('a', {
      onEvent: (event) => {
        seen.push(event.type)
        stop()
      },
      onCatchup: () => seen.push('catchup'),
      onDone: () => seen.push('done'),
      onDisconnect: () => seen.push('disconnect'),
      onError: () => seen.push('error'),
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(seen).toEqual(['text'])
    expect(canceled).toBe(true)
    await opened
  })

  test('late openStream resolution after unsubscribe is canceled without callbacks', async () => {
    const t = mockTransport().t
    let resolve!: (reader: ReadableStreamDefaultReader<Uint8Array>) => void
    t.openStream = () =>
      new Promise((r) => {
        resolve = r
      })
    const seen: string[] = []
    const stop = agentsResource(t).subscribeToAgentStream('a', {
      onEvent: () => seen.push('event'),
      onDone: () => seen.push('done'),
    })
    stop()
    let canceled = false
    resolve(
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode('event: done\ndata: \n\n'))
        },
        cancel() {
          canceled = true
        },
      }).getReader()
    )
    await new Promise((r) => setTimeout(r, 10))
    expect(seen).toEqual([])
    expect(canceled).toBe(true)
  })
})

test.each(['eof', 'error'] as const)(
  'unexpected %s exhausts transport retries without emitting execution success',
  async (mode) => {
    const t = mockTransport().t
    let opens = 0
    t.openStream = async () => {
      opens++
      if (mode === 'error') throw new Error('offline')
      return streamReaderFromSse([])
    }
    const seen: string[] = []
    let finish!: () => void
    const finished = new Promise<void>((resolve) => {
      finish = resolve
    })
    const realSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = ((fn: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) =>
      realSetTimeout(fn, delay === 2000 ? 0 : delay, ...args)) as typeof globalThis.setTimeout
    let stop: (() => void) | undefined
    try {
      stop = agentsResource(t).subscribeToAgentStream('a', {
        onEvent: (event) => seen.push(event.type),
        onDone: finish,
        onError: () => seen.push('transport-error'),
      })
      await finished
      expect(opens).toBe(16)
      expect(seen).toEqual(mode === 'error' ? ['transport-error'] : [])
    } finally {
      stop?.()
      globalThis.setTimeout = realSetTimeout
    }
  }
)

test('exact execution reads forward caller cancellation without changing the route', async () => {
  const { t, calls } = mockTransport()
  const controller = new AbortController()
  await agentsResource(t).getExecution('a', 'e', controller.signal)
  expect(calls).toEqual([{ path: '/agents/a/executions/e', options: { signal: controller.signal } }])
})
