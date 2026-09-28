export type { EventMap } from '@ficus/shared'
import type { EventMap } from '@ficus/shared'
import { createLogger } from './logger'

const log = createLogger('events')

type EventHandler<T> = (data: T) => void
/**
 * Origin of an event as seen by a wildcard handler. `remote` is true when the
 * event was emitted by the OTHER process and re-emitted here by the
 * distributed listener — handlers that do durable work (e.g. squad-activity
 * materialization) must skip those, or every event is processed twice.
 */
export interface EventMeta {
  remote: boolean
}

type AnyEventHandler = (event: keyof EventMap, data: EventMap[keyof EventMap], meta: EventMeta) => void

class TypedEventEmitter {
  private handlers: Map<string, Set<EventHandler<any>>> = new Map()

  on<K extends keyof EventMap>(event: K, handler: EventHandler<EventMap[K]>): () => void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set())
    }
    this.handlers.get(event)!.add(handler)

    // Return unsubscribe function
    return () => {
      this.handlers.get(event)?.delete(handler)
    }
  }

  emit<K extends keyof EventMap>(event: K, data: EventMap[K], meta: EventMeta = { remote: false }): void {
    const handlers = this.handlers.get(event)
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(data)
        } catch (error) {
          log.error(`Error in event handler for ${event}:`, error)
        }
      }
    }
    // Fire wildcard handlers
    const anyHandlers = this.anyHandlers
    for (const handler of anyHandlers) {
      try {
        handler(event, data, meta)
      } catch (error) {
        log.error(`Error in onAny handler for ${event}:`, error)
      }
    }
  }

  private anyHandlers: Set<AnyEventHandler> = new Set()

  onAny(handler: AnyEventHandler): () => void {
    this.anyHandlers.add(handler)
    return () => {
      this.anyHandlers.delete(handler)
    }
  }

  removeAllListeners(): void {
    this.handlers.clear()
    this.anyHandlers.clear()
  }
}

type NotifyFn = (channel: string, payload: string) => Promise<void>
type ListenFn = (channel: string, callback: (payload: string) => void) => Promise<() => Promise<void>>

const CHANNEL = 'app_events'

class DistributedEmitter {
  private local = new TypedEventEmitter()
  private processId: string | null = null
  private notifyFn: NotifyFn | null = null

  /**
   * Initialize distributed forwarding. Call once at process startup.
   * Before this is called, emit() only fires locally (safe for tests).
   */
  initialize(processId: string, notifyFn: NotifyFn): void {
    this.processId = processId
    this.notifyFn = notifyFn
  }

  /**
   * Start listening for events from the other process.
   * Returns a cleanup function to stop listening.
   */
  async startListening(listenFn: ListenFn): Promise<() => Promise<void>> {
    return listenFn(CHANNEL, (payload: string) => {
      try {
        const { event, data, source } = JSON.parse(payload)
        if (source === this.processId) return // Ignore own events
        this.local.emit(event, data, { remote: true }) // Emit locally only — no re-forward
      } catch (error) {
        log.error('Failed to parse distributed event:', error)
      }
    })
  }

  emit<K extends keyof EventMap>(event: K, data: EventMap[K]): void {
    this.local.emit(event, data) // Local handlers get full data
    if (this.processId && this.notifyFn) {
      this.notifyFn(CHANNEL, JSON.stringify({ event, data, source: this.processId })).catch((err) => {
        log.error(`Failed to forward event ${event}:`, err)
      })
    }
  }

  on<K extends keyof EventMap>(event: K, handler: EventHandler<EventMap[K]>): () => void {
    return this.local.on(event, handler)
  }

  onAny(handler: AnyEventHandler): () => void {
    return this.local.onAny(handler)
  }

  removeAllListeners(): void {
    this.local.removeAllListeners()
  }
}

export const eventEmitter = new DistributedEmitter()
