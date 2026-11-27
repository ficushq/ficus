/**
 * Keyed async concurrency primitives.
 *
 * Two related-but-distinct patterns that were hand-rolled across services:
 *
 * - {@link InflightDeduper}: concurrent callers with the same key SHARE the
 *   one in-flight promise (e.g. "ensure sandbox X" — everyone wants the same
 *   result, doing the work twice is wasteful or harmful).
 * - {@link KeyedSerialQueue}: tasks with the same key run strictly one after
 *   another, each getting its own result (e.g. manifest/store mutations —
 *   read-modify-write cycles that would lose updates if interleaved).
 *
 * Both clean up their map entries once the last task for a key settles, so
 * long-lived processes don't accumulate keys.
 */

import { shareAcrossRequests } from '../../db/query-cancellation'

export class InflightDeduper<T> {
  private readonly inflight = new Map<string, Promise<T>>()

  get size(): number {
    return this.inflight.size
  }

  has(key: string): boolean {
    return this.inflight.has(key)
  }

  /**
   * Resolves once every run in flight AT CALL TIME has settled (rejections
   * swallowed). Runs started after the call are not awaited. For shutdown
   * paths that must observe the side effects of parked work (e.g. a tunnel
   * forward registered mid-ensure) before sweeping/releasing resources.
   */
  async settled(): Promise<void> {
    await Promise.allSettled([...this.inflight.values()])
  }

  /**
   * Run `fn` for `key`, or join the already-in-flight run for that key.
   * The entry clears when the promise settles; rejections propagate to every
   * joiner and the next call runs fresh.
   */
  run(key: string, fn: () => Promise<T> | T): Promise<T> {
    const existing = this.inflight.get(key)
    if (existing) return existing

    // Shared by every caller that joins it, so it belongs to none of them: an abandoned
    // read that started it must not cancel it for the rest (db/query-cancellation.ts).
    const promise = shareAcrossRequests(() => Promise.resolve().then(fn)).finally(() => {
      // Identity check: only clear our own entry (a fresh run may have
      // replaced it if timing interleaves).
      if (this.inflight.get(key) === promise) this.inflight.delete(key)
    })
    this.inflight.set(key, promise)
    return promise
  }
}

export class KeyedSerialQueue {
  private readonly queues = new Map<string, Promise<unknown>>()

  get size(): number {
    return this.queues.size
  }

  /**
   * Enqueue `fn` behind any pending tasks for `key`. Each caller gets its own
   * result/rejection; a failed task does not break the chain for later tasks.
   */
  run<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve()
    // Later tasks chain on this one, so it runs outside the caller's request scope.
    const next = shareAcrossRequests(() => previous.catch(() => undefined).then(fn))
    this.queues.set(key, next)
    return next.finally(() => {
      if (this.queues.get(key) === next) this.queues.delete(key)
    }) as Promise<T>
  }
}
