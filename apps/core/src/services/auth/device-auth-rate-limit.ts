export const MAX_LIMITER_KEYS = 10_000

export class FixedWindowLimiter {
  private readonly windows = new Map<string, { startsAt: number; count: number }>()

  constructor(private readonly now: () => number = Date.now) {}

  /** Observable for diagnostics and hard-bound regression tests; entries remain private. */
  get size(): number {
    return this.windows.size
  }

  reset(): void {
    this.windows.clear()
  }

  take(key: string, max: number, windowMs: number): boolean {
    const now = this.now()
    let entry = this.windows.get(key)
    if (!entry) {
      this.makeRoom(now, windowMs)
      entry = { startsAt: now, count: 0 }
      this.windows.set(key, entry)
    } else if (now - entry.startsAt >= windowMs) {
      entry = { startsAt: now, count: 0 }
      this.windows.set(key, entry)
    }
    if (entry.count >= max) return false
    entry.count++
    return true
  }

  private makeRoom(now: number, windowMs: number): void {
    if (this.windows.size < MAX_LIMITER_KEYS) return

    for (const [candidate, value] of this.windows) {
      if (now - value.startsAt >= windowMs) this.windows.delete(candidate)
    }

    // If all windows are still live, evict the oldest inserted windows. This
    // preserves a strict memory bound while letting new clients receive their
    // own bucket instead of sharing a globally exhaustible overflow bucket.
    while (this.windows.size >= MAX_LIMITER_KEYS) {
      const oldest = this.windows.keys().next().value
      if (oldest === undefined) break
      this.windows.delete(oldest)
    }
  }
}

export const deviceAuthorizationStartLimiter = new FixedWindowLimiter()

/** Web handoff exchanges, per client address (the codes are unguessable; this bounds hammering). */
export const webHandoffExchangeLimiter = new FixedWindowLimiter()
