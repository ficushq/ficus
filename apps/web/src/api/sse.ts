import type { StreamEvent } from '@ficus/shared'

export interface SSECallbacks {
  onEvent: (event: StreamEvent) => void
  onError?: (error: Error) => void
  onDone?: () => void
}

/**
 * Parse an SSE response body, dispatching events to callbacks.
 * Shared between chat (inline POST stream) and agent (reconnectable GET stream).
 */
export async function parseSSEStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  callbacks: SSECallbacks
): Promise<void> {
  const decoder = new TextDecoder()
  let buffer = ''
  let currentEvent = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''

    for (const line of lines) {
      if (line.startsWith('event: ')) {
        currentEvent = line.slice(7)
      } else if (line.startsWith('data: ')) {
        const raw = line.slice(6)
        if (currentEvent === 'catchup') {
          const { events } = JSON.parse(raw) as { events: StreamEvent[] }
          for (const event of events) {
            callbacks.onEvent(event)
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
          // Yield after certain events so React renders incrementally
          if (event.type === 'tool_start' || event.type === 'text' || event.type === 'thinking') {
            await new Promise((r) => setTimeout(r, 0))
          }
        }
      }
    }
  }
}
