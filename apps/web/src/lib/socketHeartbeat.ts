/**
 * The page's own proof that its socket is alive.
 *
 * Core pings every socket at the transport level and the browser's network
 * process answers without the page ever seeing it, so a connection whose frames
 * have stopped reaching the page looks healthy to both ends: the server keeps
 * it, the page keeps waiting, and nothing reconnects. This heartbeat closes that
 * gap. After `intervalMs` without an inbound frame it sends a ping; if nothing at
 * all arrives within `timeoutMs` after that, the socket is declared dead and the
 * owner replaces it. Any inbound frame counts as life, so a busy socket never
 * pings at all.
 */

export interface SocketHeartbeatOptions {
  /** Quiet time before a ping goes out. */
  intervalMs: number
  /** Time after a ping to hear anything back. */
  timeoutMs: number
  /** Sends the ping; false when the socket cannot send right now, which arms no timeout. */
  send: () => boolean
  /** The socket went quiet past the timeout; called once per start(). */
  onDead: () => void
  /** Injected for deterministic tests; default to real timers. */
  schedule?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>
  cancel?: (handle: ReturnType<typeof setTimeout>) => void
}

export interface SocketHeartbeat {
  /** Begin watching an open socket. A second start while running is a no-op. */
  start(): void
  /** An inbound frame arrived: the socket is alive right now. */
  frame(): void
  /** Stop watching and cancel every timer. */
  stop(): void
}

export function createSocketHeartbeat(options: SocketHeartbeatOptions): SocketHeartbeat {
  const schedule = options.schedule ?? ((callback, ms) => setTimeout(callback, ms))
  const cancel = options.cancel ?? ((handle) => clearTimeout(handle))
  let quiet: ReturnType<typeof setTimeout> | null = null
  let timeout: ReturnType<typeof setTimeout> | null = null
  let running = false

  function clear() {
    if (quiet !== null) cancel(quiet)
    if (timeout !== null) cancel(timeout)
    quiet = null
    timeout = null
  }

  function armQuiet() {
    quiet = schedule(() => {
      quiet = null
      if (!running) return
      if (!options.send()) {
        armQuiet()
        return
      }
      timeout = schedule(() => {
        timeout = null
        if (!running) return
        running = false
        options.onDead()
      }, options.timeoutMs)
    }, options.intervalMs)
  }

  return {
    start() {
      if (running) return
      running = true
      armQuiet()
    },
    frame() {
      if (!running) return
      clear()
      armQuiet()
    },
    stop() {
      running = false
      clear()
    },
  }
}
