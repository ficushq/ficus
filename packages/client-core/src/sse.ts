import type { StreamEvent } from '@ficus/shared'

export interface SSECallbacks {
  onEvent: (event: StreamEvent) => void
  onCatchup?: (events: StreamEvent[]) => void
  onError?: (error: Error) => void
  onDone?: () => void
}

const STREAM_YIELD_INTERVAL_MS = 16
const STREAM_YIELD_EVENT_COUNT = 100

async function yieldIfParserHasBeenBusy(state: { lastYieldAt: number; eventsSinceYield: number }): Promise<void> {
  state.eventsSinceYield += 1
  const now = Date.now()
  if (state.eventsSinceYield < STREAM_YIELD_EVENT_COUNT && now - state.lastYieldAt < STREAM_YIELD_INTERVAL_MS) {
    return
  }

  state.lastYieldAt = now
  state.eventsSinceYield = 0
  await new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * Parse an SSE response body, dispatching events to callbacks.
 * Shared between chat (inline POST stream) and agent (reconnectable GET stream),
 * and between web and mobile (both supply a byte-stream reader via Transport.openStream).
 * Moved from apps/web/src/api/sse.ts.
 */
export async function parseSSEStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  callbacks: SSECallbacks,
  signal?: AbortSignal
): Promise<void> {
  const decoder = new TextDecoder()
  let buffer = ''
  let currentEvent = ''
  const yieldState = { lastYieldAt: Date.now(), eventsSinceYield: 0 }

  // Aborting fetch cannot retract already decoded frames. Own reader cancellation too,
  // and fence dispatch after every read/yield (including catchup fallback dispatch).
  const cancel = () => {
    void reader.cancel().catch(() => {})
  }
  signal?.addEventListener('abort', cancel, { once: true })
  try {
    if (signal?.aborted) {
      cancel()
      return
    }
    while (!signal?.aborted) {
      const { done, value } = await reader.read()
      if (signal?.aborted || done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        if (signal?.aborted) return
        if (line.startsWith('event: ')) {
          currentEvent = line.slice(7)
        } else if (line.startsWith('data: ')) {
          const raw = line.slice(6)
          if (currentEvent === 'catchup') {
            const { events } = JSON.parse(raw) as { events: StreamEvent[] }
            if (callbacks.onCatchup) {
              callbacks.onCatchup(events)
            } else {
              for (const event of events) {
                if (signal?.aborted) return
                callbacks.onEvent(event)
              }
            }
          } else if (currentEvent === 'ping') {
            continue
          } else if (currentEvent === 'done' && !raw.trim()) {
            // Bare done signal (stream termination)
            callbacks.onDone?.()
            continue
          } else {
            const event = JSON.parse(raw) as StreamEvent
            callbacks.onEvent(event)
            // Give consumers occasional paint opportunities without creating a
            // typewriter-style backlog when native mobile delivers many SSE
            // deltas in one buffered chunk.
            if (event.type === 'tool_start' || event.type === 'text' || event.type === 'thinking') {
              await yieldIfParserHasBeenBusy(yieldState)
            }
          }
        }
      }
    }
  } finally {
    signal?.removeEventListener('abort', cancel)
    reader.releaseLock()
  }
}
