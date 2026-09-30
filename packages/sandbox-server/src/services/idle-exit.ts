/**
 * Idle self-exit policy for a SOCKET-ACTIVATED sandbox server (VM boxes only).
 *
 * Measured on the noah tenant host (4 vCPU / 8 GB, 44 boxes, ~2 of them doing
 * anything): 39 idle bun sandbox-servers held 1.67 GB of RAM purely to answer
 * a health probe once a minute. Under systemd socket activation the box's port
 * is owned by a `.socket` unit, `systemd-socket-proxyd` fronts the unix socket
 * the server listens on, and the server itself may simply GO AWAY while idle —
 * the next connection re-activates the whole chain.
 *
 * "Idle" is deliberately conservative. Exiting under a foreground Bash
 * invocation, an open terminal or a live file watch would destroy supported work, so the policy is a
 * pure function with every gate pinned by tests, and the caller injects the
 * clock and every liveness signal.
 */

export interface IdleExitInput {
  /** Now, epoch ms. */
  now: number
  /** When this process started serving, epoch ms. */
  bootedAt: number
  /** Last HTTP request (including /healthz) or websocket message, epoch ms. */
  lastActivityAt: number
  /** The idle window; `<= 0` disables self-exit entirely. */
  windowMs: number
  /** Any bash invocation in state starting|running|cancelling. */
  activeInvocations: boolean
  /** Open /shell websockets. */
  openShells: number
  /** Whether the workspace watcher is running. */
  watcherActive: boolean
}

/** The default idle window: 10 minutes. */
export const DEFAULT_IDLE_EXIT_MS = 600_000

export interface IdleExitGates {
  now: number
  activeInvocations: boolean
  openShells: number
  watcherActive: boolean
  reconciliationSettled: boolean
}

export interface RequestReservation {
  release(): void
}

export interface IdleExitClaim {
  abort(): void
}

/** Reserve request admission or return the fixed response used after drain wins. */
export function beginRequestOrDrainingResponse(
  coordinator: IdleExitCoordinator,
  now: number
): RequestReservation | Response {
  return (
    coordinator.beginRequest(now) ??
    new Response('Sandbox is draining; retry request', {
      status: 503,
      headers: { 'Retry-After': '1' },
    })
  )
}

/**
 * Serializes request admission with idle drain in the server's event loop.
 * A request reserves synchronously before its first await. Once draining has
 * been claimed, later requests are rejected until the claim is aborted.
 */
export class IdleExitCoordinator {
  private state: 'open' | 'draining' = 'open'
  private inFlightRequests = 0
  private readonly bootedAt: number
  private lastActivityAt: number
  private readonly windowMs: number

  constructor(input: { bootedAt: number; lastActivityAt: number; windowMs: number }) {
    this.bootedAt = input.bootedAt
    this.lastActivityAt = input.lastActivityAt
    this.windowMs = input.windowMs
  }

  beginRequest(now: number): RequestReservation | undefined {
    if (this.state !== 'open') return undefined
    this.lastActivityAt = now
    this.inFlightRequests += 1
    let released = false
    return {
      release: () => {
        if (released) return
        released = true
        this.inFlightRequests -= 1
      },
    }
  }

  noteActivity(now: number): void {
    if (this.state === 'open') this.lastActivityAt = now
  }

  tryBeginExit(gates: IdleExitGates): IdleExitClaim | undefined {
    if (this.state !== 'open' || this.inFlightRequests !== 0 || !gates.reconciliationSettled) return undefined
    if (
      !shouldIdleExit({
        now: gates.now,
        bootedAt: this.bootedAt,
        lastActivityAt: this.lastActivityAt,
        windowMs: this.windowMs,
        activeInvocations: gates.activeInvocations,
        openShells: gates.openShells,
        watcherActive: gates.watcherActive,
      })
    )
      return undefined
    this.state = 'draining'
    let settled = false
    return {
      abort: () => {
        if (settled) return
        settled = true
        this.state = 'open'
      },
    }
  }
}

/**
 * Whether a socket-activated server should exit(0) now. TRUE requires ALL of:
 * self-exit enabled, at least one full window since boot, a full window since
 * the last request/message, no live bash invocation, no open shell, and no
 * active watcher.
 */
export function shouldIdleExit(input: IdleExitInput): boolean {
  const { now, bootedAt, lastActivityAt, windowMs, activeInvocations, openShells, watcherActive } = input
  if (windowMs <= 0) return false
  // Never within the first window after boot: a box that was just activated for
  // a request whose work has not reached the server yet (the proxy is still
  // handing over, an SSH forward is still being rebuilt) must not vanish under
  // the caller that woke it.
  if (now - bootedAt < windowMs) return false
  if (now - lastActivityAt < windowMs) return false
  if (activeInvocations) return false
  if (openShells > 0) return false
  if (watcherActive) return false
  return true
}

/**
 * The configured window. Self-exit is FORCED OFF unless the server is listening
 * on a unix socket: k8s pods and docker sandboxes are reached directly on TCP
 * with nothing to re-activate them, so a server that exited there would simply
 * be gone. A malformed value falls back to the default rather than silently
 * disabling the feature; an explicit `0` disables it.
 */
export function resolveIdleExitWindowMs(input: { socketPath?: string; raw?: string }): number {
  if (!input.socketPath) return 0
  const raw = input.raw?.trim()
  if (!raw) return DEFAULT_IDLE_EXIT_MS
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_IDLE_EXIT_MS
  return Math.floor(parsed)
}

/**
 * How often to re-evaluate. 30s for any production-sized window; a quarter of
 * the window for the short windows tests use, floored at 100ms so a tiny window
 * can never turn the checker into a busy loop.
 */
export function idleExitCheckIntervalMs(windowMs: number): number {
  return Math.min(30_000, Math.max(100, Math.floor(windowMs / 4)))
}
