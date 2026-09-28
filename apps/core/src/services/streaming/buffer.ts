import type { StreamEvent } from '@ficus/shared'

export class StreamBuffer {
  private events: StreamEvent[] = []
  private subscribers = new Set<(event: StreamEvent) => void>()
  private _status: 'streaming' | 'done' | 'error' = 'streaming'
  private cleanupTimer: ReturnType<typeof setTimeout> | null = null
  private doneResolvers: Array<() => void> = []

  get status(): 'streaming' | 'done' | 'error' {
    return this._status
  }

  /** Returns a promise that resolves when the buffer is done or errored */
  waitUntilDone(): Promise<void> {
    if (this._status !== 'streaming') return Promise.resolve()
    return new Promise((resolve) => {
      this.doneResolvers.push(resolve)
    })
  }

  push(event: StreamEvent): void {
    if (this._status !== 'streaming') return
    this.events.push(event)
    for (const cb of this.subscribers) {
      try {
        cb(event)
      } catch {
        // ignore subscriber errors
      }
    }
  }

  /**
   * Remove buffered events that should no longer be replayed to reconnecting subscribers.
   * Live subscribers are not notified; callers should push a separate clearing event when
   * the UI needs to react immediately.
   */
  removeEvents(predicate: (event: StreamEvent) => boolean): void {
    this.events = this.events.filter((event) => !predicate(event))
  }

  /**
   * Subscribe to live events. Returns all buffered events so far (for catchup).
   */
  subscribe(cb: (event: StreamEvent) => void): StreamEvent[] {
    this.subscribers.add(cb)
    return [...this.events]
  }

  unsubscribe(cb: (event: StreamEvent) => void): void {
    this.subscribers.delete(cb)
  }

  close(): void {
    this._status = 'done'
    for (const resolve of this.doneResolvers) resolve()
    this.doneResolvers = []
    this.cleanupTimer = setTimeout(() => {
      streamManager.remove(this)
    }, 60_000)
  }

  fail(): void {
    this._status = 'error'
    for (const resolve of this.doneResolvers) resolve()
    this.doneResolvers = []
    this.cleanupTimer = setTimeout(() => {
      streamManager.remove(this)
    }, 60_000)
  }

  destroy(): void {
    if (this.cleanupTimer) clearTimeout(this.cleanupTimer)
    this.subscribers.clear()
    this.events = []
  }
}

class StreamManager {
  private buffers = new Map<string, StreamBuffer>()

  create(id: string): StreamBuffer {
    const existing = this.buffers.get(id)
    if (existing) existing.destroy()
    const buffer = new StreamBuffer()
    this.buffers.set(id, buffer)
    return buffer
  }

  get(id: string): StreamBuffer | undefined {
    return this.buffers.get(id)
  }

  remove(buffer: StreamBuffer): void {
    for (const [id, b] of this.buffers) {
      if (b === buffer) {
        b.destroy()
        this.buffers.delete(id)
        break
      }
    }
  }

  removeById(id: string): void {
    const buffer = this.buffers.get(id)
    if (buffer) {
      buffer.destroy()
      this.buffers.delete(id)
    }
  }
}

export const streamManager = new StreamManager()
