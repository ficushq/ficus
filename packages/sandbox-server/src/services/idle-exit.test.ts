import { describe, expect, it } from 'bun:test'
import {
  IdleExitCoordinator,
  beginRequestOrDrainingResponse,
  idleExitCheckIntervalMs,
  resolveIdleExitWindowMs,
  shouldIdleExit,
  type IdleExitInput,
} from './idle-exit'

/**
 * The idle self-exit policy is the ONE thing standing between "an idle box
 * costs zero RAM" and "a socket-activated server killed a running build".
 * Every gate is pinned individually: the base case exits, and flipping exactly
 * one input must keep the server alive.
 */
const BASE: IdleExitInput = {
  now: 2_000_000,
  bootedAt: 0,
  lastActivityAt: 1_000_000,
  windowMs: 600_000,
  activeInvocations: false,
  openShells: 0,
  watcherActive: false,
}

describe('shouldIdleExit', () => {
  it('exits once the window has elapsed with nothing in flight', () => {
    expect(shouldIdleExit(BASE)).toBe(true)
  })

  it('never exits while the window has not elapsed since the last activity', () => {
    expect(shouldIdleExit({ ...BASE, lastActivityAt: BASE.now - BASE.windowMs + 1 })).toBe(false)
    // Exactly at the window is an exit (>= window, per the policy).
    expect(shouldIdleExit({ ...BASE, lastActivityAt: BASE.now - BASE.windowMs })).toBe(true)
  })

  it('never exits within the first window after boot, even with no activity at all', () => {
    // A box that booted 1s ago and has never been touched: lastActivityAt is
    // its boot time, so the activity gate alone would already hold — pin the
    // boot gate independently by making activity look ancient.
    expect(shouldIdleExit({ ...BASE, bootedAt: BASE.now - 1_000, lastActivityAt: 0 })).toBe(false)
    expect(shouldIdleExit({ ...BASE, bootedAt: BASE.now - BASE.windowMs, lastActivityAt: 0 })).toBe(true)
  })

  it('never exits while a bash invocation is starting/running/cancelling', () => {
    expect(shouldIdleExit({ ...BASE, activeInvocations: true })).toBe(false)
  })

  it('never exits while a shell websocket is open', () => {
    expect(shouldIdleExit({ ...BASE, openShells: 1 })).toBe(false)
  })

  it('never exits while the workspace watcher is active', () => {
    expect(shouldIdleExit({ ...BASE, watcherActive: true })).toBe(false)
  })

  it('is disabled by a zero or negative window', () => {
    expect(shouldIdleExit({ ...BASE, windowMs: 0 })).toBe(false)
    expect(shouldIdleExit({ ...BASE, windowMs: -1 })).toBe(false)
  })
})

describe('IdleExitCoordinator', () => {
  const clearGates = {
    now: 1_200_000,
    activeInvocations: false,
    openShells: 0,
    watcherActive: false,
    reconciliationSettled: true,
  }

  it('claims only at the exact idle boundary', () => {
    const idle = new IdleExitCoordinator({ bootedAt: 0, lastActivityAt: 0, windowMs: 600_000 })
    expect(idle.tryBeginExit({ ...clearGates, now: 599_999 })).toBeUndefined()
    expect(idle.tryBeginExit({ ...clearGates, now: 600_000 })).toBeDefined()
  })

  it('blocks exit while a request reservation is held', () => {
    const idle = new IdleExitCoordinator({ bootedAt: 0, lastActivityAt: 0, windowMs: 600_000 })
    const request = idle.beginRequest(600_000)
    expect(request).toBeDefined()
    expect(idle.tryBeginExit(clearGates)).toBeUndefined()
    request!.release()
    expect(idle.tryBeginExit(clearGates)).toBeDefined()
  })

  it('serializes both admission and exit orderings', () => {
    const admittedFirst = new IdleExitCoordinator({ bootedAt: 0, lastActivityAt: 0, windowMs: 600_000 })
    const admitted = admittedFirst.beginRequest(600_000)
    expect(admitted).toBeDefined()
    expect(admittedFirst.tryBeginExit(clearGates)).toBeUndefined()

    const exitFirst = new IdleExitCoordinator({ bootedAt: 0, lastActivityAt: 0, windowMs: 600_000 })
    const claim = exitFirst.tryBeginExit(clearGates)
    expect(claim).toBeDefined()
    expect(exitFirst.beginRequest(600_000)).toBeUndefined()
  })

  it('returns an immediate retryable response when a request loses to drain', async () => {
    const idle = new IdleExitCoordinator({ bootedAt: 0, lastActivityAt: 0, windowMs: 600_000 })
    expect(idle.tryBeginExit(clearGates)).toBeDefined()
    const result = beginRequestOrDrainingResponse(idle, 1_200_000)
    expect(result).toBeInstanceOf(Response)
    const response = result as Response
    expect(response.status).toBe(503)
    expect(response.headers.get('Retry-After')).toBe('1')
    expect(await response.text()).toBe('Sandbox is draining; retry request')
  })

  it('defers exit until startup reconciliation settles and reopens when a claim aborts', () => {
    const idle = new IdleExitCoordinator({ bootedAt: 0, lastActivityAt: 0, windowMs: 600_000 })
    expect(idle.tryBeginExit({ ...clearGates, reconciliationSettled: false })).toBeUndefined()
    const claim = idle.tryBeginExit(clearGates)
    expect(claim).toBeDefined()
    claim!.abort()
    expect(idle.beginRequest(1_200_000)).toBeDefined()
  })
})

describe('resolveIdleExitWindowMs', () => {
  it('is forced off without a unix socket — TCP boxes (k8s/docker) never self-exit', () => {
    expect(resolveIdleExitWindowMs({ socketPath: '', raw: '600000' })).toBe(0)
    expect(resolveIdleExitWindowMs({ socketPath: undefined, raw: undefined })).toBe(0)
  })

  it('defaults to 10 minutes on a unix socket', () => {
    expect(resolveIdleExitWindowMs({ socketPath: '/run/x.sock', raw: undefined })).toBe(600_000)
    expect(resolveIdleExitWindowMs({ socketPath: '/run/x.sock', raw: '' })).toBe(600_000)
  })

  it('honors an explicit window, and 0 disables', () => {
    expect(resolveIdleExitWindowMs({ socketPath: '/run/x.sock', raw: '1500' })).toBe(1_500)
    expect(resolveIdleExitWindowMs({ socketPath: '/run/x.sock', raw: '0' })).toBe(0)
  })

  it('falls back to the default on a malformed window rather than disabling silently', () => {
    expect(resolveIdleExitWindowMs({ socketPath: '/run/x.sock', raw: 'soon' })).toBe(600_000)
    expect(resolveIdleExitWindowMs({ socketPath: '/run/x.sock', raw: '-5' })).toBe(600_000)
  })
})

describe('idleExitCheckIntervalMs', () => {
  it('checks every 30s for the production window', () => {
    expect(idleExitCheckIntervalMs(600_000)).toBe(30_000)
  })

  it('checks at a quarter of a short window, floored so it can never busy-loop', () => {
    expect(idleExitCheckIntervalMs(4_000)).toBe(1_000)
    expect(idleExitCheckIntervalMs(100)).toBe(100)
  })
})
