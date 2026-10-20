/**
 * Evidence for a live-update stall: what this page believes about its socket.
 *
 * The WebSocket client reconnects only when the browser delivers a close event,
 * so a half-open socket, or a stall upstream of a healthy socket, looks exactly
 * like a quiet connected one. The tracker records when the current connection
 * opened and when it last received a frame; the watcher reports at the moments a
 * stalled app usually comes back to the person (window focus, visibility, the
 * network returning, a page restored from the back-forward cache). The provider
 * logs both to the console so a stall leaves a timestamped trail next to the
 * server's own open/close lines.
 */

export type SocketReadyStateName = 'connecting' | 'open' | 'closing' | 'closed' | 'none'

export interface SocketLivenessSnapshot {
  readyState: SocketReadyStateName
  /** Milliseconds since the current connection opened; null while there is none. */
  openForMs: number | null
  /** Milliseconds since the current connection last received a frame; null when it never has. */
  sinceLastMessageMs: number | null
}

export type SocketLivenessTrigger = 'visibilitychange' | 'focus' | 'online' | 'pageshow'

const READY_STATE_NAMES: Record<number, SocketReadyStateName> = {
  0: 'connecting',
  1: 'open',
  2: 'closing',
  3: 'closed',
}

export class SocketLivenessTracker {
  private openedAt: number | null = null
  private lastMessageAt: number | null = null

  constructor(private readonly now: () => number = Date.now) {}

  /** The current connection opened; frames from an earlier connection no longer count. */
  opened(): void {
    this.openedAt = this.now()
    this.lastMessageAt = null
  }

  message(): void {
    this.lastMessageAt = this.now()
  }

  closed(): void {
    this.openedAt = null
    this.lastMessageAt = null
  }

  snapshot(readyState: number | undefined): SocketLivenessSnapshot {
    const now = this.now()
    return {
      readyState: readyState === undefined ? 'none' : (READY_STATE_NAMES[readyState] ?? 'none'),
      openForMs: this.openedAt === null ? null : now - this.openedAt,
      sinceLastMessageMs: this.lastMessageAt === null ? null : now - this.lastMessageAt,
    }
  }
}

/**
 * Calls `report` on each signal that usually brings a stalled app back in front
 * of the person. Returns the function that removes the listeners.
 */
export function watchSocketLiveness(
  report: (trigger: SocketLivenessTrigger) => void,
  target: { window: Window; document: Document }
): () => void {
  const onVisibility = () => report('visibilitychange')
  const onFocus = () => report('focus')
  const onOnline = () => report('online')
  const onPageShow = () => report('pageshow')
  target.document.addEventListener('visibilitychange', onVisibility)
  target.window.addEventListener('focus', onFocus)
  target.window.addEventListener('online', onOnline)
  target.window.addEventListener('pageshow', onPageShow)
  return () => {
    target.document.removeEventListener('visibilitychange', onVisibility)
    target.window.removeEventListener('focus', onFocus)
    target.window.removeEventListener('online', onOnline)
    target.window.removeEventListener('pageshow', onPageShow)
  }
}
