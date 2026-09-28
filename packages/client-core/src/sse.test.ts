import { describe, expect, test } from 'bun:test'
import type { StreamEvent } from '@ficus/shared'
import { parseSSEStream } from './sse'

function readerFromText(text: string): ReadableStreamDefaultReader<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text))
      controller.close()
    },
  }).getReader()
}

describe('parseSSEStream', () => {
  test('does not insert a timer delay between every buffered text delta', async () => {
    const eventCount = 25
    const payload = Array.from({ length: eventCount }, (_, index) => {
      return `event: message\ndata: ${JSON.stringify({ type: 'text', text: String(index) })}\n\n`
    }).join('')
    const events: string[] = []
    let timerCalls = 0
    const originalSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      timerCalls += 1
      if (typeof handler === 'function') handler(...args)
      return 0 as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof setTimeout

    try {
      await parseSSEStream(readerFromText(payload), {
        onEvent: (event) => {
          if (event.type === 'text') events.push(event.text)
        },
      })
    } finally {
      globalThis.setTimeout = originalSetTimeout
    }

    expect(events).toHaveLength(eventCount)
    expect(timerCalls).toBeLessThan(5)
  })
})

describe('parseSSEStream — catchup batching', () => {
  test('delivers a catchup frame as one batch to onCatchup when provided', async () => {
    const events: StreamEvent[] = [
      { type: 'text', text: 'a', streamGroupId: 'S' },
      { type: 'text', text: 'b', streamGroupId: 'S' },
    ]
    const frame = `event: catchup\ndata: ${JSON.stringify({ events })}\n\n`
    const batches: StreamEvent[][] = []
    const singles: StreamEvent[] = []
    await parseSSEStream(readerFromText(frame), {
      onEvent: (e) => singles.push(e),
      onCatchup: (b) => batches.push(b),
    })
    expect(batches).toHaveLength(1)
    expect(batches[0]).toHaveLength(2)
    expect(singles).toHaveLength(0) // not double-delivered
  })

  test('without onCatchup, catchup events still flow through onEvent (back-compat)', async () => {
    const events: StreamEvent[] = [{ type: 'text', text: 'a', streamGroupId: 'S' }]
    const frame = `event: catchup\ndata: ${JSON.stringify({ events })}\n\n`
    const singles: StreamEvent[] = []
    await parseSSEStream(readerFromText(frame), { onEvent: (e) => singles.push(e) })
    expect(singles).toHaveLength(1)
  })
})

describe('parser cancellation', () => {
  test('abort during a parser yield suppresses every remaining decoded frame', async () => {
    const controller = new AbortController()
    const realSetTimeout = globalThis.setTimeout
    const events: string[] = []
    let yields = 0
    globalThis.setTimeout = ((fn: () => void) => {
      yields++
      controller.abort()
      return realSetTimeout(fn, 0)
    }) as typeof setTimeout
    try {
      const frames = Array.from({ length: 101 }, () => 'data: {"type":"text","text":"x","streamGroupId":"S"}\n\n').join(
        ''
      )
      await parseSSEStream(
        readerFromText(frames + 'event: done\ndata: \n\n'),
        {
          onEvent: (event) => events.push(event.type),
          onDone: () => events.push('done'),
        },
        controller.signal
      )
      expect(yields).toBe(1)
      expect(events.length).toBeLessThanOrEqual(100)
      expect(events).not.toContain('done')
    } finally {
      globalThis.setTimeout = realSetTimeout
    }
  })

  test('fallback catchup dispatch stops when a consumer aborts mid-batch', async () => {
    const controller = new AbortController()
    const seen: string[] = []
    await parseSSEStream(
      readerFromText('event: catchup\ndata: {"events":[{"type":"flush_agent"},{"type":"error","message":"old"}]}\n\n'),
      {
        onEvent: (event) => {
          seen.push(event.type)
          controller.abort()
        },
      },
      controller.signal
    )
    expect(seen).toEqual(['flush_agent'])
  })
})
